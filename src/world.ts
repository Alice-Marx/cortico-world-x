/**
 * World 实例的真身：浏览器引擎、知识库、定时扫描、事件投递、7 个工具的装配入口。
 *
 * 契约 core/types.ts:903-952：id / envPromptVars() / tools() / webUi?(language) / start(host) / stop()。
 *
 * ★ start() 绝不抛错（PLAN 第 6 节；cwb NOTES 第 3 条）。浏览器起不来、端口不通、程序没找到，
 *   一律投一条 x-feed.down 之后安静返回：装配层不会因为一个 World 的连接失败而掉整条时间线。
 *   工具调用时再按 5 类失败回报（见 src/tools/receipt.ts）。
 *
 * 依赖方向单向（PLAN 第 2 节）：tools → world → {cdp, x, learn}。world 运行时要 tools 来装配工具表，
 * 所以 tools 只对 world 做 import type。
 *
 * 落盘约定（都在 ctx.dataDir 下 cfg.vaultSubdir 里，别写别处）：
 *   index.jsonl / notes/ / meta.json   知识库本体，归 learn（W4）
 *   state.json                         World 自己的游标（上次扫描时刻、轮数），重启后还在
 *   sources.local.json                 x_watch 的本地覆盖（加/减源）；宿主没有配置写入面，只能写这里
 *   login-done                         own 模式登录过一次的标记：有它才把浏览器开到屏幕外
 *   browser-profile/                   own 模式的专属浏览器 profile，绝不碰用户日常 profile
 *   export-<时间戳>.json               x_export 产出的记忆包
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Language } from 'cortico/core/language.ts';
import type {
  EventOrigin,
  ToolDef,
  TriggerMode,
  World,
  WorldHost,
  WorldLamp,
  WorldWebUiDecl,
} from 'cortico/core/types.ts';
import { WORLD_ID, sourceLines, xFeedConfigGroups, type XFeedConfigSection } from './config.ts';
import { MODEL, strings, TEXT } from './i18n.ts';
import { CdpError, createEngine, type BrowserEngine, type BrowserStatus, type EngineOptions } from './cdp/types.ts';
import { XError, formatSource, parseSource, readPost, readSource, type XPost } from './x/index.ts';
import {
  createVault,
  digest,
  learnedId,
  memoryExport,
  type LearnedItem,
  type Vault,
  type VaultStats,
} from './learn/types.ts';
import { INDEX_FILE } from './learn/vault.ts';
import { buildTools } from './tools/index.ts';

/** 环境提示词模板的绝对路径。框架直接按它读文件（core/prefix.ts:63-87）。 */
export const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/** envPrompt 的 key 惯例：worlds.<id>.<名>（types.ts:799-801）。 */
export const ENV_PROMPT_KEY = 'worlds.' + WORLD_ID + '.envPrompt';

/** 游标文件：与知识库同目录，重启后仍知道「上次扫描」是何时。 */
export const STATE_FILE = 'state.json';
/** own 模式的专属 profile 目录名，落在 vault 目录下。 */
export const PROFILE_DIR = 'browser-profile';
/** 登录过一次的标记：没有它时 own 模式把浏览器开到看得见的地方，让人能登录。 */
export const LOGIN_MARKER = 'login-done';
/** x_watch 的本地覆盖（宿主没有配置写入面，见 _research/contract/REPORT.md §7）。 */
export const SOURCES_FILE = 'sources.local.json';
/** 参数不合法（不是浏览器坏了）：工具层据此给「参数不对」的回执。 */
export class SourceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceInputError';
  }
}

/** 一个源最长多少字：它会被拼进系统提示词，越长越像一篇指令。 */
export const MAX_SOURCE_CHARS = 200;
/** 最多几个源：同理，源表也是一段会被模型当成环境说明的文字。 */
export const MAX_SOURCES = 40;
/** 一次导出最多多少条：记忆包会长期留在记忆里，别一把灌进去。 */
export const EXPORT_MAX_ITEMS = 500;
/** 等宿主落库的上限：宿主不回话不许把整轮扫描堵死。 */
const EVENT_PUSH_TIMEOUT_MS = 5000;
/** stop() 等一轮在飞扫描落地的上限。 */
const STOP_WAIT_MS = 10_000;
/** 冷启动第一轮：60 秒后就去读，不等一个 intervalMinutes。 */
export const COLD_START_DELAY_MS = 60_000;
/** 等登录态的重试间隔与次数上限（约 30 分钟）。 */
export const LOGIN_RETRY_MS = 60_000;
export const LOGIN_RETRY_MAX = 30;

/** 控制字符（含换行、制表、U+2028/2029）：任何一个都足以把一行源顶成两行。 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f\u2028\u2029]/;

/** 进系统前缀之前再清一遍：控制字符换成空格、压成一行、超长截断。 */
function flattenSourceLine(line: string): string {
  const flat = String(line).replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return flat.length <= MAX_SOURCE_CHARS ? flat : flat.slice(0, MAX_SOURCE_CHARS - 1) + '…';
}

/** 原子写：tmp + rename。掉电最多丢掉这一次写入，不会把旧文件撕成半截。 */
async function writeFileAtomic(path: string, content: string): Promise<void> {
  const tmp = path + '.' + randomUUID() + '.tmp';
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, path);
  } catch (error) {
    try {
      await rm(tmp, { force: true });
    } catch {
      // 临时文件清不掉也只是留个垃圾，别掩盖真正的错误
    }
    throw error;
  }
}

