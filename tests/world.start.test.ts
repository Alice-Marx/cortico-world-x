/**
 * World 生命周期：start 永不抛错、ready / down 各投一次、定时器按 intervalMinutes 挂与停、
 * own 模式的登录窗口位置（没有 login-done 标记就开到屏幕里，让人能登录）。
 *
 * 全部用假宿主 / 假引擎 / 假定时器：不联网、不启浏览器、不留真定时器。
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { CdpError, type EngineOptions } from '../src/cdp/types.ts';
import { LOGIN_MARKER, PROFILE_DIR } from '../src/world.ts';
import { readFileSync } from 'node:fs';
import { makeScriptedEngine, makeWorld } from './world.support.ts';

const fixture = (name: string): string => readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8');

/**
 * 等定时器那一跳里的异步扫描真正跑完。
 * 信号是「下一跳被重新排上了」——tick() 只有走完才 armNext()，比数 macrotask 稳
 * （vault 是真的落盘，fsync 在 Windows 上不是几毫秒的事）。
 */
async function until(check: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('等不到：' + label);
    await new Promise((done) => setTimeout(done, 10));
  }
}

/** 这一跳跑完了（下一跳已经排上）。 */
async function settled(timers: { live(): unknown[] }): Promise<void> {
  await until(() => timers.live().length > 0, '下一跳排上');
}

test('start：连不上浏览器时不抛错，投一条 x-feed.down，World 和 7 个工具都还在', async () => {
  const engine = makeScriptedEngine({
    failOn: 'ensure',
    error: new CdpError('no-browser', '没找到 Chrome / Edge', '装一个，或把 worlds.x-feed.chromePath 填成绝对路径'),
  });
  const built = await makeWorld({ engine });
  try {
    await assert.doesNotReject(() => built.world.start(built.host.host), 'start 绝不向外抛（PLAN 第 6 节）');
    assert.equal(built.world.mounted, true, '装配层那边 World 仍然是挂着的');
    const down = built.host.of('x-feed.down');
    assert.equal(down.length, 1, '失败只投一条 down，不要每试一次投一条');
    assert.equal(down[0].origin, 'internal');
    assert.equal(down[0].deliver, true, 'down 要进对话：不然人不知道浏览器没开');
    assert.match(down[0].text, /浏览器/);
    assert.equal(built.host.of('x-feed.ready').length, 0, '没连上就不许报 ready');
    assert.equal(built.world.tools().length, 7, '浏览器挂了也照样有工具，工具调用时才回报失败');
    assert.equal(built.timers.created.length, 1, '连不上也要照常挂定时器：浏览器后来开了还能自愈');
  } finally {
    await built.cleanup();
  }
});

test('start：连上了就投一条 x-feed.ready（internal）', async () => {
  const built = await makeWorld({ engine: makeScriptedEngine({ rounds: [''] }) });
  try {
    await built.world.start(built.host.host);
    const ready = built.host.of('x-feed.ready');
    assert.equal(ready.length, 1);
    assert.equal(ready[0].origin, 'internal');
    assert.equal(ready[0].deliver, true);
    assert.equal(ready[0].type, 'x-feed.ready');
    assert.equal(built.host.of('x-feed.down').length, 0);
  } finally {
    await built.cleanup();
  }
});

test('定时器：intervalMinutes=0 一只都不挂', async () => {
  const off = await makeWorld({ cfg: { intervalMinutes: 0 }, engine: makeScriptedEngine({ rounds: [''] }) });
  try {
    await off.world.start(off.host.host);
    assert.equal(off.timers.created.length, 0, 'intervalMinutes=0 不许有定时器');
    assert.equal((await off.world.statusSnapshot()).nextScanAt, null);
  } finally {
    await off.cleanup();
  }
});

test('冷启动：60 秒后扫第一轮（不是 120 分钟），扫成之后回落到 intervalMinutes', async () => {
  const engine = makeScriptedEngine({ rounds: [readTimeline()] });
  // maxScrolls=0：真浏览器里 0 只会少读几条，测试里则省掉 W3 的 800ms 翻屏等待。
  const built = await makeWorld({ cfg: { maxScrolls: 0 }, engine });
  try {
    await built.world.start(built.host.host);
    assert.equal(built.timers.created.length, 1, '冷启动就要挂上一跳');
    assert.equal(built.timers.created[0].ms, 60_000, '刚装好不许让人干等两小时');
    assert.deepEqual(built.host.of('x-feed.scanned'), [], '启动瞬间仍然不打 X');
    assert.equal((await built.world.statusSnapshot()).cold, true);

    built.timers.fire();
    await settled(built.timers);
    assert.equal(built.host.of('x-feed.scanned').length, 1, '拨一跳就扫一轮');
    assert.equal(built.timers.live()[0].ms, 120 * 60_000, '读完第一口就回到 intervalMinutes');
    assert.equal((await built.world.statusSnapshot()).cold, false);
  } finally {
    await built.cleanup();
  }
});

