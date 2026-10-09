/**
 * RAG 编排：问题改写 → 检索 → 重排 → 阈值判定 → 生成（流式）
 * 以 async generator 产出事件，前端可实时展示 Agent 每一步的中间状态。
 */
import { loadConfig } from './config.js';
import { embedOne, embedTexts } from './embed.js';
import { retrieve, normalizeCandidates } from './retrieve.js';
import { rerank } from './rerank.js';
import { chatComplete, chatStream } from './llm.js';
import * as kb from './kb.js';

/* ---------------------------- 问题改写 ---------------------------- */
const REWRITE_MULTI_PROMPT =
  '你是检索查询生成专家。基于对话历史和用户最新问题，生成 {n} 个不同角度的检索查询，用于召回互补资料。\n' +
  '只输出 JSON：{"queries":["q1","q2"]}，不要解释。';
const HYDE_PROMPT =
  '请针对下面的问题，写一段"假设性答案"（100~200字），用于向量检索。\n' +
  '要求：像资料中的原话一样表述，包含可能的专业术语；不要说"根据资料"，直接写内容。\n\n问题：{q}';
const RETRY_PROMPT =
  '上一轮检索没有找到能回答该问题的资料。请换一种表述方式，生成一个更利于检索的新查询（可拆分为更具体的子问题或替换同义词）。\n' +
  '只输出一个新查询文本，不要解释。\n\n原始问题：{q}\n已尝试的查询：{tried}';

