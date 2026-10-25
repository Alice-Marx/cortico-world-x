/**
 * 扫描串起来的那条线：ensure → 逐源 readSource → LearnedItem → vault.put → 有新条目才 digest → 投事件。
 * 断言的是四件事：新条目真的入库、重复扫描不重复入库、digest 只在有新增时非空、事件每轮只投一次。
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { LOGIN_MARKER, SOURCES_FILE } from '../src/world.ts';
import { createVault } from '../src/learn/types.ts';
import { makeScriptedEngine, makeWorld } from './world.support.ts';
import { readFileSync } from 'node:fs';

const fixture = (name: string): string => readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8');

/** 时间线夹具里有三条帖子：@elonmusk、@NASA、@paulg（带引用推）。 */
const TIMELINE = fixture('x-timeline.html');
const LOGIN_WALL = fixture('x-login-wall.html');

test('一轮扫描：新条目入库、事件各投一条，正文用 digest 生成', async () => {
  const engine = makeScriptedEngine({ rounds: [TIMELINE] });
  const built = await makeWorld({ cfg: { maxScrolls: 0, sources: 'home' }, engine });
  try {
    await built.world.start(built.host.host);
    const outcome = await built.world.scan();

    assert.equal(outcome.perSource.length, 1, '一个源读成功');
    assert.equal(outcome.perSource[0].line, 'home');
    assert.equal(outcome.perSource[0].read, 3, '夹具里三条帖子');
    assert.equal(outcome.added.length, 3, '三条都是新的');
    assert.equal(outcome.added[0].author, 'elonmusk');
    assert.equal(outcome.added[0].source, 'home');
    assert.ok(outcome.added[0].id.length === 64, 'id 用 W4 的 learnedId（sha256(url)）');
    assert.deepEqual(outcome.added[0].metrics, { replies: 12, reposts: 34, likes: 1200 });

    const vault = createVault(join(built.dir, 'x-feed'));
    const stats = await vault.stats();
    assert.equal(stats.items, 3, '三条真的落进了知识库');
    assert.equal(stats.sources.home, 3);

    const posts = built.host.of('x-feed.posts');
    assert.equal(posts.length, 1, '有新内容才投摘要，且只投一条');
    assert.equal(posts[0].origin, 'external', '正文来自 X：origin 必须是 external');
    assert.equal(posts[0].trigger, 'debounce');
    assert.equal(posts[0].deliver, true);
    assert.match(posts[0].text, /elonmusk/, '摘要由 W4 的 digest 生成，带作者');
    assert.match(posts[0].text, /Starship/);

    const scanned = built.host.of('x-feed.scanned');
    assert.equal(scanned.length, 1, '一轮扫描记一条 scanned');
    assert.equal(scanned[0].deliver, false, 'scanned 只落库，不许吵醒对话');
    assert.equal(scanned[0].origin, 'internal');
  } finally {
    await built.cleanup();
  }
});

test('再扫一轮：added=0、不再投摘要、scanned 多一条', async () => {
  const engine = makeScriptedEngine({ rounds: [TIMELINE] });
  const built = await makeWorld({ cfg: { maxScrolls: 0, sources: 'home' }, engine });
  try {
    await built.world.start(built.host.host);
    const first = await built.world.scan();
    const second = await built.world.scan();

    assert.equal(first.added.length, 3);
    assert.equal(second.added.length, 0, '同样的内容不该再进一次库');
    assert.equal(second.skipped, 3, '跳过计数要照实说');
    assert.equal(built.host.of('x-feed.posts').length, 1, '没新增就没有摘要事件');
    assert.equal(built.host.of('x-feed.scanned').length, 2);

    const stats = await createVault(join(built.dir, 'x-feed')).stats();
    assert.equal(stats.items, 3, '重复扫描不会把库撑大');
  } finally {
    await built.cleanup();
  }
});

test('deliverDigest=false：摘要只落库、不投递，回执里说清', async () => {
  const engine = makeScriptedEngine({ rounds: [TIMELINE] });
  const built = await makeWorld({ cfg: { maxScrolls: 0, sources: 'home', deliverDigest: false }, engine });
  try {
    await built.world.start(built.host.host);
    const outcome = await built.world.scan();
    assert.equal(outcome.added.length, 3);
    const posts = built.host.of('x-feed.posts');
    assert.equal(posts.length, 1, '事件照样落库（留档），只是不投递');
    assert.equal(posts[0].deliver, false, 'deliver 受 cfg.deliverDigest 控制');
    assert.equal(outcome.delivered, false);
  } finally {
    await built.cleanup();
  }
});

test('空 url / 空 text 的条目在入库前就被丢掉，不惊动 vault 的 TypeError', async () => {
  const engine = makeScriptedEngine({
    envelope: {
      posts: [
        { url: '', text: '没有链接' },
        { url: 'https://x.com/a/status/9', text: '   ' },
        { url: 'https://x.com/a/status/10', text: '这一条是好的', author: 'alpha' },
      ],
      state: { articles: 3, text: '', loginWall: false, rateLimited: false },
    },
  });
  const built = await makeWorld({ cfg: { maxScrolls: 0, sources: 'home' }, engine });
  try {
    await built.world.start(built.host.host);
    const outcome = await built.world.scan();
    assert.equal(outcome.added.length, 1, '只有那条完整的能进库');
    assert.equal(outcome.added[0].url, 'https://x.com/a/status/10');
    const raw = await readFile(join(built.dir, 'x-feed', 'index.jsonl'), 'utf8');
    for (const line of raw.split(/\r?\n/).filter((one) => one.trim() !== '')) {
      const record = JSON.parse(line);
      assert.ok(String(record.url).length > 0 && String(record.text).length > 0, '库里不许出现空 url / 空 text');
    }
  } finally {
    await built.cleanup();
  }
});

