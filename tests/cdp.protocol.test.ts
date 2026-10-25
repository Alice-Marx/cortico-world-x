/**
 * src/cdp 的单元测试。零第三方依赖：假 ws 按 WS 帧语义手写（onopen/onmessage/onclose +
 * JSON 帧），HTTP 发现口用真的 node:http 顶着 —— 除了一张假 ws，链路都是真的。
 *
 * 覆盖 PLAN 3.1 必须成立的四条：id 匹配、sessionId 路由、超时 reject、断连时挂起 promise 全 reject。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CdpWire } from '../src/cdp/wire.ts';
import { CdpError } from '../src/cdp/error.ts';
import { createEngine, type BrowserEngine } from '../src/cdp/types.ts';
import { assertBrowserPathTrusted, browserCandidates, ownBrowserArgs, OwnBrowser } from '../src/cdp/own.ts';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WS_OPEN = 1;
const WS_CLOSED = 3;

/** 手写的假 WebSocket：只提供 CdpWire 用到的那几样。 */
class FakeSocket {
  readonly url: string;
  readyState = 0;
  /** 客户端发出去的帧（已解析）。 */
  sent: any[] = [];
  #listeners = new Map<string, Set<(ev: any) => void>>();

  constructor(url: string, openDelayMs = 0) {
    this.url = url;
    // 异步开：连接真 ws 也是异步的，同步开会掩盖竞态。延时用来复现「ensure 卡在建链」。
    setTimeout(() => this.serverOpen(), openDelayMs);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.serverClose();
  }

  addEventListener(type: string, listener: (ev: any) => void): void {
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (ev: any) => void): void {
    this.#listeners.get(type)?.delete(listener);
  }

  emit(type: string, ev: any): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) listener(ev);
  }

  // ——— 服务端动作 ———

  serverOpen(): void {
    if (this.readyState !== 0) return;
    this.readyState = WS_OPEN;
    this.emit('open', {});
  }

  serverSend(message: any): void {
    this.emit('message', { data: JSON.stringify(message) });
  }

  serverClose(): void {
    if (this.readyState === WS_CLOSED) return;
    this.readyState = WS_CLOSED;
    this.emit('close', {});
  }

  get last(): any {
    return this.sent[this.sent.length - 1];
  }

  frames(method: string): any[] {
    return this.sent.filter((frame) => frame.method === method);
  }
}

/** 让假 ws 按表自动回执；处理不到的方法就一直挂着（正好用来测超时）。 */
function autoRespond(socket: FakeSocket, table: Record<string, (frame: any) => any>): void {
  const original = socket.send.bind(socket);
  socket.send = (data: string): void => {
    original(data);
    const frame = socket.last;
    const handler = table[frame.method];
    if (!handler) return;
    const result = handler(frame);
    if (result === undefined) return;
    setTimeout(() => {
      if (result && typeof result === 'object' && '__error' in result) {
        socket.serverSend({ id: frame.id, error: result.__error });
      } else {
        socket.serverSend({ id: frame.id, result });
      }
    }, 0);
  };
}

/** 最近一个假 socket：工厂每次建新的，测试里紧跟着取（同一个文件里测试是顺序跑的）。 */
let lastSocket: FakeSocket | null = null;

function nextSocket(url: string, openDelayMs = 0): FakeSocket {
  const socket = new FakeSocket(url, openDelayMs);
  lastSocket = socket;
  return socket;
}

function currentSocket(): FakeSocket {
  if (!lastSocket) assert.fail('还没建过假 ws');
  return lastSocket;
}

async function waitFor(predicate: () => boolean, what: string, budgetMs = 2000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`等不到：${what}`);
}

// ——— PLAN 3.1 的四条硬要求 ———

