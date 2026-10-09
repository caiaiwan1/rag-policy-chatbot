/**
 * 知识库：文档 + chunk + 向量，落盘 data/kb.json
 * 规模定位：个人/中小团队知识库（数千 chunk 量级），内存 + JSON 足够，无需额外数据库。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';
import { tokenizeForIndex, countTokens } from './tokenizer.js';
import { BM25 } from './retrieve.js';

const KB_FILE = path.join(DATA_DIR, 'kb.json');

let state = { docs: [], chunks: [] };
let bm25Index = null;
let bm25Dirty = true;
let saveTimer = null;

export function ensureKb() {
  try {
    state = JSON.parse(fs.readFileSync(KB_FILE, 'utf-8'));
    state.docs ||= [];
    state.chunks ||= [];
  } catch {
    state = { docs: [], chunks: [] };
  }
  bm25Dirty = true;
  return state;
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(KB_FILE, JSON.stringify(state), 'utf-8');
    saveTimer = null;
  }, 300);
}

export function saveNow() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(KB_FILE, JSON.stringify(state), 'utf-8');
}

export const newId = (p = 'id') => `${p}_${crypto.randomBytes(6).toString('hex')}`;

/* -------------------------------- 文档 -------------------------------- */
export function listDocs() {
  return state.docs.map((d) => ({ ...d, chunkCount: state.chunks.filter((c) => c.docId === d.id).length }));
}

export function addDoc({ name, size, ext, chars, path: filePath }) {
  const doc = {
    id: newId('doc'),
    name,
    size,
    ext,
    chars,
    tokens: 0,
    filePath,
    status: 'parsed',
    createdAt: new Date().toISOString(),
  };
  state.docs.push(doc);
  scheduleSave();
  return doc;
}

export function getDoc(id) {
  return state.docs.find((d) => d.id === id);
}

export function deleteDoc(id) {
  const doc = getDoc(id);
  if (doc?.filePath) {
    try {
      fs.unlinkSync(doc.filePath);
    } catch {
      /* 文件可能已不存在 */
    }
  }
  state.docs = state.docs.filter((d) => d.id !== id);
  state.chunks = state.chunks.filter((c) => c.docId !== id);
  bm25Dirty = true;
  scheduleSave();
}

/* -------------------------------- Chunk -------------------------------- */
export function replaceChunks(docId, chunks) {
  state.chunks = state.chunks.filter((c) => c.docId !== docId);
  const rows = chunks.map((c, i) => ({
    id: newId('ck'),
    docId,
    docName: getDoc(docId)?.name || '',
    index: i,
    text: c.text,
    tokens: c.tokens || countTokens(c.text),
    vector: c.vector || null,
    updatedAt: new Date().toISOString(),
  }));
  state.chunks.push(...rows);
  const doc = getDoc(docId);
  if (doc) {
    doc.chunkCount = rows.length;
    doc.status = rows.some((r) => r.vector) ? 'indexed' : 'chunked';
  }
  bm25Dirty = true;
  scheduleSave();
  return rows;
}

export function listChunks({ docId, offset = 0, limit = 50, keyword } = {}) {
  let rows = state.chunks.filter((c) => !docId || c.docId === docId);
  if (keyword) {
    const k = keyword.toLowerCase();
    rows = rows.filter((c) => c.text.toLowerCase().includes(k));
  }
  return { total: rows.length, rows: rows.slice(offset, offset + limit) };
}

export function updateChunk(id, text) {
  const c = state.chunks.find((x) => x.id === id);
  if (!c) return null;
  c.text = text;
  c.tokens = countTokens(text);
  c.vector = null; // 文本变更，向量失效需重建
  c.updatedAt = new Date().toISOString();
  bm25Dirty = true;
  scheduleSave();
  return c;
}

export function deleteChunk(id) {
  const before = state.chunks.length;
  state.chunks = state.chunks.filter((c) => c.id !== id);
  bm25Dirty = true;
  scheduleSave();
  return before !== state.chunks.length;
}

export function addManualChunk(docId, text) {
  const c = {
    id: newId('ck'),
    docId,
    docName: getDoc(docId)?.name || '手动新增',
    index: state.chunks.filter((x) => x.docId === docId).length,
    text,
    tokens: countTokens(text),
    vector: null,
    updatedAt: new Date().toISOString(),
  };
  state.chunks.push(c);
  bm25Dirty = true;
  scheduleSave();
  return c;
}

export function allChunks() {
  return state.chunks;
}

export function pendingChunks() {
  return state.chunks.filter((c) => !c.vector);
}

export function setVectors(pairs) {
  for (const { id, vector } of pairs) {
    const c = state.chunks.find((x) => x.id === id);
    if (c) c.vector = vector;
  }
  for (const d of state.docs) {
    const rows = state.chunks.filter((c) => c.docId === d.id);
    if (rows.length && rows.every((c) => c.vector)) d.status = 'indexed';
  }
  bm25Dirty = true;
  scheduleSave();
}

export function stats() {
  const indexed = state.chunks.filter((c) => c.vector).length;
  const dim = state.chunks.find((c) => c.vector)?.vector?.length || 0;
  return {
    docs: state.docs.length,
    chunks: state.chunks.length,
    indexed,
    pending: state.chunks.length - indexed,
    dim,
    tokens: state.chunks.reduce((a, c) => a + (c.tokens || 0), 0),
  };
}

export function getBm25() {
  if (bm25Dirty || !bm25Index) {
    bm25Index = new BM25(state.chunks.map((c) => tokenizeForIndex(c.text)));
    bm25Dirty = false;
  }
  return bm25Index;
}

export function clearKb() {
  state = { docs: [], chunks: [] };
  bm25Dirty = true;
  saveNow();
}
