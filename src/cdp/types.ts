/**
 * PLAN 3.1 的契约，逐字对齐（W2 拥有这个文件）。
 *
 * 与 PLAN 的唯一差异是实现位置：CdpError 定义在 error.ts 后由这里转出，
 * createEngine 定义在 engine.ts 后由这里转出 —— 这样 types.ts 仍是唯一入口，
 * 而 CdpError 只有一份（两边 instanceof 才成立）。
 */
import type { CdpErrorCode } from './error.ts';
import type { OwnSpawn, WindowPosition } from './own.ts';
import type { WebSocketFactory } from './wire.ts';

export type { CdpErrorCode } from './error.ts';
export { CdpError } from './error.ts';

/** PLAN 3.1 只写了 createEngine(opts: EngineOptions)，形状由这里定。 */
export interface EngineOptions {
  /** own = 自己拉一个专属浏览器；attach = 连已经在跑的那个调试口 */
  mode: 'own' | 'attach';
  /** own 的调试口 / attach 的探测口 */
  port: number;
  /** own 模式的 profile 目录，由调用方给：绝不碰用户日常 profile */
  profileDir?: string;
  /** 空 = 自动探测 Chrome / Edge */
  chromePath?: string;
  /**
   * own 模式专属窗口摆在哪儿，默认 'offscreen'（不晃到用户眼前）。
   * 需要用户亲手在那个 profile 里登录 X 时传 'onscreen'：窗口必须在屏幕内，
   * 位置参数才有意义 —— 窗口在屏幕外，用户根本没法完成需要交互的登录。
   * attach 模式忽略此项。
   */
  windowPosition?: WindowPosition;
  /** 单条 CDP 命令的兜底超时，默认 15000 */
  commandTimeoutMs?: number;
  /** own 模式等浏览器就绪的上限，默认 30000 */
  readyTimeoutMs?: number;
  /** 建 WebSocket 的超时，默认 10000 */
  connectTimeoutMs?: number;
  /**
   * 新标签页开在后台还是前台，默认 true（后台，不抢用户的焦点）。
   *
   * 为什么要这一项：后台标签页在站点眼里是 `document.visibilityState === 'hidden'`，
   * SPA（X 就是）常常因此不渲染或只延迟渲染。要它当场渲染就传 false —— 标签页会被激活，
   * 站点看到的是 visible。代价是会抢焦点，所以默认不开。
   */
  backgroundTabs?: boolean;
  /** 测试注入口：替换全局 WebSocket（生产不传） */
  webSocket?: WebSocketFactory;
  /** 测试注入口：替换 own 模式的 spawn（生产不传） */
  spawnImpl?: OwnSpawn;
}

export interface BrowserStatus {
  connected: boolean;
  mode: 'own' | 'attach';
  endpoint?: string;
  browser?: string;
  error?: { code: CdpErrorCode; message: string; hint?: string };
}
export interface PageHandle {
  targetId: string;
  url: string;
}

export interface BrowserEngine {
  status(): BrowserStatus;
  ensure(): Promise<void>;
  newPage(url: string): Promise<PageHandle>;
  goto(
    p: PageHandle,
    url: string,
    o?: { timeoutMs?: number },
  ): Promise<{ ok: boolean; url: string; note?: string }>;
  waitReady(p: PageHandle, o?: { timeoutMs?: number }): Promise<boolean>;
  evaluate<T>(
    p: PageHandle,
    expr: string,
    o?: { awaitPromise?: boolean; timeoutMs?: number },
  ): Promise<T>;
  text(p: PageHandle): Promise<string>;
  screenshot(p: PageHandle): Promise<Uint8Array>;
  click(p: PageHandle, selector: string): Promise<void>;
  type(p: PageHandle, selector: string, text: string): Promise<void>;
  scroll(p: PageHandle, o?: { deltaY?: number; times?: number }): Promise<void>;
  closePage(p: PageHandle): Promise<void>;
  dispose(): Promise<void>;
}

export { createEngine } from './engine.ts';