test('id 匹配：回执乱序回来也各归各家，回完之后不残留挂起', async () => {
  const wire = new CdpWire({ webSocket: nextSocket });
  await wire.connect('ws://fake/1', 1000);
  const sock = currentSocket();

  const first = wire.send('A.run');
  const second = wire.send('B.run');
  assert.deepEqual(
    sock.sent.map((frame) => frame.id),
    [1, 2],
  );
  assert.equal(sock.sent[0].method, 'A.run');
  assert.equal('sessionId' in sock.sent[0], false, '浏览器级命令不该带 sessionId');
  assert.equal(wire.pendingCount, 2);

  sock.serverSend({ id: 2, result: { from: 'B' } });
  sock.serverSend({ id: 1, result: { from: 'A' } });
  assert.deepEqual(await first, { from: 'A' });
  assert.deepEqual(await second, { from: 'B' });
  assert.equal(wire.pendingCount, 0);
  await wire.close();
});

test('sessionId 路由：attach 一次、复用、每个 target 各自的会话', async () => {
  const wire = new CdpWire({ webSocket: nextSocket });
  await wire.connect('ws://fake/2', 1000);
  const sock = currentSocket();

  const first = wire.sessionFor('T1');
  await waitFor(() => sock.frames('Target.attachToTarget').length === 1, 'T1 的 attach 帧');
  const attach = sock.frames('Target.attachToTarget')[0];
  assert.equal('sessionId' in attach, false, 'attach 是浏览器级命令');
  assert.deepEqual(attach.params, { targetId: 'T1', flatten: true });
  sock.serverSend({ id: attach.id, result: { sessionId: 'S1' } });
  assert.equal(await first, 'S1');

  // 复用：同一个 target 不再 attach
  assert.equal(await wire.sessionFor('T1'), 'S1');
  assert.equal(sock.frames('Target.attachToTarget').length, 1);

  // 该 target 上的命令走 S1
  const evaluated = wire.send('Runtime.evaluate', { expression: '1' }, 'S1');
  await waitFor(() => sock.frames('Runtime.evaluate').length === 1, 'Runtime.evaluate 帧');
  const command = sock.frames('Runtime.evaluate')[0];
  assert.equal(command.sessionId, 'S1');
  sock.serverSend({ id: command.id, result: { result: { value: 1 } } });
  assert.deepEqual(await evaluated, { result: { value: 1 } });

  // 另一个 target 拿自己的会话
  const second = wire.sessionFor('T2');
  await waitFor(() => sock.frames('Target.attachToTarget').length === 2, 'T2 的 attach 帧');
  sock.serverSend({ id: sock.frames('Target.attachToTarget')[1].id, result: { sessionId: 'S2' } });
  assert.equal(await second, 'S2');
  assert.notEqual('S2', 'S1');
  await wire.close();
});

test('detachedFromTarget 会作废缓存：下一条命令重新 attach', async () => {
  const wire = new CdpWire({ webSocket: nextSocket });
  await wire.connect('ws://fake/3', 1000);
  const sock = currentSocket();

  const first = wire.sessionFor('T1');
  await waitFor(() => sock.frames('Target.attachToTarget').length === 1, '第一次 attach');
  sock.serverSend({ id: sock.frames('Target.attachToTarget')[0].id, result: { sessionId: 'S1' } });
  assert.equal(await first, 'S1');

  sock.serverSend({ method: 'Target.detachedFromTarget', params: { sessionId: 'S1', targetId: 'T1' } });
  const again = wire.sessionFor('T1');
  await waitFor(() => sock.frames('Target.attachToTarget').length === 2, '第二次 attach');
  sock.serverSend({ id: sock.frames('Target.attachToTarget')[1].id, result: { sessionId: 'S9' } });
  assert.equal(await again, 'S9');
  await wire.close();
});

test('超时：没回话的命令按 timeout reject，后面还能接着用', async () => {
  const wire = new CdpWire({ webSocket: nextSocket });
  await wire.connect('ws://fake/4', 1000);
  const sock = currentSocket();

  await assert.rejects(wire.send('Slow.run', {}, undefined, 40), (err: unknown) => {
    assert.ok(err instanceof CdpError);
    assert.equal(err.code, 'timeout');
    assert.match(err.message, /Slow\.run/);
    assert.ok(err.hint && err.hint.length > 10);
    return true;
  });
  assert.equal(wire.pendingCount, 0, '超时的命令不能留在表里');

  const next = wire.send('Next.run', {}, undefined, 500);
  await waitFor(() => sock.frames('Next.run').length === 1, 'Next.run 帧');
  sock.serverSend({ id: sock.frames('Next.run')[0].id, result: { fine: true } });
  assert.deepEqual(await next, { fine: true });
  assert.equal(wire.pendingCount, 0);
  await wire.close();
});