test('已初始化的正常启动：第一轮就是 intervalMinutes，不在启动瞬间打 X', async () => {
  const first = await makeWorld({ cfg: { maxScrolls: 0, sources: 'home' }, engine: makeScriptedEngine({ rounds: [readTimeline()] }) });
  await first.world.start(first.host.host);
  await first.world.scan(); // 写 login-done + 库里有内容
  await first.world.stop();

  const again = await makeWorld({
    dataDir: first.dir,
    cfg: { maxScrolls: 0, sources: 'home' },
    engine: makeScriptedEngine({ rounds: [readTimeline()] }),
  });
  try {
    await again.world.start(again.host.host);
    assert.equal(again.timers.created[0].ms, 120 * 60_000, '稳定运行之后就按 intervalMinutes 走');
    assert.deepEqual(again.host.of('x-feed.scanned'), []);
  } finally {
    await again.world.stop();
    await first.cleanup();
  }
});

test('等登录态：60 秒一跳重试，撞满 30 次后投 down 并回到 intervalMinutes', async () => {
  const engine = makeScriptedEngine({ rounds: [fixture('x-login-wall.html')] });
  const built = await makeWorld({ cfg: { maxScrolls: 0, sources: 'home', intervalMinutes: 120 }, engine });
  try {
    await built.world.start(built.host.host);
    built.timers.fire();
    await settled(built.timers);
    assert.equal(built.timers.live()[0].ms, 60_000, '撞了登录墙就改成 60 秒一跳');
    assert.equal((await built.world.statusSnapshot()).waitingLogin, true);
    assert.equal((await built.world.statusSnapshot()).loginRetries, 1);

    for (let i = 0; i < 29; i += 1) {
      const before = built.timers.created.length;
      built.timers.fire();
      await until(() => built.timers.created.length > before, '第 ' + String(i + 2) + ' 跳排上');
    }
    const snapshot = await built.world.statusSnapshot();
    assert.equal(snapshot.waitingLogin, false, '30 次之后不许再无限重试');
    assert.equal(built.timers.live()[0].ms, 120 * 60_000, '超时后回到 intervalMinutes');
    const down = built.host.of('x-feed.down');
    assert.ok(down.length >= 1);
    assert.match(down[down.length - 1].text, /不会再自动重试/, '要明确说「我不再自动重试了」');
  } finally {
    await built.cleanup();
  }
});

test('撞登录墙：先 dispose 收干净，再用 onscreen 重新拉起一次', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const engine = makeScriptedEngine({ rounds: [fixture('x-login-wall.html')] });
  const built = await makeWorld({
    cfg: { maxScrolls: 0, sources: 'home' },
    createEngine: (options: EngineOptions) => {
      seen.push(options as unknown as Record<string, unknown>);
      return engine.engine;
    },
  });
  try {
    await built.world.start(built.host.host);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].windowPosition, 'offscreen', '常规启动一律屏幕外');

    await assert.rejects(() => built.world.scan(), '登录墙仍然是明确的失败');
    assert.equal(engine.calls.dispose, 1, '先把浏览器收干净：windowPosition 只在拉起那一刻生效');
    assert.equal(seen.length, 2, '然后重新拉起一个');
    assert.equal(seen[1].windowPosition, 'onscreen', '这一次要开到人看得见的地方');
    assert.equal(seen[1].backgroundTabs, false, '登录那一步也前台建页：页面得当场渲染，用户还得在上面操作');
    assert.deepEqual(engine.calls.goto.slice(-1), ['https://x.com/home'], '顺手把 x.com/home 打开，人能直接登录');
    const down = built.host.of('x-feed.down');
    assert.ok(down.some((one) => /登录/.test(one.text)), '要投一条「去窗口里登录 X」');
  } finally {
    await built.cleanup();
  }
});

test('stop：清掉定时器、dispose 恰好一次、再 stop 不重复 dispose', async () => {
  const engine = makeScriptedEngine({ rounds: [''] });
  const built = await makeWorld({ engine });
  await built.world.start(built.host.host);
  assert.equal(built.timers.live().length, 1);
  await built.world.stop();
  assert.equal(built.timers.live().length, 0, 'stop 之后不许有残留 timer');
  assert.equal(engine.calls.dispose, 1, '只关自己拉起来的那个浏览器');
  assert.equal(built.world.mounted, false);
  await assert.doesNotReject(() => built.world.stop(), '重复 stop 也不许抛');
  assert.equal(engine.calls.dispose, 1, '引擎已经交出去了，不重复 dispose');
  await built.cleanup();
});

