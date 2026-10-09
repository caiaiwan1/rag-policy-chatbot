/**
 * 分块（Chunking）引擎
 * 支持四种策略，全部支持 overlap：
 *   fixed     —— 按 token 数滑窗切块（overlap 在滑窗内精确生效）
 *   semantic  —— 句子级语义切块（embedding 相似度断点），受 maxTokens 约束
 *   paragraph —— 按段落切块，小段可合并，overlap 按段落数
 *   recursive —— 按分隔符递归切块（\n\n → \n → 句 → token），工程最常用
 */
import { countTokens, toUnits, sliceByTokens, splitSentences, splitParagraphs } from './tokenizer.js';

/** 根据配置换算 overlap 的 token 数 */
export function overlapTokens(cfg) {
  if (!cfg.overlapEnabled) return 0;
  const size = Number(cfg.size) || 512;
  if (cfg.overlapMode === 'percent') {
    return Math.max(0, Math.round((size * Number(cfg.overlapValue || 0)) / 100));
  }
  return Math.max(0, Number(cfg.overlapValue || 0));
}

/** 取文本末尾 n 个 token 的内容（按单元边界对齐，不切坏单词） */
function tailTokens(text, n) {
  if (n <= 0) return '';
  const units = toUnits(text);
  let acc = 0;
  const keep = [];
  for (let i = units.length - 1; i >= 0 && acc < n; i--) {
    keep.unshift(units[i].t);
    acc += units[i].w;
  }
  return keep.join('').trim();
}

const MD_HEADING = /^#{1,6}\s+/;

/** markdown 友好处理：避免标题行孤零零留在块尾 */
function postProcessMarkdown(chunks) {
  for (let i = 0; i < chunks.length - 1; i++) {
    const lines = chunks[i].text.split('\n');
    const last = lines[lines.length - 1].trim();
    if (MD_HEADING.test(last) && lines.length > 1) {
      lines.pop();
      chunks[i].text = lines.join('\n').trim();
      chunks[i + 1].text = `${last}\n${chunks[i + 1].text}`.trim();
      chunks[i].tokens = countTokens(chunks[i].text);
      chunks[i + 1].tokens = countTokens(chunks[i + 1].text);
    }
  }
  return chunks.filter((c) => c.text);
}

/** 通用 overlap 后处理：tokens 模式 */
function applyTokenOverlap(chunks, ovTokens) {
  if (ovTokens <= 0 || chunks.length < 2) return chunks;
  const out = [chunks[0]];
  for (let i = 1; i < chunks.length; i++) {
    const head = tailTokens(chunks[i - 1].text, ovTokens);
    const text = head ? `${head}\n${chunks[i].text}` : chunks[i].text;
    out.push({ ...chunks[i], text: text.trim(), tokens: countTokens(text.trim()) });
  }
  return out;
}

/* ------------------------------ 策略实现 ------------------------------ */

function strategyFixed(text, cfg) {
  const size = Number(cfg.size) || 512;
  const ov = overlapTokens(cfg);
  const chunks = sliceByTokens(text, size, ov);
  return chunks.map((c, i) => ({ index: i, text: c.text, tokens: c.tokens }));
}

function strategyRecursive(text, cfg) {
  const size = Number(cfg.size) || 512;
  const separators = ['\n\n', '\n', '。', '！', '？', '. ', '；', '，', ' '];
  let parts = [text];
  for (const sep of separators) {
    const next = [];
    for (const p of parts) {
      if (countTokens(p) > size) next.push(...p.split(sep).filter(Boolean));
      else next.push(p);
    }
    parts = next;
    if (parts.every((p) => countTokens(p) <= size)) break;
  }
  // 贪心合并到接近 size
  const merged = [];
  let buf = '';
  for (const p of parts) {
    const cand = buf ? `${buf}${buf.endsWith('\n') || p.startsWith('\n') ? '' : '\n'}${p}` : p;
    if (countTokens(cand) > size && buf) {
      merged.push(buf.trim());
      buf = p;
    } else {
      buf = cand;
    }
  }
  if (buf.trim()) merged.push(buf.trim());
  const ov = overlapTokens(cfg);
  return applyTokenOverlap(
    merged.map((t, i) => ({ index: i, text: t, tokens: countTokens(t) })),
    ov,
  );
}

function strategyParagraph(text, cfg) {
  const p = cfg.paragraph || {};
  const maxTokens = Number(p.maxTokens) || 800;
  const mergeSmall = p.mergeSmall !== false;
  const paras = splitParagraphs(text);

  const merged = [];
  let buf = '';
  for (const para of paras) {
    const cand = buf ? `${buf}\n\n${para}` : para;
    if (countTokens(cand) > maxTokens && buf) {
      merged.push(buf.trim());
      buf = para;
    } else {
      buf = cand;
    }
  }
  if (buf.trim()) merged.push(buf.trim());

  // 合并过小的尾部块
  if (mergeSmall && merged.length > 1 && countTokens(merged[merged.length - 1]) < 60) {
    const last = merged.pop();
    merged[merged.length - 1] = `${merged[merged.length - 1]}\n\n${last}`;
  }

  // 段落级 overlap
  const ovPara = Number(p.overlapParagraphs) || 0;
  const chunks = merged.map((t, i) => ({ index: i, text: t, tokens: countTokens(t) }));
  if (ovPara > 0 && chunks.length > 1) {
    const out = [chunks[0]];
    for (let i = 1; i < chunks.length; i++) {
      const prevParas = splitParagraphs(chunks[i - 1].text);
      const head = prevParas.slice(-ovPara).join('\n\n');
      const text = head ? `${head}\n\n${chunks[i].text}` : chunks[i].text;
      out.push({ ...chunks[i], text: text.trim(), tokens: countTokens(text.trim()) });
    }
    return out;
  }
  return chunks;
}