test('断连：所有挂起的命令立刻被 reject 成 not-connected', async () => {
  const wire = new CdpWire({ webSocket: nextSocket });
  await wire.connect('ws://fake/5', 1000);
  const sock = currentSocket();

  const first = wire.send('A.run');
  const second = wire.send('B.run');
  // 先挂上断言（同步），再模拟对端关连接，避免未处理的 rejection
  const claims = [
    assert.rejects(first, (err: unknown) => err instanceof CdpError && err.code === 'not-connected'),
    assert.rejects(second, (err: unknown) => err instanceof CdpError && err.code === 'not-connected'),
  ];
  sock.serverClose();
  await Promise.all(claims);
  assert.equal(wire.pendingCount, 0);
  assert.equal(wire.isOpen, false);

  await assert.rejects(
    wire.send('C.run'),
    (err: unknown) => err instanceof CdpError && err.code === 'not-connected',
  );
});

test('浏览器报错：cdp-failed + 人话 hint；页面没了归 page-failed', async () => {
  const wire = new CdpWire({ webSocket: nextSocket });
  await wire.connect('ws://fake/6', 1000);
  const sock = currentSocket();

  const rejected = wire.send('Runtime.evaluate', { expression: '1' }, 'S1', 2000);
  await waitFor(() => sock.frames('Runtime.evaluate').length === 1, 'Runtime.evaluate 帧');
  sock.serverSend({
    id: sock.frames('Runtime.evaluate')[0].id,
    error: { code: -32000, message: 'Something odd happened' },
  });
  await assert.rejects(rejected, (err: unknown) => {
    assert.ok(err instanceof CdpError);
    assert.equal(err.code, 'cdp-failed');
    assert.match(err.message, /Something odd happened/);
    assert.ok(err.hint);
    return true;
  });

  const attachFailed = wire.sessionFor('GONE', 2000);
  await waitFor(() => sock.frames('Target.attachToTarget').length === 1, 'attach 帧');
  sock.serverSend({
    id: sock.frames('Target.attachToTarget')[0].id,
    error: { code: -32602, message: 'No target with given id found' },
  });
  await assert.rejects(attachFailed, (err: unknown) => {
    assert.ok(err instanceof CdpError);
    assert.equal(err.code, 'page-failed');
    return true;
  });
  await wire.close();
});

// ——— 引擎层：真的 HTTP 发现口 + 假 ws ———

