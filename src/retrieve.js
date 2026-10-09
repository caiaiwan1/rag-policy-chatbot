/**
 * 检索层：向量语义检索 + BM25 关键词检索 + 融合（RRF / 加权）
 */
import { tokenizeForIndex } from './tokenizer.js';
import { cosine } from './chunk.js';

/* ------------------------------- BM25 ------------------------------- */
export class BM25 {
  constructor(docTokens = [], k1 = 1.5, b = 0.75) {
    this.k1 = k1;
    this.b = b;
    this.docs = docTokens;
    this.docLen = docTokens.map((d) => d.length);
    this.avgdl = this.docLen.length ? this.docLen.reduce((a, c) => a + c, 0) / this.docLen.length : 0;
    this.df = new Map();
    for (const d of docTokens) {
      for (const t of new Set(d)) this.df.set(t, (this.df.get(t) || 0) + 1);
    }
    this.N = docTokens.length;
  }

  idf(term) {
    const n = this.df.get(term) || 0;
    // BM25 经典平滑式 IDF
    return Math.log(1 + ((this.N - n + 0.5) / (n + 0.5)) * 1);
  }

  /** @returns {number[]} 与 docs 对齐的原始 BM25 分（未归一化，可为负） */
  scores(queryTokens) {
    const q = queryTokens.slice(0, 128);
    return this.docs.map((doc, i) => {
      const tf = new Map();
      for (const t of doc) tf.set(t, (tf.get(t) || 0) + 1);
      let s = 0;
      const dl = this.docLen[i] || 0;
      for (const t of q) {
        const f = tf.get(t);
        if (!f) continue;
        const denom = f + this.k1 * (1 - this.b + (this.b * dl) / (this.avgdl || 1));
        s += this.idf(t) * ((f * (this.k1 + 1)) / denom);
      }
      return s;
    });
  }

  scoresNormalized(queryTokens) {
    const raw = this.scores(queryTokens);
    const max = Math.max(...raw, 0);
    if (max <= 0) return raw.map(() => 0);
    return raw.map((s) => (s > 0 ? s / max : 0)); // 归一到 0~1
  }
}

/* ------------------------------ 检索入口 ------------------------------ */

/**
 * @param {object} args
 * @param {string} args.query
 * @param {number[]} args.queryVector
 * @param {Array} args.chunks  [{id, text, vector, docName}]
 * @param {BM25} args.bm25
 * @param {object} args.cfg    retrieve 配置
 * @returns {Array} 候选 [{chunkIndex, semantic, bm25, fused}]
 */
export function retrieve({ query, queryVector, chunks, bm25, cfg }) {
  const mode = cfg.mode || 'hybrid';
  const candidateK = Math.max(1, Number(cfg.candidateK) || 30);

  let semScores = new Array(chunks.length).fill(0);
  let bmScores = new Array(chunks.length).fill(0);

  if (mode !== 'bm25' && queryVector && chunks.some((c) => c.vector)) {
    for (let i = 0; i < chunks.length; i++) {
      semScores[i] = chunks[i].vector ? cosine(queryVector, chunks[i].vector) : 0;
    }
  }
  if (mode !== 'semantic' && bm25) {
    bmScores = bm25.scoresNormalized(tokenizeForIndex(query));
  }

  const fused = new Array(chunks.length).fill(0);
  if (mode === 'semantic') {
    for (let i = 0; i < chunks.length; i++) fused[i] = semScores[i];
  } else if (mode === 'bm25') {
    for (let i = 0; i < chunks.length; i++) fused[i] = bmScores[i];
  } else if (cfg.fusion === 'weighted') {
    const ws = Number(cfg.weightSemantic ?? 0.6);
    const wb = Number(cfg.weightBm25 ?? 0.4);
    const sum = ws + wb || 1;
    for (let i = 0; i < chunks.length; i++) fused[i] = (semScores[i] * ws + bmScores[i] * wb) / sum;
  } else {
    // RRF：按两路排名倒数求和，天然消除量纲差异
    const k = Number(cfg.rrfK) || 60;
    const rankMap = (scores) =>
      scores
        .map((s, i) => ({ s, i }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .reduce((acc, x, r) => {
          acc[x.i] = 1 / (k + r + 1);
          return acc;
        }, {});
    const rs = rankMap(semScores);
    const rb = rankMap(bmScores);
    for (let i = 0; i < chunks.length; i++) fused[i] = (rs[i] || 0) + (rb[i] || 0);
  }

  return fused
    .map((f, i) => ({
      chunkIndex: i,
      semantic: semScores[i],
      bm25: bmScores[i],
      fused: f,
    }))
    .sort((a, b) => b.fused - a.fused)
    .slice(0, candidateK);
}

/**
 * 把融合分数归一到 0~1，且**不同查询之间可比**（不能以本次最大值为分母，否则第一名恒为 1，阈值失效）
 * - RRF：除以「两路均排名第 1」的理论满分 2/(k+1)
 * - 加权/单路：cosine 与归一化 BM25 本身已在 0~1，保持原值
 */
export function normalizeCandidates(candidates, cfg) {
  const k = Number(cfg.rrfK) || 60;
  const isHybrid = (cfg.mode || 'hybrid') === 'hybrid';
  const maxRrf = (isHybrid ? 2 : 1) / (k + 1);
  const useRrf = isHybrid && (cfg.fusion || 'rrf') === 'rrf';
  return candidates.map((c) => ({
    ...c,
    fusedNorm: useRrf ? Math.min(1, Math.max(0, c.fused / maxRrf)) : Math.min(1, Math.max(0, c.fused)),
  }));
}
