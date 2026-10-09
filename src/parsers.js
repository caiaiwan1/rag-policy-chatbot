/**
 * 文档解析：txt / md / markdown / csv / json / html / pdf / docx
 * 统一输出纯文本，再交给 chunk 模块处理。
 */
import fs from 'node:fs';
import path from 'node:path';

export const SUPPORTED_EXT = ['.txt', '.md', '.markdown', '.csv', '.json', '.html', '.htm', '.pdf', '.docx'];

export function isSupported(filename) {
  return SUPPORTED_EXT.includes(path.extname(filename || '').toLowerCase());
}

async function parsePdf(buf) {
  const mod = await import('pdf-parse');
  const pdfParse = mod.default || mod;
  const data = await pdfParse(buf);
  return data.text || '';
}

async function parseDocx(buf) {
  const mammoth = await import('mammoth');
  const res = await mammoth.extractRawText({ buffer: buf });
  return res.value || '';
}

function parseHtml(text) {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return '';
  const rows = lines.map((l) => l.split(',').map((c) => c.replace(/^"|"$/g, '').trim()));
  const header = rows[0];
  // 有表头时输出成 "字段: 值" 的行，语义更完整，利于检索
  return rows
    .slice(1)
    .map((r) => (header.length === r.length ? header.map((h, i) => `${h}: ${r[i]}`).join(' | ') : r.join(' | ')))
    .join('\n');
}

function parseJson(text) {
  try {
    const obj = JSON.parse(text);
    return typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  } catch {
    return text;
  }
}

export async function extractText(filePath, originalName) {
  const ext = path.extname(originalName || filePath).toLowerCase();
  const buf = await fs.promises.readFile(filePath);
  switch (ext) {
    case '.pdf':
      return (await parsePdf(buf)).trim();
    case '.docx':
      return (await parseDocx(buf)).trim();
    case '.html':
    case '.htm':
      return parseHtml(buf.toString('utf-8'));
    case '.csv':
      return parseCsv(buf.toString('utf-8'));
    case '.json':
      return parseJson(buf.toString('utf-8'));
    default:
      return buf.toString('utf-8').trim();
  }
}

/** 归一化：去多余空行、行尾空格、控制字符 */
export function normalizeText(text) {
  return (text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
