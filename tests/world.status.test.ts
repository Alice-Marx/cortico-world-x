/**
 * x_status 的「别报假警」回归测试（真机踩过：登录成功后一切正常，回执却说连接检查报错）。
 *
 * 三条底线：
 * ① 连接成没成由本实例的引擎状态机说了算，引擎自己那份 status() 里的历史遗留错误不许当现状；
 * ② 引擎换代（登录要 dispose 再建）时，旧状态不许跨代——重建那一刻既不是错误，也没有可报的现状；
 * ③ 「不报假警」不等于「永不报错」：真的连不上时照样要按 5 类之一说清楚。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { CdpError } from '../src/cdp/types.ts';
import { FAILURE_LABEL } from '../src/tools/receipt.ts';
import { makeScriptedEngine, makeWorld, callTool } from './world.support.ts';
import { readFileSync } from 'node:fs';

const fixture = (name: string): string => readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8');

/** 回执里一条失败分类都不许有：这是「一切正常」的场面。 */
function assertNoFailureClaim(text: string): void {
  assert.ok(!text.includes('[失败'), '正常状态里不许出现失败回执：' + text);
  for (const label of Object.values(FAILURE_LABEL)) {
    assert.ok(!text.includes('没连上（' + label + '）'), '正常状态里不许说「没连上（' + label + '）」：' + text);
  }
  assert.ok(!text.includes('报错'), '正常状态里不许说报错：' + text);
}

test('假报警回归：引擎 status() 带着历史遗留错误，扫成功之后 x_status 一个字都不许提错', async () => {
  const engine = makeScriptedEngine({
    rounds: [fixture('x-timeline.html')],
    staleStatusError: { code: 'ws-failed', message: '上一代引擎留下的失败' },
  });
  const built = await makeWorld({ cfg: { maxScrolls: 0, sources: 'home' }, engine });
  try {
    await built.world.start(built.host.host);
    await built.world.scan();
    const snapshot = await built.world.statusSnapshot();
    assert.equal(snapshot.browser.connected, true, '这一代引擎是连着的');
    assert.equal(snapshot.browser.error, undefined, '连上了就不许带 error');

    const receipt = await callTool(built.world, 'x_status');
    assert.match(receipt.text, /\[浏览器\] 已连上/);
    assertNoFailureClaim(receipt.text);
    assert.match(receipt.text, /\[知识库\] 3 条/);
  } finally {
    await built.cleanup();
  }
});

test('先失败后成功：ensure 第二次成功后 status 里不许再留着上一次的错误', async () => {
  const engine = makeScriptedEngine({ rounds: [fixture('x-timeline.html')], ensureFailsTimes: 1 });
  const built = await makeWorld({ cfg: { maxScrolls: 0, sources: 'home' }, engine });
  try {
    await built.world.start(built.host.host);
    const failed = await built.world.statusSnapshot();
    assert.equal(failed.browser.connected, false, '第一次确实没连上');
    assert.ok(failed.browser.error && failed.browser.error.message.length > 0, '这时该如实报错');

    const receipt = await callTool(built.world, 'x_look');
    assert.equal(receipt.failed, false, '第二次 ensure 成功，扫描应当成功');

    const snapshot = await built.world.statusSnapshot();
    assert.equal(snapshot.browser.connected, true);
    assert.equal(snapshot.browser.error, undefined, '成功了就要把旧账清干净');
    assert.equal(snapshot.lastFailure, null);
    assertNoFailureClaim((await callTool(built.world, 'x_status')).text);
  } finally {
    await built.cleanup();
  }
});

test('重建中：dispose 之后、新引擎 ensure 还没回来时，status 说「正在准备」，不是报错', async () => {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const first = makeScriptedEngine({ rounds: [fixture('x-login-wall.html')] });
  const second = makeScriptedEngine({ rounds: [fixture('x-login-wall.html')], ensureGate: () => gate });
  const queue = [first, second];
  const built = await makeWorld({
    cfg: { maxScrolls: 0, sources: 'home' },
    createEngine: () => queue.shift()!.engine,
  });
  try {
    await built.world.start(built.host.host);
    const scan = built.world.scan(); // 撞登录墙 → dispose → 用 onscreen 重开（第二个引擎，卡在 ensure）
    scan.catch(() => undefined);

    let phase = '';
    for (let i = 0; i < 200 && phase !== 'connecting'; i += 1) {
      await new Promise((done) => setTimeout(done, 5));
      phase = (await built.world.statusSnapshot()).enginePhase;
    }
    assert.equal(phase, 'connecting', '这一刻确实处在重建窗口里');

    const receipt = await callTool(built.world, 'x_status');
    assert.match(receipt.text, /正在准备（重建中）/, '重建中要这么说');
    assertNoFailureClaim(receipt.text);
    assert.ok(!receipt.text.includes('没连上'), '重建中不算「没连上」');

    (release as (() => void) | null)?.();
    await scan.catch(() => undefined);
    const after = await built.world.statusSnapshot();
    assert.equal(after.enginePhase, 'ready', 'ensure 回来之后就是就绪');
    assert.equal(after.browser.error, undefined, '就绪之后不许带 error');
    assert.match((await callTool(built.world, 'x_status')).text, /\[浏览器\] 已连上/);
  } finally {
    await built.cleanup();
  }
});

test('不报假警 ≠ 永不报错：真的连不上时照样按 5 类说清楚', async () => {
  const engine = makeScriptedEngine({ failOn: 'ensure', error: new CdpError('no-browser', '没找到 Chrome / Edge') });
  const built = await makeWorld({ engine });
  try {
    await built.world.start(built.host.host);
    const receipt = await callTool(built.world, 'x_status');
    assert.match(receipt.text, /\[浏览器\] 没连上（连不上浏览器）/);
    assert.match(receipt.text, /\[该做什么\]/);
  } finally {
    await built.cleanup();
  }
});