/** 有上限的等待：超时抛错，让调用方只记日志、不把整条流程卡死。 */
async function withTimeout<T>(task: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(label + ' 超过 ' + String(ms) + ' 毫秒没回话')), ms);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => {
    const timer = setTimeout(done, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}

/**
 * 定时器注入点：测试用假的 setTimeout 数句柄，生产用全局实现。
 *
 * 用一次性 setTimeout 而不是 setInterval：节奏是变的——冷启动 60 秒、等登录 60 秒、
 * 稳定之后才是一个 intervalMinutes。每跳完了由 tick() 重新排下一次。
 */
export interface XWorldTimers {
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
}

const GLOBAL_TIMERS: XWorldTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

/** create(ctx) 交给实例的东西。ctx 本身不进实例：它带着装配层的对象图，实例只留自己用得上的。 */
export interface XWorldOptions {
  /** worlds.x-feed 的活引用：热改的键现读即生效。 */
  cfg: XFeedConfigSection;
  timezone: string;
  /** 部署数据目录；知识库落在它下面。 */
  dataDir: string;
  /** 包目录；包内模板与资产从这里读。 */
  packageDir: string;
  /** ctx.secret(name)；Phase 2 用不到，先留着。 */
  secret?: (name: string) => string;
  /** ctx.restart()；改完必须重建的配置项由它触发。 */
  restart?: () => Promise<void>;
  /** 浏览器引擎工厂；省略＝src/cdp 的真实实现。测试注入用。 */
  createEngine?: (options: EngineOptions) => BrowserEngine;
  /** 定时器；省略＝全局 setInterval。测试注入用。 */
  timers?: XWorldTimers;
}

/** 引擎生命周期：idle 没有引擎 / connecting 刚建还没 ensure / ready 可用 / failed 上一次连不上。 */
export type EnginePhase = 'idle' | 'connecting' | 'ready' | 'failed';

/** 一个源这一轮读到了什么。 */
export interface SourceRead {
  /** 配置里的那一行 */
  line: string;
  /** 读到几条 */
  read: number;
  /** 新入库几条 */
  added: number;
  /** 库里已有或本轮重复，跳过几条 */
  skipped: number;
}

/** 一轮扫描的结果。工具回执与事件文本都从这里算，不各自猜。 */
export interface ScanOutcome {
  at: string;
  /** 成功的源 */
  perSource: SourceRead[];
  /** 本轮真正新入库的条目，按读到顺序 */
  added: LearnedItem[];
  skipped: number;
  /** 失败的源与原因（错误对象原样交给回执去分类） */
  failures: Array<{ line: string; error: unknown }>;
  /** x-feed.posts 是否真的投出去了 */
  delivered: boolean;
}

/** x_status 的快照。 */
export interface StatusSnapshot {
  browser: BrowserStatus;
  vault: VaultStats;
  sources: string[];
  lastScanAt: string | null;
  lastScanAdded: number;
  scans: number;
  intervalMinutes: number;
  vaultDir: string;
  mounted: boolean;
  /** 浏览器这一侧现在活着吗（跨扫描常驻，stop() 才关）。 */
  browserAlive: boolean;
  /** own 模式还没登录过：浏览器会出现在屏幕上等人登录。 */
  needsLogin: boolean;
  /** x_watch 本地覆盖里有几条加法条目。 */
  localAdded: number;
  overlayPath: string;
  /** 这一轮是冷启动（还没扫过第一轮 / 库是空的）：第一轮只等 60 秒。 */
  cold: boolean;
  /** 正在等人登录 X：每 60 秒重试一次，最多 LOGIN_RETRY_MAX 次。 */
  waitingLogin: boolean;
  loginRetries: number;
  /** 下一次自动扫描的预计时刻；intervalMinutes=0 时为 null。 */
  nextScanAt: string | null;
  /** 最近一次失败的原始异常（工具层按它分类）。 */
  lastFailure: unknown;
  /** 引擎这一代处在哪一步：connecting 时不许把上一代的错误当现状报出来。 */
  enginePhase: EnginePhase;
}

interface Cursor {
  lastScanAt: string | null;
  lastScanAdded: number;
  scans: number;
}

/** sources.local.json 的形状：在 cfg.sources 之上「加哪些、减哪些」，本地优先、去重。 */
export interface SourceOverlay {
  added: string[];
  removed: string[];
}

const EMPTY_OVERLAY: SourceOverlay = { added: [], removed: [] };

const EMPTY_CURSOR: Cursor = { lastScanAt: null, lastScanAdded: 0, scans: 0 };

function nowIso(): string {
  return new Date().toISOString();
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error === null || error === undefined ? '' : error);
}

