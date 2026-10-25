import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, appendFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { createVault } from '../src/learn/types.ts';
import type { LearnedItem } from '../src/learn/types.ts';

const roots: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cw-x-learn-'));
  roots.push(dir);
  return dir;
}
after(async () => {
  for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

function item(patch: Partial<LearnedItem> = {}): LearnedItem {
  return {
    id: '1899',
    url: 'https://x.com/a/status/1899',
    author: 'elonmusk',
    text: 'AI agents are eating software',
    createdAt: '2026-10-20T08:00:00.000Z',
    learnedAt: '2026-10-20T09:00:00.000Z',
    source: 'user:elonmusk',
    ...patch,
  };
}

test('三件套落地：index.jsonl / notes/<YYYY-MM>.md / meta.json', async () => {
  const dir = await tempDir();
  const vault = createVault(dir);
  const result = await vault.put([item()]);
  assert.deepEqual(result, { added: 1, skipped: 0 });

  assert.ok(existsSync(join(dir, 'index.jsonl')), 'index.jsonl 必须存在');
  assert.ok(existsSync(join(dir, 'notes', '2026-10.md')), 'notes/2026-10.md 必须存在');
  assert.ok(existsSync(join(dir, 'meta.json')), 'meta.json 必须存在');

  const lines = (await readFile(join(dir, 'index.jsonl'), 'utf8')).split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), item());

  const notes = await readFile(join(dir, 'notes', '2026-10.md'), 'utf8');
  assert.match(notes, /^# 2026-10 · x-feed 学习笔记/);
  assert.match(notes, /^## 2026-10-20$/m, '按天小节');
  assert.match(notes, /- 09:00 · @elonmusk · user:elonmusk/);
  assert.match(notes, /链接：https:\/\/x\.com\/a\/status\/1899/);

  const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
  assert.equal(meta.items, 1);
  assert.equal(meta.bytes, (await stat(join(dir, 'index.jsonl'))).size);
  assert.equal(meta.lastLearnedAt, '2026-10-20T09:00:00.000Z');
  assert.deepEqual(meta.sources, { 'user:elonmusk': 1 });
});

test('去重：同 id 只写一次；缺 id 时退回 sha256(url)', async () => {
  const dir = await tempDir();
  const vault = createVault(dir);

  assert.deepEqual(await vault.put([item()]), { added: 1, skipped: 0 });
  assert.deepEqual(await vault.put([item({ text: '改了正文也还是同一条' })]), { added: 0, skipped: 1 });
  assert.equal(await vault.has('1899'), true);
  assert.equal(await vault.has('nope'), false);
  // 同批内重复同样只算一次
  assert.deepEqual(await vault.put([item({ id: '1900', url: 'https://x.com/a/status/1900' }), item({ id: '1900', url: 'https://x.com/a/status/1900' })]), { added: 1, skipped: 1 });

  const noId = { ...item({ url: 'https://x.com/b/status/7' }) } as Partial<LearnedItem>;
  delete noId.id;
  const hashed = createHash('sha256').update('https://x.com/b/status/7').digest('hex');
  assert.deepEqual(await vault.put([noId as LearnedItem]), { added: 1, skipped: 0 });
  assert.equal(await vault.has(hashed), true);
  assert.deepEqual(await vault.put([noId as LearnedItem]), { added: 0, skipped: 1 });

  const lines = (await readFile(join(dir, 'index.jsonl'), 'utf8')).split('\n').filter(Boolean);
  assert.equal(lines.length, 3);
});

test('并发 put 不撕裂：12 批 × 5 条并发，行数与可解析性都对', async () => {
  const dir = await tempDir();
  const vault = createVault(dir);
  const batches = Array.from({ length: 12 }, (_, b) =>
    Array.from({ length: 5 }, (_, i) =>
      item({
        id: 'p' + b + '-' + i,
        url: 'https://x.com/c/status/' + b + '-' + i,
        text: '并发写入批次 ' + b + ' 第 ' + i + ' 条，正文需要足够长以跨过单次 write 的可能边界。',
      }),
    ),
  );

  const results = await Promise.all(batches.map((batch) => vault.put(batch)));
  assert.equal(results.reduce((s, r) => s + r.added, 0), 60);
  assert.equal(results.reduce((s, r) => s + r.skipped, 0), 0);

  const raw = await readFile(join(dir, 'index.jsonl'), 'utf8');
  assert.ok(raw.endsWith('\n'), '每次 append 都以换行结束，不留半行');
  const lines = raw.split('\n').filter(Boolean);
  assert.equal(lines.length, 60);
  const ids = new Set<string>();
  for (const line of lines) {
    const parsed = JSON.parse(line); // 任何撕裂都会在这里炸
    assert.equal(typeof parsed.id, 'string');
    ids.add(parsed.id);
  }
  assert.equal(ids.size, 60);
  assert.equal((await vault.stats()).items, 60);
});

test('并发 put 撞同一 id：只有一个 added', async () => {
  const dir = await tempDir();
  const vault = createVault(dir);
  const results = await Promise.all([vault.put([item()]), vault.put([item()]), vault.put([item()])]);
  assert.equal(results.reduce((s, r) => s + r.added, 0), 1);
  assert.equal(results.reduce((s, r) => s + r.skipped, 0), 2);
  assert.equal((await vault.stats()).items, 1);
});

test('坏行/半截行不影响读取', async () => {
  const dir = await tempDir();
  const vault = createVault(dir);
  await vault.put([item()]);
  await appendFile(join(dir, 'index.jsonl'), '{"id":"torn","url":', 'utf8');
  const found = await vault.search('agents');
  assert.equal(found.length, 1);
  assert.equal((await vault.stats()).items, 1);
});

test('外部追加（另一个实例写文件）后能被看见', async () => {
  const dir = await tempDir();
  const a = createVault(dir);
  await a.put([item()]);
  const other = item({ id: '2000', url: 'https://x.com/d/status/2000', text: '外部追加的一条' });
  await appendFile(join(dir, 'index.jsonl'), JSON.stringify(other) + '\n', 'utf8');

  const stats = await a.stats();
  assert.equal(stats.items, 2);
  assert.equal(await a.has('2000'), true);
  const found = await a.search('外部追加');
  assert.equal(found.length, 1);
  assert.equal(found[0].id, '2000');
});

test('recent / stats 行为', async () => {
  const dir = await tempDir();
  const vault = createVault(dir);
  assert.deepEqual(await vault.stats(), { items: 0, bytes: 0, sources: {} });
  assert.deepEqual(await vault.recent(), []);
  assert.deepEqual(await vault.search('anything'), []);

  await vault.put([
    item({ id: 'a', learnedAt: '2026-10-01T00:00:00.000Z', source: 'user:elonmusk' }),
    item({ id: 'b', learnedAt: '2026-10-03T00:00:00.000Z', source: 'search:ai agents' }),
    item({ id: 'c', learnedAt: '2026-10-02T00:00:00.000Z', source: 'user:elonmusk' }),
  ]);
  assert.deepEqual((await vault.recent()).map((x) => x.id), ['b', 'c', 'a']);
  assert.deepEqual((await vault.recent(1)).map((x) => x.id), ['b']);

  const stats = await vault.stats();
  assert.equal(stats.items, 3);
  assert.equal(stats.lastLearnedAt, '2026-10-03T00:00:00.000Z');
  assert.deepEqual(stats.sources, { 'user:elonmusk': 2, 'search:ai agents': 1 });
  assert.equal(stats.bytes, (await stat(join(dir, 'index.jsonl'))).size);
});

test('镜像写失败不留 *.tmp，也不把已入库的数据判成失败', async () => {
  const dir = await tempDir();
  const vault = createVault(dir);
  await vault.put([item()]);

  // 把 meta.json 换成同名目录：writeAtomic 的 mkdir 会过，tmp 写完后 rename 必然失败（Windows: EPERM）
  await rm(join(dir, 'meta.json'));
  await mkdir(join(dir, 'meta.json'));

  assert.deepEqual(await vault.put([item({ id: 'after', url: 'https://x.com/a/status/after' })]), { added: 1, skipped: 0 });
  assert.equal((await vault.stats()).items, 2, 'index.jsonl 已 fsync，权威数据不能因为镜像失败而丢');

  const leftovers = (await readdir(dir)).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], '失败路径必须清掉临时文件');
  const noteLeftovers = (await readdir(join(dir, 'notes'))).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(noteLeftovers, []);
});

test('非法条目直接抛错，不落盘', async () => {
  const dir = await tempDir();
  const vault = createVault(dir);
  await assert.rejects(() => vault.put([item({ url: '   ' })]), /url/);
  await assert.rejects(() => vault.put([item({ text: '  ' })]), /text/);
  assert.equal((await vault.stats()).items, 0);
  assert.deepEqual(await readdir(dir), []);
  // 拒掉一次之后写入队列不能被毒死
  assert.deepEqual(await vault.put([item({ id: 'ok', url: 'https://x.com/ok/1' })]), { added: 1, skipped: 0 });
  assert.equal((await vault.stats()).items, 1);
});
