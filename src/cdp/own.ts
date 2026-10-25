/**
 * own 模式：给这个扩展一个专属 Chrome/Edge（独立 profile、独立调试口）。
 * 参数与收尸方式照抄 _research/cwb 的 own-browser.ts（MIT），理由见每条注释。
 *
 * 只杀自己 spawn 出来的那个进程树：探活捡到别人已经在跑的实例就复用，不动它。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { CdpError, HINT, describe } from './error.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const PROBE_TIMEOUT_MS = 2000;
const READY_POLL_MS = 500;
const KILL_WAIT_MS = 8000;

export interface BrowserVersion {
  wsUrl: string;
  browser: string;
}

/** 从浏览器自己的 HTTP 口读 /json/version。没开/不应答一律 null（不抛错）。 */
export async function probeVersion(
  port: number,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<BrowserVersion | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(Math.max(200, timeoutMs)),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { webSocketDebuggerUrl?: unknown; Browser?: unknown };
    const wsUrl = typeof body.webSocketDebuggerUrl === 'string' ? body.webSocketDebuggerUrl : '';
    if (!wsUrl) return null;
    return { wsUrl, browser: typeof body.Browser === 'string' ? body.Browser : '' };
  } catch {
    return null;
  }
}

/** 本机上常见的 Chrome / Edge / Chromium 位置，按优先级。 */
export function browserCandidates(): string[] {
  const pf = process.env['PROGRAMFILES'] ?? 'C:\\Program Files';
  const pf86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'];
  const list = [
    join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    local ? join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    local ? join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
    join(pf, 'Chromium', 'Application', 'chrome.exe'),
  ].filter((item) => item !== '');
  return [...new Set(list)];
}

