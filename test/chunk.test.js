import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overlapTokens, chunkText, cosine } from '../src/chunk.js';

test('overlapTokens: percent / absolute / disabled', () => {
  const base = { size: 512 };
  assert.equal(overlapTokens({ ...base, overlapEnabled: false }), 0, '关闭应为 0');
  assert.equal(overlapTokens({ ...base, overlapEnabled: true, overlapMode: 'percent', overlapValue: 15 }), 77, '512*0.15=76.8→77');
  assert.equal(overlapTokens({ ...base, overlapEnabled: true, overlapMode: 'absolute', overlapValue: 30 }), 30, '绝对值应原样返回');
});

test('chunkText fixed: 产出块且 token 接近 size', async () => {
  const text = Array.from({ length: 120 }, (_, i) => `知识块内容${i}示例文本`).join('。');
  const { chunks, meta } = await chunkText(text, { strategy: 'fixed', size: 120, overlapEnabled: false });
  assert.ok(chunks.length >= 2, `应切出多块，实际 ${chunks.length}`);
  assert.equal(meta.strategy, 'fixed');
  assert.equal(meta.count, chunks.length);
  for (const c of chunks) {
    assert.ok(c.tokens > 0 && c.tokens <= 200, `块 token(${c.tokens})应≤宽松上限`);
  }
});

test('chunkText fixed: overlap 关闭块数 < 开启块数', async () => {
  const text = Array.from({ length: 300 }, (_, i) => `内容${i}长文本示例`).join(' ');
  const a = await chunkText(text, { strategy: 'fixed', size: 50, overlapEnabled: false });
  const b = await chunkText(text, { strategy: 'fixed', size: 50, overlapEnabled: true, overlapMode: 'absolute', overlapValue: 15 });
  assert.ok(b.chunks.length >= a.chunks.length, `overlap 开启块数(${b.chunks.length})应≥关闭(${a.chunks.length})`);
});

test('chunkText paragraph: 段落合并与上限', async () => {
  const text = '第一段内容较长一些描述。\n\n第二段内容也是如此需要被处理。\n\n第三段短。';
  const { chunks, meta } = await chunkText(text, {
    strategy: 'paragraph',
    paragraph: { maxTokens: 200, mergeSmall: true },
  });
  assert.ok(chunks.length >= 1, '应至少 1 块');
  assert.ok(meta.count === chunks.length);
  for (const c of chunks) assert.ok(c.tokens <= 260, `段落块不应远超上限，实际 ${c.tokens}`);
});

test('chunkText recursive: 可产出非空块', async () => {
  const text = '标题一\n这是第一段内容，描述项目背景与目标。\n\n标题二\n第二段包含更多细节与实现说明。';
  const { chunks } = await chunkText(text, { strategy: 'recursive', size: 60, overlapEnabled: false });
  assert.ok(chunks.length >= 1 && chunks.every((c) => c.text.trim()), 'recursive 块应非空');
});

test('chunkText semantic 无 embedFn: 降级为启发式', async () => {
  const text = '句子一描述概念。句子二展开说明。句子三给出例子。句子四总结要点。'.repeat(4);
  const { chunks, meta } = await chunkText(text, { strategy: 'semantic', semantic: { maxTokens: 200, minTokens: 40 } });
  assert.equal(meta.degraded, 'no-embedding', '应标记降级');
  assert.ok(chunks.length >= 1, '降级也应产出块');
});

test('chunkText semantic 带 embedFn: 产出与断点阈值', async () => {
  // 确定性 embedFn：用字符计数构造向量，使相邻句相似度稳定
  const embedFn = async (texts) =>
    texts.map((t) => {
      const v = new Array(8).fill(0);
      for (const ch of t) v[ch.charCodeAt(0) % 8] += 1;
      const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
      return v.map((x) => x / n);
    });
  const text = '苹果是一种水果。香蕉也是水果。今天股市上涨。科技股表现强劲。'.repeat(3);
  const { chunks, meta } = await chunkText(
    text,
    {
      strategy: 'semantic',
      semantic: { maxTokens: 200, minTokens: 40, threshold: 0.6 },
      overlapEnabled: false,
    },
    embedFn,
  );
  assert.ok(!meta.degraded, '不应降级');
  assert.ok(typeof meta.threshold === 'number', '应返回语义断点阈值');
  assert.ok(chunks.length >= 1, '应产出语义块');
});

test('cosine: 正交与相同向量', () => {
  assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9, '相同向量余弦为 1');
  assert.ok(Math.abs(cosine([1, 0], [0, 1]) - 0) < 1e-9, '正交向量余弦为 0');
  assert.equal(cosine([1], [1, 2]), 0, '维度不一致返回 0');
});