/** vaultSubdir 只允许落在 dataDir 里面：去掉盘符、绝对路径与 .. 段。 */
export function vaultPath(dataDir: string, subdir: unknown): string {
  const raw = String(subdir === null || subdir === undefined ? '' : subdir).trim();
  const parts = raw
    .replace(/[\\/]+/g, sep)
    .split(sep)
    .filter((part) => part !== '' && part !== '.' && part !== '..' && part !== ':');
  return join(dataDir, parts.length ? parts.join(sep) : WORLD_ID);
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** XPost → LearnedItem。id 用 W4 的 learnedId（sha256(url) 的唯一出处）；空 url / 空 text 直接丢。 */
function toItem(post: XPost, source: string, learnedAt: string): LearnedItem | null {
  const url = String(post && post.url ? post.url : '').trim();
  const text = String(post && post.text ? post.text : '').trim();
  if (!url || !text) return null;
  const item: LearnedItem = { id: learnedId(url), url, text, learnedAt, source };
  const handle = String(post.author && post.author.handle ? post.author.handle : '').trim();
  if (handle) item.author = handle;
  const createdAt = String(post.createdAt ? post.createdAt : '').trim();
  if (createdAt) item.createdAt = createdAt;
  const metrics = post.metrics;
  if (metrics && typeof metrics === 'object') {
    const clean: Record<string, number> = {};
    for (const [key, value] of Object.entries(metrics)) {
      const n = Number(value);
      if (Number.isFinite(n)) clean[key] = n;
    }
    if (Object.keys(clean).length) item.metrics = clean;
  }
  return item;
}

export class XWorld implements World {
  readonly id = WORLD_ID;

  private readonly opts: XWorldOptions;
  private readonly vault: Vault;
  private readonly vaultDir: string;

  private host: WorldHost | null = null;
  private startedAt: string | null = null;
  private failure: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  private engine: BrowserEngine | null = null;
  /**
   * 引擎的状态机。不能用「engineReady 一个布尔」记：登录要 dispose 旧引擎再重建，
   * 布尔会带着上一代的值跨代活着，status 就会把上一代的错误当成现状报出来（真机踩过）。
   */
  private enginePhase: EnginePhase = 'idle';

  /** 只有 ready 才算连上：这个值永远跟着「当前这一代引擎」走。 */
  private get engineReady(): boolean {
    return this.enginePhase === 'ready';
  }
  /**
   * 这一个引擎是不是「看得见」的那次拉起。
   * windowPosition 只在拉起浏览器那一刻生效，复用路径不搬窗口（W2 三组对照实测），
   * 所以登录要先把浏览器收干净、再用 onscreen 重开一次。
   */
  private visibleWindow = false;
  /** 最近一次失败的原始异常：状态页要按它分类，不能拿 CdpError 的 code 去猜。 */
  private lastFailure: unknown = null;
  /** 上一次投出去的是 ready 还是 down：只有状态翻转时才投，免得每个扫描周期吵一次。 */
  private down = false;

  private scanning = false;
  /** stop() 之后要让在飞的那一轮尽快收手。 */
  private cancelled = false;
  private inflight: Promise<void> | null = null;
  private cursor: Cursor = { ...EMPTY_CURSOR };
  private cursorLoaded = false;
  /** x_watch 的本地覆盖：宿主没有配置写入面，加/减的源只存在 sources.local.json。 */
  private overlay: SourceOverlay = { added: [], removed: [] };
  private overlayLoaded = false;
  /** own 模式登录过一次没有：决定浏览器开到屏幕外还是看得见的地方。 */
  private loginDone = false;
  private loginChecked = false;
  /** 冷启动：装完还没扫过第一轮（或库还是空的）。第一轮只等 60 秒，不等一个 intervalMinutes。 */
  private cold = false;
  /** 正在等人登录 X：每 60 秒重试一次，最多 LOGIN_RETRY_MAX 次。 */
  private waitingLogin = false;
  private loginRetries = 0;
  private nextScanAt: string | null = null;
  private toolCache: ToolDef[] | null = null;

  constructor(opts: XWorldOptions) {
    this.opts = opts;
    this.vaultDir = vaultPath(opts.dataDir, opts.cfg.vaultSubdir);
    // createVault 只记目录，不建文件：装配层随时会构造实例（含 enabled=false），构造必须无副作用。
    this.vault = createVault(this.vaultDir);
  }

  get cfg(): XFeedConfigSection {
    return this.opts.cfg;
  }

  /**
   * 实际要读的源 = sources.local.json 的覆盖 + cfg.sources，本地优先、去重。
   * 宿主不给配置写入面（_research/contract/REPORT.md §7），所以 x_watch 只能改这一层。
   */
  get sources(): string[] {
    const out: string[] = [];
    const push = (line: string): void => {
      const trimmed = line.trim();
      if (trimmed === '') return;
      if (this.overlay.removed.some((one) => sameSource(one, trimmed))) return;
      if (out.some((one) => sameSource(one, trimmed))) return;
      out.push(trimmed);
    };
    for (const line of this.overlay.added) push(line);
    for (const line of sourceLines(this.opts.cfg.sources)) push(line);
    return out;
  }

  /** sources.local.json 的绝对路径：回执要说清这条只存在哪里。 */
  get overlayFile(): string {
    return join(this.vaultDir, SOURCES_FILE);
  }

  /** 这一行是不是 x_watch 加进去的（回执要标出来，别让人以为改的是配置）。 */
  isLocalOverride(line: string): boolean {
    return this.overlay.added.some((one) => sameSource(one, line));
  }

  /** 知识库目录（绝对路径）。回执要把它给模型看。 */
  get knowledgeDir(): string {
    return this.vaultDir;
  }

  /** 给 W5 的测试用：现在挂着宿主吗。 */
  get mounted(): boolean {
    return this.host !== null;
  }

  /** [W5-1] 7 个工具，声明逐字取自 definition.ts 的 TOOL_SPECS，这里只挂 handler。 */
  tools(): ToolDef[] {
    if (this.toolCache === null) this.toolCache = buildTools(this);
    return this.toolCache;
  }

  webUi(language?: Language): WorldWebUiDecl {
    const s = strings(language);
    const state = this.lampState();
    return {
      label: s.label,
      // 不声明 panels：声明了就要求包里有 webUiClient，没有只会换来一条警告。
      lamps: [{ label: s.lamp.label, state, hint: s.lamp.hint[state] }],
      config: xFeedConfigGroups(language),
      promptDocs: [
        {
          key: ENV_PROMPT_KEY,
          title: s.env.title,
          description: s.env.description,
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            { name: 'x.status', description: s.env.vars.status },
            { name: 'x.sources', description: s.env.vars.sources, multiline: true },
            { name: 'x.interval', description: s.env.vars.interval },
            { name: 'x.vault', description: s.env.vars.vault },
          ],
        },
      ],
    };
  }

  /**
   * 进系统前缀的变量。每次前缀重建都会重新调用（types.ts:905-910），所以这里每次都现算。
   * [W5-4] status 用引擎的真实状态。
   */
  envPromptVars(): Record<string, string> {
    const lines = this.sources;
    const minutes = Number(this.opts.cfg.intervalMinutes);
    return {
      'x.status': this.statusText(),
      // 纵深防御：sources 来自配置与 x_watch 的本地覆盖，进系统前缀之前再单行化 + 截断一次。
      'x.sources': lines.length ? MODEL.sourcesSome(lines.map(flattenSourceLine)) : MODEL.sourcesNone,
      'x.interval': Number.isFinite(minutes) && minutes > 0 ? MODEL.intervalOn(minutes) : MODEL.intervalOff,
      'x.vault': MODEL.vault(String(this.opts.cfg.vaultSubdir || WORLD_ID)),
    };
  }

  /**
   * [W5-2] 连浏览器 → 投 ready / down → 排第一次扫描。整段包在 try/catch 里：start 永不向外抛。
   *
   * 节奏：冷启动（还没登录过，或库还是空的）60 秒后扫第一轮；已初始化的正常启动等一个
   * intervalMinutes。稳定运行之后一律 intervalMinutes——2 小时是给「已经读得通」的状态用的，
   * 不能让刚装好的人干等两小时。
   */
  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.startedAt = nowIso();
    this.failure = null;
    try {
      await this.loadCursor();
      await this.loadOverlay();
      await this.checkLoginMarker();
      this.cold = !this.loginDone || (await this.vaultIsEmpty());
      await this.ensureEngine();
    } catch (error) {
      // ensureEngine 已经按需投过 down（markDown）；这里再补一次只在它没投成时兜底。
      this.failure = errorText(error);
      await this.markDown(error, 'start');
    }
    this.cold = !this.loginDone || (await this.vaultIsEmpty());
    try {
      this.armNext();
    } catch (error) {
      this.failure = errorText(error);
    }
  }

  /** [W5-3] 定时器必须在这里清掉（PLAN 第 6 节；子进程里的 Node 定时器不会自己走）。 */
  async stop(): Promise<void> {
    this.cancelled = true;
    this.disarmTimer();
    // 先跟这一轮扫描会合：不落地就 dispose，那一轮会继续用一条已经断掉的 wire 去 closePage，
    // attach 模式下那个 tab 会永远留在用户浏览器里。
    const inflight = this.inflight;
    if (inflight !== null) {
      try {
        await Promise.race([inflight, sleep(STOP_WAIT_MS)]);
      } catch {
        // 那一轮自己失败了也不影响 stop
      }
    }
    const engine = this.engine;
    this.engine = null;
    this.enginePhase = 'idle';
    this.host = null;
    this.startedAt = null;
    this.failure = null;
    this.down = false;
    if (engine) {
      try {
        await engine.dispose();
      } catch {
        // 浏览器可能已经被关掉了；stop 也不许抛。
      }
    }
  }

  // ——— 扫描 ———

  /**
   * 一轮扫描：ensure → 逐源 readSource → 转 LearnedItem → vault.put → 有新条目才 digest → 投事件。
   * 单源失败不拖垮其他源；全部源都失败时把第一个错误抛给回执去分类。
   */
  async scan(o: { sources?: string[]; limit?: number } = {}): Promise<ScanOutcome> {
    if (this.scanning) throw new Error('上一轮扫描还没结束，等它完成或稍后再试。');
    this.scanning = true;
    this.cancelled = false;
    const task = this.runScan(o);
    // stop() 靠它跟这一轮会合：不落地就 dispose，attach 模式下会留下永远关不掉的 tab。
    this.inflight = task.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await task;
    } finally {
      this.scanning = false;
      this.inflight = null;
    }
  }

  private async runScan(o: { sources?: string[]; limit?: number } = {}): Promise<ScanOutcome> {
    {
      const engine = await this.ensureEngine();
      const lines = o.sources === undefined ? this.sources : o.sources;
      const limit = clampInt(o.limit, clampInt(this.opts.cfg.limitPerSource, 20, 1, 100), 1, 100);
      const scrolls = clampInt(this.opts.cfg.maxScrolls, 3, 0, 20);
      const learnedAt = nowIso();
      const outcome: ScanOutcome = {
        at: learnedAt,
        perSource: [],
        added: [],
        skipped: 0,
        failures: [],
        delivered: false,
      };

      for (const line of lines) {
        if (this.cancelled) break; // stop() 之后不许再开新页面
        const source = parseSource(line);
        if (!source) {
          outcome.failures.push({ line, error: new Error('这一行读不懂，不是 home / user: / search: / list: / hashtag: / post: 中的任何一种') });
          continue;
        }
        try {
          const posts = await readSource(engine, source, { limit, scrolls });
          const items: LearnedItem[] = [];
          for (const post of posts) {
            const item = toItem(post, line, learnedAt);
            if (item) items.push(item);
          }
          const stored = await this.store(items);
          outcome.perSource.push({ line, read: posts.length, added: stored.added.length, skipped: stored.skipped });
          outcome.added.push(...stored.added);
          outcome.skipped += stored.skipped;
        } catch (error) {
          outcome.failures.push({ line, error });
        }
      }

      // 撞了登录墙又没登录过：把浏览器收干净、开到屏幕里一次，让人有机会登录（第 5 类失败 + 一句人话）。
      if (this.needsLoginWindow(outcome)) await this.showLoginWindow();

      // 一个源都没成：把第一个错误原样抛出去，让工具按 5 类失败回报。
      if (outcome.perSource.length === 0 && outcome.failures.length > 0) {
        throw outcome.failures[0].error;
      }

      if (this.cancelled) return outcome;
      this.cold = false;
      // 一轮读成功了就等于「这一代引擎可用」：把失败的旧账清掉，别留给 x_status 当现状。
      this.failure = null;
      this.lastFailure = null;
      await this.markLoginIfClean(outcome);
      this.cursor = { lastScanAt: outcome.at, lastScanAdded: outcome.added.length, scans: this.cursor.scans + 1 };
      await this.saveCursor();
      await this.publish(outcome);
      return outcome;
    }
  }

  /** x_look：给一行就是只读这一行，不给就是全部配置的源。 */
  async lookNow(source: string | undefined, limit: number | undefined): Promise<ScanOutcome> {
    const line = typeof source === 'string' ? source.trim() : '';
    return this.scan(line === '' ? {} : { sources: [line], limit });
  }

  /** x_read：读单条帖子并入库。 */
  async readNow(url: string): Promise<{ item: LearnedItem; added: boolean }> {
    const target = String(url === undefined || url === null ? '' : url).trim();
    const source = parseSource(target);
    if (!source || source.kind !== 'post') {
      throw new Error('这不是一条 X 帖子链接：' + (target || '(空)') + '。要形如 https://x.com/handle/status/1234567890。');
    }
    const engine = await this.ensureEngine();
    const post = await readPost(engine, target);
    if (!post) {
      // 页面级失败：帖子删了 / 没渲染 / 链接不对，都不是「浏览器坏了」。
      throw new XError('empty', '这条帖子读不到内容（可能已删除、被设成不公开、页面没渲染，或链接不对）：' + target);
    }
    const item = toItem(post, 'post:' + target, nowIso());
    if (!item) throw new XError('empty', '这条帖子没有正文（只有图片或视频）：' + target);
    const stored = await this.store([item]);
    return { item, added: stored.added.length > 0 };
  }

  /** x_recall：只在本地库里检索，不联网。 */
  async recall(query: string, limit?: number): Promise<LearnedItem[]> {
    return this.vault.search(String(query === undefined || query === null ? '' : query), {
      limit: clampInt(limit, 10, 1, 50),
    });
  }

  /** x_status 的快照。 */
  async statusSnapshot(): Promise<StatusSnapshot> {
    await this.loadCursor();
    await this.loadOverlay();
    await this.checkLoginMarker();
    const stats = await this.vault.stats();
    return {
      browser: this.browserStatus(),
      vault: stats,
      sources: this.sources,
      lastScanAt: this.cursor.lastScanAt,
      lastScanAdded: this.cursor.lastScanAdded,
      scans: this.cursor.scans,
      intervalMinutes: Number(this.opts.cfg.intervalMinutes),
      vaultDir: this.vaultDir,
      mounted: this.host !== null,
      browserAlive: this.browserAlive,
      needsLogin: this.needsLogin,
      localAdded: this.overlay.added.length,
      overlayPath: this.overlayPath(),
      cold: this.cold,
      waitingLogin: this.waitingLogin,
      loginRetries: this.loginRetries,
      nextScanAt: this.nextScanAt,
      lastFailure: this.lastFailure,
      enginePhase: this.enginePhase,
    };
  }

  /**
   * x_export：把知识库写成 cortico-memory-export 记忆包，落进 vault 目录，回执给路径。
   * 全量读取走 index.jsonl：Vault 契约只有 search/recent（recent 上限 100 条），
   * 而导出要「全部」，所以读 W4 自己声明为权威数据的那个文件（learn/vault.ts:1-4）。
   */
  async exportNow(since?: string): Promise<{ path: string; items: number; total: number; truncated: number }> {
    const all = await this.allItems();
    const from = typeof since === 'string' ? since.trim() : '';
    let items = all;
    if (from !== '') {
      const sinceMs = Date.parse(from);
      if (!Number.isFinite(sinceMs)) {
        throw new Error('since 要写成 ISO 8601 时刻（例如 2026-02-01T00:00:00Z），现在是「' + from + '」。');
      }
      items = all.filter((item) => {
        const ms = Date.parse(item.learnedAt);
        return Number.isFinite(ms) && ms >= sinceMs;
      });
    }
    const total = items.length;
    // 记忆包会长期留在记忆里：一次最多导最近 EXPORT_MAX_ITEMS 条，超了就照实说。
    if (items.length > EXPORT_MAX_ITEMS) {
      items = [...items]
        .sort((a, b) => (Date.parse(b.learnedAt) || 0) - (Date.parse(a.learnedAt) || 0))
        .slice(0, EXPORT_MAX_ITEMS);
    }
    const bundle = memoryExport(items);
    const stamp = nowIso().replace(/[:.]/g, '-');
    const path = join(this.vaultDir, 'export-' + stamp + '.json');
    await writeFileAtomic(path, JSON.stringify(bundle, null, 2) + '\n');
    return { path, items: items.length, total, truncated: total - items.length };
  }

  /** x_watch list 之外的增删：改的是 worlds.x-feed.sources。 */
  /**
   * 加一个源。这里只存 parseSource → formatSource 归一化后的结果，绝不留原始输入：
   * sources 会被拼进系统前缀（{{x.sources}}），存原文等于让第三方文本顶进指令位。
   */
  async addSource(raw: string): Promise<'added' | 'exists'> {
    const line = String(raw === undefined || raw === null ? '' : raw).trim();
    if (line === '') throw new SourceInputError('source 不能是空的：每行一个源，例如 user:elonmusk。');
    if (CONTROL_CHARS.test(line)) {
      throw new SourceInputError('源里不许有换行、制表或其他控制字符：一行只能是一个源（它会被拼进系统提示词）。');
    }
    if (line.length > MAX_SOURCE_CHARS) {
      throw new SourceInputError(
        '一个源最长 ' + String(MAX_SOURCE_CHARS) + ' 字，现在是 ' + String(line.length) + ' 字。',
      );
    }
    const source = parseSource(line);
    if (!source) {
      throw new SourceInputError(
        '这一行读不懂：「' + line + '」。种类只能是 home / user / search / list / hashtag / post，值写在「:」后面。',
      );
    }
    const normalized = formatSource(source);
    const lines = this.sources;
    if (lines.some((existing) => sameSource(existing, normalized))) return 'exists';
    if (lines.length >= MAX_SOURCES) {
      throw new SourceInputError(
        '最多看 ' + String(MAX_SOURCES) + ' 个源，现在已经满了：先 x_watch remove 去掉一个。',
      );
    }
    this.overlay.removed = this.overlay.removed.filter((one) => !sameSource(one, normalized));
    this.overlay.added = [...this.overlay.added, normalized];
    await this.saveOverlay();
    return 'added';
  }

  async removeSource(raw: string): Promise<'removed' | 'missing'> {
    const line = String(raw === undefined || raw === null ? '' : raw).trim();
    const lines = this.sources;
    if (!lines.some((existing) => sameSource(existing, line))) return 'missing';
    const local = this.overlay.added.some((one) => sameSource(one, line));
    if (local) {
      this.overlay.added = this.overlay.added.filter((one) => !sameSource(one, line));
    } else {
      this.overlay.removed = [...this.overlay.removed, line];
    }
    await this.saveOverlay();
    return 'removed';
  }

  // ——— 引擎 ———

  private buildEngine(): BrowserEngine {
    const cfg = this.opts.cfg;
    const mode = cfg.mode === 'attach' ? 'attach' : 'own';
    // windowPosition 只在拉起那一刻生效（W2 实测：复用已在跑的浏览器不会搬窗口），
    // 所以常规一律屏幕外，只有 showLoginWindow() 明确要人登录时才用 onscreen 重开一次。
    const windowPosition = this.visibleWindow && mode === 'own' ? 'onscreen' : 'offscreen';
    const options: EngineOptions = {
      mode,
      port: clampInt(cfg.port, 9223, 1, 65535),
      chromePath: String(cfg.chromePath === undefined || cfg.chromePath === null ? '' : cfg.chromePath).trim() || undefined,
      // own 模式必须有自己的 profile：绝不碰用户日常那个。
      profileDir: mode === 'own' ? join(this.vaultDir, PROFILE_DIR) : undefined,
      windowPosition,
      // 后台标签页在站点眼里是 visibility=hidden，X 这种 SPA 常常因此不渲染（W2 四条对照实测）。
      // own 模式：前台建页，站点当场渲染，窗口仍留在屏幕外，用户屏幕上什么都不弹。
      // attach 模式：绝不抢用户日常浏览器的焦点，保持默认的后台开页（代价是可能被节流，回执里会说）。
      backgroundTabs: mode !== 'own',
    };
    const factory = this.opts.createEngine ?? createEngine;
    const engine = factory(options);
    // 新一代引擎刚建出来、还没 ensure：状态必须回落，别让上一代的 ready / error 跨代。
    this.enginePhase = 'connecting';
    return engine;
  }

  /** 连上浏览器（已连上就是空操作）；失败时按需投 down 并把错误抛给调用方。 */
  private async ensureEngine(): Promise<BrowserEngine> {
    const engine = this.engine === null ? this.buildEngine() : this.engine;
    this.engine = engine;
    if (this.enginePhase === 'ready') return engine;
    try {
      await engine.ensure();
      this.enginePhase = 'ready';
      this.failure = null;
      this.lastFailure = null;
      await this.markReady();
      return engine;
    } catch (error) {
      this.enginePhase = 'failed';
      this.failure = errorText(error);
      this.lastFailure = error;
      await this.markDown(error, 'ensure');
      throw error;
    }
  }

  /**
   * 连接成没成由本实例说了算，绝不直接回引擎那一份 status()：
   * engine.ts 的 #lastError 是历史遗留，成功连上时不会自清，直接信它会让「一切正常」的一轮
   * 扫描带着一条假报警（真机踩过：库扫到 17 条、进程活着，回执却说连接检查报错）。
   */
  private browserStatus(): BrowserStatus {
    const mode = this.opts.cfg.mode === 'attach' ? 'attach' : 'own';
    const live = this.engine === null ? null : this.engine.status();
    const endpoint = live && live.endpoint ? live.endpoint : undefined;

    if (this.enginePhase === 'ready') {
      // 只借引擎的标签（endpoint / 版本），错误一律不看。
      if (live !== null && live.connected === false) {
        // 这一代确实握着引擎，但 socket 已经断了：如实说断线，不去翻旧账。
        return {
          connected: false,
          mode,
          endpoint,
          error: { code: 'not-connected', message: '浏览器连接断了；下一次调用会重新连上。' },
        };
      }
      return { connected: true, mode, endpoint, browser: live ? live.browser : undefined };
    }

    if (this.enginePhase === 'connecting') {
      // 重建中：新引擎还没 ensure，这一刻既不是错误也没有可报的现状。
      return { connected: false, mode, endpoint };
    }

    const raw = this.lastFailure;
    const code = raw instanceof CdpError ? raw.code : 'not-connected';
    const hint = raw instanceof CdpError ? raw.hint : undefined;
    return {
      connected: false,
      mode,
      endpoint,
      error: this.failure === null ? undefined : { code, message: this.failure, hint },
    };
  }

  // ——— 定时器 ———

  /** 排下一次扫描。intervalMinutes=0 就一只定时器都不挂（PLAN 第 4 节：0＝只由工具手动触发）。 */
  private armNext(delayMs?: number): void {
    this.disarmTimer();
    const intervalMs = this.intervalMs();
    if (intervalMs === null) {
      this.nextScanAt = null;
      return;
    }
    const delay = delayMs === undefined ? this.nextDelay(intervalMs) : delayMs;
    const timers = this.opts.timers ?? GLOBAL_TIMERS;
    const handle = timers.setTimeout(() => {
      void this.tick();
    }, delay);
    const unref = (handle as { unref?: () => void }).unref;
    if (typeof unref === 'function') unref.call(handle);
    this.timer = handle;
    this.nextScanAt = new Date(Date.now() + delay).toISOString();
  }

  private disarmTimer(): void {
    if (this.timer === null) return;
    const handle = this.timer;
    this.timer = null;
    (this.opts.timers ?? GLOBAL_TIMERS).clearTimeout(handle);
  }

  private intervalMs(): number | null {
    const minutes = Number(this.opts.cfg.intervalMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) return null;
    return Math.max(1000, Math.round(minutes * 60_000));
  }

  /**
   * 下一次该等多久：
   * - 等登录态：60 秒一跳（最多 LOGIN_RETRY_MAX 次）；
   * - 冷启动第一轮：60 秒（不是 intervalMinutes：刚装好的人不该干等两小时）；
   * - 其余：intervalMinutes。
   */
  private nextDelay(intervalMs: number): number {
    if (this.waitingLogin && this.loginRetries < LOGIN_RETRY_MAX) return LOGIN_RETRY_MS;
    if (this.cold) return COLD_START_DELAY_MS;
    return intervalMs;
  }

  /** 一跳：跑一轮，按结果决定下一跳的节奏。连不上或撞登录墙都不许让 World 消失。 */
  private async tick(): Promise<void> {
    try {
      await this.scan();
      this.cold = false;
      if (this.waitingLogin) {
        // 扫通了：markLoginIfClean 已经写过 login-done，回到正常节奏。
        this.waitingLogin = false;
        this.loginRetries = 0;
      }
    } catch (error) {
      this.failure = errorText(error);
      this.lastFailure = error;
      this.cold = false;
      if (this.isLoginWall(error) && !this.loginDone) {
        this.waitingLogin = true;
        this.loginRetries += 1;
        if (this.loginRetries >= LOGIN_RETRY_MAX) {
          this.waitingLogin = false;
          this.loginRetries = 0;
          await this.emit(
            'x-feed.down',
            'X 还没登录，我不会再自动重试了。'
              + '登录好之后叫我一声（或者等下一轮 ' + String(this.opts.cfg.intervalMinutes) + ' 分钟后的自动扫描）。',
          );
        }
      } else {
        this.warn('自动扫描失败：' + errorText(error));
      }
    }
    if (this.cancelled) return;
    this.armNext();
  }

  private isLoginWall(error: unknown): boolean {
    return error instanceof XError && error.code === 'login-required';
  }

  /** 该不该把浏览器开到人面前：撞了登录墙、还没登录过、而且不是 attach（attach 用的是用户自己的浏览器）。 */
  private needsLoginWindow(outcome: ScanOutcome): boolean {
    if (this.opts.cfg.mode === 'attach') return false;
    if (this.loginDone || this.visibleWindow) return false;
    return outcome.failures.some((one) => this.isLoginWall(one.error));
  }

  /**
   * 登录窗口：windowPosition 只在拉起那一刻生效（W2 三组对照实测：复用在跑的浏览器不会搬窗口），
   * 所以这里必须先 dispose 收干净，再用 onscreen 重新拉起——profile 目录没动，登录态不会丢。
   * 然后打开 x.com/home，让人一眼看到该在哪登录。
   */
  private async showLoginWindow(): Promise<void> {
    const previous = this.engine;
    this.engine = null;
    this.enginePhase = 'idle';
    if (previous !== null) {
      try {
        await previous.dispose();
      } catch {
        // 收不干净也要接着拉：拉起时自己会先探活复用
      }
    }
    this.visibleWindow = true;
    try {
      const engine = this.buildEngine();
      this.engine = engine;
      await engine.ensure();
      this.enginePhase = 'ready';
      this.failure = null;
      this.lastFailure = null;
      const page = await engine.newPage('about:blank');
      try {
        await engine.goto(page, 'https://x.com/home');
        await engine.waitReady(page);
      } finally {
        try {
          await engine.closePage(page);
        } catch {
          // 人还要在那个窗口里登录，tab 关不掉也不影响
        }
      }
    } catch (error) {
      this.failure = errorText(error);
      this.lastFailure = error;
      this.warn('登录窗口没弹出来：' + errorText(error));
      return;
    }
    const minutes = Number(this.opts.cfg.intervalMinutes);
    const after = Number.isFinite(minutes) && minutes > 0
      ? '登录成功之后窗口会自动收回屏幕外，之后每 ' + String(minutes) + ' 分钟自动看一次。'
      : '登录成功之后窗口会自动收回屏幕外（自动扫描现在是关着的，登录好叫我手动读一次）。';
    await this.emit(
      'x-feed.down',
      '需要你登录 X 一次：浏览器窗口已经弹出来了，请在弹出的 Chrome 里登录（只需一次），登录完再叫我。' + after,
    );
  }

  /** 库是空的就还算冷启动：装完先给一口内容，别让人等两小时。 */
  private async vaultIsEmpty(): Promise<boolean> {
    try {
      const stats = await this.vault.stats();
      return stats.items === 0;
    } catch {
      return true;
    }
  }

  // ——— 事件 ———

  private async markReady(): Promise<void> {
    this.down = false;
    await this.emit('x-feed.ready', MODEL.status.ready);
  }

  private async markDown(error: unknown, where: string): Promise<void> {
    const first = !this.down;
    this.down = true;
    if (!first) return;
    await this.emit(
      'x-feed.down',
      TEXT.events.down.zh + '（' + where + '：' + errorText(error) + '）',
    );
  }

  /** 一轮扫描之后的投递：有新内容才投摘要，扫完必投一条只落库的 scanned。 */
  private async publish(outcome: ScanOutcome): Promise<void> {
    if (outcome.added.length > 0) {
      const text = digest(outcome.added, { maxChars: clampInt(this.opts.cfg.digestMaxChars, 1200, 200, 8000) });
      if (text.trim() !== '') {
        const deliver = this.opts.cfg.deliverDigest !== false;
        await this.emit('x-feed.posts', text, { origin: 'external', deliver, trigger: 'debounce' });
        outcome.delivered = deliver;
      }
    }
    const parts = outcome.perSource.map((one) => one.line + ' ' + String(one.read) + ' 条/新增 ' + String(one.added));
    const failed = outcome.failures.map((one) => one.line + '（失败）');
    const head = '新增 ' + String(outcome.added.length) + ' 条，跳过 ' + String(outcome.skipped) + ' 条。';
    await this.emit('x-feed.scanned', head + (parts.length ? ' ' + parts.concat(failed).join('；') : ''), {
      deliver: false,
    });
  }

  private async emit(
    type: string,
    text: string,
    o: { origin?: EventOrigin; deliver?: boolean; trigger?: TriggerMode } = {},
  ): Promise<void> {
    const host = this.host;
    if (host === null) return;
    try {
      // 宿主不回话不许把整轮扫描（连带 scanning 锁）堵死：超时就只记日志，本轮照常结束。
      await withTimeout(
        host.pushEvent(
          {
            type,
            ts: nowIso(),
            source: this.id,
            origin: o.origin ?? 'internal',
            senderKey: this.id,
            text,
          },
          { deliver: o.deliver === undefined ? true : o.deliver, trigger: o.trigger },
        ),
        EVENT_PUSH_TIMEOUT_MS,
        'pushEvent(' + type + ')',
      );
    } catch (error) {
      this.warn('事件投递失败：' + type + '（' + errorText(error) + '）');
    }
  }

  private warn(message: string): void {
    try {
      this.host?.log.warn(message);
    } catch {
      // 日志失败也不许冒泡到调用方。
    }
  }

  // ——— 知识库与游标 ———

  /** 逐条 has() 预检后再 put：put 只回计数，而摘要与回执需要「到底哪几条是新的」。 */
  private async store(items: LearnedItem[]): Promise<{ added: LearnedItem[]; skipped: number }> {
    const seen = new Set<string>();
    const fresh: LearnedItem[] = [];
    let skipped = 0;
    for (const item of items) {
      if (seen.has(item.id)) {
        skipped += 1;
        continue;
      }
      seen.add(item.id);
      if (await this.vault.has(item.id)) {
        skipped += 1;
        continue;
      }
      fresh.push(item);
    }
    if (fresh.length === 0) return { added: [], skipped };
    const put = await this.vault.put(fresh);
    return { added: fresh, skipped: skipped + put.skipped };
  }

  private async allItems(): Promise<LearnedItem[]> {
    let raw = '';
    try {
      raw = await readFile(join(this.vaultDir, INDEX_FILE), 'utf8');
    } catch {
      return [];
    }
    const byId = new Map<string, LearnedItem>();
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const record = JSON.parse(trimmed) as LearnedItem;
        if (record && typeof record.id === 'string' && record.id !== '') byId.set(record.id, record);
      } catch {
        // 坏行跳过：导出不该因为一行受损就整包失败。
      }
    }
    return [...byId.values()];
  }

  private cursorPath(): string {
    return join(this.vaultDir, STATE_FILE);
  }

  private async loadCursor(): Promise<void> {
    if (this.cursorLoaded) return;
    this.cursorLoaded = true;
    let raw: string;
    try {
      raw = await readFile(this.cursorPath(), 'utf8');
    } catch {
      // 文件不存在是正常的第一次；不是错误。
      this.cursor = { ...EMPTY_CURSOR };
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<Cursor>;
      this.cursor = {
        lastScanAt: typeof parsed.lastScanAt === 'string' ? parsed.lastScanAt : null,
        lastScanAdded: Number.isFinite(Number(parsed.lastScanAdded)) ? Number(parsed.lastScanAdded) : 0,
        scans: Number.isFinite(Number(parsed.scans)) ? Number(parsed.scans) : 0,
      };
    } catch (error) {
      // 读得懂文件、读不懂内容：留着原文件当证据，别静默清零。
      await this.quarantine(this.cursorPath(), 'state.json 内容读不懂');
      this.cursor = { ...EMPTY_CURSOR };
      this.warn('state.json 内容读不懂，已另存：' + errorText(error));
    }
  }

  private async saveCursor(): Promise<void> {
    try {
      await writeFileAtomic(this.cursorPath(), JSON.stringify(this.cursor, null, 2) + '\n');
    } catch (error) {
      this.warn('游标没写进 state.json：' + errorText(error));
    }
  }

  /** 坏文件改名留下来，人还能看；不悄悄覆盖掉。 */
  private async quarantine(path: string, why: string): Promise<void> {
    const stamp = nowIso().replace(/[:.]/g, '-');
    try {
      await rename(path, path + '.bad-' + stamp);
    } catch {
      this.warn(why + '，而且改名失败：' + path);
    }
  }

  // ——— 本地覆盖与登录标记 ———

  private overlayPath(): string {
    return join(this.vaultDir, SOURCES_FILE);
  }

  private async loadOverlay(): Promise<void> {
    if (this.overlayLoaded) return;
    this.overlayLoaded = true;
    let raw: string;
    try {
      raw = await readFile(this.overlayPath(), 'utf8');
    } catch {
      this.overlay = { added: [], removed: [] };
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<SourceOverlay>;
      this.overlay = {
        added: Array.isArray(parsed.added) ? parsed.added.filter((one): one is string => typeof one === 'string') : [],
        removed: Array.isArray(parsed.removed) ? parsed.removed.filter((one): one is string => typeof one === 'string') : [],
      };
    } catch (error) {
      // 本地加的源不能因为一次坏写就消失：原文件留下，人还能捞回来。
      await this.quarantine(this.overlayPath(), SOURCES_FILE + ' 内容读不懂');
      this.overlay = { added: [], removed: [] };
      this.warn(SOURCES_FILE + ' 内容读不懂，已另存：' + errorText(error));
    }
  }

  private async saveOverlay(): Promise<void> {
    try {
      await writeFileAtomic(this.overlayPath(), JSON.stringify({ version: 1, ...this.overlay }, null, 2) + '\n');
    } catch (error) {
      this.warn(SOURCES_FILE + ' 没写成：' + errorText(error));
    }
  }

  /** 登录标记在不在。读不到就是没有：宁可多开一次看得见的窗口，也不要让人卡在登录墙上。 */
  private async checkLoginMarker(): Promise<void> {
    if (this.loginChecked) return;
    this.loginChecked = true;
    try {
      await readFile(join(this.vaultDir, LOGIN_MARKER), 'utf8');
      this.loginDone = true;
    } catch {
      this.loginDone = false;
    }
  }

  /** 扫到一次「有源读成功、且没撞登录墙」的扫描＝登录态可用，写标记，下次起浏览器直接屏幕外。 */
  private async markLoginIfClean(outcome: ScanOutcome): Promise<void> {
    await this.checkLoginMarker();
    if (this.loginDone) return;
    if (this.opts.cfg.mode === 'attach') return; // 共享用户的浏览器，登录态不是本扩展的事
    if (outcome.perSource.length === 0) return;
    if (outcome.failures.some((one) => this.isLoginWall(one.error))) return;
    this.loginDone = true;
    this.visibleWindow = false;
    try {
      await writeFileAtomic(join(this.vaultDir, LOGIN_MARKER), JSON.stringify({ at: nowIso() }) + '\n');
    } catch (error) {
      this.warn(LOGIN_MARKER + ' 没写成：' + errorText(error));
    }
  }

  /** 浏览器这一侧现在是不是活着（跨扫描常驻，只在 stop() 里关）。 */
  get browserAlive(): boolean {
    return this.engine !== null && this.engineReady;
  }

  /** own 模式还需不需要人登录一次。 */
  get needsLogin(): boolean {
    return this.opts.cfg.mode !== 'attach' && !this.loginDone;
  }

  // ——— 界面状态 ———

  private lampState(): WorldLamp['state'] {
    if (this.failure !== null) return 'error';
    if (this.engineReady) return 'online';
    if (!this.opts.cfg.enabled) return 'offline';
    return this.startedAt === null ? 'offline' : 'loading';
  }

  private statusText(): string {
    if (this.failure !== null) return MODEL.status.failed;
    if (this.engineReady) return MODEL.status.ready;
    if (this.startedAt !== null) return MODEL.status.starting;
    return MODEL.status.idle;
  }
}

/** 两行源是不是同一个源：按 parseSource 的语义比，user:ElonMusk 与 USER:elonmusk 算一个。 */
export function sameSource(a: string, b: string): boolean {
  const left = parseSource(a);
  const right = parseSource(b);
  if (!left || !right) return a.trim().toLowerCase() === b.trim().toLowerCase();
  return left.kind === right.kind && left.value.toLowerCase() === right.value.toLowerCase();
}