/** 无 embedding 时的语义降级：按句子 + 长度启发式合并 */
function semanticFallback(text, cfg) {
  const s = cfg.semantic || {};
  const maxTokens = Number(s.maxTokens) || 700;
  const minTokens = Number(s.minTokens) || 80;
  const sentences = splitSentences(text);
  const out = [];
  let buf = '';
  for (const sent of sentences) {
    const cand = buf ? `${buf}${buf.endsWith('\n') ? '' : ''}${sent}` : sent;
    if (countTokens(cand) > maxTokens && buf) {
      out.push(buf.trim());
      buf = sent;
    } else {
      buf = cand;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  if (out.length > 1 && countTokens(out[out.length - 1]) < minTokens) {
    const last = out.pop();
    out[out.length - 1] = `${out[out.length - 1]}${last}`;
  }
  return out.map((t, i) => ({ index: i, text: t, tokens: countTokens(t) }));
}

/**
 * 语义切块（需要 embedding）
 * @param {string[]} sentences
 * @param {number[][]} vectors 与 sentences 对齐
 * @param {object} cfg chunk.semantic
 */
function groupBySemantics(sentences, vectors, cfg) {
  const maxTokens = Number(cfg.maxTokens) || 700;
  const minTokens = Number(cfg.minTokens) || 80;
  const sims = [];
  for (let i = 0; i < vectors.length - 1; i++) sims.push(cosine(vectors[i], vectors[i + 1]));

  let threshold = Number(cfg.threshold) || 0.55;
  if (cfg.thresholdMode === 'percentile' && sims.length) {
    const sorted = [...sims].sort((a, b) => a - b);
    const p = Math.min(100, Math.max(0, Number(cfg.percentile) || 85));
    const idx = Math.floor((sorted.length - 1) * (p / 100));
    threshold = sorted[idx];
  }

  const groups = [];
  let cur = [sentences[0]];
  let curTokens = countTokens(sentences[0]);
  for (let i = 0; i < sims.length; i++) {
    const nextTokens = countTokens(sentences[i + 1]);
    const disconnected = sims[i] < threshold;
    const overflow = curTokens + nextTokens > maxTokens;
    if (disconnected || overflow) {
      groups.push(cur.join(''));
      cur = [sentences[i + 1]];
      curTokens = nextTokens;
    } else {
      cur.push(sentences[i + 1]);
      curTokens += nextTokens;
    }
  }
  if (cur.length) groups.push(cur.join(''));

  // 合并过小的块（合并后不得超过 maxTokens）
  const merged = [];
  for (const g of groups) {
    const prev = merged[merged.length - 1];
    const tooSmall = prev !== undefined && (countTokens(g) < minTokens || countTokens(prev) < minTokens);
    if (prev !== undefined && tooSmall && countTokens(prev) + countTokens(g) <= maxTokens) {
      merged[merged.length - 1] = prev + g;
    } else {
      merged.push(g);
    }
  }
  return { chunks: merged.map((t) => t.trim()).filter(Boolean), threshold };
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 主入口
 * @param {string} text
 * @param {object} cfg  chunk 配置
 * @param {(texts:string[])=>Promise<number[][]>} [embedFn] 语义切块所需
 */
export async function chunkText(text, cfg, embedFn) {
  if (!text || !text.trim()) return { chunks: [], meta: {} };
  let raw;
  const meta = { strategy: cfg.strategy };

  if (cfg.strategy === 'fixed') {
    raw = strategyFixed(text, cfg);
  } else if (cfg.strategy === 'recursive') {
    raw = strategyRecursive(text, cfg);
  } else if (cfg.strategy === 'paragraph') {
    raw = strategyParagraph(text, cfg);
  } else if (cfg.strategy === 'semantic') {
    const sentences = splitSentences(text);
    if (!embedFn || sentences.length < 2) {
      raw = semanticFallback(text, cfg);
      meta.degraded = !embedFn ? 'no-embedding' : 'too-few-sentences';
    } else {
      try {
        const vecs = await embedFn(sentences);
        // 预留 overlap 预算，保证加上重叠后仍不超过 maxTokens
        const ovBudget = overlapTokens(cfg);
        const s = cfg.semantic || {};
        const semCfg = { ...s, maxTokens: Math.max(128, (Number(s.maxTokens) || 700) - ovBudget) };
        const { chunks, threshold } = groupBySemantics(sentences, vecs, semCfg);
        meta.threshold = Number(threshold.toFixed(4));
        raw = chunks.map((t, i) => ({ index: i, text: t, tokens: countTokens(t) }));
        const ov = overlapTokens(cfg);
        raw = applyTokenOverlap(raw, ov);
      } catch (e) {
        raw = semanticFallback(text, cfg);
        meta.degraded = `embed-failed: ${e.message}`;
      }
    }
  } else {
    raw = strategyFixed(text, cfg);
  }

  if (cfg.respectMarkdown) raw = postProcessMarkdown(raw);

  const chunks = raw
    .map((c, i) => ({ index: i, text: c.text.trim(), tokens: countTokens(c.text.trim()) }))
    .filter((c) => c.text);

  const tokens = chunks.map((c) => c.tokens);
  meta.count = chunks.length;
  meta.avgTokens = tokens.length ? Math.round(tokens.reduce((a, b) => a + b, 0) / tokens.length) : 0;
  meta.minTokens = tokens.length ? Math.min(...tokens) : 0;
  meta.maxTokens = tokens.length ? Math.max(...tokens) : 0;
  meta.overlapTokens = cfg.strategy === 'fixed' ? overlapTokens(cfg) : overlapTokens(cfg);
  return { chunks, meta };
}
