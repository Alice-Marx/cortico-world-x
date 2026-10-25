import { test } from 'node:test';
import assert from 'node:assert/strict';

import { digest } from '../src/learn/types.ts';
import type { LearnedItem } from '../src/learn/types.ts';

function item(patch: Partial<LearnedItem> = {}): LearnedItem {
  return {
    id: 'a1',
    url: 'https://x.com/a/status/a1',
    author: 'elonmusk',
    text: 'hello world',
    createdAt: '2026-10-20T08:00:00.000Z',
    learnedAt: '2026-10-20T09:00:00.000Z',
    source: 'user:elonmusk',
    ...patch,
  };
}

test('单条摘要行形状：· @handle 日期 正文', () => {
  assert.equal(digest([item()]), '· @elonmusk 2026-10-20 hello world');
});

test('作者缺失时用 source 占位，正文压成一行', () => {
  const text = digest([item({ author: undefined, source: 'search:ai agents', text: '第一行\n第二行   第三行' })]);
  assert.equal(text, '· search:ai agents 2026-10-20 第一行 第二行 第三行');
});

test('单条正文按 120 字截断并加省略号', () => {
  const text = digest([item({ text: 'z'.repeat(400) })]);
  assert.ok(text.endsWith('…'));
  assert.equal(text.length, '· @elonmusk 2026-10-20 '.length + 120);
});

test('超出 maxChars 截断并标注省略多少条', () => {
  const items = Array.from({ length: 5 }, (_, i) =>
    item({ id: 'd' + i, url: 'https://x.com/d/' + i, author: 'u', text: '第' + (i + 1) + '条：' + 'x'.repeat(20) }),
  );
  const text = digest(items, { maxChars: 60 });
  assert.ok(text.length <= 60, '总长必须守住预算');
  assert.ok(text.startsWith('· @u 2026-10-20 第1条：'));
  assert.match(text, /另有 4 条未显示/);
  assert.equal(text.split('\n').length, 2);
});

test('默认预算 1200 字，多出来的条目标注省略', () => {
  const items = Array.from({ length: 40 }, (_, i) =>
    item({ id: 'm' + i, url: 'https://x.com/m/' + i, text: '第' + i + '条 ' + 'y'.repeat(50) }),
  );
  const text = digest(items);
  assert.ok(text.length <= 1200);
  assert.match(text, /另有 \d+ 条未显示/);
});

test('预算放不下第一条时只给省略说明', () => {
  const items = [item({ text: 'x'.repeat(200) })];
  const text = digest(items, { maxChars: 20 });
  assert.equal(text, '…（另有 1 条未显示）');
  assert.ok(text.length <= 20);
});

test('空数组返回空串（没有内容就不产生事件文本）', () => {
  assert.equal(digest([]), '');
  assert.equal(digest([] as LearnedItem[], { maxChars: 100 }), '');
});

test('非法 maxChars 退回默认值', () => {
  const text = digest([item()], { maxChars: Number.NaN });
  assert.equal(text, '· @elonmusk 2026-10-20 hello world');
});
