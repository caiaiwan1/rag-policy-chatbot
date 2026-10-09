# RAG Agent Studio

一个**可配置、可观测、可溯源**的 RAG 网页实验台。模型、分块策略、检索方式、重排与阈值全部可以在界面上调整，每一步的中间结果都能看到——用来搞懂 RAG 每个模块到底在干什么，以及参数该怎么调。

> 后端 Node.js（无框架依赖，Express + 原生 fetch）+ 前端零构建三件套，clone 下来一条命令就能跑。

---

## 一、功能对照

| 你的需求 | 实现方式 |
| --- | --- |
| ① 模型自己配置，通过 API Key | LLM / Embedding / Rerank 三套独立配置，均走 OpenAI 兼容协议，内置 DeepSeek、通义、Moonshot、智谱、OpenAI、硅基流动、Cohere、本地 Ollama / Xinference 预设，Key 存本地 `data/config.json` |
| ② 上传文档 + 切片管理 | 支持 `.txt .md .csv .json .html .pdf .docx`；切片可预览、可编辑、可删除、可手动新增，改完标记"待重建"单独补索引 |
| ② Embedding 模型自选 | 任意 OpenAI 兼容 embedding 接口，可设维度、批处理大小、是否归一化，带连通性测试（返回维度与耗时） |
| ③ 按 token 自定义切块 | `fixed` 滑窗策略，块大小 + 重叠精确生效 |
| ③ token 上限 + 语义切块 | `semantic` 策略：句向量相似度断点，支持绝对阈值 / 百分位自适应，受 maxTokens 约束 |
| ③ 按段落切块 | `paragraph` 策略：小段自动合并、按段数重叠；另附 `recursive` 递归分隔符策略 |
| ③ Overlap 及覆盖度 | 所有策略统一支持，可按**百分比（覆盖度）**或**绝对 token 数**设置，界面实时显示换算结果与重叠示意图 |
| ④ 问题改写可配置 | 开关 + 三种模式（单查询改写 / Multi-Query 多查询扩展 / HyDE 假设性答案）+ 提示词可编辑 + 参考历史轮数，可单独测试改写效果 |
| ⑤ 语义检索 / 语义 + BM25 | 三种模式：纯语义、纯 BM25、混合；混合支持 RRF 倒数排名融合与加权求和两种方式 |
| ⑥ 重排数量设置 | Rerank 候选数 Top-N 与最终进上下文的 Top-K 分开设置；支持专业 Rerank API，失败自动降级为 LLM 打分 |
| ⑥ 低于阈值提示无法回答 | 阈值可按重排分数或融合分数判定；未命中时可选「直接拒答」或「交给模型自行作答」，并支持 Agent 自动改写问题重新检索（可设重试轮次） |

---

## 二、五分钟跑起来

```bash
git clone <你的仓库地址> rag-agent
cd rag-agent
npm install
node server.js          # 打开 http://localhost:5178
```

### 没有 API Key 也能完整体验

项目内置了一个本地 Mock 模型服务（词袋哈希向量，语义趋势与真实模型一致）：

```bash
node tools/mock-server.js &     # 端口 5199
node server.js &                # 端口 5178
node tools/smoke-test.js        # 自动跑通全链路并打印各环节结果
```

然后把界面里的三处配置填成：

| 项目 | Base URL | API Key | 模型 |
| --- | --- | --- | --- |
| LLM | `http://localhost:5199/v1` | `mock` | `mock-llm-7b` |
| Embedding | `http://localhost:5199/v1` | `mock` | `mock-embedding-1024` |
| Rerank | `http://localhost:5199/v1/rerank` | `mock` | `mock-reranker` |

`tools/smoke-test.js` 会依次验证：连通性 → 上传解析 → 四种分块策略对比 → overlap 生效检测 → 建索引 → 三种检索模式对比 → 完整问答（改写/召回/重排/引用）→ 阈值拒答。

