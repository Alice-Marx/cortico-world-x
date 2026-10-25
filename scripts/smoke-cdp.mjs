#!/usr/bin/env node
/**
 * 真浏览器冒烟：拉起专属 Chrome（端口 9333，profile 指到 %TEMP%\x-feed-smoke），
 * 开一个 data: 页面，读一段 DOM、截一张图、再走一次 file:// 的 goto，最后 dispose 并查收尸。
 *
 * 退出码 0 = PASS。脚本自己检查僵尸：跑前跑后各查一次 netstat 9333 + 带本 profile 的进程。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createEngine } from '../src/cdp/types.ts';
import { CdpWire } from '../src/cdp/wire.ts';
import { probeVersion } from '../src/cdp/own.ts';

const exec = promisify(execFile);

const PORT = 9333;
const PROFILE = join(tmpdir(), 'x-feed-smoke');
const PAGE_FILE = join(PROFILE, 'goto-page.html');
const DATA_URL = 'data:text/html,<h1>hi</h1><div id=t>42</div>';
const GOTO_URL = pathToFileURL(PAGE_FILE).href;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
let failed = 0;

function record(name, ok, detail) {
  if (!ok) failed += 1;
  checks.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail === undefined ? '' : `  →  ${detail}`}`);
}

async function run(file, args) {
  try {
    const { stdout } = await exec(file, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return stdout ?? '';
  } catch (err) {
    return err?.stdout ?? '';
  }
}

/** 谁在听这个端口（netstat -ano）。 */
async function listeners(port) {
  const out = await run('netstat', ['-ano']);
  const pids = new Set();
  const marker = new RegExp(`:${port}\\s`);
  for (const line of out.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    if (!marker.test(line)) continue;
    const columns = line.trim().split(/\s+/);
    const pid = Number(columns[columns.length - 1]);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

/** 命令行里带本 profile 的 chrome/msedge 进程（= 我们自己的，可以动手）。 */
async function profileProcs(profile) {
  const script =
    'Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\' or Name=\'msedge.exe\'" ' +
    `| Where-Object { $_.CommandLine -like '*${profile}*' } | ForEach-Object { $_.ProcessId }`;
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  return out
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function killPids(pids) {
  for (const pid of pids) {
    await run('taskkill', ['/pid', String(pid), '/T', '/F']);
  }
}

/** 端口空了 + 没有带本 profile 的进程，才算收干净。 */
async function snapshot() {
  return { ports: await listeners(PORT), procs: await profileProcs(PROFILE) };
}

async function waitClean(budgetMs) {
  const deadline = Date.now() + budgetMs;
  let last = await snapshot();
  while (Date.now() < deadline) {
    if (last.ports.length === 0 && last.procs.length === 0) return last;
    await sleep(300);
    last = await snapshot();
  }
  return last;
}

let page0 = null;

/**
 * 量窗口在屏幕上的真实位置与尺寸。
 *
 * 不能用页面里的 window.screenX/outerWidth：后台 tab 一律报 0（实测两个模式都是 0/0），
 * 测不出窗口在哪。真正的真相在 Browser.getWindowForTarget 给的 OS 窗口边界上 ——
 * 这里另开一条短连接的 CDP，问一句就关。
 */
async function windowPlacement(page) {
  const version = await probeVersion(PORT, 3000);
  if (!version) throw new Error('量窗口位置时探不到调试口');
  const wire = new CdpWire({ commandTimeoutMs: 5000 });
  await wire.connect(version.wsUrl, 5000);
  try {
    const got = await wire.send('Browser.getWindowForTarget', { targetId: page.targetId }, undefined, 5000);
    const bounds = got.bounds ?? {};
    return {
      x: typeof bounds.left === 'number' ? bounds.left : NaN,
      y: typeof bounds.top === 'number' ? bounds.top : NaN,
      w: typeof bounds.width === 'number' ? bounds.width : NaN,
      h: typeof bounds.height === 'number' ? bounds.height : NaN,
      state: typeof bounds.windowState === 'string' ? bounds.windowState : '',
    };
  } finally {
    await wire.close();
  }
}

/** 站点自己怎么看这个标签页：visibilityState + hasFocus（backgroundTabs 的唯一判据）。 */
async function siteVisibility(engine, page) {
  const raw = await engine.evaluate(
    page,
    'JSON.stringify({vis: document.visibilityState, focus: document.hasFocus()})',
  );
  return JSON.parse(String(raw));
}

async function main() {
  console.log(`cortico-world-x · CDP 冒烟  port=${PORT}  profile=${PROFILE}`);

  // 1. 前置：端口必须空；上次遗留（同 profile）的自己人先收拾掉
  const stale = await profileProcs(PROFILE);
  if (stale.length > 0) {
    console.log(`· 清理上次遗留的进程：${stale.join(', ')}`);
    await killPids(stale);
    await waitClean(8000);
  }
  const before = await snapshot();
  console.log(`· 跑前 netstat ${PORT}：${before.ports.length === 0 ? '空' : `被 pid ${before.ports.join(', ')} 占着`}`);
  if (before.ports.length !== 0) {
    record(`端口 ${PORT} 跑前必须是空的`, false, `被 pid ${before.ports.join(', ')} 占着，先关掉它再跑`);
    return;
  }
  record(`端口 ${PORT} 跑前是空的`, true);

  mkdirSync(PROFILE, { recursive: true });
  writeFileSync(PAGE_FILE, '<h1>goto ok</h1><div id=g>nav</div>', 'utf8');

  const engine = createEngine({ mode: 'own', port: PORT, profileDir: PROFILE, readyTimeoutMs: 30000 });
  try {
    await engine.ensure();
    const status = engine.status();
    console.log(`· status: ${JSON.stringify(status)}`);
    record('ensure：连上专属 Chrome', status.connected === true, status.browser);
    record('ensure：端点就是 127.0.0.1:' + PORT, status.endpoint === `http://127.0.0.1:${PORT}`, status.endpoint);

    const page = await engine.newPage(DATA_URL);
    page0 = page;
    console.log(`· newPage: ${JSON.stringify(page)}`);
    record('newPage 拿到 targetId', typeof page.targetId === 'string' && page.targetId.length > 0, page.targetId);

    const ready = await engine.waitReady(page, { timeoutMs: 15000 });
    record('waitReady：document.readyState 到 complete', ready === true);

    // 对照组的另一半在第 5 段（backgroundTabs:false）。两条合起来才是「这条能力的理由」。
    const hidden = await siteVisibility(engine, page);
    record(
      'backgroundTabs 默认（后台建页）：站点看到 hidden —— 所以需要下面那条能力',
      hidden.vis === 'hidden',
      `visibilityState=${hidden.vis} hasFocus=${hidden.focus}`,
    );

    const text = await engine.evaluate(page, 'document.getElementById("t").innerText');
    record('#t.innerText === "42"', text === '42', JSON.stringify(text));

    const href = await engine.evaluate(page, 'location.href');
    record('页面确实停在 data: 上', typeof href === 'string' && href.startsWith('data:text/html'), String(href).slice(0, 60));

    const where = await windowPlacement(page);
    record(
      '默认（offscreen）：窗口确实在屏幕外',
      where.x <= -10000 && where.y <= -10000,
      `窗口 left=${where.x} top=${where.y} ${where.state}`,
    );

    const shot = await engine.screenshot(page);
    record('截图字节数 > 1000', shot instanceof Uint8Array && shot.length > 1000, `${shot.length} bytes`);
    record('截图像是 PNG', shot.length > 8 && shot[0] === 0x89 && shot[1] === 0x50 && shot[2] === 0x4e && shot[3] === 0x47, `头 4 字节 ${[...shot.slice(0, 4)].join(',')}`);

    const nav = await engine.goto(page, GOTO_URL, { timeoutMs: 15000 });
    console.log(`· goto: ${JSON.stringify(nav)}`);
    record('goto(file://) 报 ok:true', nav.ok === true, nav.note ?? '');
    const navText = await engine.evaluate(page, 'document.getElementById("g").innerText');
    record('goto 之后新 DOM 读得到', navText === 'nav', JSON.stringify(navText));

    const pidBefore = await listeners(PORT);
    record('跑着的浏览器确实占着调试口', pidBefore.length > 0, `pid ${pidBefore.join(', ')}`);
    // 正向对照：现在浏览器明明在跑，僵尸检查必须查得到东西 —— 否则后面那句「没有残留」是空话
    const liveProcs = await profileProcs(PROFILE);
    record(
      '僵尸检查自身有效：跑着的时候查得到本 profile 的进程',
      liveProcs.length > 0,
      `pid ${liveProcs.join(', ')}`,
    );
  } finally {
    // 收尾前故意留一条命令在飞：dispose 必须让它立刻 reject，不能挂着
    // （前面某一步就失败时 page0 还是 null，跳过这条：别把原错误盖成 TypeError）
    if (page0) {
      const inFlight = engine.evaluate(
        page0,
        'new Promise((r) => setTimeout(() => r("late"), 5000))',
        { timeoutMs: 20000 },
      );
      await sleep(150);
      const settled = inFlight.then(
        (value) => ({ value }),
        (err) => ({ err }),
      );
      await engine.dispose();
      const outcome = await Promise.race([settled, sleep(3000).then(() => ({ hung: true }))]);
      record(
        'dispose 时在飞的命令被 reject 成 not-connected（不挂起）',
        outcome?.err?.code === 'not-connected',
        outcome?.hung ? '仍然挂着' : String(outcome?.err?.code ?? outcome?.value),
      );
    } else {
      await engine.dispose();
    }
    // dispose 自己就该收干净：查得到残留就是 dispose 的失败（这里顺手也收掉，不留给机器）
    const leftovers = await profileProcs(PROFILE);
    record(
      'dispose 自己就收干净了（不需要兜底扫尾）',
      leftovers.length === 0,
      leftovers.length > 0 ? `还留着 pid ${leftovers.join(', ')}` : '',
    );
    if (leftovers.length > 0) await killPids(leftovers);
    record('dispose 之后 status().connected === false', engine.status().connected === false);
  }

  // 2. 后置：端口与进程都得干净
  const after = await waitClean(15000);
  console.log(`· 跑后 netstat ${PORT}：${after.ports.length === 0 ? '空' : `还被 pid ${after.ports.join(', ')} 占着`}`);
  record(`收尸：端口 ${PORT} 已释放`, after.ports.length === 0, after.ports.join(', '));
  record('收尸：没有带本 profile 的进程残留', after.procs.length === 0, after.procs.join(', '));
  record('profile 目录还在（下次可复用）', existsSync(PROFILE), PROFILE);

  // 3. 复用复测：own 模式下端口已经被占且连得上 → 复用，不重复拉；dispose 也不许杀别人的
  const owner = createEngine({ mode: 'own', port: PORT, profileDir: PROFILE });
  const reuser = createEngine({ mode: 'own', port: PORT, profileDir: PROFILE });
  try {
    await owner.ensure();
    const listenersFirst = await listeners(PORT);
    record('复用复测：owner 拉起了浏览器', listenersFirst.length > 0, `pid ${listenersFirst.join(',')}`);

    await reuser.ensure();
    const listenersSecond = await listeners(PORT);
    record(
      '复用复测：端口已被占时复用，没有重复拉',
      listenersSecond.length > 0 && listenersSecond.join(',') === listenersFirst.join(','),
      `${listenersSecond.join(',')} vs ${listenersFirst.join(',')}`,
    );

    await reuser.dispose();
    const aliveAfterReuser = await listeners(PORT);
    record(
      '复用复测：复用者的 dispose 不杀别人的浏览器',
      aliveAfterReuser.length > 0,
      `pid ${aliveAfterReuser.join(',')}`,
    );
  } finally {
    await reuser.dispose();
    await owner.dispose();
  }

  const cleaned = await waitClean(15000);
  record('复用复测之后同样收干净', cleaned.ports.length === 0 && cleaned.procs.length === 0,
    cleaned.ports.length === 0 ? `残留进程 ${cleaned.procs.join(',')}` : `端口还被 ${cleaned.ports.join(',')} 占着`);

  // 4. onscreen：窗口必须进屏幕内，用户才能在这个专属 profile 里登录 X —— 否则 own 模式是死的
  const visible = createEngine({ mode: 'own', port: PORT, profileDir: PROFILE, windowPosition: 'onscreen' });
  try {
    await visible.ensure();
    const page = await visible.newPage('data:text/html,<h1>visible</h1><div id=ok>1</div>');
    await visible.waitReady(page, { timeoutMs: 15000 });
    const at = await windowPlacement(page);
    console.log(`· onscreen 窗口: left=${at.x} top=${at.y} 尺寸 ${at.w}x${at.h} ${at.state}`);
    record(
      'onscreen：窗口进了屏幕内（不是 -32000，用户看得见）',
      at.x > -1000 && at.y > -1000 && Math.abs(at.x) < 3000 && Math.abs(at.y) < 3000,
      `窗口 left=${at.x} top=${at.y}`,
    );
    record(
      'onscreen：尺寸仍是 1100x800',
      at.w >= 1000 && at.w <= 1200 && at.h >= 700 && at.h <= 900,
      `${at.w}x${at.h}`,
    );
  } finally {
    await visible.dispose();
  }
  const cleanedVisible = await waitClean(15000);
  record(
    'onscreen 之后同样收干净（窗口待遇不改变收尸行为）',
    cleanedVisible.ports.length === 0 && cleanedVisible.procs.length === 0,
    cleanedVisible.ports.length === 0
      ? `残留进程 ${cleanedVisible.procs.join(',')}`
      : `端口还被 ${cleanedVisible.ports.join(',')} 占着`,
  );

  // 5. backgroundTabs:false：站点必须看到 visible。SPA（X 就是）在 hidden 下常常不渲染时间线，
  //    所以这条能力的存在理由要在这里被测出来 —— 注意窗口仍然留在屏幕外，两件事互不影响。
  const focused = createEngine({
    mode: 'own',
    port: PORT,
    profileDir: PROFILE,
    backgroundTabs: false,
  });
  try {
    await focused.ensure();
    const page = await focused.newPage('data:text/html,<h1>fg</h1><div id=v>x</div>');
    await focused.waitReady(page, { timeoutMs: 15000 });
    const shown = await siteVisibility(focused, page);
    const at = await windowPlacement(page);
    console.log(
      `· backgroundTabs:false → visibilityState=${shown.vis} hasFocus=${shown.focus} 窗口 left=${at.x}`,
    );
    record(
      'backgroundTabs:false（前台建页）：站点看到 visible —— SPA 才会当场渲染',
      shown.vis === 'visible',
      `visibilityState=${shown.vis} hasFocus=${shown.focus}`,
    );
    record(
      'backgroundTabs:false 不改变窗口位置（仍在屏幕外，不晃到用户）',
      at.x <= -10000 && at.y <= -10000,
      `窗口 left=${at.x} top=${at.y}`,
    );
  } finally {
    await focused.dispose();
  }
  const cleanedFocused = await waitClean(15000);
  record(
    'backgroundTabs:false 之后同样收干净',
    cleanedFocused.ports.length === 0 && cleanedFocused.procs.length === 0,
    cleanedFocused.ports.length === 0
      ? `残留进程 ${cleanedFocused.procs.join(',')}`
      : `端口还被 ${cleanedFocused.ports.join(',')} 占着`,
  );
}

let exitCode = 1;
try {
  await main();
  exitCode = failed === 0 ? 0 : 1;
} catch (err) {
  console.error('✗ 冒烟抛错：', err);
  exitCode = 1;
}

console.log('');
console.log(`${exitCode === 0 ? 'PASS' : 'FAIL'} — ${checks.filter((c) => c.ok).length}/${checks.length} 项通过`);
for (const item of checks) {
  if (!item.ok) console.log(`  ✗ ${item.name}${item.detail ? `  →  ${item.detail}` : ''}`);
}
process.exitCode = exitCode;
// 兜底退出：万一有 keepalive 句柄把事件循环挂着
const bail = setTimeout(() => process.exit(exitCode), 2000);
bail.unref();
