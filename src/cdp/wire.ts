/**
 * 一条浏览器级 WebSocket 上的 CDP 协议层：id → promise 的对照表、扁平 sessionId 路由、
 * 每条命令的超时、连接关闭时把所有挂起 promise 一律 reject。
 *
 * 这里只管机械的事，不认业务：引擎（engine.ts）决定发什么命令。
 */
import { CdpError, HINT, describe } from './error.ts';

/** WebSocket.OPEN。不引用全局构造器，假 ws 也能过。 */
const WS_OPEN = 1;
const WS_CLOSED = 3;

/** PLAN 要求「全部 CDP 命令要带超时（默认 15s）」。 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;

export type CdpResult = Record<string, any>;

export interface CdpEventMessage {
  method?: string;
  params?: any;
  sessionId?: string;
}

/** 全局 WebSocket 的结构子集：测试用一个照着 WS 帧语义手写的假对象顶替。 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (ev: any) => void): void;
  removeEventListener(type: string, listener: (ev: any) => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface WireOptions {
  /** 测试注入；缺省用全局 WebSocket */
  webSocket?: WebSocketFactory;
  commandTimeoutMs?: number;
  connectTimeoutMs?: number;
}

interface Pending {
  method: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: CdpResult) => void;
  reject: (err: CdpError) => void;
}

export class CdpWire {
  #ws: WebSocketLike | null = null;
  #seq = 0;
  #pending = new Map<number, Pending>();
  /** targetId → 扁平会话 id。 */
  #sessions = new Map<string, string>();
  #tornDown = false;
  #commandTimeoutMs: number;
  #connectTimeoutMs: number;
  #webSocket: WebSocketFactory;

  /** `/json/version` 报的浏览器名（例如 `Chrome/138.0.7204.97`），连上之后才有。 */
  browserLabel = '';
  /** 非应答帧（事件）都送到这里，引擎拿它跟踪 attach/detach。 */
  onEvent: ((msg: CdpEventMessage) => void) | null = null;

  constructor(opts: WireOptions = {}) {
    this.#webSocket = opts.webSocket ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
    this.#commandTimeoutMs = opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.#connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
  }

  get isOpen(): boolean {
    return this.#ws !== null && !this.#tornDown && this.#ws.readyState === WS_OPEN;
  }

  /** 还挂着的命令数（测试与诊断用：应当永远回落到 0）。 */
  get pendingCount(): number {
    return this.#pending.size;
  }

