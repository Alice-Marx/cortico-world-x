/**
 * W5 测试的共用夹具：假宿主、假引擎、假定时器、临时数据目录。
 * 文件名带 world. 前缀，归 W5（tests/world.*.test.ts / tests/tools.*.test.ts）专用。
 *
 * 只用包内代码与 node 内建模块：包必须能裸 node 跑测试。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { EventEnvelope, WorldHost } from 'cortico/core/types.ts';
import type { BrowserEngine, EngineOptions } from '../src/cdp/types.ts';
import { CdpError } from '../src/cdp/types.ts';
import { X_FEED } from '../src/definition.ts';
import type { XFeedConfigSection } from '../src/config.ts';
import { XWorld, type XWorldTimers } from '../src/world.ts';
import { makeFakeEngine } from './fixtures/support/fake-engine.ts';

export const ROOT = resolve(import.meta.dirname, '..');

/** 一条被记下来的事件：只留断言要用的那几个字段。 */
export interface PushedEvent {
  type: string;
  text: string;
  origin: string;
  deliver: boolean;
  trigger?: string;
  ts: string;
}

export interface FakeHost {
  host: WorldHost;
  events: PushedEvent[];
  logs: string[];
  of(type: string): PushedEvent[];
}

/** 假宿主：pushEvent 记下来，其余按框架契约给最小实现。 */
export function makeHost(): FakeHost {
  const events: PushedEvent[] = [];
  const logs: string[] = [];
  const host = {
    pushEvent: async (e: Record<string, unknown>, opts: Record<string, unknown> = {}) => {
      const record: PushedEvent = {
        type: String(e.type),
        text: String(e.text),
        origin: String(e.origin ?? 'external'),
        deliver: opts.deliver === undefined ? true : Boolean(opts.deliver),
        trigger: opts.trigger === undefined ? undefined : String(opts.trigger),
        ts: String(e.ts),
      };
      events.push(record);
      return { cursor: events.length, ...e, origin: record.origin } as unknown as EventEnvelope;
    },
    pushDeferred: () => undefined,
    store: {
      get: () => undefined,
      latestCursor: () => 0,
      range: () => [],
      around: () => [],
      grep: () => [],
    },
    drainPendingEvents: async () => [],
    modelFacts: { vision: false, toolCalling: true },
    blob: () => null,
    reportUsage: () => undefined,
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: (message: string) => logs.push(String(message)),
      error: () => undefined,
    },
  };
  return {
    host: host as unknown as WorldHost,
    events,
    logs,
    of: (type: string) => events.filter((one) => one.type === type),
  };
}

export interface FakeTimers {
  timers: XWorldTimers;
  created: Array<{ handle: unknown; ms: number; fn: () => void; cleared: boolean; fired: boolean }>;
  /** 还挂着、还没拨过的那几只。 */
  live(): Array<{ handle: unknown; ms: number; fn: () => void; cleared: boolean; fired: boolean }>;
  /** 拨一跳（默认拨最新挂着的那一只）。 */
  fire(index?: number): void;
}

/** 假定时器：数得清挂了几只、清了几只，还能手动拨一跳。 */
export function makeTimers(): FakeTimers {
  const created: Array<{ handle: unknown; ms: number; fn: () => void; cleared: boolean; fired: boolean }> = [];
  const timers: XWorldTimers = {
    setTimeout: (fn, ms) => {
      const handle = {
        id: created.length + 1,
        unref() {
          return handle;
        },
      };
      created.push({ handle, ms, fn, cleared: false, fired: false });
      return handle as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle) => {
      const found = created.find((one) => one.handle === handle);
      if (found) found.cleared = true;
    },
  };
  const live = () => created.filter((one) => !one.cleared && !one.fired);
  return {
    timers,
    created,
    live,
    /** 拨一跳：默认拨当前挂着的那一只（每跳之后会重新排下一只）。 */
    fire: (index?: number) => {
      const pending = live();
      const target = index === undefined ? pending[pending.length - 1] : pending[index];
      if (!target) return;
      target.fired = true;
      target.fn();
    },
  };
}

export interface ScriptedEngine {
  engine: BrowserEngine;
  calls: { ensure: number; newPage: number; goto: string[]; evaluate: number; dispose: number; closePage: number };
  options: EngineOptions[];
}

