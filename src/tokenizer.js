/**
 * 轻量 tokenizer：不依赖 wasm / 外部服务，采用业界通用的启发式估算。
 * - CJK 字符：约 1 token/字（cl100k 常见汉字 1~1.5，取 1 保守）
 * - 其它字符（英文/数字/符号）：约 4 字符 = 1 token
 * 目的：保证「按 token 切块 / overlap」的粒度稳定可控，不是计费口径。
 */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\uf900-\ufaff]/;

/** 单字符估算权重 */
function charWeight(ch) {
  if (CJK.test(ch)) return 1;
  if (ch === ' ' || ch === '\n' || ch === '\t') return 0.2;
  return 0.25;
}

/** 估算整段文本 token 数 */
export function countTokens(text) {
  if (!text) return 0;
  let n = 0;
  for (const ch of text) n += charWeight(ch);
  return Math.max(0, Math.round(n));
}

/**
 * 把文本切成「不可再分的单元」：CJK 单字 / 英文单词 / 数字 / 标点 / 空白
 * 切块时只在单元边界断开，避免把一个英文单词劈成两半。
 */
export function toUnits(text) {
  const units = [];
  const re = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\uf900-\ufaff]|[A-Za-z]+|[0-9]+(?:\.[0-9]+)?|\s+|[^\s]/g;
  const matches = text.match(re);
  if (!matches) return units;
  for (const m of matches) {
    let w = 0;
    for (const ch of m) w += charWeight(ch);
    units.push({ t: m, w });
  }
  return units;
}

/**
 * 按 token 滑窗切块（fixed 策略核心）
 * @param {string} text
 * @param {number} size      每块目标 token
 * @param {number} overlap   重叠 token
 */
export function sliceByTokens(text, size, overlap = 0) {
  const units = toUnits(text);
  const chunks = [];
  if (!units.length) return chunks;

  let start = 0;
  let acc = 0;
  let buf = [];
  const push = (from) => {
    const s = buf.map((u) => u.t).join('').trim();
    if (s) chunks.push({ text: s, tokens: countTokens(s), fromUnit: from });
  };

  for (let i = 0; i < units.length; i++) {
    buf.push(units[i]);
    acc += units[i].w;
    if (acc >= size) {
      push(start);
      if (overlap > 0) {
        // 计算下一块的起点：回退 overlap 个 token 的单元
        let back = 0;
        let j = buf.length - 1;
        while (j > 0 && back < overlap) {
          back += buf[j].w;
          j--;
        }
        const keepCount = Math.max(1, buf.length - 1 - j);
        const carried = buf.slice(buf.length - keepCount);
        start = i + 1 - carried.length;
        buf = carried;
        acc = carried.reduce((a, u) => a + u.w, 0);
      } else {
        // overlap 关闭：不回退，下一块从当前单元之后开始（严格无重叠）
        start = i + 1;
        buf = [];
        acc = 0;
      }
    }
  }
  if (buf.length) push(start);
  return chunks;
}

/**
 * 句子切分：支持中英文标点、引号闭合、换行。
 */
export function splitSentences(text) {
  const cleaned = text.replace(/\r\n?/g, '\n');
  const raw = cleaned.match(/[^。！？!?；;\n]+[。！？!?；;]?["'”’）)]*|\n+/g);
  if (!raw) return [];
  const out = [];
  let buf = '';
  for (const s of raw) {
    if (/^\n+$/.test(s)) {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += s;
    // 句子过长（> 400 token）也强制断开，避免块体失控
    if (countTokens(buf) > 400 || /[。！？!?；;]["'”’）)]*$/.test(buf)) {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

/** 段落切分：空行分隔，兼容单换行密集文本 */
export function splitParagraphs(text) {
  const normalized = text.replace(/\r\n?/g, '\n');
  let parts = normalized.split(/\n\s*\n/);
  if (parts.length <= 1) parts = normalized.split(/\n/);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** 中文/英文混合分词，用于 BM25 */
export function tokenizeForIndex(text) {
  const lower = (text || '').toLowerCase();
  const out = [];
  // 英文/数字词
  const words = lower.match(/[a-z0-9][a-z0-9_\-\.]{0,30}/g) || [];
  out.push(...words);
  // CJK：单字 + 二元组，兼顾召回与精度
  const cjkRuns = lower.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\uf900-\ufaff]+/g) || [];
  for (const run of cjkRuns) {
    const chars = Array.from(run);
    for (const c of chars) out.push(c);
    for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1]);
  }
  return out;
}