  /** 建立连接。超时/报错一律 ws-failed。 */
  async connect(url: string, timeoutMs = this.#connectTimeoutMs): Promise<void> {
    if (this.isOpen) return;
    this.#tornDown = false;
    let ws: WebSocketLike;
    try {
      ws = this.#webSocket(url);
    } catch (err) {
      throw new CdpError('ws-failed', `连不上浏览器的 WebSocket：${describe(err)}`, HINT['ws-failed']);
    }
    const budget = Math.max(200, timeoutMs);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (err?: CdpError): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onError);
        ws.removeEventListener('close', onClose);
        if (err) {
          try {
            ws.close();
          } catch {
            // 本来就没开成
          }
          reject(err);
          return;
        }
        resolve();
      };
      const onOpen = (): void => finish();
      const onError = (): void =>
        finish(
          new CdpError('ws-failed', '连浏览器的 WebSocket 报错（调试口可能已经关了）', HINT['ws-failed']),
        );
      const onClose = (): void =>
        finish(new CdpError('ws-failed', '连上之前 WebSocket 就被关掉了', HINT['ws-failed']));
      timer = setTimeout(
        () =>
          finish(
            new CdpError(
              'ws-failed',
              `连浏览器的 WebSocket 超时（${budget} 毫秒没开成）`,
              HINT['ws-failed'],
            ),
          ),
        budget,
      );
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
      ws.addEventListener('close', onClose);
    });
    this.#ws = ws;
    this.#tornDown = false;
    this.#bind(ws);
  }

  #bind(ws: WebSocketLike): void {
    ws.addEventListener('message', (ev: any) => this.#onFrame(ev));
    ws.addEventListener('close', () =>
      this.#teardown(
        new CdpError('not-connected', '浏览器的 WebSocket 断开了', HINT['not-connected']),
      ),
    );
    ws.addEventListener('error', () => {
      this.#teardown(
        new CdpError(
          'ws-failed',
          'WebSocket 出错（浏览器可能已关闭，或调试口被切断）',
          HINT['ws-failed'],
        ),
      );
      try {
        ws.close();
      } catch {
        // close 自己会走上面的分支
      }
    });
  }

  #onFrame(ev: any): void {
    const raw = typeof ev?.data === 'string' ? ev.data : String(ev?.data ?? '');
    if (!raw) return;
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // 不是 JSON 的帧直接丢
    }
    if (!msg || typeof msg !== 'object') return;
    if (typeof msg.id === 'number') {
      const waiter = this.#pending.get(msg.id);
      if (!waiter) return; // 超时之后才回来的旧回执：丢掉
      this.#pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.error) waiter.reject(this.#cdpError(waiter.method, msg.error));
      else waiter.resolve((msg.result ?? {}) as CdpResult);
      return;
    }
    if (msg.method === 'Target.attachedToTarget') {
      const targetId = msg.params?.targetInfo?.targetId;
      const sessionId = msg.params?.sessionId;
      if (typeof targetId === 'string' && typeof sessionId === 'string') {
        this.#sessions.set(targetId, sessionId);
      }
    } else if (msg.method === 'Target.detachedFromTarget') {
      const sessionId = msg.params?.sessionId;
      for (const [targetId, known] of [...this.#sessions]) {
        if (known === sessionId) this.#sessions.delete(targetId);
      }
    }
    this.onEvent?.(msg as CdpEventMessage);
  }

  #cdpError(method: string, error: any): CdpError {
    const text = typeof error?.message === 'string' ? error.message : JSON.stringify(error);
    const code = typeof error?.code === 'number' ? `（${error.code}）` : '';
    return new CdpError('cdp-failed', `${method} 被浏览器拒绝：${text}${code}`, hintForCdpMessage(text));
  }

  /**
   * 发一条命令。sessionId 为空是浏览器级命令（Target.* 这类），有值就走扁平会话。
   * 超时/断连都会把这条 promise reject 掉，绝不留下挂起的。
   */
  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = this.#commandTimeoutMs,
  ): Promise<CdpResult> {
    const ws = this.#ws;
    if (!ws || this.#tornDown || ws.readyState !== WS_OPEN) {
      return Promise.reject(
        new CdpError('not-connected', `没连上浏览器就发了命令：${method}`, HINT['not-connected']),
      );
    }
    const id = ++this.#seq;
    const budget = Math.max(1, timeoutMs);
    return new Promise<CdpResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new CdpError('timeout', `CDP 命令超时：${method}（${budget} 毫秒没回话）`, HINT.timeout),
        );
      }, budget);
      this.#pending.set(id, { method, timer, resolve, reject });
      const frame: Record<string, unknown> = { id, method, params };
      if (sessionId) frame.sessionId = sessionId;
      try {
        ws.send(JSON.stringify(frame));
      } catch (err) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new CdpError('ws-failed', `发不出 CDP 命令 ${method}：${describe(err)}`, HINT['ws-failed']));
      }
    });
  }

  /** 拿一个 target 的扁平会话；拿过就复用（扁平模式下 attach 是幂等但多余的）。 */
  async sessionFor(targetId: string, timeoutMs = this.#commandTimeoutMs): Promise<string> {
    const known = this.#sessions.get(targetId);
    if (known) return known;
    let result: CdpResult;
    try {
      result = await this.send('Target.attachToTarget', { targetId, flatten: true }, undefined, timeoutMs);
    } catch (err) {
      const message = describe(err);
      // 「页面没了」是日常（被关掉/被回收），不是连接事故，要分开说。
      if (/No target with given id|No such target|Not attached/i.test(message)) {
        throw new CdpError(
          'page-failed',
          `页面不存在或已关闭（target ${targetId}）`,
          '看一眼现在还有哪些页面，或重新开一个页面',
        );
      }
      throw err instanceof CdpError ? err : new CdpError('cdp-failed', message, HINT['cdp-failed']);
    }
    const sessionId = typeof result.sessionId === 'string' ? result.sessionId : '';
    if (!sessionId) {
      throw new CdpError(
        'cdp-failed',
        `Target.attachToTarget 没回 sessionId（target ${targetId}）`,
        HINT['cdp-failed'],
      );
    }
    this.#sessions.set(targetId, sessionId);
    return sessionId;
  }

  forget(targetId: string): void {
    this.#sessions.delete(targetId);
  }

  #teardown(cause: CdpError): void {
    this.#tornDown = true;
    this.#ws = null;
    this.#sessions.clear();
    this.#failAll(cause);
  }

  /** 把所有挂起的命令 reject 掉：断连之后它们永远不会有回执。 */
  #failAll(cause: CdpError): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const waiter of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(cause);
    }
  }

  /** 主动断开：幂等。挂起的命令一律 reject 成 not-connected。 */
  async close(): Promise<void> {
    const ws = this.#ws;
    this.#tornDown = true;
    this.#ws = null;
    this.#sessions.clear();
    this.#failAll(new CdpError('not-connected', '浏览器连接已关闭', HINT['not-connected']));
    if (!ws) return;
    if (ws.readyState === WS_CLOSED) return;
    const closed = new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, 2000);
      ws.addEventListener('close', finish);
    });
    try {
      ws.close();
    } catch {
      // 已经关了
    }
    await closed;
  }
}

/** 浏览器给的 error.message 里，哪些是「等一等/换个页面」就能好的。 */
export function hintForCdpMessage(text: string): string {
  if (/No target with given id|No such target|Not attached/i.test(text)) {
    return '那条页面已经关掉了：重新开一个页面再来';
  }
  if (/Execution context was destroyed|Cannot find context|Inspected target navigated/i.test(text)) {
    return '页面正在导航，旧上下文作废了：等一下重试这条命令';
  }
  if (/Target closed|Session closed|Detached/i.test(text)) {
    return '页面或调试会话已经关了：重新开页面';
  }
  if (/Could not find node|No node with given id/i.test(text)) {
    return 'DOM 变了：重新取一次节点再来';
  }
  return HINT['cdp-failed'];
}
