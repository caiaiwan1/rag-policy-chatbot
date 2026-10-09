import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BM25, retrieve, normalizeCandidates } from '../src/retrieve.js';
import { tokenizeForIndex } from '../src/tokenizer.js';

const chunks = [
  { id: 'c0', text: '机器学习是人工智能的一个分支', vector: [1, 0, 0, 0] },
  { id: 'c1', text: '深度学习使用神经网络进行建模', vector: [0, 1, 0, 0] },
  { id: 'c2', text: '向量检索通过余弦相似度匹配语义', vector: [0, 0, 1, 0] },
  { id: 'c3', text: '无关内容：今天天气晴朗适合出游', vector: [0, 0, 0, 1] },
];

test('BM25: 含查询词的文档得分更高', () => {
  const docs = ['机器学习模型训练', '今天天气晴朗', '机器学习与深度学习'];
  const bm = new BM25(docs.map(tokenizeForIndex));
  const scores = bm.scoresNormalized(tokenizeForIndex('机器学习'));
  assert.ok(scores[0] > 0 && scores[2] > 0, '含关键词文档应得正分');
  assert.equal(scores[1], 0, '不含关键词文档应为 0');
  assert.ok(scores[2] >= scores[0], '关键词出现两次的文档不应低于一次');
});

test('retrieve semantic: 向量最相似者排第一', () => {
  const queryVector = [0, 0, 1, 0]; // 与 c2 完全一致
  const cand = retrieve({ query: '语义检索', queryVector, chunks, cfg: { mode: 'semantic', candidateK: 4 } });
  assert.equal(cand[0].chunkIndex, 2, '最相似块应排第一');
  assert.ok(cand[0].semantic > cand[1].semantic, '语义分应降序');
});

test('retrieve hybrid RRF: 融合排序且包含两路信号', () => {
  const queryVector = [0, 0, 1, 0];
  const bm = new BM25(chunks.map((c) => c.text.split('')));
  const cand = retrieve({ query: '向量检索语义', queryVector, chunks, bm25: bm, cfg: { mode: 'hybrid', fusion: 'rrf', rrfK: 60, candidateK: 4 } });
  assert.ok(cand.length === 4);
  assert.ok(cand[0].fused > cand[cand.length - 1].fused, '融合分应降序');
  // 同时有语义与 bm25 信号
  assert.ok(cand.some((c) => c.semantic > 0));
});

test('retrieve weighted: 加权融合', () => {
  const queryVector = [0, 0, 1, 0];
  const bm = new BM25(chunks.map((c) => c.text.split('')));
  const cand = retrieve({ query: '检索', queryVector, chunks, bm25: bm, cfg: { mode: 'hybrid', fusion: 'weighted', weightSemantic: 0.7, weightBm25: 0.3, candidateK: 4 } });
  assert.ok(cand.length === 4);
  assert.ok(cand[0].fused > cand[cand.length - 1].fused);
});

test('normalizeCandidates: RRF 归一化保持区分度（不恒为 1）', () => {
  const cfg = { mode: 'hybrid', fusion: 'rrf', rrfK: 60 };
  const cand = [
    { chunkIndex: 0, fused: 0.03 },
    { chunkIndex: 1, fused: 0.01 },
  ];
  const norm = normalizeCandidates(cand, cfg);
  assert.ok(norm[0].fusedNorm < 1, '第一名不应恒为 1');
  assert.ok(norm[0].fusedNorm > norm[1].fusedNorm, '应保持排序区分度');
  assert.ok(norm.every((c) => c.fusedNorm >= 0 && c.fusedNorm <= 1), '应在 0~1');
});

test('normalizeCandidates: 加权模式原值截取 0~1', () => {
  const cfg = { mode: 'hybrid', fusion: 'weighted' };
  const cand = [{ chunkIndex: 0, fused: 0.85 }, { chunkIndex: 1, fused: 1.2 }];
  const norm = normalizeCandidates(cand, cfg);
  assert.deepEqual(norm.map((c) => c.fusedNorm), [0.85, 1]);
});
