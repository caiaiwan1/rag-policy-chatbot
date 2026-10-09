import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countTokens,
  sliceByTokens,
  splitSentences,
  splitParagraphs,
  tokenizeForIndex,
} from '../src/tokenizer.js';

test('countTokens: 空串与边界', () => {
  assert.equal(countTokens(''), 0);
  assert.ok(countTokens('   \n\t ') > 0, '空白字符也计少量 token');
  assert.ok(countTokens('你好世界') >= 4, '中文按字计，至少 4 token');
});

test('countTokens: 中文权重高于英文', () => {
  const zh = countTokens('人工智能'); // 4 字 ≈ 4
  const en = countTokens('artificial'); // 10 字母 ≈ 2.5
  assert.ok(zh > en, `期望中文(${zh}) > 英文(${en})`);
});

test('sliceByTokens: 基本切块且按 token 边界对齐', () => {
  const text = '小明 去 学校 学习 语文 数学 英语 体育 音乐 美术 科学 历史 地理 政治 物理 化学'.repeat(3);
  const chunks = sliceByTokens(text, 30, 0);
  assert.ok(chunks.length >= 2, '应切出多块');
  for (const c of chunks) {
    assert.ok(c.text.trim().length > 0, '块不应为空');
    assert.ok(c.tokens > 0 && c.tokens <= 45, `块 token 应接近 size(30)，实际 ${c.tokens}`);
  }
});

test('sliceByTokens: 开启 overlap 后块数不减反增（滑窗重叠）', () => {
  const text = Array.from({ length: 200 }, (_, i) => `句${i}内容`).join(' ');
  const noOv = sliceByTokens(text, 20, 0);
  const withOv = sliceByTokens(text, 20, 8);
  assert.ok(withOv.length >= noOv.length, `overlap 后块数(${withOv.length})应≥无 overlap(${noOv.length})`);
  // 重叠块之间应存在文本重叠：后一块包含前一块结尾片段（滑窗回退）
  let overlapHit = false;
  for (let i = 1; i < withOv.length; i++) {
    const tail = withOv[i - 1].text.slice(-6);
    if (tail.length >= 2 && withOv[i].text.includes(tail)) overlapHit = true;
  }
  assert.ok(overlapHit, '相邻块应存在 token 级重叠');
});

test('splitSentences: 中英文句末标点切分', () => {
  const s = splitSentences('今天天气不错。我们去散步吧！他说 hello? 好的。');
  assert.ok(s.length >= 3, `应切出多句，实际 ${s.length} 句`);
  assert.ok(s.some((x) => x.includes('天气')), '应包含中文句');
});

test('splitParagraphs: 空行分隔', () => {
  const text = '段落一第一行\n段落一第二行\n\n段落二\n\n段落三';
  const p = splitParagraphs(text);
  assert.equal(p.length, 3, `应得到 3 段，实际 ${p.length}`);
  assert.ok(p[0].includes('段落一第一行'));
});

test('tokenizeForIndex: 中文单字+二元组，英文小写词', () => {
  const t = tokenizeForIndex('人工智能 AI 学习');
  assert.ok(t.includes('人') && t.includes('人工'), '应包含单字与二元组');
  assert.ok(t.includes('ai') && t.includes('学习'.toLowerCase ? '学习' : '学习'), '应包含英文词');
  assert.ok(!t.some((x) => x === 'AI'), '英文应小写化');
});