export interface ScriptOptions {
  /** 页面 HTML 逐轮；给 makeFakeEngine 用（真实 EXTRACT_JS + mini-dom）。 */
  rounds?: string[];
  /** 在某个引擎调用上抛错。 */
  failOn?: 'ensure' | 'newPage' | 'goto' | 'evaluate';
  error?: unknown;
  /** evaluate 直接回这个信封（不走 mini-dom）。 */
  envelope?: unknown;
  /** ensure 前 N 次抛错（N=1 就是「先失败、后成功」）。 */
  ensureFailsTimes?: number;
  /** 让 status() 像真引擎那样带着一条历史遗留的错误（#lastError 成功连上时不会自清）。 */
  staleStatusError?: { code: 'no-browser' | 'no-port' | 'ws-failed' | 'cdp-failed' | 'page-failed' | 'timeout' | 'not-connected'; message: string };
  /** ensure 挂在这一关后面（测试「重建中」那一刻的措辞用）。 */
  ensureGate?: () => Promise<void>;
}

/** 假引擎：成功路径复用 W3 的 fake-engine，失败路径按 failOn 定点抛。 */
export function makeScriptedEngine(options: ScriptOptions = {}): ScriptedEngine {
  const calls = { ensure: 0, newPage: 0, goto: [] as string[], evaluate: 0, dispose: 0, closePage: 0 };
  const internal = makeFakeEngine({ rounds: options.rounds ?? [''] });
  // 先绑住原实现：下面是在同一个对象上改方法，晚绑就会自己调自己。
  const baseEvaluate = internal.engine.evaluate.bind(internal.engine);
  const engine = internal.engine as unknown as Record<string, (...args: unknown[]) => unknown>;
  const boom = (): never => {
    throw options.error ?? new CdpError('no-browser', '没有浏览器');
  };
  engine.ensure = async () => {
    calls.ensure += 1;
    if (options.failOn === 'ensure') boom();
    if (options.ensureFailsTimes !== undefined && calls.ensure <= options.ensureFailsTimes) boom();
    if (options.ensureGate !== undefined) await options.ensureGate();
    return undefined;
  };
  if (options.staleStatusError !== undefined) {
    const stale = options.staleStatusError;
    engine.status = () => ({ connected: true, mode: 'own', error: { ...stale } });
  }
  engine.newPage = async (url: unknown) => {
    calls.newPage += 1;
    if (options.failOn === 'newPage') boom();
    return { targetId: 'w5-page', url: String(url) };
  };
  engine.goto = async (_page: unknown, url: unknown) => {
    calls.goto.push(String(url));
    if (options.failOn === 'goto') boom();
    return { ok: true, url: String(url) };
  };
  engine.evaluate = async (page: unknown, expr: unknown) => {
    calls.evaluate += 1;
    if (options.failOn === 'evaluate') boom();
    if (options.envelope !== undefined) return options.envelope;
    return baseEvaluate(page as never, expr as string);
  };
  engine.closePage = async () => {
    calls.closePage += 1;
    return undefined;
  };
  engine.dispose = async () => {
    calls.dispose += 1;
    return undefined;
  };
  return { engine: engine as unknown as BrowserEngine, calls, options: [] };
}

export interface WorldOptions {
  cfg?: Partial<XFeedConfigSection>;
  engine?: ScriptedEngine;
  timers?: FakeTimers;
  dataDir?: string;
  /** 换掉引擎工厂（要看 EngineOptions 里的 mode / windowPosition 时用）。 */
  createEngine?: (options: EngineOptions) => BrowserEngine;
}

export interface BuiltWorld {
  world: XWorld;
  host: FakeHost;
  timers: FakeTimers;
  dir: string;
  cleanup(): Promise<void>;
}

export async function makeWorld(options: WorldOptions = {}): Promise<BuiltWorld> {
  const dir = options.dataDir ?? (await mkdtemp(join(tmpdir(), 'x-feed-w5-')));
  const cfg = { ...X_FEED.defaults(), ...(options.cfg ?? {}) } as XFeedConfigSection;
  const timers = options.timers ?? makeTimers();
  const host = makeHost();
  const engine = options.engine;
  const factory = options.createEngine ?? ((): BrowserEngine => engine?.engine as BrowserEngine);
  const world = new XWorld({
    cfg,
    timezone: 'Asia/Shanghai',
    dataDir: dir,
    packageDir: ROOT,
    secret: () => '',
    restart: async () => undefined,
    createEngine: factory,
    timers: timers.timers,
  });
  return {
    world,
    host,
    timers,
    dir,
    cleanup: async () => {
      if (options.dataDir === undefined) await rm(dir, { recursive: true, force: true });
    },
  };
}

/** 按名字取一个工具并直接调用 handler；断言只看回执文本。 */
export async function callTool(world: XWorld, name: string, args: Record<string, unknown> = {}) {
  const def = world.tools().find((one) => one.name === name);
  if (!def) throw new Error('没有这个工具：' + name);
  const outcome = await def.handler(args, { role: 'test', log: { warn: () => undefined } } as never);
  return typeof outcome === 'string' ? { text: outcome, failed: false } : { text: outcome.text, failed: outcome.failed === true };
}