async function versionServer(bindPort = 0): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const address = server.address() as AddressInfo;
    if (req.url === '/json/version') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          Browser: 'Chrome/999.0.0.0',
          webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/devtools/browser/fake`,
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(bindPort, '127.0.0.1', () => resolve()));
  // unref：某条测试失败、没走到 close() 时，别让这个监听句柄把测试进程一直吊着
  server.unref();
  const { port } = server.address() as AddressInfo;
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function freePort(): Promise<number> {
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

interface FakeEngine {
  engine: BrowserEngine;
  table: Record<string, (frame: any) => any>;
  sock: () => FakeSocket;
  port: number;
  close: () => Promise<void>;
}

async function fakeEngine(): Promise<FakeEngine> {
  const server = await versionServer();
  const table: Record<string, (frame: any) => any> = {
    'Target.setDiscoverTargets': () => ({}),
    'Page.enable': () => ({}),
  };
  let socket: FakeSocket | null = null;
  const engine = createEngine({
    mode: 'attach',
    port: server.port,
    commandTimeoutMs: 3000,
    webSocket: (url: string) => {
      socket = nextSocket(url);
      autoRespond(socket, table);
      return socket;
    },
  });
  return {
    engine,
    table,
    port: server.port,
    sock: () => {
      if (!socket) assert.fail('还没建 ws');
      return socket;
    },
    close: server.close,
  };
}

test('engine：ensure 走 /json/version + ws，status 报上 mode/endpoint/browser', async () => {
  const { engine, sock, close } = await fakeEngine();
  await engine.ensure();
  const status = engine.status();
  assert.equal(status.connected, true);
  assert.equal(status.mode, 'attach');
  assert.match(String(status.endpoint), /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(status.browser, 'Chrome/999.0.0.0');
  assert.equal(status.error, undefined);
  assert.deepEqual(
    sock().frames('Target.setDiscoverTargets')[0].params,
    { discover: true },
    'PLAN 要求 Target.setDiscoverTargets',
  );
  await engine.dispose();
  await close();
});

test('engine：newPage → createTarget，evaluate 带 sessionId/returnByValue/awaitPromise', async () => {
  const { engine, table, sock, close } = await fakeEngine();
  table['Target.createTarget'] = () => ({ targetId: 'T1' });
  table['Target.attachToTarget'] = () => ({ sessionId: 'S1' });
  let evalValue: unknown = '42';
  table['Runtime.evaluate'] = () => ({ result: { value: evalValue } });

  const dataUrl = 'data:text/html,<h1>hi</h1><div id=t>42</div>';
  const page = await engine.newPage(dataUrl);
  assert.deepEqual(page, { targetId: 'T1', url: dataUrl });
  assert.deepEqual(sock().frames('Target.createTarget')[0].params, {
    url: dataUrl,
    background: true,
  });

  assert.equal(await engine.evaluate(page, 'document.getElementById("t").innerText'), '42');
  const frame = sock().frames('Runtime.evaluate')[0];
  assert.equal(frame.sessionId, 'S1');
  assert.equal(frame.params.returnByValue, true);
  assert.equal(frame.params.awaitPromise, true);

  evalValue = 'body text';
  assert.equal(await engine.text(page), 'body text');

  table['Page.captureScreenshot'] = () => ({ data: Buffer.alloc(2048, 7).toString('base64') });
  const shot = await engine.screenshot(page);
  assert.ok(shot instanceof Uint8Array);
  assert.equal(shot.length, 2048);
  assert.equal(sock().frames('Page.captureScreenshot')[0].params.format, 'png');

  await engine.dispose();
  await close();
});

test('engine：backgroundTabs 控制标签页前后台（默认 true，false 时补 activateTarget）', async () => {
  // 默认：后台建页，不发 activateTarget
  const first = await fakeEngine();
  first.table['Target.createTarget'] = () => ({ targetId: 'T1' });
  first.table['Target.activateTarget'] = () => ({});
  const bgPage = await first.engine.newPage('about:blank');
  assert.equal(bgPage.targetId, 'T1');
  assert.equal(first.sock().frames('Target.createTarget')[0].params.background, true);
  assert.equal(first.sock().frames('Target.activateTarget').length, 0, '后台建页不该激活');
  await first.engine.dispose();
  await first.close();

  // backgroundTabs:false：前台建页 + 补一次 activateTarget
  const server = await versionServer();
  const table: Record<string, (frame: any) => any> = {
    'Target.setDiscoverTargets': () => ({}),
    'Page.enable': () => ({}),
    'Target.createTarget': () => ({ targetId: 'T2' }),
    'Target.activateTarget': () => ({}),
  };
  let socket: FakeSocket | null = null;
  const engine = createEngine({
    mode: 'attach',
    port: server.port,
    backgroundTabs: false,
    webSocket: (url: string) => {
      socket = nextSocket(url);
      autoRespond(socket, table);
      return socket;
    },
  });
  try {
    const fgPage = await engine.newPage('about:blank');
    assert.equal(fgPage.targetId, 'T2');
    const sock = socket as FakeSocket | null;
    assert.ok(sock);
    assert.equal(sock!.frames('Target.createTarget')[0].params.background, false);
    const activated = sock!.frames('Target.activateTarget');
    assert.equal(activated.length, 1, '前台建页应当补一次 activateTarget');
    assert.deepEqual(activated[0].params, { targetId: 'T2' });
  } finally {
    await engine.dispose();
    await server.close();
  }
});

test('engine：goto 等加载超时 → ok:false + note（不算失败，页面还在）', async () => {
  const { engine, table, close } = await fakeEngine();
  table['Target.createTarget'] = () => ({ targetId: 'T1' });
  table['Target.attachToTarget'] = () => ({ sessionId: 'S1' });
  table['Page.navigate'] = () => ({ frameId: 'F1' });
  // readyState 永远停在 loading
  table['Runtime.evaluate'] = () => ({
    result: { value: JSON.stringify({ ready: 'loading', url: 'http://example.test/' }) },
  });

  const page = await engine.newPage('about:blank');
  const result = await engine.goto(page, 'http://example.test/', { timeoutMs: 300 });
  assert.equal(result.ok, false);
  assert.equal(result.url, 'http://example.test/');
  assert.match(String(result.note), /等加载超时/);
  assert.equal(await engine.waitReady(page, { timeoutMs: 200 }), false);

  // 页面成了 complete → ok:true
  table['Runtime.evaluate'] = () => ({
    result: { value: JSON.stringify({ ready: 'complete', url: 'http://example.test/done' }) },
  });
  const done = await engine.goto(page, 'http://example.test/done', { timeoutMs: 500 });
  assert.equal(done.ok, true);
  assert.equal(done.url, 'http://example.test/done');
  await engine.dispose();
  await close();
});

test('engine：等加载期间断连立刻报 not-connected（不吃满超时预算）', async () => {
  const { engine, table, sock, close } = await fakeEngine();
  table['Target.createTarget'] = () => ({ targetId: 'T1' });
  table['Target.attachToTarget'] = () => ({ sessionId: 'S1' });
  table['Page.navigate'] = () => ({ frameId: 'F1' });
  // Page.navigate 有回执，之后 readyState 的查询一直没人回；就在这时候把连接关掉
  table['Runtime.evaluate'] = () => undefined;

  const page = await engine.newPage('about:blank');
  const started = Date.now();
  const pending = engine.goto(page, 'http://example.test/', { timeoutMs: 20000 });
  await waitFor(() => sock().frames('Runtime.evaluate').length > 0, 'readyState 查询帧');
  sock().serverClose();
  await assert.rejects(pending, (err: unknown) => {
    assert.ok(err instanceof CdpError);
    assert.equal(err.code, 'not-connected');
    return true;
  });
  assert.ok(Date.now() - started < 5000, '断连必须立刻冒出去，不能等满 20 秒预算');
  await engine.dispose();
  await close();
});

test('engine：求值抛错与找不到元素都归 page-failed，并带 hint', async () => {
  const { engine, table, close } = await fakeEngine();
  table['Target.createTarget'] = () => ({ targetId: 'T1' });
  table['Target.attachToTarget'] = () => ({ sessionId: 'S1' });
  table['Runtime.evaluate'] = () => ({
    exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: nope\n    at <anonymous>' } },
  });
  const page = await engine.newPage('about:blank');
  await assert.rejects(engine.evaluate(page, 'boom()'), (err: unknown) => {
    assert.ok(err instanceof CdpError);
    assert.equal(err.code, 'page-failed');
    assert.match(err.message, /TypeError: nope/);
    assert.ok(err.hint);
    return true;
  });

  // 正常求值但元素不存在 → click 报 page-failed
  table['Runtime.evaluate'] = () => ({ result: { value: { ok: false } } });
  await assert.rejects(engine.click(page, '#missing'), (err: unknown) => {
    assert.ok(err instanceof CdpError);
    assert.equal(err.code, 'page-failed');
    assert.match(err.message, /#missing/);
    return true;
  });
  await engine.dispose();
  await close();
});

test('engine：dispose 幂等，之后 ensure 报 not-connected', async () => {
  const { engine, sock, close } = await fakeEngine();
  await engine.ensure();
  await engine.dispose();
  await engine.dispose();
  assert.equal(sock().readyState, WS_CLOSED, 'dispose 必须关掉 ws');
  assert.equal(engine.status().connected, false);
  await assert.rejects(engine.ensure(), (err: unknown) => {
    assert.ok(err instanceof CdpError);
    assert.equal(err.code, 'not-connected');
    return true;
  });
  await close();
});

test('engine：端口上没东西 → no-port，status 里留着人话', async () => {
  const port = await freePort();
  const engine = createEngine({ mode: 'attach', port });
  await assert.rejects(engine.ensure(), (err: unknown) => {
    assert.ok(err instanceof CdpError);
    assert.equal(err.code, 'no-port');
    return true;
  });
  const status = engine.status();
  assert.equal(status.connected, false);
  assert.equal(status.error?.code, 'no-port');
  assert.ok(status.error?.hint && status.error.hint.length > 10);
  await engine.dispose();
});

test('engine：own 模式配置不对 → no-browser（不尝试 spawn）', async () => {
  const port = await freePort();
  const engine = createEngine({
    mode: 'own',
    port,
    profileDir: 'C:\\Temp\\x-feed-test-profile',
    chromePath: 'C:\\nope\\chrome.exe',
  });
  await assert.rejects(engine.ensure(), (err: unknown) => {
    assert.ok(err instanceof CdpError);
    assert.equal(err.code, 'no-browser');
    assert.equal(engine.status().error?.code, 'no-browser');
    return true;
  });
  await engine.dispose();
});

test('engine：发现口在、ws 连不上 → ws-failed（这条走真的全局 WebSocket）', async () => {
  const deadWsPort = await freePort();
  const server = createServer((req, res) => {
    if (req.url !== '/json/version') {
      res.statusCode = 404;
      res.end('{}');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        Browser: 'Chrome/1.0',
        // 指向一个没人听的端口：ws 建链必然失败
        webSocketDebuggerUrl: `ws://127.0.0.1:${deadWsPort}/devtools/browser/x`,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  const engine = createEngine({ mode: 'attach', port, connectTimeoutMs: 1500 });
  try {
    await assert.rejects(engine.ensure(), (err: unknown) => {
      assert.ok(err instanceof CdpError);
      assert.equal(err.code, 'ws-failed');
      assert.ok(err.hint && err.hint.length > 10);
      return true;
    });
    assert.equal(engine.status().error?.code, 'ws-failed');
    assert.equal(engine.status().connected, false);
  } finally {
    await engine.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ——— own 模式的静态契约 ———

test('own 模式启动参数逐条对齐 cwb（profile / 反节流 / 屏幕外默认）', () => {
  const args = ownBrowserArgs('C:\\Temp\\x-feed-smoke', 9333);
  const required = [
    '--user-data-dir=C:\\Temp\\x-feed-smoke',
    '--remote-debugging-port=9333',
    '--remote-allow-origins=*',
    '--window-position=-32000,-32000',
    '--window-size=1100,800',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling',
  ];
  for (const flag of required) {
    assert.ok(args.includes(flag), `缺启动参数：${flag}`);
  }
  assert.equal(new Set(args).size, args.length, '启动参数不该重复');
  // 默认（不传第三参）就是屏幕外，且不带屏幕内那档坐标
  assert.ok(args.includes('--window-position=-32000,-32000'), '默认该把窗口放在屏幕外');
  assert.ok(!args.includes('--window-position=120,120'), '默认不该摆到屏幕内');
});

test("windowPosition='onscreen'：窗口进屏幕内，其余参数一个都不变", () => {
  const offscreen = ownBrowserArgs('C:\\Temp\\x-feed-smoke', 9333, 'offscreen');
  const onscreen = ownBrowserArgs('C:\\Temp\\x-feed-smoke', 9333, 'onscreen');

  // 显式给了坐标：不传的话 Chrome 会按 profile 上次保存的位置恢复，多半还是 -32000
  assert.ok(onscreen.includes('--window-position=120,120'), 'onscreen 该把窗口摆到屏幕内');
  assert.ok(!onscreen.includes('--window-position=-32000,-32000'), 'onscreen 不该再有屏幕外坐标');
  // 尺寸两档一致
  assert.ok(onscreen.includes('--window-size=1100,800'), '尺寸不该跟着窗口待遇变');

  // 「只改窗口位置这一条」：两份参数集合的差集必须正好是那两条坐标
  const onlyOffscreen = offscreen.filter((flag) => !onscreen.includes(flag));
  const onlyOnscreen = onscreen.filter((flag) => !offscreen.includes(flag));
  assert.deepEqual(onlyOffscreen, ['--window-position=-32000,-32000']);
  assert.deepEqual(onlyOnscreen, ['--window-position=120,120']);
  assert.equal(offscreen.length, onscreen.length, '两档参数条数相同');
});

test('本机浏览器候选里包含硬环境事实给的那两个路径', () => {
  const candidates = browserCandidates();
  assert.ok(
    candidates.includes('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'),
    '缺 Chrome 的默认位置',
  );
  assert.ok(
    candidates.includes('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'),
    '缺 Edge 的默认位置',
  );
});

test('CdpError 的形状：code / hint / name / toJSON', () => {
  const err = new CdpError('timeout', '没回话', '等一等再试');
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'CdpError');
  assert.equal(err.code, 'timeout');
  assert.equal(err.hint, '等一等再试');
  assert.deepEqual(err.toJSON(), { code: 'timeout', message: '没回话', hint: '等一等再试' });
});

