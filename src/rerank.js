/**
 * 重排（Rerank）
 *  mode = api  —— 调用专业 rerank 服务（SiliconFlow / Cohere / Xinference / 自建 TEI）
 *  mode = llm  —— 让大模型对候选片段打分（无需额外服务，速度略慢）
 *  mode = none —— 不重排，直接用融合分数
 */
import { loadConfig } from './config.js';
import { chatComplete } from './llm.js';

/** 统一解析各家 rerank 响应 */
function parseRerankResponse(json) {
  const list = json?.results || json?.output?.results || json?.data || json?.documents;
  if (!Array.isArray(list)) return null;
  return list
    .map((r) => ({
      index: r.index ?? r.document?.index,
      score: r.relevance_score ?? r.score ?? r.relevance ?? r.similarity,
    }))
    .filter((r) => r.index !== undefined && r.score !== undefined)
    .map((r) => ({ index: Number(r.index), score: Number(r.score) }));
}

async function rerankByApi(query, docs, topN, override = {}) {
  const cfg = loadConfig().rerank;
  const baseUrl = override.baseUrl || cfg.baseUrl;
  const apiKey = override.apiKey || cfg.apiKey;
  const model = override.model || cfg.model;
  if (!apiKey) throw new Error('未配置 Rerank API Key');
  if (!baseUrl) throw new Error('未配置 Rerank 接口地址');

  // 阿里云 DashScope 原生 rerank 使用 input 嵌套格式，需单独适配
  const isDashscope = /dashscope/.test(baseUrl) && /services\/rerank/.test(baseUrl);
  const body = isDashscope
    ? { model, input: { query, documents: docs }, parameters: { top_n: topN, return_documents: false } }
    : { model, query, documents: docs, top_n: topN };

  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Rerank ${res.status}: ${text.slice(0, 300)}`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Rerank 返回非 JSON: ${text.slice(0, 200)}`);
  }
  const parsed = parseRerankResponse(json);
  if (!parsed) throw new Error(`Rerank 响应格式无法识别: ${text.slice(0, 200)}`);
  return parsed;
}

async function rerankByLlm(query, docs, topN, override = {}) {
  const numbered = docs.map((d, i) => `[#${i}] ${String(d).slice(0, 1200)}`).join('\n\n');
  const messages = [
    {
      role: 'system',
      content:
        '你是检索相关性评审专家。给定用户查询与若干候选片段，请为每个片段打出 0~100 的相关性分数。' +
        '只输出 JSON：{"scores":[{"index":0,"score":87}]}，不要任何解释。',
    },
    { role: 'user', content: `查询：${query}\n\n候选片段：\n${numbered}` },
  ];
  const { content } = await chatComplete(messages, { temperature: 0, jsonMode: true, ...override });
  let list = [];
  try {
    const m = content.match(/\{[\s\S]*\}/);
    const json = JSON.parse(m ? m[0] : content);
    list = json.scores || json.results || json.data || [];
  } catch {
    throw new Error(`LLM 重排结果解析失败: ${content.slice(0, 200)}`);
  }
  return list
    .map((r) => ({ index: Number(r.index), score: Number(r.score) / 100 }))
    .filter((r) => Number.isFinite(r.index) && Number.isFinite(r.score));
}

/**
 * @param {string} query
 * @param {string[]} docs
 * @param {object} opts {topN, mode, baseUrl, apiKey, model}
 * @returns {Promise<{items:{index:number,score:number}[], mode:string, degraded?:string}>}
 */
export async function rerank(query, docs, opts = {}) {
  const cfg = loadConfig().rerank;
  const mode = opts.mode || (cfg.enabled ? cfg.mode : 'none');
  const topN = Math.max(1, Number(opts.topN ?? cfg.topN) || docs.length);
  if (mode === 'none' || !docs.length) return { items: [], mode: 'none' };

  try {
    const items =
      mode === 'llm'
        ? await rerankByLlm(query, docs, topN, opts)
        : await rerankByApi(query, docs, topN, opts);
    const sorted = items
      .filter((r) => r.index >= 0 && r.index < docs.length)
      .sort((a, b) => b.score - a.score)
      .slice(0, topN);
    if (!sorted.length) throw new Error('重排结果为空');
    return { items: sorted, mode };
  } catch (e) {
    if (mode === 'api') {
      // API 失败自动降级为 LLM 打分
      try {
        const items = await rerankByLlm(query, docs, topN, opts);
        return {
          items: items.sort((a, b) => b.score - a.score).slice(0, topN),
          mode: 'llm',
          degraded: `重排 API 失败，已降级为 LLM 打分：${e.message}`,
        };
      } catch (e2) {
        return { items: [], mode: 'none', degraded: `${e.message} | ${e2.message}` };
      }
    }
    return { items: [], mode: 'none', degraded: e.message };
  }
}

export async function testRerank(override = {}) {
  const t0 = Date.now();
  const r = await rerank(
    '人工智能的应用场景',
    ['人工智能在医疗影像诊断中广泛使用。', '今天天气很好，适合出游。', '大模型可用于智能客服与知识问答。'],
    { topN: 3, ...override },
  );
  return { ...r, latencyMs: Date.now() - t0 };
}