### 容器化部署（Docker）

无需在本机装 Node，一条命令起服务：

```bash
docker compose up -d                  # 构建并启动，访问 http://localhost:5178
docker compose --profile mock up -d   # 额外拉起本地 Mock 模型，零 API Key 即可完整体验
```

`data/` 已挂载为卷持久化（`config.json` 里的 API Key、上传文档、向量索引都在这里，请勿提交）。改端口在 `docker-compose.yml` 的 `ports` 映射即可。

---

## 三、界面导览

**① 模型配置** — 三张卡片分别配置 LLM / Embedding / Rerank，点预设一键填入地址与模型名，填 Key 后「保存并测试」会真实打一次接口。

**② 知识库与分块** — 上传 → 选策略 → 预览切块效果（显示块数、平均 token、区间、实际断点阈值）→ 确认后一键建索引。下方切片管理可搜索、编辑、删除、手动新增。

**③ 检索实验台** — 不经过生成，直接看召回结果及各路分数，用来调 mode / 融合方式 / 权重 / 阈值最快。问题改写可以单独测试，直观看到"用户的问题被改成了什么"。

**④ 对话问答** — 完整链路流式执行，右侧执行轨迹面板实时显示：问题改写 → 召回 N 条 → 重排分数 → 进入上下文的切片 → 最终引用。答案里的 `[1]` `[2]` 可点开查看原文与分数。

---

## 四、分块怎么选（经验值）

| 策略 | 适用场景 | 建议参数 |
| --- | --- | --- |
| `fixed` 按 token | 通用文档、未知结构的语料 | 300~600 token，overlap 10%~20% |
| `semantic` 语义 | 长文、答问类内容，要求块内语义完整 | maxTokens 600~800，阈值 0.5~0.6 或百分位 85 |
| `paragraph` 段落 | 手册、规章、排版良好的文档 | maxTokens 800，重叠 1 段 |
| `recursive` 递归 | 混合格式、工程兜底方案 | 300~500 token，overlap 15% |

**关于 Overlap**：块边界处最容易丢失关键信息。重叠 15% 是常见起点；低于 10% 效果不明显，高于 25% 索引体积和成本明显上升但收益递减。语义切块本身已保证块内完整，overlap 可以调小甚至关闭。

---

## 五、检索与重排怎么调

- **纯语义**：擅长同义表述、模糊意图；对型号、错误码、条款编号这类精确字符串不敏感。
- **纯 BM25**：精确匹配强、零模型依赖、速度极快；无法处理同义泛化。
- **混合（默认）**：工业界默认选择。融合优先用 **RRF**（只用排名，不受分数量纲影响，鲁棒）；想精细控制权重再用加权求和。
- **两阶段检索**：先混合召回 20~50 条（candidateK），再交给 Rerank 精排取 Top 3~8（topK）。
- **阈值**：用重排分数时 0.3~0.5 是常见起点；用融合分数时先在检索实验台跑一批真实问题，观察"命中/未命中"的分界线再定。建议先把阈值调低看召回，再逐步抬高到能拒答明显无关的问题。
- **问题改写**：多轮对话必开（否则"它有什么缺点"这种指代无法检索）；单轮问答可用 Multi-Query 提升召回；专业术语多的场景可试 HyDE。

---

## 六、目录结构