test('撞登录墙：整轮失败按 login-required 抛、库还是空的、不写 login-done 标记', async () => {
  const engine = makeScriptedEngine({ rounds: [LOGIN_WALL] });
  const built = await makeWorld({ cfg: { maxScrolls: 0, sources: 'home' }, engine });
  try {
    await built.world.start(built.host.host);
    await assert.rejects(
      () => built.world.scan(),
      (error: { name?: string; code?: string }) => {
        assert.equal(error.name, 'XError');
        assert.equal(error.code, 'login-required');
        return true;
      },
      '登录墙是一件明确的失败，不是「读到 0 条」',
    );
    assert.equal((await createVault(join(built.dir, 'x-feed')).stats()).items, 0);
    await assert.rejects(() => readFile(join(built.dir, 'x-feed', LOGIN_MARKER)), '没登录成功就不许写标记');
    assert.equal(built.world.needsLogin, true, 'own 模式还等人登录一次');
  } finally {
    await built.cleanup();
  }
});

test('第一次没有登录墙的成功扫描写 login-done 标记，之后不再等人登录', async () => {
  const engine = makeScriptedEngine({ rounds: [TIMELINE] });
  const built = await makeWorld({ cfg: { maxScrolls: 0, sources: 'home' }, engine });
  try {
    await built.world.start(built.host.host);
    assert.equal(built.world.needsLogin, true);
    await built.world.scan();
    assert.equal(built.world.needsLogin, false, '扫通了说明登录态可用');
    const marker = JSON.parse(await readFile(join(built.dir, 'x-feed', LOGIN_MARKER), 'utf8'));
    assert.ok(typeof marker.at === 'string' && marker.at.length > 0);
  } finally {
    await built.cleanup();
  }
});

test('多源：一个源失败不拖垮另一个，失败的源进 failures', async () => {
  const engine = makeScriptedEngine({ rounds: [TIMELINE] });
  const built = await makeWorld({ cfg: { maxScrolls: 0, sources: 'user:alpha' }, engine });
  try {
    await built.world.start(built.host.host);
    const outcome = await built.world.scan({ sources: ['home', '这不是源'] });
    assert.equal(outcome.perSource.length, 1, '读得懂的源照读');
    assert.equal(outcome.failures.length, 1, '读不懂的行单独记一条');
    assert.match(String(outcome.failures[0].error.message), /读不懂/);
  } finally {
    await built.cleanup();
  }
});

test('游标：扫描时刻写进 state.json，重启后还认得上次扫描', async () => {
  const engine = makeScriptedEngine({ rounds: [TIMELINE] });
  const built = await makeWorld({ cfg: { maxScrolls: 0, sources: 'home' }, engine });
  try {
    await built.world.start(built.host.host);
    const outcome = await built.world.scan();
    const state = JSON.parse(await readFile(join(built.dir, 'x-feed', 'state.json'), 'utf8'));
    assert.equal(state.lastScanAt, outcome.at);
    assert.equal(state.scans, 1);

    const again = await makeWorld({ dataDir: built.dir, cfg: { maxScrolls: 0, sources: 'home' }, engine });
    await again.world.start(again.host.host);
    const snapshot = await again.world.statusSnapshot();
    assert.equal(snapshot.lastScanAt, outcome.at, '重启后游标还在');
    assert.equal(snapshot.scans, 1);
    await again.world.stop();
  } finally {
    await built.cleanup();
  }
});
test('本地覆盖读不懂：原文件留下（.bad-*），不静默清零也不炸', async () => {
  const built = await makeWorld({ cfg: { sources: 'home' }, engine: makeScriptedEngine({ rounds: [''] }) });
  try {
    await mkdir(join(built.dir, 'x-feed'), { recursive: true });
    await writeFile(join(built.dir, 'x-feed', SOURCES_FILE), '{ 这不是 JSON');
    const snapshot = await built.world.statusSnapshot();
    assert.deepEqual(snapshot.sources, ['home'], '坏文件不参与合并，但不许拖垮整个 World');
    const files = await readdir(join(built.dir, 'x-feed'));
    assert.ok(
      files.some((one) => one.startsWith(SOURCES_FILE + '.bad-')),
      '坏文件要改名留下来当证据：' + files.join(','),
    );
  } finally {
    await built.cleanup();
  }
});

test('游标读不懂：同样另存，不当成「从来没扫过」的静默结果', async () => {
  const built = await makeWorld({ cfg: { sources: 'home' }, engine: makeScriptedEngine({ rounds: [''] }) });
  try {
    await mkdir(join(built.dir, 'x-feed'), { recursive: true });
    await writeFile(join(built.dir, 'x-feed', 'state.json'), 'null');
    const snapshot = await built.world.statusSnapshot();
    assert.equal(snapshot.lastScanAt, null);
    const files = await readdir(join(built.dir, 'x-feed'));
    assert.ok(files.some((one) => one.startsWith('state.json.bad-')), '坏游标要留底：' + files.join(','));
  } finally {
    await built.cleanup();
  }
});