/** 配置里的 chromePath 优先；空则按候选列表探测。都找不到 = no-browser。 */
export function resolveBrowser(chromePath?: string): string {
  const wanted = (chromePath ?? '').trim();
  if (wanted) {
    if (!existsSync(wanted)) {
      throw new CdpError(
        'no-browser',
        `chromePath 指向的文件不存在：${wanted}`,
        '填 chrome.exe / msedge.exe 的绝对路径，或留空让它自动探测',
      );
    }
    return wanted;
  }
  for (const candidate of browserCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  throw new CdpError(
    'no-browser',
    '找不到 Chrome / Edge 的可执行文件',
    `试过：${browserCandidates().join('；')}。请在配置里填 chromePath`,
  );
}

/** 窗口待遇：屏幕外（默认，不打扰人）或屏幕内（用户要能看见并动手）。 */
export type WindowPosition = 'offscreen' | 'onscreen';

/** 屏幕外的住处：远到任何显示器都不可能看见。 */
const OFFSCREEN_POSITION = '-32000,-32000';
/** 屏幕内的落点：左上角留点余量，正常人一眼看得见。 */
const ONSCREEN_POSITION = '120,120';

/**
 * 专属实例的固定启动参数（照抄 cwb own-browser.ts，每条都有理由）：
 * - --remote-debugging-port：调试口，我们与 DevTools 都从这里进
 * - --remote-allow-origins=*：Chrome 111 起会挡掉没带来源头的 ws 连接
 * - --window-position：屏幕外（默认）或屏幕内，见 `windowPosition`
 * - CalculateNativeWinOcclusion 关掉：Windows 上被盖住的窗口会被判 hidden，后台页面被掐掉
 * - IntensiveWakeUpThrottling + 三个 background 节流开关：长闲置页面里的定时器别被夹到分钟级
 */
export function ownBrowserArgs(
  profileDir: string,
  port: number,
  windowPosition: WindowPosition = 'offscreen',
): string[] {
  // 屏幕内这一档必须显式给坐标，不能"不传就让 Chrome 自己摆"：Chrome 会按 profile 里
  // **上次保存的位置**恢复窗口，而上一次多半正停在 -32000 —— 不传就等于还是屏幕外。
  const position = windowPosition === 'onscreen' ? ONSCREEN_POSITION : OFFSCREEN_POSITION;
  return [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--window-position=${position}`,
    '--window-size=1100,800',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-service-autorun',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling',
  ];
}

/** `taskkill /pid <pid> /T /F`，返回退出码（拿不到就 -1）。 */
async function runTaskkill(pid: number): Promise<number> {
  return new Promise<number>((resolve) => {
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code);
    };
    const timer = setTimeout(() => finish(-1), 5000);
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('exit', (code) => finish(code ?? -1));
      killer.on('error', () => finish(-1));
    } catch {
      finish(-1);
    }
  });
}

/** 拉起子进程的最小形状（测试可以换掉它，不去真跑一个浏览器）。 */
export type OwnSpawn = (
  exe: string,
  args: string[],
  options: { detached: boolean; stdio: 'ignore'; windowsHide: boolean },
) => ChildProcess;

/** 任意用户可写、不该从里头执行浏览器的地方。 */
function tempRoots(): string[] {
  const raw = [
    tmpdir(),
    process.env['TEMP'] ?? '',
    process.env['TMP'] ?? '',
    process.env['LOCALAPPDATA'] ? join(process.env['LOCALAPPDATA'], 'Temp') : '',
    'C:\\Windows\\Temp',
  ];
  const roots = new Set<string>();
  for (const item of raw) {
    if (item.trim() === '') continue;
    try {
      roots.add(resolve(item).toLowerCase());
    } catch {
      // 解析不了就不当它是根
    }
  }
  return [...roots];
}

/**
 * chromePath 是"配置项直通 spawn"的通道，信任级与配置本身相同 —— 这里不假装它是安全边界，
 * 只把两件明显不对的事在最低成本的地方拦掉（审计 P2-10）：
 * 在 Windows 上必须以 .exe 结尾（别处要求可执行位），且不能落在任意用户可写的临时目录里。
 */
export function assertBrowserPathTrusted(exe: string): void {
  const lower = resolve(exe).toLowerCase();
  if (process.platform === 'win32') {
    if (!lower.endsWith('.exe')) {
      throw new CdpError(
        'no-browser',
        `chromePath 必须以 .exe 结尾：${exe}`,
        '填 chrome.exe / msedge.exe 这类可执行文件的绝对路径',
      );
    }
  } else {
    let mode = 0;
    try {
      mode = statSync(resolve(exe)).mode;
    } catch {
      mode = 0;
    }
    if ((mode & 0o111) === 0) {
      throw new CdpError('no-browser', `chromePath 没有可执行位：${exe}`, 'chmod +x 之后再试');
    }
  }
  for (const root of tempRoots()) {
    if (lower === root || lower.startsWith(root + sep) || lower.startsWith(`${root}/`)) {
      throw new CdpError(
        'no-browser',
        `chromePath 落在临时目录里，不接受：${exe}`,
        `临时目录（${root}）是任意用户可写的地方；请用 Program Files 下的浏览器，或把 chromePath 留空自动探测`,
      );
    }
  }
}

export interface OwnBrowserOptions {
  exePath: string;
  profileDir: string;
  port: number;
  /** 窗口待遇，默认 'offscreen' */
  windowPosition?: WindowPosition;
  /** 额外启动参数 */
  extraArgs?: readonly string[];
  /** 测试注入口：替换 spawn（生产不传） */
  spawnImpl?: OwnSpawn;
}

export class OwnBrowser {
  #opts: OwnBrowserOptions;
  #child: ChildProcess | null = null;
  #pid: number | null = null;
  #reused = false;
  #spawnError = '';

  constructor(opts: OwnBrowserOptions) {
    this.#opts = opts;
  }

  /** 探活捡到的实例：收尸时不许动它。 */
  get reusedExisting(): boolean {
    return this.#reused;
  }

  /** 自己 spawn 的 pid（复用来的实例为 null）。 */
  get pid(): number | null {
    return this.#pid;
  }

  get endpoint(): string {
    return `http://127.0.0.1:${this.#opts.port}`;
  }

  /**
   * 保证端口上有浏览器：先探活（活着就复用），探不到才拉起，起来后等 /json/version 应答。
   * 失败抛 CdpError（no-browser / no-port）。
   */
  async ensure(readyTimeoutMs = 30_000): Promise<BrowserVersion> {
    const existing = await probeVersion(this.#opts.port);
    if (existing) {
      this.#reused = true;
      return existing;
    }
    const profileDir = this.#opts.profileDir ?? '';
    if (!profileDir.trim()) {
      throw new CdpError(
        'no-browser',
        'own 模式没给 profileDir（专属 profile 目录）',
        '传一个独占的目录进来，绝不要指向用户日常 profile',
      );
    }
    if (!existsSync(this.#opts.exePath)) {
      throw new CdpError(
        'no-browser',
        `浏览器可执行文件不存在：${this.#opts.exePath}`,
        '填 chrome.exe / msedge.exe 的绝对路径',
      );
    }
    assertBrowserPathTrusted(this.#opts.exePath);
    try {
      mkdirSync(profileDir, { recursive: true });
    } catch (err) {
      throw new CdpError('no-browser', `建不了 profile 目录：${describe(err)}`, '换一个可写目录');
    }
    // 只有窗口坐标这一条跟着开关走：探活、复用、收尸一概不认 windowPosition。
    const args = ownBrowserArgs(profileDir, this.#opts.port, this.#opts.windowPosition ?? 'offscreen');
    for (const extra of this.#opts.extraArgs ?? []) {
      if (extra.trim() !== '') args.push(extra.trim());
    }
    let child: ChildProcess;
    try {
      // windowsHide 故意为 false：那面旗会把 SW_HIDE 传给子进程，Chrome 的窗口于是生来就是
      // 操作系统层面的隐藏（任务栏连按钮都没有）。窗口位置由 --window-position 决定（默认屏幕外），
      // 所以不隐藏也不会晃到用户眼前；chrome.exe 是 GUI 程序，不隐藏也不会弹控制台。
      // 例外是 windowPosition='onscreen'：那是用户自己要看见的窗口，隐藏反而坏事。
      const spawner = this.#opts.spawnImpl ?? (spawn as unknown as OwnSpawn);
      child = spawner(this.#opts.exePath, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
    } catch (err) {
      throw new CdpError('no-browser', `拉不起浏览器：${describe(err)}`, '看浏览器能不能从命令行启动');
    }
    child.on('error', (err: Error) => {
      this.#spawnError = `拉不起浏览器：${err.message}`;
    });
    child.unref(); // 不跟着本进程退出走：World 重启时它还在，下次探活就能复用
    this.#child = child;
    this.#pid = child.pid ?? null;
    this.#reused = false; // 这次是自己拉的，不是捡来的

    const budget = Math.max(3000, readyTimeoutMs);
    const deadline = Date.now() + budget;
    while (Date.now() < deadline) {
      const found = await probeVersion(this.#opts.port, PROBE_TIMEOUT_MS);
      if (found) return found;
      if (this.#spawnError) {
        const message = this.#spawnError;
        await this.stop();
        throw new CdpError('no-browser', message, '看浏览器能不能从命令行启动');
      }
      if (child.exitCode !== null) {
        const code = child.exitCode;
        await this.stop(); // 进程已经没了，但 #pid 不能留着（留给将来的 stop 去 taskkill 一个死 pid）
        throw new CdpError(
          'no-browser',
          `浏览器进程起来就退了（exit ${code}）`,
          'profile 可能被另一个 Chrome 占着，或启动参数被拒绝',
        );
      }
      await sleep(READY_POLL_MS);
    }
    // 这是我们自己拉起来的那只：调试口不应答就等于废了。先收尸再报错，否则它会一直挂着、
    // 占着 profile，下次启动直接变成「profile 正在使用」（审计 P2-4）。
    await this.stop();
    throw new CdpError(
      'no-port',
      `浏览器起来了但调试口 ${this.#opts.port} 没响应（等了 ${Math.round(budget / 1000)} 秒）`,
      'profile 可能被别的进程占用；或本机安全软件拦了调试端口',
    );
  }

  /**
   * 只关自己拉起的那个进程树。复用的实例不动。幂等：重复调用什么都不做。
   * Windows 上 Chrome 是一棵进程树：只 kill 主进程会留下 renderer / crashpad 这些子进程，
   * 它们还占着 profile（下次启动就说「profile 正在使用」），所以要用 taskkill /T /F 整棵树一起收。
   */
  async stop(): Promise<void> {
    const child = this.#child;
    const pid = this.#pid;
    this.#child = null;
    this.#pid = null;
    if (pid === null) return;
    if (process.platform === 'win32') {
      // 顺序要紧：先 taskkill /T 整棵树一起收。反过来先 child.kill() 会先把父进程做掉，
      // taskkill 再去按 pid 找子进程就找不到了 —— 量到过 renderer/crashpad 两个进程被落下，
      // 它们仍占着 profile，下次启动就变成「profile 正在使用」。
      const code = await runTaskkill(pid);
      if (code !== 0) {
        // taskkill 说没有这个 pid（已经退了）或工具缺失：补一刀
        try {
          child?.kill();
        } catch {
          // 已经没了
        }
      }
    } else {
      try {
        child?.kill();
      } catch {
        // 已经没了
      }
    }
    // 等调试口真的不说话（最多 KILL_WAIT_MS）：收尸是否彻底由调用方另外查。
    const deadline = Date.now() + KILL_WAIT_MS;
    while (Date.now() < deadline) {
      if (!(await probeVersion(this.#opts.port, 800))) return;
      await sleep(200);
    }
  }
}