async function rewriteQueries(messages, cfg, tried = []) {
  const q = cfg.query || {};
  if (!q.rewriteEnabled) return { queries: [lastUser(messages)], mode: 'none' };

  const history = messages.slice(-1 - (Number(q.historyTurns) || 3) * 2, -1);
  const prompt = (q.rewritePrompt || '').trim();
  const base = [
    { role: 'system', content: '你是查询优化专家。只输出查询语句本身，不要回答用户的问题。' },
  ];
  if (history.length) base.push(...history);

  try {
    if (q.rewriteMode === 'multi') {
      const n = Math.max(2, Math.min(5, Number(q.multiCount) || 3));
      const { content } = await chatComplete(
        [...base, { role: 'user', content: `${prompt}\n\n${REWRITE_MULTI_PROMPT.replace('{n}', n)}\n\n用户问题：${lastUser(messages)}` }],
        { temperature: 0.2, jsonMode: true },
      );
      const m = content.match(/\{[\s\S]*\}/);
      const json = JSON.parse(m ? m[0] : content);
      const queries = (json.queries || []).filter(Boolean).slice(0, n);
      if (queries.length) return { queries, mode: 'multi' };
    } else if (q.rewriteMode === 'hyde') {
      const { content } = await chatComplete(
        [...base, { role: 'user', content: HYDE_PROMPT.replace('{q}', lastUser(messages)) }],
        { temperature: 0.4 },
      );
      if (content.trim()) return { queries: [lastUser(messages), content.trim()], mode: 'hyde' };
    }
    const { content } = await chatComplete(
      [...base, { role: 'user', content: `${prompt}\n\n用户问题：${lastUser(messages)}` }],
      { temperature: 0.2 },
    );
    const text = content.trim().replace(/^["'`]|["'`]$/g, '');
    return { queries: text ? [text] : [lastUser(messages)], mode: 'single' };
  } catch (e) {
    return { queries: [lastUser(messages)], mode: 'error', error: e.message };
  }
}

function lastUser(messages) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return messages[i].content;
  return '';
}

/** 只做问题改写（供前端调试面板单独测试） */
export async function rewriteOnly(messages, queryCfg, history = []) {
  const full = [...history, ...messages];
  return rewriteQueries(full, { query: { ...loadConfig().query, ...(queryCfg || {}) } }, []);
}

/* ---------------------------- 单轮检索 ---------------------------- */
async function searchOnce(queries, cfg, embedOverride) {
  const chunks = kb.allChunks();
  if (!chunks.length) return { candidates: [], chunks: [] };
  const bm25 = kb.getBm25();
  const mode = cfg.retrieve.mode;

  let vectors = [];
  if (mode !== 'bm25') {
    try {
      vectors = await embedTexts(queries, embedOverride);
    } catch (e) {
      if (mode === 'semantic') throw e;
      vectors = [];
    }
  }

  const merged = new Map();
  const perQuery = [];
  for (let i = 0; i < queries.length; i++) {
    const qv = vectors[i] || null;
    const hits = retrieve({ query: queries[i], queryVector: qv, chunks, bm25, cfg: cfg.retrieve });
    perQuery.push({ query: queries[i], hits: hits.slice(0, 10) });
    for (const h of hits) {
      const prev = merged.get(h.chunkIndex);
      if (!prev || h.fused > prev.fused) merged.set(h.chunkIndex, h);
    }
  }
  const candidates = [...merged.values()].sort((a, b) => b.fused - a.fused).slice(0, Number(cfg.retrieve.candidateK) || 30);
  return { candidates, chunks, perQuery };
}

const normalizeScores = (candidates, rCfg) => normalizeCandidates(candidates, rCfg);

/* ---------------------------- 主流程 ---------------------------- */
/**
 * @param {object} args
 * @param {Array} args.messages  [{role, content}]
 * @param {object} [args.override] 临时覆盖配置（前端可在对话页即时调参）
 */
export async function* runRag({ messages, override = {} }) {
  const base = loadConfig();
  const cfg = {
    query: { ...base.query, ...(override.query || {}) },
    retrieve: { ...base.retrieve, ...(override.retrieve || {}) },
    rerank: { ...base.rerank, ...(override.rerank || {}) },
    agent: { ...base.agent, ...(override.agent || {}) },
    llmOverride: override.llm || {},
  };
  const statsRows = kb.allChunks();
  if (!statsRows.length) {
    yield { type: 'error', message: '知识库为空，请先上传文档并完成索引。' };
    return;
  }

  const trace = [];
  const tried = [];

  /* 1. 问题改写 */
  let queries = [lastUser(messages)];
  if (cfg.query.rewriteEnabled) {
    yield { type: 'stage', stage: 'rewrite', label: '正在改写问题…' };
    const r = await rewriteQueries(messages, cfg, tried);
    queries = r.queries;
    tried.push(...queries);
    yield { type: 'rewritten', mode: r.mode, queries, error: r.error };
    trace.push({ step: 'rewrite', mode: r.mode, queries });
  }

  let iteration = 0;
  let finalChunks = [];
  let usedScores = [];
  let lastCandidates = [];

  while (true) {
    /* 2. 检索 */
    yield { type: 'stage', stage: 'retrieve', label: `正在检索（第 ${iteration + 1} 轮）…` };
    let search;
    try {
      search = await searchOnce(queries, cfg, override.embedding || {});
    } catch (e) {
      yield { type: 'error', message: `检索失败：${e.message}` };
      return;
    }
    let candidates = normalizeScores(search.candidates, cfg.retrieve);
    lastCandidates = candidates;
    yield {
      type: 'retrieved',
      mode: cfg.retrieve.mode,
      count: candidates.length,
      items: candidates.slice(0, 10).map((c) => ({
        text: search.chunks[c.chunkIndex].text.slice(0, 200),
        docName: search.chunks[c.chunkIndex].docName,
        semantic: +c.semantic.toFixed(4),
        bm25: +c.bm25.toFixed(4),
        fused: +c.fusedNorm.toFixed(4),
      })),
    };

    /* 3. 重排 */
    let ranked = candidates;
    let rerankInfo = { mode: 'none' };
    if (cfg.rerank.enabled && cfg.rerank.mode !== 'none' && candidates.length) {
      yield { type: 'stage', stage: 'rerank', label: '正在重排…' };
      const docs = candidates.map((c) => search.chunks[c.chunkIndex].text);
      const rr = await rerank(queries[0], docs, {
        mode: cfg.rerank.mode,
        topN: Math.min(Number(cfg.rerank.topN) || 20, docs.length),
      });
      rerankInfo = rr;
      if (rr.items?.length) {
        ranked = rr.items.map((r) => ({ ...candidates[r.index], rerank: r.score }));
      }
      yield {
        type: 'reranked',
        mode: rr.mode,
        degraded: rr.degraded,
        items: ranked.slice(0, 10).map((c) => ({
          text: search.chunks[c.chunkIndex].text.slice(0, 200),
          docName: search.chunks[c.chunkIndex].docName,
          score: +(c.rerank ?? c.fusedNorm).toFixed(4),
        })),
      };
    }

    /* 4. 阈值过滤 */
    const threshold = Number(cfg.retrieve.minScore) || 0;
    const src = cfg.retrieve.scoreSource;
    const scored = ranked.map((c) => {
      const hasRerank = typeof c.rerank === 'number';
      const useRerank = src === 'rerank' ? hasRerank : src === 'fusion' ? false : hasRerank;
      const score = useRerank ? c.rerank : c.fusedNorm;
      return { ...c, finalScore: score, scoreFrom: useRerank ? 'rerank' : 'fusion' };
    }).sort((a, b) => b.finalScore - a.finalScore);

    const kept = scored.filter((c) => c.finalScore >= threshold).slice(0, Number(cfg.retrieve.topK) || 8);
    finalChunks = kept.map((c, i) => ({
      ref: i + 1,
      id: search.chunks[c.chunkIndex].id,
      docName: search.chunks[c.chunkIndex].docName,
      text: search.chunks[c.chunkIndex].text,
      score: +c.finalScore.toFixed(4),
      scoreFrom: c.scoreFrom,
      semantic: +c.semantic.toFixed(4),
      bm25: +c.bm25.toFixed(4),
    }));
    usedScores = scored;

    if (finalChunks.length) break;

    /* 5. Agent：改写后重试 */
    const canRetry = cfg.agent.enabled && iteration < (Number(cfg.agent.maxIterations) || 0) && threshold > 0;
    if (!canRetry) break;
    iteration++;
    yield { type: 'stage', stage: 'retry', label: `未命中阈值，Agent 重新改写问题（第 ${iteration} 次重试）…` };
    try {
      const { content } = await chatComplete(
        [
          { role: 'system', content: '你是检索优化助手，只输出一条新的检索查询。' },
          {
            role: 'user',
            content: RETRY_PROMPT.replace('{q}', lastUser(messages)).replace('{tried}', tried.join(' / ')),
          },
        ],
        { temperature: 0.5 },
      );
      const nq = content.trim().replace(/^["'`]|["'`]$/g, '');
      if (nq && !tried.includes(nq)) {
        queries = [nq];
        tried.push(nq);
        yield { type: 'rewritten', mode: 'retry', queries };
        continue;
      }
    } catch {
      /* 改写失败则放弃重试 */
    }
    break;
  }

  /* 6. 生成 */
  if (!finalChunks.length) {
    yield {
      type: 'noanswer',
      threshold: cfg.retrieve.minScore,
      best: usedScores[0]
        ? { score: +usedScores[0].finalScore.toFixed(4), from: usedScores[0].scoreFrom, text: kb.allChunks()[usedScores[0].chunkIndex]?.text?.slice(0, 200) }
        : null,
      mode: cfg.retrieve.noAnswerMode,
    };
    if (cfg.retrieve.noAnswerMode === 'refuse') {
      yield { type: 'delta', text: cfg.retrieve.noAnswerText };
      yield { type: 'done', refs: [], refused: true, trace };
      return;
    }
  } else {
    yield { type: 'context', chunks: finalChunks, threshold: cfg.retrieve.minScore };
  }

  const contextBlock = finalChunks.length
    ? finalChunks.map((c) => `[${c.ref}] 来源：${c.docName}\n${c.text}`).join('\n\n')
    : '（无参考资料）';

  const sys = cfg.llmOverride.systemPrompt || loadConfig().llm.systemPrompt;
  const genMessages = [
    { role: 'system', content: sys },
    ...messages.slice(-8),
    { role: 'user', content: `【参考资料】\n${contextBlock}\n\n【用户问题】\n${lastUser(messages)}` },
  ];

  yield { type: 'stage', stage: 'generate', label: '正在生成答案…' };
  try {
    let acc = '';
    for await (const d of chatStream(genMessages, cfg.llmOverride)) {
      acc += d;
      yield { type: 'delta', text: d };
    }
    yield { type: 'done', refs: finalChunks, answer: acc, refused: false, trace };
  } catch (e) {
    yield { type: 'error', message: `生成失败：${e.message}` };
  }
}

/** 仅检索（调试用，不生成答案） */
export async function searchOnly(query, override = {}) {
  const base = loadConfig();
  const cfg = { retrieve: { ...base.retrieve, ...(override.retrieve || {}) } };
  const { candidates, chunks } = await searchOnce([query], cfg, override.embedding || {});
  const norm = normalizeScores(candidates, cfg.retrieve);
  return norm.slice(0, Number(cfg.retrieve.topK) || 8).map((c) => ({
    text: chunks[c.chunkIndex].text,
    docName: chunks[c.chunkIndex].docName,
    semantic: +c.semantic.toFixed(4),
    bm25: +c.bm25.toFixed(4),
    fused: +c.fusedNorm.toFixed(4),
  }));
}
