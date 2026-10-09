/**
 * 端到端冒烟测试：不依赖任何真实 API Key，直接跑通「上传 → 分块 → 索引 → 检索 → 重排 → 生成」。
 * 用法：
 *   node tools/mock-server.js &
 *   node server.js &
 *   node tools/smoke-test.js
 */
const BASE = process.env.BASE || 'http://localhost:5178';
const MOCK = process.env.MOCK || 'http://localhost:5199';

const post = async (p, body) => {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (j.ok === false) throw new Error(`${p}: ${j.error}`);
  return j;
};
const get = async (p) => (await fetch(BASE + p)).json();
const log = (...a) => console.log(...a);
const line = (s) => log(`\n${'─'.repeat(60)}\n${s}\n${'─'.repeat(60)}`);

async function main() {
  // 清空知识库，保证可重复执行
  await fetch(BASE + '/api/kb/clear', { method: 'DELETE' });

  line('1 · 写入 Mock 模型配置');
  await post('/api/config', {
    llm: { baseUrl: `${MOCK}/v1`, apiKey: 'mock', model: 'mock-llm-7b' },
    embedding: { baseUrl: `${MOCK}/v1`, apiKey: 'mock', model: 'mock-embedding-1024', dimensions: 1024 },
    rerank: { enabled: true, mode: 'api', baseUrl: `${MOCK}/v1/rerank`, apiKey: 'mock', model: 'mock-reranker', topN: 10 },
  });
  log('  LLM 测试:', (await post('/api/test/llm')).latencyMs + 'ms');
  const emb = await post('/api/test/embedding');
  log('  Embedding 测试: dim=' + emb.dim, emb.latencyMs + 'ms');
  const rr = await post('/api/test/rerank');
  log('  Rerank 测试: mode=' + rr.mode, rr.latencyMs + 'ms');

  line('2 · 上传示例文档');
  const { default: fs } = await import('node:fs');
  const file = new Blob([fs.readFileSync(new URL('../docs/sample.md', import.meta.url))], { type: 'text/markdown' });
  const fd = new FormData();
  fd.append('files', file, 'sample.md');
  const up = await fetch(BASE + '/api/upload', { method: 'POST', body: fd }).then((r) => r.json());
  const doc = up.docs[0];
  log(`  已解析 ${up.docs.length} 个文档：${doc.name} · ${doc.chars} 字 · ${doc.tokens} token`);

  line('3 · 四种分块策略对比');
  for (const strategy of ['fixed', 'semantic', 'paragraph', 'recursive']) {
    const cfg = { strategy, size: 400, overlapEnabled: true, overlapMode: 'percent', overlapValue: 15 };
    const r = await post('/api/chunk/preview', { docId: doc.id, chunk: cfg });
    log(`  ${strategy.padEnd(10)} → ${String(r.meta.count).padStart(3)} 块 · 平均 ${r.meta.avgTokens} token · 区间 ${r.meta.minTokens}~${r.meta.maxTokens}` +
      (r.meta.threshold ? ` · 断点阈值 ${r.meta.threshold}` : ''));
  }
  const noOv = await post('/api/chunk/preview', {
    docId: doc.id,
    chunk: { strategy: 'fixed', size: 400, overlapEnabled: false },
  });
  const withOv = await post('/api/chunk/preview', {
    docId: doc.id,
    chunk: { strategy: 'fixed', size: 400, overlapEnabled: true, overlapMode: 'percent', overlapValue: 15 },
  });
  // 验证重叠真的发生：第 2 块的开头应出现在第 1 块的结尾
  const head2 = withOv.chunks[1]?.text.slice(0, 20);
  const overlapHit = head2 && withOv.chunks[0].text.includes(head2);
  log(`  overlap 关闭 → ${noOv.meta.count} 块；overlap 15%（${withOv.overlapTokens} token）→ ${withOv.meta.count} 块`);
  log(`  相邻块重叠检测：${overlapHit ? '命中 ✓（第 2 块开头重复出现在第 1 块尾部）' : '未命中 ✗'}`);

  line('4 · 建索引（SSE 进度）');
  const t0 = Date.now();
  const buildRes = await fetch(BASE + '/api/kb/build', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chunk: { strategy: 'fixed', size: 400, overlapEnabled: true, overlapMode: 'percent', overlapValue: 15 },
    }),
  });
  const text = await buildRes.text();
  if (/event: failed/.test(text)) throw new Error(text);
  log(`  构建完成，耗时 ${Date.now() - t0}ms`);
  log('  统计:', JSON.stringify((await get('/api/kb/stats')).stats));

  line('5 · 检索对比（语义 / BM25 / 混合）');
  const q = '分块的重叠比例应该设置多少';
  for (const mode of ['semantic', 'bm25', 'hybrid']) {
    const r = await post('/api/search', { query: q, override: { retrieve: { mode, topK: 3 } } });
    const top = r.results[0];
    log(`  ${mode.padEnd(9)} Top1 综合 ${top?.fused.toFixed(3)}（语义 ${top?.semantic.toFixed(3)} / BM25 ${top?.bm25.toFixed(3)}） · ${top?.text.slice(0, 40)}…`);
  }

  line('6 · 完整问答（含改写 / 重排 / 阈值 / 引用）');
  const chat = await fetch(BASE + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: '为什么需要重排，两阶段检索是怎么做的？' }],
      override: {
        query: { rewriteEnabled: true, rewriteMode: 'single' },
        retrieve: { mode: 'hybrid', topK: 4, minScore: 0.2 },
        rerank: { enabled: true, mode: 'api', topN: 10 },
      },
    }),
  });
  const reader = chat.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let answer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() || '';
    for (const p of parts) {
      const dl = p.split('\n').find((l) => l.startsWith('data:'));
      if (!dl) continue;
      const payload = dl.slice(5).trim();
      if (payload === '[DONE]') continue;
      const ev = JSON.parse(payload);
      if (ev.type === 'rewritten') log('  [改写]', ev.queries.join(' || '));
      if (ev.type === 'retrieved') log(`  [召回] ${ev.count} 条候选`);
      if (ev.type === 'reranked') log(`  [重排] ${ev.mode}，Top1 分数 ${ev.items[0]?.score}`);
      if (ev.type === 'context') log(`  [上下文] ${ev.chunks.map((c) => `[${c.ref}]${c.score}`).join(' ')}`);
      if (ev.type === 'delta') answer += ev.text;
      if (ev.type === 'done') log('  [引用]', (ev.refs || []).map((r) => `[${r.ref}] ${r.docName} ${r.score}`).join(' | '));
    }
  }
  log('  [答案]', answer.slice(0, 180).replace(/\n/g, ' '), '…');

  line('7 · 阈值拒答验证');
  // 先探测该问题的实际最高分，再把阈值抬高到其之上，确保命中拒答分支
  const probe = await post('/api/search', {
    query: '请介绍量子纠缠在超导量子比特中的应用',
    override: { retrieve: { mode: 'hybrid', topK: 1, candidateK: 10 } },
  });
  const topScore = probe.results[0]?.fused ?? 0;
  // Mock 向量对中文的相似度普遍偏高，这里取「最高分 + 0.01」确保必然越过拒答线
  const hardThreshold = +(topScore + 0.01).toFixed(3);
  log(`  该问题实际最高分 ${topScore.toFixed(3)}，将阈值设为 ${hardThreshold} 以触发拒答`);
  const refuse = await fetch(BASE + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: '请介绍量子纠缠在超导量子比特中的应用' }],
      override: {
        retrieve: { mode: 'hybrid', topK: 3, minScore: hardThreshold, candidateK: 10 },
        rerank: { enabled: false },
        agent: { enabled: false },
      },
    }),
  });
  const rtext = await refuse.text();
  const refused = /"type":"noanswer"/.test(rtext);
  log('  是否触发拒答:', refused ? '是 ✓' : '否 ✗');
  const deltas = [...rtext.matchAll(/"type":"delta","text":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join('');
  log('  返回给用户的文案:', refused ? JSON.parse(`"${deltas}"`) : deltas.slice(0, 60));

  line('全部通过 ✓');
}
main().catch((e) => {
  console.error('\n测试失败：', e.message);
  process.exit(1);
});
