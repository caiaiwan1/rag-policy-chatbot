/**
 * 本地 Mock 服务：在没有真实 API Key 的情况下，完整跑通 RAG 全链路。
 * 提供 OpenAI 兼容的 /v1/embeddings、/v1/chat/completions、/v1/rerank、/v1/models
 *
 * 向量不是随机噪声：采用「词袋哈希向量」——相同词汇贡献相同方向，
 * 因此文本重叠越多，余弦相似度越高，检索/重排行为与真实模型趋势一致，可用于调参验证。
 *
 * 启动： node tools/mock-server.js  （默认端口 5199）
 */
import http from 'node:http';

const PORT = process.env.MOCK_PORT || 5199;
const DIM = Number(process.env.MOCK_DIM || 1024);

function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 词 → 固定的 d 个分量（伪随机但确定） */
function wordVector(word) {
  const v = new Array(DIM).fill(0);
  const base = hash32(word);
  for (let k = 0; k < 12; k++) {
    const h = hash32(`${word}#${k}`);
    const idx = h % DIM;
    const sign = ((h >>> 8) & 1) ? 1 : -1;
    v[idx] += sign * (1 + ((base >>> k % 16) & 7) / 8);
  }
  return v;
}

function tokenize(text) {
  const t = (text || '').toLowerCase();
  const words = t.match(/[a-z0-9][a-z0-9_\-]*/g) || [];
  const cjk = t.match(/[\u3400-\u4dbf\u4e00-\u9fff]+/g) || [];
  const out = [...words];
  for (const run of cjk) {
    const ch = Array.from(run);
    for (const c of ch) out.push(c);
    for (let i = 0; i < ch.length - 1; i++) out.push(ch[i] + ch[i + 1]);
  }
  return out;
}

function embed(text) {
  const toks = tokenize(text);
  const v = new Array(DIM).fill(0);
  for (const w of toks) {
    const wv = wordVector(w);
    for (let i = 0; i < DIM; i++) v[i] += wv[i];
  }
  // L2 归一化
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => +(x / n).toFixed(6));
}

function cosine(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf-8');
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      /* noop */
    }
    const url = req.url.split('?')[0];
    const json = (obj, code = 200) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(obj));
    };

    if (url === '/v1/models' || url === '/models') {
      return json({
        object: 'list',
        data: [{ id: 'mock-llm-7b' }, { id: 'mock-embedding-1024' }, { id: 'mock-reranker' }],
      });
    }

    if (url.endsWith('/embeddings')) {
      const input = Array.isArray(body.input) ? body.input : [body.input ?? ''];
      const dim = Number(body.dimensions) || DIM;
      const data = input.map((t, i) => {
        const v = embed(t);
        return { object: 'embedding', index: i, embedding: v.slice(0, dim) };
      });
      return json({ object: 'list', model: body.model || 'mock-embedding', data, usage: { total_tokens: 1 } });
    }

    if (url.endsWith('/rerank')) {
      const docs = body.documents || body.input?.documents || [];
      const query = body.query || body.input?.query || '';
      const qv = embed(query);
      const results = docs.map((d, i) => ({
        index: i,
        // 不做饱和放大，保留分数区分度，便于验证阈值拒答
        relevance_score: +Math.max(0, Math.min(0.99, (cosine(qv, embed(d)) + 0.2) * 0.95)).toFixed(4),
      }));
      const topN = body.top_n || body.parameters?.top_n || results.length;
      return json({
        model: body.model || 'mock-reranker',
        results: results.sort((a, b) => b.relevance_score - a.relevance_score).slice(0, topN),
      });
    }

    if (url.endsWith('/chat/completions')) {
      const isStream = !!body.stream;
      const lastUser = [...(body.messages || [])].reverse().find((m) => m.role === 'user')?.content || '';
      const answer =
        `【Mock 模型回答】我已阅读你提供的参考资料。\n\n` +
        `针对「${String(lastUser).split('\n').pop().slice(0, 60)}」，` +
        `依据检索到的资料片段，结论如下 [1]：\n\n` +
        `- 资料中包含与问题相关的段落，可作为回答依据 [1]；\n` +
        `- 如需更精确的答案，建议缩小问题范围或补充文档。\n\n` +
        `（当前由本地 Mock 模型生成，未调用真实大模型。）`;

      if (!isStream) {
        return json({
          choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
          usage: { total_tokens: 88 },
        });
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      const id = 'mock';
      const pieces = answer.match(/[\s\S]{1,12}/g) || [];
      let i = 0;
      const timer = setInterval(() => {
        if (i >= pieces.length) {
          res.write(`data: ${JSON.stringify({ id, choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          clearInterval(timer);
          return;
        }
        res.write(`data: ${JSON.stringify({ id, choices: [{ delta: { content: pieces[i++] }, index: 0 }] })}\n\n`);
      }, 30);
      return;
    }

    json({ error: 'not found' }, 404);
  });
});

server.listen(PORT, () => {
  console.log(`  Mock 模型服务已启动 -> http://localhost:${PORT}  (embedding dim=${DIM})`);
  console.log(`  可用于无 Key 情况下的完整链路验证。\n`);
});