// ——— 安全审计回归：P2-3 / P2-4 / P2-10 ———

/**
 * 一个刚退出、确定不存在的 pid：收尸路径会真的 taskkill 这个号，用死号才不会误伤
 * 机器上恰好占着 4242 的某个进程。
 */
function deadPid(): number {
  const done = spawnSync(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  return done.pid ?? 0;
}

/** 假子进程：只提供 OwnBrowser 用到的那几下，用来验「有没有收尸」。 */
class FakeChild {
  pid = deadPid();
  exitCode: number | null = null;
  killed = false;
  unref(): void {}
  on(_event: string, _listener: (arg: any) => void): this {
    return this;
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

test('P2-3：ensure 卡在建链时 dispose —— 刚建好的 ws 必须就地关掉，不留悬挂连接', async () => {
  const server = await versionServer();
  let socket: FakeSocket | null = null;
  const engine = createEngine({
    mode: 'attach',
    port: server.port,
    connectTimeoutMs: 2000,
    // 开得慢一点：让 ensure 卡在 connect 里，dispose 正好落在中间
    webSocket: (url: string) => {
      socket = nextSocket(url, 80);
      return socket;
    },
  });
  try {
    const ensuring = engine.ensure().catch((err) => err);
    await new Promise((resolve) => setTimeout(resolve, 20)); // 此刻 ensure 还在等 ws 打开
    await engine.dispose();
    const outcome = await ensuring;
    assert.ok(outcome instanceof CdpError, 'ensure 应当以 CdpError 收场');
    assert.equal(outcome.code, 'not-connected');
    assert.ok(socket, '应当建过假 ws');
    assert.equal(socket!.readyState, WS_CLOSED, 'dispose 之后这条 ws 必须已经关掉');
    assert.equal(engine.status().connected, false);
  } finally {
    await engine.dispose();
    await server.close(); // 注意：versionServer() 给的是 close()，它自己返回 promise
  }
});

test('status：失败时看得到原因，连上之后不该再背着旧错误', async () => {
  const port = await freePort();
  const table: Record<string, (frame: any) => any> = {
    'Target.setDiscoverTargets': () => ({}),
    'Page.enable': () => ({}),
  };
  const engine = createEngine({
    mode: 'attach',
    port,
    connectTimeoutMs: 1000,
    webSocket: (url: string) => {
      const socket = nextSocket(url);
      autoRespond(socket, table);
      return socket;
    },
  });
  let server: { port: number; close: () => Promise<void> } | null = null;
  try {
    // 1) 端口上还没人：失败，并且 status 必须说得出原因
    await assert.rejects(engine.ensure(), (err: unknown) => {
      assert.ok(err instanceof CdpError);
      assert.equal(err.code, 'no-port');
      return true;
    });
    const failed = engine.status();
    assert.equal(failed.connected, false);
    assert.equal(failed.error?.code, 'no-port');
    assert.ok(failed.error?.message, '失败之后要能看到原因');

    // 2) 同一个端口起发现口 → 再 ensure 成功 → 旧错误必须消失
    server = await versionServer(port);
    await engine.ensure();
    const healthy = engine.status();
    assert.equal(healthy.connected, true);
    assert.equal(healthy.error, undefined, '连上之后不该还挂着上一次的错误');

    // 3) 早退路径（wire 已经开着）也不许把旧错误捡回来
    await engine.ensure();
    assert.equal(engine.status().error, undefined);
    assert.equal(engine.status().connected, true);
  } finally {
    await engine.dispose();
    await server?.close();
  }
});

test('status：dispose 之后不该再报旧错误（历史不能当现状）', async () => {
  const port = await freePort();
  const engine = createEngine({ mode: 'attach', port, connectTimeoutMs: 1000 });
  await assert.rejects(engine.ensure(), (err: unknown) => {
    assert.ok(err instanceof CdpError);
    assert.equal(err.code, 'no-port');
    return true;
  });
  assert.equal(engine.status().error?.code, 'no-port', 'dispose 之前要能看到失败原因');
  await engine.dispose();
  const after = engine.status();
  assert.equal(after.connected, false);
  assert.equal(after.error, undefined, 'dispose 之后不该还留着旧错误');
});

test('P2-3：ensure 还在等浏览器拉起时 dispose —— 那只 Chrome 必须被收掉', async () => {
  const child = new FakeChild();
  const port = await freePort();
  const engine = createEngine({
    mode: 'own',
    port,
    profileDir: join(tmpdir(), 'x-feed-p23-profile'),
    chromePath: process.execPath, // 存在的 .exe，能过路径校验；反正不会真 spawn
    readyTimeoutMs: 10, // 内部下限 3 秒：这段时间正好模拟「浏览器还没就绪」
    spawnImpl: (() => child) as any,
  });
  const ensuring = engine.ensure().catch((err) => err);
  await new Promise((resolve) => setTimeout(resolve, 50)); // ensure 正卡在等就绪里
  await engine.dispose();
  const outcome = await ensuring;
  assert.ok(outcome instanceof CdpError);
  assert.equal(child.killed, true, 'dispose 必须把这次拉起的那只进程收掉');
  assert.equal(engine.status().connected, false);
});

test('P2-4：调试口始终不应答 —— 超时先收尸再报 no-port，不把 Chrome 留在后台', async () => {
  const child = new FakeChild();
  const port = await freePort();
  const own = new OwnBrowser({
    exePath: process.execPath,
    profileDir: join(tmpdir(), 'x-feed-p24-profile'),
    port,
    spawnImpl: (() => child) as any,
  });
  await assert.rejects(own.ensure(10), (err: unknown) => {
    assert.ok(err instanceof CdpError);
    assert.equal(err.code, 'no-port');
    assert.ok(err.hint && err.hint.length > 10);
    return true;
  });
  assert.equal(child.killed, true, '超时分支必须先 stop');
  assert.equal(own.pid, null, '超时之后不该再留着 pid');
});

test('P2-10：chromePath 轻校验 —— 非 .exe / 落在临时目录都拒', () => {
  assert.throws(
    () => assertBrowserPathTrusted('C:\\Program Files\\Google\\Chrome\\Application\\chrome'),
    (err: unknown) => {
      assert.ok(err instanceof CdpError);
      assert.equal(err.code, 'no-browser');
      assert.match(err.message, /\.exe/);
      return true;
    },
  );
  assert.throws(
    () => assertBrowserPathTrusted(join(tmpdir(), 'x-feed-p210', 'chrome.exe')),
    (err: unknown) => {
      assert.ok(err instanceof CdpError);
      assert.equal(err.code, 'no-browser');
      assert.match(err.message, /临时目录/);
      assert.ok(err.hint);
      return true;
    },
  );
  assert.doesNotThrow(() =>
    assertBrowserPathTrusted('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'),
  );
});

test('P2-10：ensure 阶段就拦住临时目录里的 exe（根本不去 spawn）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'x-feed-p210-'));
  const exe = join(dir, 'chrome.exe');
  writeFileSync(exe, '');
  let spawned = false;
  const own = new OwnBrowser({
    exePath: exe,
    profileDir: join(dir, 'profile'),
    port: await freePort(),
    spawnImpl: (() => {
      spawned = true;
      return new FakeChild();
    }) as any,
  });
  try {
    await assert.rejects(own.ensure(10), (err: unknown) => {
      assert.ok(err instanceof CdpError);
      assert.equal(err.code, 'no-browser');
      assert.match(err.message, /临时目录/);
      return true;
    });
    assert.equal(spawned, false, '不合规的路径不该走到 spawn');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
