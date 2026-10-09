import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { loadConfig, saveConfig, resetConfig, publicConfig, DATA_DIR } from './src/config.js';
import { extractText, normalizeText, isSupported, SUPPORTED_EXT } from './src/parsers.js';
import { chunkText, overlapTokens } from './src/chunk.js';
import { embedTexts, testEmbedding } from './src/embed.js';
import { testRerank } from './src/rerank.js';
import { chatComplete, listModels } from './src/llm.js';
import { runRag, searchOnly, rewriteOnly } from './src/rag.js';
import { countTokens } from './src/tokenizer.js';
import * as kb from './src/kb.js';

const app = express();
const PORT = process.env.PORT || 5178;
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const TEXT_DIR = path.join(DATA_DIR, 'texts');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(TEXT_DIR, { recursive: true });

app.use(express.json({ limit: '30mb' }));
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const safe = Buffer.from(file.originalname, 'latin1').toString('utf8').replace(/[^\w.\u4e00-\u9fa5-]/g, '_');
      cb(null, `${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${safe}`);
    },
  }),
  limits: { fileSize: 30 * 1024 * 1024 },
});

const textPath = (docId) => path.join(TEXT_DIR, `${docId}.txt`);
const ok = (res, data) => res.json({ ok: true, ...data });
const fail = (res, e, code = 400) => res.status(code).json({ ok: false, error: e.message || String(e) });

/* ------------------------------- 配置 ------------------------------- */
app.get('/api/config', (req, res) => ok(res, { config: publicConfig(), ext: SUPPORTED_EXT }));
app.post('/api/config', (req, res) => {
  try {
    ok(res, { config: publicConfigOf(saveConfig(req.body || {})) });
  } catch (e) {
    fail(res, e);
  }
});
function publicConfigOf() {
  return publicConfig();
}
app.post('/api/config/reset', (req, res) => ok(res, { config: publicConfigOf(resetConfig()) }));

app.post('/api/test/llm', async (req, res) => {
  try {
    const t0 = Date.now();
    const { content } = await chatComplete(
      [{ role: 'user', content: '请用一句话说明你是谁，并输出"OK"。' }],
      req.body || {},
    );
    ok(res, { text: content.slice(0, 200), latencyMs: Date.now() - t0 });
  } catch (e) {
    fail(res, e);
  }
});
app.post('/api/test/embedding', async (req, res) => {
  try {
    ok(res, await testEmbedding(req.body || {}));
  } catch (e) {
    fail(res, e);
  }
});
app.post('/api/test/rerank', async (req, res) => {
  try {
    ok(res, await testRerank(req.body || {}));
  } catch (e) {
    fail(res, e);
  }
});
app.get('/api/models', async (req, res) => {
  try {
    const models = await listModels(req.query.type === 'embedding' ? 'embedding' : 'llm');
    ok(res, { models: models || [] });
  } catch (e) {
    fail(res, e);
  }
});

/* ------------------------------- 文档 ------------------------------- */
app.post('/api/upload', upload.array('files', 20), async (req, res) => {
  try {
    const created = [];
    for (const f of req.files || []) {
      if (!isSupported(f.originalname)) {
        fs.unlinkSync(f.path);
        continue;
      }
      const raw = await extractText(f.path, f.originalname);
      const text = normalizeText(raw);
      const doc = kb.addDoc({
        name: Buffer.from(f.originalname, 'latin1').toString('utf8'),
        size: f.size,
        ext: path.extname(f.originalname).toLowerCase(),
        chars: text.length,
        path: f.path,
      });
      doc.tokens = countTokens(text);
      fs.writeFileSync(textPath(doc.id), text, 'utf-8');
      created.push({ ...doc, tokens: doc.tokens, preview: text.slice(0, 500) });
    }
    kb.saveNow();
    ok(res, { docs: created });
  } catch (e) {
    fail(res, e, 500);
  }
});

app.get('/api/docs', (req, res) => ok(res, { docs: kb.listDocs() }));
app.get('/api/docs/:id/text', (req, res) => {
  try {
    const t = fs.readFileSync(textPath(req.params.id), 'utf-8');
    ok(res, { text: t.slice(0, Number(req.query.limit) || 20000), total: t.length });
  } catch (e) {
    fail(res, e, 404);
  }
});
app.delete('/api/docs/:id', (req, res) => {
  try {
    kb.deleteDoc(req.params.id);
    try {
      fs.unlinkSync(textPath(req.params.id));
    } catch {
      /* 可能不存在 */
    }
    ok(res, {});
  } catch (e) {
    fail(res, e);
  }
});

/* ----------------------------- 分块预览 ----------------------------- */
app.post('/api/chunk/preview', async (req, res) => {
  try {
    const { docId, text: inlineText, chunk: chunkCfg } = req.body || {};
    let text = inlineText;
    if (docId && !text) text = fs.readFileSync(textPath(docId), 'utf-8');
    if (!text) return fail(res, new Error('缺少文本内容'));
    const cfg = chunkCfg || loadConfig().chunk;
    const embedFn =
      cfg.strategy === 'semantic'
        ? async (arr) => embedTexts(arr, req.body?.embedding || {})
        : undefined;
    const { chunks, meta } = await chunkText(text, cfg, embedFn);
    ok(res, { chunks: chunks.slice(0, 200), meta, overlapTokens: overlapTokens(cfg) });
  } catch (e) {
    fail(res, e, 500);
  }
});