```
rag-agent/
├── server.js              Express 服务与全部 HTTP API
├── src/
│   ├── config.js          配置持久化与默认值（所有可调参数的家）
│   ├── tokenizer.js       token 估算、单元切分、句子/段落切分、BM25 分词
│   ├── parsers.js         txt/md/csv/json/html/pdf/docx → 纯文本
│   ├── chunk.js           四种分块策略 + 统一 overlap 机制
│   ├── embed.js           Embedding 客户端（批处理、归一化）
│   ├── retrieve.js        BM25、向量检索、RRF/加权融合、分数归一化
│   ├── rerank.js          Rerank API + LLM 打分降级
│   ├── llm.js             聊天补全（流式/非流式）、模型列表
│   ├── rag.js             编排：改写 → 检索 → 重排 → 阈值 → 生成
│   └── kb.js              知识库存储（文档/切片/向量，JSON 落盘）
├── public/                前端（index.html / styles.css / app.js，零构建）
├── tools/
│   ├── mock-server.js     本地 Mock 模型服务
│   └── smoke-test.js      端到端冒烟测试
├── test/                 单元测试（tokenizer / chunk / retrieve 核心算法，纯本地）
├── Dockerfile            生产镜像（多阶段，约 200MB）
├── docker-compose.yml    一键部署（含可选 Mock 体验服务）
├── .github/workflows/ci.yml   CI：Node 18/20 矩阵自动跑 npm test
└── docs/sample.md         示例文档
```

数据落在 `data/`：`config.json`（配置与 Key）、`kb.json`（切片与向量）、`uploads/`（原始文件）、`texts/`（解析后纯文本）。

---

## 七、HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/api/config` | 读取（Key 掩码）/ 保存配置 |
| POST | `/api/test/{llm,embedding,rerank}` | 连通性测试 |
| POST | `/api/upload` | 上传并解析文档 |
| GET/DELETE | `/api/docs`、`/api/docs/:id` | 文档列表 / 删除 |
| POST | `/api/chunk/preview` | 按当前策略预览切块（不写库） |
| POST | `/api/kb/build` | 切块 + 向量化建库（SSE 进度） |
| GET | `/api/kb/chunks` | 切片分页查询 |
| POST/PATCH/DELETE | `/api/kb/chunk[/:id]` | 新增 / 编辑 / 删除切片 |
| POST | `/api/kb/index` | 为未向量化的切片补建索引 |
| POST | `/api/search` | 仅检索 |
| POST | `/api/chat` | 完整 RAG 问答（SSE 事件流） |
| POST | `/api/rewrite` | 单独测试问题改写 |

---

## 八、注意事项

- **API Key 安全**：Key 明文存在本机 `data/config.json`，`.gitignore` 已排除该目录，**不要**把 `data/` 提交到仓库。
- **向量存储**：JSON 落盘 + 内存索引，面向个人与中小团队知识库（数千切片量级）。量级更大可替换为 sqlite-vec / Qdrant / Milvus，`src/kb.js` 是唯一改动点。
- **协议兼容**：所有模型走 OpenAI 兼容协议。阿里云 DashScope 的原生 rerank 接口格式已单独适配。
- **PDF 扫描件**：当前 `pdf-parse` 只能提取文字层，图片型 PDF 需要接 OCR。

---

## 九、测试与 CI

核心算法（分词、分块、检索/融合）有纯本地单元测试，不依赖任何外部模型服务：

```bash
npm test            # 运行 test/ 下的单元测试（当前 21 项）
npm run test:e2e    # 需先启动 server + mock，跑端到端冒烟测试
```

`test/` 覆盖：token 估算与边界、四种分块策略与 overlap 机制、BM25、三种检索模式（语义 / BM25 / 混合）与分数归一化——后者重点验证 **RRF 归一化不会让第一名恒为 1 而失去阈值区分度**。

仓库通过 GitHub Actions 做 CI：每次 push / PR 在 **Node 18、20** 两个版本上自动 `npm ci` 并 `npm test`，并对 `server.js`、`tools/mock-server.js` 做语法检查。

---

## 十、可以继续扩展的方向

- 多路召回合并（多知识库 / 结构化表格单独召回）
- 引用级校验：让模型判断每个引用是否真的支撑了对应句子
- 评测集：内置一批问答对，自动算召回率与拒答准确率，参数调优从"凭感觉"变成"看指标"
- 迭代式 Agent：检索 → 反思 → 补检 → 再生成（当前已实现"改写重试"，可继续加深）

---

## License

MIT
