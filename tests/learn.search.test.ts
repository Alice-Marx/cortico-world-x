import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createVault } from '../src/learn/types.ts';
import type { LearnedItem } from '../src/learn/types.ts';

const roots: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cw-x-search-'));
  roots.push(dir);
  return dir;
}
after(async () => {
  for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

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

test('中文不分词：整串查询按 2 字滑窗命中', async () => {
  const dir = await tempDir();
  const vault = createVault(dir);
  await vault.put([
    item({ id: 'zh1', text: '人工智能正在改变软件工程的协作方式', source: 'search:ai' }),
    item({ id: 'zh2', text: '今天种了一棵树，雨水很好', source: 'search:life' }),
  ]);
  const hit = await vault.search('人工智能');
  assert.deepEqual(hit.map((x) => x.id), ['zh1']);

  const bigramOnly = await vault.search('软件工程');
  assert.deepEqual(bigramOnly.map((x) => x.id), ['zh1'], '4 字查询靠滑窗命中');

  const short = await vault.search('雨水');
  assert.deepEqual(short.map((x) => x.id), ['zh2'], '2 字查询整段命中');
});

test('英文按词：完整词命中，不命中词内变体', async () => {
  const dir = await tempDir();
  const vault = createVault(dir);
  await vault.put([
    item({ id: 'en1', text: 'AI agents are eating software' }),
    item({ id: 'en2', text: 'agentic workflows everywhere' }),
  ]);
  const hit = await vault.search('agents');
  assert.deepEqual(hit.map((x) => x.id), ['en1']);
  const agentic = await vault.search('agentic');
  assert.deepEqual(agentic.map((x) => x.id), ['en2']);
});

test('作者命中：正文没提到 handle 也能靠作者召回', async () => {
  const dir = await tempDir();
  const vault = createVault(dir);
  await vault.put([
    item({ id: 'au1', author: 'elonmusk', text: 'rocket go brrr' }),
    item({ id: 'au2', author: 'someone', text: 'rocket science is hard' }),
  ]);
  const hit = await vault.search('elonmusk');
  assert.deepEqual(hit.map((x) => x.id), ['au1']);
});

test('命中数越多排越前', async () => {
  const dir = await tempDir();
  const vault = createVault(dir);
  await vault.put([
    item({ id: 'one', text: 'rust 语言' }),
    item({ id: 'two', text: 'rust rust rust 与 rust 生态' }),
  ]);
  const ranked = await vault.search('rust');
  assert.deepEqual(ranked.map((x) => x.id), ['two', 'one']);
});

test('时间衰减：同分时新条目靠前', async () => {
  const dir = await tempDir();
  const vault = createVault(dir);
  await vault.put([
    item({ id: 'old', text: 'memory 系统', learnedAt: '2024-01-01T00:00:00.000Z' }),
    item({ id: 'new', text: 'memory 系统', learnedAt: new Date().toISOString() }),
  ]);
  const ranked = await vault.search('memory');
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].id, 'new');
});

test('limit 默认 10，可显式收窄', async () => {
  const dir = await tempDir();
  const vault = createVault(dir);
  const batch = Array.from({ length: 12 }, (_, i) =>
    item({ id: 'l' + i, url: 'https://x.com/l/' + i, text: 'token 命中 ' + i }),
  );
  await vault.put(batch);
  assert.equal((await vault.search('token')).length, 10);
  assert.equal((await vault.search('token', { limit: 3 })).length, 3);
});

test('单条正文截断防爆 token，但库里原文不动', async () => {
  const dir = await tempDir();
  const vault = createVault(dir);
  const long = 'y'.repeat(2000);
  await vault.put([item({ id: 'long', text: long, url: 'https://x.com/long/1' })]);
  const [hit] = await vault.search('yyyy');
  assert.equal(hit.text.length, 400);
  assert.ok(hit.text.endsWith('…'));
  const [stored] = await vault.recent();
  assert.equal(stored.text.length, 2000, 'recent/导出要拿全文');
});

test('空查询退回 recent 而不是空数组', async () => {
  const dir = await tempDir();
  const vault = createVault(dir);
  await vault.put([item({ id: 'r1', learnedAt: '2026-10-01T00:00:00.000Z' }), item({ id: 'r2', learnedAt: '2026-10-05T00:00:00.000Z' })]);
  assert.deepEqual((await vault.search('   ')).map((x) => x.id), ['r2', 'r1']);
});