/* --------------------------- 建库（SSE进度） --------------------------- */
app.post('/api/kb/build', async (req, res) => {
  const { docIds, chunk: chunkCfg, embedding } = req.body || {};
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const cfg = chunkCfg || loadConfig().chunk;
    const ids = docIds?.length ? docIds : kb.listDocs().map((d) => d.id);
    let done = 0;
    for (const id of ids) {
      const doc = kb.getDoc(id);
      if (!doc) continue;
      send('progress', { docId: id, name: doc.name, stage: 'chunk', done, total: ids.length });
      let text = '';
      try {
        text = fs.readFileSync(textPath(id), 'utf-8');
      } catch {
        text = normalizeText(await extractText(doc.filePath, doc.name));
      }
      const embedFn = cfg.strategy === 'semantic' ? async (arr) => embedTexts(arr, embedding || {}) : undefined;
      const { chunks, meta } = await chunkText(text, cfg, embedFn);
      send('progress', { docId: id, name: doc.name, stage: 'chunked', chunks: chunks.length, meta });

      // 批量向量化
      const bs = Math.max(1, Number(embedding?.batchSize || loadConfig().embedding.batchSize) || 16);
      for (let i = 0; i < chunks.length; i += bs) {
        const batch = chunks.slice(i, i + bs);
        const vecs = await embedTexts(batch.map((c) => c.text), embedding || {});
        batch.forEach((c, k) => (c.vector = vecs[k]));
        send('progress', { docId: id, name: doc.name, stage: 'embedding', done: i + batch.length, total: chunks.length });
      }
      kb.replaceChunks(id, chunks);
      done++;
      send('progress', { docId: id, name: doc.name, stage: 'done', done, total: ids.length });
    }
    kb.saveNow();
    send('finished', { stats: kb.stats() });
  } catch (e) {
    send('failed', { error: e.message });
  }
  res.end();
});

/* ------------------------------ Chunk 管理 ------------------------------ */
app.get('/api/kb/chunks', (req, res) => {
  const { docId, offset = 0, limit = 50, keyword = '' } = req.query;
  const r = kb.listChunks({ docId, offset: Number(offset), limit: Number(limit), keyword });
  ok(res, { ...r, rows: r.rows.map((c) => ({ ...c, hasVector: !!c.vector })) });
});
app.post('/api/kb/chunk', (req, res) => {
  try {
    ok(res, { chunk: kb.addManualChunk(req.body.docId, req.body.text || '') });
  } catch (e) {
    fail(res, e);
  }
});
app.patch('/api/kb/chunk/:id', (req, res) => {
  try {
    const c = kb.updateChunk(req.params.id, req.body.text || '');
    if (!c) return fail(res, new Error('chunk 不存在'), 404);
    ok(res, { chunk: { ...c, hasVector: !!c.vector } });
  } catch (e) {
    fail(res, e);
  }
});
app.delete('/api/kb/chunk/:id', (req, res) => ok(res, { deleted: kb.deleteChunk(req.params.id) }));

app.post('/api/kb/index', async (req, res) => {
  try {
    const pending = kb.pendingChunks();
    if (!pending.length) return ok(res, { indexed: 0 });
    const bs = Math.max(1, Number(loadConfig().embedding.batchSize) || 16);
    for (let i = 0; i < pending.length; i += bs) {
      const batch = pending.slice(i, i + bs);
      const vecs = await embedTexts(batch.map((c) => c.text), req.body?.embedding || {});
      kb.setVectors(batch.map((c, k) => ({ id: c.id, vector: vecs[k] })));
    }
    kb.saveNow();
    ok(res, { indexed: pending.length, stats: kb.stats() });
  } catch (e) {
    fail(res, e, 500);
  }
});

app.get('/api/kb/stats', (req, res) => ok(res, { stats: kb.stats() }));
app.delete('/api/kb/clear', (req, res) => {
  kb.clearKb();
  ok(res, {});
});

/* ------------------------------ 检索 / 问答 ------------------------------ */
app.post('/api/search', async (req, res) => {
  try {
    const { query, override } = req.body || {};
    ok(res, { results: await searchOnly(query, override || {}) });
  } catch (e) {
    fail(res, e, 500);
  }
});

app.post('/api/chat', async (req, res) => {
  const { messages = [], override = {} } = req.body || {};
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  try {
    for await (const ev of runRag({ messages, override })) send(ev);
  } catch (e) {
    send({ type: 'error', message: e.message });
  }
  res.write('data: [DONE]\n\n');
  res.end();
});

app.post('/api/rewrite', async (req, res) => {
  try {
    const { messages = [], query: qCfg, history = [] } = req.body || {};
    const r = await rewriteOnly(messages, { ...(qCfg || {}), rewriteEnabled: true }, history);
    ok(res, r);
  } catch (e) {
    fail(res, e, 500);
  }
});

/* ------------------------------- 静态 ------------------------------- */
app.use(express.static(path.resolve(process.cwd(), 'public')));
app.get('/health', (req, res) => res.json({ ok: true }));

kb.ensureKb();
app.listen(PORT, () => {
  console.log(`\n  RAG Agent Studio 已启动  ->  http://localhost:${PORT}`);
  console.log(`  数据目录: ${DATA_DIR}\n`);
});
