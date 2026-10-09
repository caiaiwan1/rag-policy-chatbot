/* ============================== 基础工具 ============================== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 2200);
}
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {},
    ...opts,
    body: opts.body instanceof FormData ? opts.body : opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) throw new Error(json.error || `请求失败 ${res.status}`);
  return json;
}
async function ssePost(url, body, onEvent) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder('utf-8');
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() || '';
    for (const p of parts) {
      const lines = p.split('\n');
      const ev = (lines.find((l) => l.startsWith('event:')) || 'event: message').slice(6).trim();
      const dl = lines.find((l) => l.startsWith('data:'));
      if (!dl) continue;
      const payload = dl.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        onEvent(JSON.parse(payload), ev);
      } catch {
        /* ignore */
      }
    }
  }
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 极简 Markdown 渲染（代码块 / 标题 / 列表 / 粗体 / 引用编号） */
function md(text) {
  let s = esc(text || '');
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (m, lang, code) => `<pre><code>${code.replace(/^\n|\n$/g, '')}</code></pre>`);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/^######\s+(.*)$/gm, '<b>$1</b>');
  s = s.replace(/^#{1,5}\s+(.*)$/gm, '<b>$1</b>');
  s = s.replace(/^\s*[-*]\s+(.*)$/gm, '<li>$1</li>');
  s = s.replace(/(<li>.*<\/li>)(?![\s\S]*?<li>)/gs, '<ul>$1</ul>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/\[(\d+)\]/g, '<span class="ref-chip">[$1]</span>');
  return s.replace(/\n/g, '<br/>').replace(/<br\/>(?=<li>)/g, '');
}

/* ============================== 配置绑定 ============================== */
let CFG = {};
const get = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
const set = (o, p, v) => {
  const ks = p.split('.');
  const last = ks.pop();
  let cur = o;
  for (const k of ks) cur = cur[k] || (cur[k] = {});
  cur[last] = v;
};
function collectScope(prefix, root = document) {
  const out = {};
  $$(`[data-cfg^="${prefix}."]`, root).forEach((el) => {
    const path = el.dataset.cfg;
    // 密码框留空表示「不修改」，避免把已保存的 Key 清空
    if (el.type === 'password' && !el.value) return;
    let v;
    if (el.type === 'checkbox') v = el.checked;
    else if (el.type === 'number') v = el.value === '' ? undefined : Number(el.value);
    else v = el.value;
    if (v !== undefined) set(out, path, v);
  });
  return out[prefix] || {};
}
function fillAll(cfg, root = document) {
  $$('[data-cfg]', root).forEach((el) => {
    const v = get(cfg, el.dataset.cfg);
    if (v === undefined || el.type === 'password') return;
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
  });
}
const PRESETS = {
  llm: [
    ['DeepSeek', { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }],
    ['通义千问', { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' }],
    ['Moonshot', { baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' }],
    ['智谱 GLM', { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' }],
    ['OpenAI', { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' }],
    ['本地 Ollama', { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b', apiKey: 'ollama' }],
  ],
  embedding: [
    ['硅基流动 BGE-M3', { baseUrl: 'https://api.siliconflow.cn/v1', model: 'BAAI/bge-m3', dimensions: 1024 }],
    ['OpenAI', { baseUrl: 'https://api.openai.com/v1', model: 'text-embedding-3-small', dimensions: 1536 }],
    ['通义 text-embedding-v3', { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'text-embedding-v3', dimensions: 1024 }],
    ['本地 Ollama bge-m3', { baseUrl: 'http://localhost:11434/v1', model: 'bge-m3', dimensions: 1024, apiKey: 'ollama' }],
    ['Xinference', { baseUrl: 'http://localhost:9997/v1', model: 'bge-m3', dimensions: 1024 }],
  ],
  rerank: [
    ['硅基流动 BGE-Reranker', { baseUrl: 'https://api.siliconflow.cn/v1/rerank', model: 'BAAI/bge-reranker-v2-m3' }],
    ['Cohere', { baseUrl: 'https://api.cohere.com/v1/rerank', model: 'rerank-multilingual-v3.0' }],
    ['通义 gte-rerank', { baseUrl: 'https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank', model: 'gte-rerank-v2' }],
    ['Xinference', { baseUrl: 'http://localhost:9997/v1/rerank', model: 'bge-reranker-v2-m3' }],
  ],
};
function renderPresets() {
  Object.entries(PRESETS).forEach(([group, items]) => {
    const box = $(`.presets[data-preset-group="${group}"]`);
    if (!box) return;
    box.innerHTML = '';
    items.forEach(([name, vals]) => {
      const b = document.createElement('button');
      b.className = 'preset';
      b.textContent = name;
      b.onclick = () => {
        Object.entries(vals).forEach(([k, v]) => {
          const el = $(`[data-cfg="${group}.${k}"]`);
          if (el) el.value = v;
        });
        toast(`已填入 ${name} 预设，记得填写 API Key`);
      };
      box.appendChild(b);
    });
  });
}

/* ============================== Tab ============================== */
$$('.nav-item').forEach((btn) => {
  btn.onclick = () => {
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b === btn));
    $$('.tab').forEach((s) => s.classList.toggle('active', s.id === `tab-${btn.dataset.tab}`));
  };
});

/* ============================== 配置页 ============================== */
async function loadConfig() {
  const r = await api('/api/config');
  CFG = r.config;
  fillAll(CFG);
  $('#maskLlm').textContent = CFG.llm.apiKeyMasked ? `已保存：${CFG.llm.apiKeyMasked}` : '尚未配置';
  $('#maskEmb').textContent = CFG.embedding.apiKeyMasked ? `已保存：${CFG.embedding.apiKeyMasked}` : '尚未配置';
  $('#maskRerank').textContent = CFG.rerank.apiKeyMasked ? `已保存：${CFG.rerank.apiKeyMasked}` : '尚未配置';
  $('#extList').textContent = (r.ext || []).join(' ');
  $('#qTopK').value = CFG.retrieve.topK;
  $('#qMinScore').value = CFG.retrieve.minScore;
  $('#qMode').value = CFG.retrieve.mode;
  $('#qRerank').checked = !!CFG.rerank.enabled;
  $('#qRewrite').checked = !!CFG.query.rewriteEnabled;
  toggleRerankFields();
  syncStrategyUI();
  updateOverlapPreview();
  refreshStats();
}
function toggleRerankFields() {
  const mode = $('[data-cfg="rerank.mode"]').value;
  const on = $('[data-cfg="rerank.enabled"]').checked && mode === 'api';
  $('#rerankApiFields').classList.toggle('hidden', !on);
}
$('[data-cfg="rerank.enabled"]').onchange = toggleRerankFields;
$('[data-cfg="rerank.mode"]').onchange = toggleRerankFields;

async function saveScope(scope, resultEl, testPath) {
  const el = $(resultEl);
  try {
    el.className = 'result';
    el.textContent = '保存中…';
    const payload = {};
    payload[scope] = collectScope(scope);
    const r = await api('/api/config', { method: 'POST', body: payload });
    CFG = r.config;
    fillAll(CFG);
    $('#maskLlm').textContent = CFG.llm.apiKeyMasked ? `已保存：${CFG.llm.apiKeyMasked}` : '尚未配置';
    $('#maskEmb').textContent = CFG.embedding.apiKeyMasked ? `已保存：${CFG.embedding.apiKeyMasked}` : '尚未配置';
    $('#maskRerank').textContent = CFG.rerank.apiKeyMasked ? `已保存：${CFG.rerank.apiKeyMasked}` : '尚未配置';
    if (!testPath) {
      el.className = 'result ok';
      el.textContent = '已保存';
      toast('配置已保存');
      return;
    }
    el.textContent = '测试中…';
    const t = await api(testPath, { method: 'POST', body: {} });
    el.className = 'result ok';
    el.textContent =
      testPath.includes('embedding')
        ? `连通 ✓ 维度 ${t.dim} · ${t.latencyMs}ms`
        : testPath.includes('rerank')
          ? `连通 ✓ ${t.mode} 模式 · ${t.latencyMs}ms`
          : `连通 ✓ ${t.latencyMs}ms · ${t.text.slice(0, 60)}`;
  } catch (e) {
    el.className = 'result err';
    el.textContent = e.message;
    toast(e.message);
  }
}
$('#btnSaveLlm').onclick = () => saveScope('llm', '#resLlm', '/api/test/llm');
$('#btnSaveEmb').onclick = () => saveScope('embedding', '#resEmb', '/api/test/embedding');
$('#btnSaveRerank').onclick = () => saveScope('rerank', '#resRerank', '/api/test/rerank');
$('#btnModels').onclick = async () => {
  try {
    const r = await api('/api/models?type=llm');
    if (!r.models.length) return toast('未获取到模型列表，请检查 Base URL / Key');
    const pick = prompt('可用模型（复制后粘贴到模型名输入框）：\n\n' + r.models.join('\n'));
    if (pick) $('[data-cfg="llm.model"]').value = pick.trim();
  } catch (e) {
    toast(e.message);
  }
};

/* ============================== 知识库：上传 ============================== */
const dz = $('#dropzone');
dz.onclick = () => $('#fileInput').click();
['dragenter', 'dragover'].forEach((ev) =>
  dz.addEventListener(ev, (e) => {
    e.preventDefault();
    dz.classList.add('over');
  }),
);
['dragleave', 'drop'].forEach((ev) =>
  dz.addEventListener(ev, (e) => {
    e.preventDefault();
    dz.classList.remove('over');
  }),
);
dz.addEventListener('drop', (e) => uploadFiles(e.dataTransfer.files));
$('#fileInput').onchange = (e) => uploadFiles(e.target.files);

async function uploadFiles(files) {
  if (!files?.length) return;
  const fd = new FormData();
  [...files].forEach((f) => fd.append('files', f));
  toast('上传解析中…');
  try {
    const r = await api('/api/upload', { method: 'POST', body: fd });
    toast(`已解析 ${r.docs.length} 个文档`);
    renderDocs();
    refreshStats();
  } catch (e) {
    toast('上传失败：' + e.message);
  }
}
async function renderDocs() {
  const r = await api('/api/docs');
  const box = $('#docList');
  const opts = $('#chunkDocFilter');
  const cur = opts.value;
  opts.innerHTML = '<option value="">全部文档</option>';
  box.innerHTML = '';
  if (!r.docs.length) {
    box.innerHTML = '<div class="empty">还没有文档，先上传一个吧</div>';
    return;
  }
  r.docs.forEach((d) => {
    opts.insertAdjacentHTML('beforeend', `<option value="${d.id}">${esc(d.name)}</option>`);
    const row = document.createElement('div');
    row.className = 'doc-row';
    row.innerHTML = `
      <span class="doc-name">${esc(d.name)}</span>
      <span class="doc-meta">${(d.chars / 1000).toFixed(1)}k 字 · ${d.tokens || 0} token · ${d.chunkCount || 0} 块</span>
      <span class="tag ${d.status}">${d.status === 'indexed' ? '已索引' : d.status === 'chunked' ? '已分块' : '已解析'}</span>
      <button class="btn-mini" data-act="preview">分块预览</button>
      <button class="btn-mini" data-act="build">重建索引</button>
      <button class="btn-mini" data-act="del">删除</button>`;
    row.querySelector('[data-act="preview"]').onclick = () => previewChunk(d.id);
    row.querySelector('[data-act="build"]').onclick = () => buildKb([d.id]);
    row.querySelector('[data-act="del"]').onclick = async () => {
      await api(`/api/docs/${d.id}`, { method: 'DELETE' });
      renderDocs();
      loadChunks();
      refreshStats();
    };
    box.appendChild(row);
  });
  opts.value = cur;
}

/* ============================== 分块策略 UI ============================== */
$$('.strat').forEach((b) => {
  b.onclick = () => {
    $$('.strat').forEach((x) => x.classList.toggle('active', x === b));
    syncStrategyUI();
    updateOverlapPreview();
  };
});
function currentStrategy() {
  return $('.strat.active')?.dataset.strategy || 'fixed';
}
function syncStrategyUI() {
  const s = currentStrategy();
  $('[data-cfg="chunk.size"]').value = get(CFG, 'chunk.size');
  const isSem = s === 'semantic';
  const isPara = s === 'paragraph';
  $('#semanticFields').classList.toggle('hidden', !isSem);
  $('[data-cfg="chunk.semantic.maxTokens"]').closest('.field').classList.toggle('hidden', !isSem);
  $('[data-cfg="chunk.paragraph.maxTokens"]').closest('.field').classList.toggle('hidden', !isPara);
  $('[data-cfg="chunk.paragraph.overlapParagraphs"]').closest('.field').classList.toggle('hidden', !isPara);
  $('[data-cfg="chunk.paragraph.mergeSmall"]').closest('.check').classList.toggle('hidden', !isPara);
}
function updateOverlapPreview() {
  const size = Number($('[data-cfg="chunk.size"]').value) || 512;
  const enabled = $('[data-cfg="chunk.overlapEnabled"]').checked;
  const mode = $('[data-cfg="chunk.overlapMode"]').value;
  const val = Number($('[data-cfg="chunk.overlapValue"]').value) || 0;
  const ov = !enabled ? 0 : mode === 'percent' ? Math.round((size * val) / 100) : val;
  $('#ovLabel').textContent = mode === 'percent' ? '重叠覆盖度（%）' : '重叠 Token 数';
  $('#ovTokens').textContent = `${ov} token / 覆盖度 ${size ? Math.round((ov / size) * 100) : 0}%`;
  const ratio = size ? Math.min(1, ov / size) : 0;
  $('#ovPreview').innerHTML = Array.from({ length: 8 })
    .map((_, i) => `<i class="${i > 0 && i < 8 && ratio > (8 - i) / 8 ? 'ov' : ''}"></i>`)
    .join('');
}
$$('[data-cfg^="chunk."]').forEach((el) => {
  el.addEventListener('input', updateOverlapPreview);
  el.addEventListener('change', updateOverlapPreview);
});

async function previewChunk(docId) {
  const id = docId || $('#chunkDocFilter').value || (await api('/api/docs')).docs[0]?.id;
  if (!id) return toast('请先上传文档');
  $('#resChunk').textContent = '切块中…（语义切块需调用向量模型，稍慢）';
  try {
    const r = await api('/api/chunk/preview', {
      method: 'POST',
      body: { docId: id, chunk: { ...collectScope('chunk'), strategy: currentStrategy() } },
    });
    $('#resChunk').className = 'result ok';
    $('#resChunk').textContent =
      `共 ${r.meta.count} 块 · 平均 ${r.meta.avgTokens} token · 区间 ${r.meta.minTokens}~${r.meta.maxTokens}` +
      (r.meta.degraded ? ` · 降级：${r.meta.degraded}` : '') +
      (r.meta.threshold ? ` · 断点阈值 ${r.meta.threshold}` : '');
    renderChunkPreview(r.chunks);
  } catch (e) {
    $('#resChunk').className = 'result err';
    $('#resChunk').textContent = e.message;
  }
}
function renderChunkPreview(chunks) {
  const box = $('#chunkList');
  $('#chunkStats').innerHTML = `<span>预览 <b>${chunks.length}</b> 块</span>`;
  box.innerHTML = chunks
    .slice(0, 30)
    .map(
      (c, i) => `<div class="chunk-item">
        <div class="ci-head"><span>#${i + 1}</span><span>${c.tokens} token</span></div>
        <div class="ci-text">${esc(c.text)}</div>
      </div>`,
    )
    .join('');
}
$('#btnPreviewChunk').onclick = () => previewChunk();
$('#btnSaveChunk').onclick = async () => {
  await api('/api/config', { method: 'POST', body: { chunk: { ...collectScope('chunk'), strategy: currentStrategy() } } });
  toast('分块参数已保存');
};

/* ============================== 建索引 ============================== */
$('#btnBuild').onclick = () => buildKb();
async function buildKb(docIds) {
  const box = $('#buildProgress');
  const bar = box.querySelector('.bar i');
  box.classList.remove('hidden');
  bar.style.width = '3%';
  $('#buildText').textContent = '开始…';
  try {
    await ssePost(
      '/api/kb/build',
      { docIds, chunk: { ...collectScope('chunk'), strategy: currentStrategy() } },
      (ev) => {
        if (ev.stage === 'chunked') $('#buildText').textContent = `${ev.name}：切出 ${ev.chunks} 块`;
        else if (ev.stage === 'embedding') {
          const p = Math.round((ev.done / ev.total) * 100);
          $('#buildText').textContent = `${ev.name}：向量化 ${ev.done}/${ev.total}`;
          bar.style.width = `${Math.max(5, p)}%`;
        } else if (ev.stage === 'done') {
          bar.style.width = `${Math.round((ev.done / ev.total) * 100)}%`;
          $('#buildText').textContent = `完成 ${ev.done}/${ev.total}`;
        }
        if (ev.name === 'failed') return;
      },
    );
    bar.style.width = '100%';
    toast('索引构建完成');
    renderDocs();
    loadChunks();
    refreshStats();
  } catch (e) {
    toast('构建失败：' + e.message);
  }
}

/* ============================== Chunk 管理 ============================== */
let page = 0;
const PAGE_SIZE = 20;
async function loadChunks(p = page) {
  page = p;
  const docId = $('#chunkDocFilter').value;
  const keyword = $('#chunkKeyword').value;
  const r = await api(`/api/kb/chunks?offset=${p * PAGE_SIZE}&limit=${PAGE_SIZE}&docId=${docId}&keyword=${encodeURIComponent(keyword)}`);
  $('#pageInfo').textContent = `${p * PAGE_SIZE + 1} - ${Math.min((p + 1) * PAGE_SIZE, r.total)} / ${r.total}`;
  $('#chunkStats').innerHTML =
    `<span>总切片 <b>${r.total}</b></span>` +
    (r.rows.length ? `<span>平均 <b>${Math.round(r.rows.reduce((a, c) => a + c.tokens, 0) / r.rows.length)}</b> token</span>` : '');
  const box = $('#chunkList');
  box.innerHTML = r.rows.length
    ? ''
    : '<div class="empty">暂无切片，先上传文档并生成索引</div>';
  r.rows.forEach((c) => {
    const item = document.createElement('div');
    item.className = 'chunk-item';
    item.innerHTML = `
      <div class="ci-head">
        <span>#${c.index + 1}</span>
        <span>${esc(c.docName)}</span>
        <span>${c.tokens} token</span>
        <span class="tag ${c.hasVector ? 'indexed' : 'chunked'}">${c.hasVector ? '已向量化' : '待重建'}</span>
        <span style="flex:1"></span>
        <button class="btn-mini" data-act="edit">编辑</button>
        <button class="btn-mini" data-act="del">删除</button>
      </div>
      <div class="ci-text">${esc(c.text)}</div>`;
    item.querySelector('[data-act="del"]').onclick = async () => {
      await api(`/api/kb/chunk/${c.id}`, { method: 'DELETE' });
      loadChunks();
    };
    item.querySelector('[data-act="edit"]').onclick = () => {
      const t = item.querySelector('.ci-text');
      if (item.querySelector('textarea')) return;
      const ta = document.createElement('textarea');
      ta.value = c.text;
      item.appendChild(ta);
      const save = document.createElement('button');
      save.className = 'btn-mini';
      save.textContent = '保存（需重建向量）';
      save.style.marginTop = '6px';
      save.onclick = async () => {
        await api(`/api/kb/chunk/${c.id}`, { method: 'PATCH', body: { text: ta.value } });
        toast('已保存，请对未向量化切片重建索引');
        item.removeChild(ta);
        item.removeChild(save);
        t.textContent = ta.value;
        loadChunks();
      };
      item.appendChild(save);
    };
    box.appendChild(item);
  });
}
$('#btnReloadChunks').onclick = () => loadChunks(0);
$('#btnAddChunk').onclick = async () => {
  const text = prompt('输入切片内容（手动补充的切片同样会参与检索）：');
  if (!text?.trim()) return;
  const docId = $('#chunkDocFilter').value || (await api('/api/docs')).docs[0]?.id;
  await api('/api/kb/chunk', { method: 'POST', body: { docId, text } });
  toast('已新增，记得重建未向量化切片');
  loadChunks(0);
};
$('#btnReindex').onclick = async () => {
  try {
    const r = await api('/api/kb/index', { method: 'POST', body: {} });
    toast(r.indexed ? `已重建 ${r.indexed} 个切片的向量` : '没有需要重建的切片');
    loadChunks(0);
    refreshStats();
  } catch (e) {
    toast('重建失败：' + e.message);
  }
};
$('#prevPage').onclick = () => loadChunks(Math.max(0, page - 1));
$('#nextPage').onclick = () => loadChunks(page + 1);
$('#chunkKeyword').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadChunks(0);
});
$('#chunkDocFilter').onchange = () => loadChunks(0);

async function refreshStats() {
  const r = await api('/api/kb/stats');
  $('#stDocs').textContent = r.stats.docs;
  $('#stChunks').textContent = r.stats.chunks;
  $('#stIndexed').textContent = r.stats.indexed;
  $('#stDim').textContent = r.stats.dim || '-';
  if (r.stats.pending > 0 && $('#tab-kb').classList.contains('active')) {
    // 有未向量化切片时提示
  }
}

/* ============================== 检索实验台 ============================== */
$('#btnSearch').onclick = async () => {
  const q = $('#searchQuery').value.trim();
  if (!q) return toast('请输入查询');
  $('#resSearch').textContent = '检索中…';
  try {
    const r = await api('/api/search', { method: 'POST', body: { query: q, override: { retrieve: collectScope('retrieve') } } });
    $('#resSearch').textContent = `命中 ${r.results.length} 条`;
    $('#searchMeta').textContent = `模式 ${collectScope('retrieve').mode} · TopK ${collectScope('retrieve').topK}`;
    $('#searchResults').innerHTML = r.results.length
      ? r.results
          .map(
            (h, i) => `<div class="hit">
              <div class="hit-head">
                <b>#${i + 1}</b>
                <span class="score-pill">综合 ${h.fused.toFixed(3)}</span>
                <span class="score-pill">语义 ${h.semantic.toFixed(3)}</span>
                <span class="score-pill">BM25 ${h.bm25.toFixed(3)}</span>
                <span>${esc(h.docName)}</span>
              </div>
              <div class="hit-text">${esc(h.text.slice(0, 600))}</div>
              <div class="score-bar"><i style="width:${Math.max(2, h.fused * 100)}%"></i></div>
            </div>`,
          )
          .join('')
      : '<div class="empty">没有命中任何切片</div>';
  } catch (e) {
    $('#resSearch').className = 'result err';
    $('#resSearch').textContent = e.message;
  }
};
$('#btnSaveRetrieve').onclick = async () => {
  await api('/api/config', { method: 'POST', body: { retrieve: collectScope('retrieve') } });
  toast('检索参数已保存');
};
$('#btnSaveQuery').onclick = async () => {
  await api('/api/config', { method: 'POST', body: { query: collectScope('query') } });
  toast('改写参数已保存');
};
$('#btnTestRewrite').onclick = async () => {
  const q = $('#searchQuery').value.trim();
  if (!q) return toast('请输入查询');
  $('#resRewrite').textContent = '改写中…';
  try {
    const r = await api('/api/rewrite', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: q }], query: collectScope('query') },
    });
    $('#resRewrite').className = 'result ok';
    $('#resRewrite').textContent = `[${r.mode}] ${r.queries.join(' || ')}`;
  } catch (e) {
    $('#resRewrite').className = 'result err';
    $('#resRewrite').textContent = e.message;
  }
};

/* ============================== 对话 ============================== */
let messages = [];
function pushMsg(role, html) {
  const box = $('#chatBox');
  if (box.querySelector('.empty')) box.innerHTML = '';
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.innerHTML = `<div class="avatar">${role === 'user' ? '我' : 'AI'}</div><div class="bubble">${html}</div>`;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
  return el.querySelector('.bubble');
}
function addTrace(title, body, kind = '') {
  const box = $('#traceBox');
  if (box.querySelector('.empty')) box.innerHTML = '';
  const el = document.createElement('div');
  el.className = `trace-item ${kind}`;
  el.innerHTML = `<b>${title}</b>${body}`;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}
$('#btnClearChat').onclick = () => {
  messages = [];
  $('#chatBox').innerHTML = '<div class="empty">对话已清空</div>';
  $('#traceBox').innerHTML = '<div class="empty">暂无</div>';
};
$('#chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
$('#btnSend').onclick = send;

async function send() {
  const q = $('#chatInput').value.trim();
  if (!q) return;
  $('#chatInput').value = '';
  messages.push({ role: 'user', content: q });
  pushMsg('user', esc(q));
  $('#traceBox').innerHTML = '<div class="empty">执行中…</div>';
  const bubble = pushMsg('assistant', '<span class="ref-chip">▍</span>');
  const btn = $('#btnSend');
  btn.disabled = true;

  const override = {
    retrieve: { topK: Number($('#qTopK').value), minScore: Number($('#qMinScore').value), mode: $('#qMode').value },
    rerank: { enabled: $('#qRerank').checked },
    query: { rewriteEnabled: $('#qRewrite').checked },
    agent: { enabled: true },
  };
  let acc = '';
  try {
    await ssePost('/api/chat', { messages, override }, (ev) => {
      if (ev.type === 'stage') {
        addTrace(ev.stage.toUpperCase(), esc(ev.label));
      } else if (ev.type === 'rewritten') {
        addTrace('问题改写', `方式：${ev.mode}<br/>${ev.queries.map((x) => esc(x)).join('<br/>')}`);
      } else if (ev.type === 'retrieved') {
        addTrace('召回', `模式 ${ev.mode} · 候选 ${ev.count} 条<br/>${ev.items.slice(0, 3).map((i) => `${i.fused} · ${esc(i.text.slice(0, 60))}`).join('<br/>')}`);
      } else if (ev.type === 'reranked') {
        addTrace('重排', `${ev.mode}${ev.degraded ? '（降级：' + esc(ev.degraded) + '）' : ''}<br/>${ev.items.slice(0, 3).map((i) => `${i.score} · ${esc(i.text.slice(0, 60))}`).join('<br/>')}`);
      } else if (ev.type === 'noanswer') {
        addTrace(
          '低于阈值',
          `阈值 ${ev.threshold}${ev.best ? ` · 最高分 ${ev.best.score}（${ev.best.from}）` : ''}`,
          'warn',
        );
      } else if (ev.type === 'context') {
        addTrace('进入上下文', `${ev.chunks.length} 个切片：${ev.chunks.map((c) => `[${c.ref}] ${c.score}`).join(' ')}`);
      } else if (ev.type === 'delta') {
        acc += ev.text;
        bubble.innerHTML = md(acc);
        $('#chatBox').scrollTop = $('#chatBox').scrollHeight;
      } else if (ev.type === 'error') {
        addTrace('错误', esc(ev.message), 'err');
        bubble.innerHTML = `<span style="color:var(--err)">${esc(ev.message)}</span>`;
      } else if (ev.type === 'done') {
        if (ev.refs?.length) {
          bubble.innerHTML =
            md(acc) +
            `<div class="refs">${ev.refs
              .map(
                (r) =>
                  `<div class="ref-item"><b>[${r.ref}]</b> ${esc(r.docName)} · 分数 ${r.score}（${r.scoreFrom}）<br/>${esc(r.text.slice(0, 160))}…</div>`,
              )
              .join('')}</div>`;
        }
        messages.push({ role: 'assistant', content: acc });
        if (messages.length > 16) messages = messages.slice(-16);
      }
    });
  } catch (e) {
    bubble.innerHTML = `<span style="color:var(--err)">${esc(e.message)}</span>`;
  }
  btn.disabled = false;
}

/* ============================== 启动 ============================== */
renderPresets();
loadConfig().then(() => {
  renderDocs();
  loadChunks(0);
});
