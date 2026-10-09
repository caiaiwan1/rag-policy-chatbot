/**
 * 配置持久化：所有模型 / 分块 / 检索 / 重排参数落在 data/config.json
 * 说明：apiKey 明文存本地磁盘（与同源工具一致），接口对外输出时做掩码。
 */
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export { DATA_DIR };

export const DEFAULT_CONFIG = {
  llm: {
    provider: 'openai',            // openai | deepseek | dashscope | moonshot | custom
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.2,
    maxTokens: 2048,
    systemPrompt:
      '你是一个严谨的问答助手。只依据【参考资料】回答问题。\n' +
      '要求：\n1. 答案必须来自参考资料，禁止编造；若资料不足，直接说明"依据当前知识库无法回答该问题"。\n' +
      '2. 引用时在句末标注来源编号，形如 [1] [2]，编号对应参考资料序号。\n' +
      '3. 语言与用户提问保持一致，条理清晰，必要时用列表。',
  },
  embedding: {
    provider: 'siliconflow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKey: '',
    model: 'BAAI/bge-m3',
    dimensions: 1024,             // 0 = 不传，由模型决定
    batchSize: 16,
    normalize: true,
  },
  rerank: {
    enabled: true,
    mode: 'api',                  // api | llm | none
    baseUrl: 'https://api.siliconflow.cn/v1/rerank',
    apiKey: '',
    model: 'BAAI/bge-reranker-v2-m3',
    topN: 20,                     // 送入重排的候选数
  },
  chunk: {
    strategy: 'fixed',            // fixed | semantic | paragraph | recursive
    size: 512,                    // 每块目标 token
    overlapEnabled: true,
    overlapMode: 'percent',       // percent | tokens
    overlapValue: 15,             // percent 模式下 = 15%，tokens 模式下 = 15 token
    // 语义切块
    semantic: {
      maxTokens: 700,             // 语义块 token 上限
      minTokens: 80,              // 过小的块与相邻块合并
      threshold: 0.55,            // 相邻句余弦相似度低于此值则断开（可为 percentile 模式）
      thresholdMode: 'absolute',  // absolute | percentile
      percentile: 85,
    },
    // 段落切块
    paragraph: {
      maxTokens: 800,
      mergeSmall: true,           // 小段落向上合并
      overlapParagraphs: 1,       // 段落模式重叠段数
    },
    respectMarkdown: true,        // 尽量不在 markdown 标题/代码块中断开
  },
  query: {
    rewriteEnabled: false,
    rewriteMode: 'single',        // single | multi | hyde
    rewritePrompt:
      '你是查询优化专家。结合对话历史，把用户最新的问题改写成一个独立、完整、利于向量检索的查询语句。\n' +
      '要求：补全指代、展开缩写、保留关键实体与时间范围；不要回答，只输出改写后的查询；若问题已足够清晰，原样输出。',
    multiCount: 3,                // multi 模式生成 query 数量
    historyTurns: 3,              // 改写时参考的历史轮数
    hydeEnabled: false,
  },
  retrieve: {
    mode: 'hybrid',               // semantic | bm25 | hybrid
    topK: 8,                      // 最终进入上下文的片段数
    candidateK: 30,               // 初筛候选池
    fusion: 'rrf',                // rrf | weighted
    rrfK: 60,
    weightSemantic: 0.6,
    weightBm25: 0.4,
    minScore: 0.35,               // 相似度阈值（0~1），低于则丢弃
    scoreSource: 'auto',          // auto | rerank | fusion（用哪种分数判定阈值）
    noAnswerMode: 'refuse',       // refuse | llm（refuse=直接提示无法回答；llm=交给模型自行作答）
    noAnswerText: '抱歉，依据当前知识库无法回答该问题（未检索到置信度足够的资料）。',
  },
  agent: {
    enabled: true,                // 检索失败时是否让 Agent 改写问题重试
    maxIterations: 2,             // 最多额外检索轮次
  },
};

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(patch || {})) {
    const v = patch[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

let cache = null;

export function loadConfig() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    cache = deepMerge(DEFAULT_CONFIG, JSON.parse(raw));
  } catch {
    cache = structuredClone(DEFAULT_CONFIG);
  }
  return cache;
}

export function saveConfig(patch) {
  const next = deepMerge(loadConfig(), patch);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf-8');
  cache = next;
  return next;
}

export function resetConfig() {
  cache = structuredClone(DEFAULT_CONFIG);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cache, null, 2), 'utf-8');
  return cache;
}

export function mask(s = '') {
  if (!s) return '';
  if (s.length <= 8) return '*'.repeat(s.length);
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

/** 对外输出：隐藏 apiKey */
export function publicConfig() {
  const c = structuredClone(loadConfig());
  c.llm.apiKeyMasked = mask(c.llm.apiKey);
  c.embedding.apiKeyMasked = mask(c.embedding.apiKey);
  c.rerank.apiKeyMasked = mask(c.rerank.apiKey);
  delete c.llm.apiKey;
  delete c.embedding.apiKey;
  delete c.rerank.apiKey;
  return c;
}
