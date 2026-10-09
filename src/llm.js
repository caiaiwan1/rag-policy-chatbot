/**
 * OpenAI 兼容聊天客户端（DeepSeek / 通义 / Moonshot / 智谱 / OpenAI / 本地 Ollama-v1 等）
 */
import { loadConfig } from './config.js';

function endpoint(baseUrl) {
  const b = (baseUrl || '').replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(b)) return b;
  return `${b}/chat/completions`;
}

function headers(apiKey) {
  const h = { 'Content-Type': 'application/json' };
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  return h;
}

export async function chatComplete(messages, override = {}) {
  const cfg = loadConfig().llm;
  const baseUrl = override.baseUrl || cfg.baseUrl;
  const apiKey = override.apiKey || cfg.apiKey;
  const model = override.model || cfg.model;
  if (!apiKey) throw new Error('未配置 LLM API Key');
  if (!baseUrl) throw new Error('未配置 LLM Base URL');

  const body = {
    model,
    messages,
    temperature: override.temperature ?? cfg.temperature ?? 0.2,
    max_tokens: override.maxTokens ?? cfg.maxTokens ?? 2048,
    stream: false,
  };
  if (override.jsonMode) body.response_format = { type: 'json_object' };

  const res = await fetch(endpoint(baseUrl), {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`LLM ${res.status}: ${text.slice(0, 400)}`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`LLM 返回非 JSON: ${text.slice(0, 200)}`);
  }
  const content = json?.choices?.[0]?.message?.content ?? '';
  return { content: typeof content === 'string' ? content : JSON.stringify(content), raw: json };
}

/** 流式输出：async generator，逐块产出 text delta */
export async function* chatStream(messages, override = {}) {
  const cfg = loadConfig().llm;
  const baseUrl = override.baseUrl || cfg.baseUrl;
  const apiKey = override.apiKey || cfg.apiKey;
  const model = override.model || cfg.model;
  if (!apiKey) throw new Error('未配置 LLM API Key');

  const body = {
    model,
    messages,
    temperature: override.temperature ?? cfg.temperature ?? 0.2,
    max_tokens: override.maxTokens ?? cfg.maxTokens ?? 2048,
    stream: true,
  };

  const res = await fetch(endpoint(baseUrl), {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`LLM 流式 ${res.status}: ${t.slice(0, 400)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const json = JSON.parse(payload);
        const delta = json?.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        /* 忽略心跳/脏行 */
      }
    }
  }
}

/** 拉取模型列表（/v1/models），失败返回 null */
export async function listModels(type = 'llm') {
  const c = loadConfig();
  const cfg = type === 'llm' ? c.llm : c.embedding;
  if (!cfg.apiKey || !cfg.baseUrl) return null;
  const base = cfg.baseUrl.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  try {
    const res = await fetch(`${base}/models`, { headers: headers(cfg.apiKey) });
    if (!res.ok) return null;
    const json = await res.json();
    const arr = json?.data || json?.models || [];
    return arr.map((m) => m.id || m.model || m.name).filter(Boolean);
  } catch {
    return null;
  }
}
