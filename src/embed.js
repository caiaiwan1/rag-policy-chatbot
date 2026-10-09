/**
 * Embedding 客户端（OpenAI /v1/embeddings 兼容协议）
 * 覆盖：OpenAI、SiliconFlow(BGE-M3)、DashScope 兼容模式、Ollama、Xinference、本地 TEI 等
 */
import { loadConfig } from './config.js';

function endpoint(baseUrl) {
  const b = (baseUrl || '').replace(/\/+$/, '');
  if (/\/embeddings$/.test(b)) return b;
  return `${b}/embeddings`;
}

function normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (!n) return v;
  return v.map((x) => x / n);
}

/**
 * @param {string[]} texts
 * @param {object} override 可覆盖配置（baseUrl/apiKey/model/dimensions）
 * @returns {Promise<number[][]>} 与输入顺序一致
 */
export async function embedTexts(texts, override = {}) {
  const cfg = loadConfig().embedding;
  const baseUrl = override.baseUrl || cfg.baseUrl;
  const apiKey = override.apiKey || cfg.apiKey;
  const model = override.model || cfg.model;
  if (!apiKey) throw new Error('未配置 Embedding API Key');
  if (!baseUrl) throw new Error('未配置 Embedding Base URL');
  if (!model) throw new Error('未配置 Embedding 模型');

  const batchSize = Math.max(1, Number(override.batchSize || cfg.batchSize) || 16);
  const dims = Number(override.dimensions ?? cfg.dimensions) || 0;
  const doNormalize = override.normalize ?? cfg.normalize ?? true;

  const out = new Array(texts.length);
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const body = { model, input: batch.map((t) => (t == null ? '' : String(t))) };
    if (dims > 0) body.dimensions = dims;
    const res = await fetch(endpoint(baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Embedding ${res.status}: ${text.slice(0, 300)}`);
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Embedding 返回非 JSON: ${text.slice(0, 200)}`);
    }
    const rows = json.data || json.output?.embeddings || json.embeddings;
    if (!Array.isArray(rows)) throw new Error(`Embedding 响应格式异常: ${text.slice(0, 200)}`);
    const sorted = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    sorted.forEach((r, k) => {
      const v = r.embedding || r.embeddings || r.values;
      out[i + k] = doNormalize ? normalize(v) : v;
    });
  }
  return out;
}

/** 单条快捷方式 */
export async function embedOne(text, override = {}) {
  const [v] = await embedTexts([text], override);
  return v;
}

/** 连通性测试：返回维度与耗时 */
export async function testEmbedding(override = {}) {
  const t0 = Date.now();
  const v = await embedOne('hello 世界', override);
  return { ok: true, dim: Array.isArray(v) ? v.length : 0, latencyMs: Date.now() - t0 };
}