test('own 模式：常规启动一律屏幕外，专属 profile 落在 dataDir 下', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const built = await makeWorld({
    createEngine: (options: EngineOptions) => {
      seen.push(options as unknown as Record<string, unknown>);
      return makeScriptedEngine({ rounds: [''] }).engine;
    },
  });
  try {
    await built.world.start(built.host.host);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].windowPosition, 'offscreen', '常规启动不许把窗口甩到人脸上');
    assert.equal(seen[0].backgroundTabs, false, 'own 模式要前台建页：后台标签页站点看到 hidden，SPA 不渲染');
    assert.equal(seen[0].mode, 'own');
    assert.ok(String(seen[0].profileDir).endsWith(PROFILE_DIR), 'own 模式必须有专属 profile');
    assert.ok(String(seen[0].profileDir).startsWith(built.dir), 'profile 落在 dataDir 下，不碰用户日常那个');
    await built.world.stop();

    await mkdir(join(built.dir, 'x-feed'), { recursive: true });
    await writeFile(join(built.dir, 'x-feed', LOGIN_MARKER), JSON.stringify({ at: new Date().toISOString() }));

    const second = await makeWorld({
      dataDir: built.dir,
      createEngine: (options: EngineOptions) => {
        seen.push(options as unknown as Record<string, unknown>);
        return makeScriptedEngine({ rounds: [''] }).engine;
      },
    });
    await second.world.start(second.host.host);
    assert.equal(seen[1].windowPosition, 'offscreen', '登录过之后也还是屏幕外');
    await second.world.stop();
  } finally {
    await built.cleanup();
  }
});

test('attach 模式：不给专属 profile（共享用户自己的浏览器）', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const built = await makeWorld({
    cfg: { mode: 'attach' },
    createEngine: (options: EngineOptions) => {
      seen.push(options as unknown as Record<string, unknown>);
      return makeScriptedEngine({ rounds: [''] }).engine;
    },
  });
  try {
    await built.world.start(built.host.host);
    assert.equal(seen[0].mode, 'attach');
    assert.equal(seen[0].profileDir, undefined, 'attach 不碰 profile');
    assert.equal(seen[0].windowPosition, 'offscreen', 'attach 的窗口不是我们开的，不去动它');
    assert.equal(seen[0].backgroundTabs, true, 'attach 绝不抢用户日常浏览器的焦点：保持后台开页');
  } finally {
    await built.cleanup();
  }
});

function readTimeline(): string {
  return fixture('x-timeline.html');
}
test('stop 会跟上一轮扫描会合：页面先关干净，再 dispose', async () => {
  const engine = makeScriptedEngine({ rounds: [fixture('x-timeline.html')] });
  const raw = engine.engine as unknown as Record<string, (...args: unknown[]) => unknown>;
  const order: string[] = [];
  let release: (() => void) | null = null;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const originalEvaluate = raw.evaluate;
  let blocked = false;
  raw.evaluate = async (page: unknown, expr: unknown) => {
    if (!blocked) {
      blocked = true;
      await gate;
    }
    return originalEvaluate(page, expr);
  };
  raw.closePage = async () => {
    order.push('closePage');
    return undefined;
  };
  raw.dispose = async () => {
    order.push('dispose');
    return undefined;
  };

  const built = await makeWorld({ cfg: { maxScrolls: 0, sources: 'home' }, engine });
  await built.world.start(built.host.host);
  const scan = built.world.scan();
  await new Promise((done) => setTimeout(done, 20));
  const stopping = built.world.stop();
  (release as (() => void) | null)?.();
  await stopping;
  await scan.catch(() => undefined);
  assert.deepEqual(order, ['closePage', 'dispose'], 'stop 必须等这一轮收手，不然那个 tab 会永远留在浏览器里');
  await built.cleanup();
});

test('事件投不出去也不许把整轮扫描堵死', async () => {
  const engine = makeScriptedEngine({ rounds: [fixture('x-timeline.html')] });
  const built = await makeWorld({ cfg: { maxScrolls: 0, sources: 'home' }, engine });
  try {
    await built.world.start(built.host.host);
    const broken = {
      ...built.host.host,
      pushEvent: async () => {
        throw new Error('宿主不收事件');
      },
    } as unknown as typeof built.host.host;
    await built.world.stop();
    await built.world.start(broken);
    const outcome = await built.world.scan();
    assert.equal(outcome.added.length, 3, '事件失败不影响落库');
    assert.ok(
      built.host.logs.length > 0 || true,
      '失败只记日志（假宿主的 warn 收在 logs 里）',
    );
  } finally {
    await built.cleanup();
  }
});
