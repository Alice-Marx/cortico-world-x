/**
 * BrowserEngine 的实现（PLAN 3.1）。业务流程都在这里：连上谁、开哪个页面、怎么等加载、
 * 怎么求值。协议机械那半在 wire.ts，拉起/收尸浏览器那半在 own.ts。
 */
import { CdpError, HINT, asCdpError, describe } from './error.ts';
import { CdpWire, DEFAULT_COMMAND_TIMEOUT_MS } from './wire.ts';
import { OwnBrowser, probeVersion, resolveBrowser } from './own.ts';
import type { BrowserEngine, BrowserStatus, EngineOptions, PageHandle } from './types.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 等加载的轮询间隔（PLAN：每 500ms 查一次 document.readyState）。 */
const READY_POLL_MS = 500;
const DEFAULT_WAIT_READY_MS = 15_000;
/** 滚动之后给懒加载留的时间。 */
const SCROLL_SETTLE_MS = 800;

const clamp = (value: number, lo: number, hi: number): number =>
  Number.isFinite(value) ? Math.min(hi, Math.max(lo, value)) : lo;

export function createEngine(opts: EngineOptions): BrowserEngine {
  return new CdpBrowserEngine(opts);
}

export class CdpBrowserEngine implements BrowserEngine {
  #opts: EngineOptions;
  #wire: CdpWire | null = null;
  #own: OwnBrowser | null = null;
  #browserLabel = '';
  #lastError: CdpError | null = null;
  /** 这些 target 的 Page 域已经使能过（一次就够）。 */
  #pageEnabled = new Set<string>();
  #ensureTask: Promise<void> | null = null;
  #disposeTask: Promise<void> | null = null;
  /** dispose 一进来就置位：在飞的 ensure 靠它在下一个检查点收手。 */
  #disposed = false;

  constructor(opts: EngineOptions) {
    this.#opts = { ...opts };
  }

  // ——— 状态 ———

  status(): BrowserStatus {
    const connected = this.#wire?.isOpen ?? false;
    const port = Number(this.#opts.port);
    const out: BrowserStatus = {
      connected,
      mode: this.#opts.mode,
      endpoint: Number.isFinite(port) ? `http://127.0.0.1:${port}` : '',
    };
    if (this.#browserLabel) out.browser = this.#browserLabel;
    const err = this.#lastError;
    if (err && !connected) {
      out.error = err.hint
        ? { code: err.code, message: err.message, hint: err.hint }
        : { code: err.code, message: err.message };
    }
    return out;
  }

  // ——— 连接 ———

  /** 拉起/连上浏览器。并发调用合并成一次；失败抛 CdpError，并把原因记进 status()。 */
  async ensure(): Promise<void> {
    if (this.#disposed) {
      throw new CdpError(
        'not-connected',
        '引擎已经 dispose 了',
        'dispose() 之后这个引擎不能再用；要接着干活请重新 createEngine',
      );
    }
    if (this.#wire?.isOpen) {
      // 早退路径同样清：#lastError 是"上一次为什么连不上"，一个已经连上的引擎不该再背着它。
      this.#lastError = null;
      return;
    }
    if (this.#ensureTask) return this.#ensureTask;
    this.#ensureTask = this.#establish().finally(() => {
      this.#ensureTask = null;
    });
    return this.#ensureTask;
  }

  async #establish(): Promise<void> {
    this.#abortIfDisposed();
    const mode = this.#opts.mode;
    const port = Number(this.#opts.port);
    if (mode !== 'own' && mode !== 'attach') {
      throw this.#fail(
        new CdpError('no-port', `mode 只能是 own 或 attach，收到：${String(mode)}`, '改配置 worlds.x-feed.mode'),
      );
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw this.#fail(
        new CdpError('no-port', `调试端口不合法：${String(this.#opts.port)}`, '改配置 worlds.x-feed.port（默认 9223）'),
      );
    }
    if (mode === 'own') {
      let own = this.#own;
      if (!own) {
        try {
          own = new OwnBrowser({
            exePath: resolveBrowser(this.#opts.chromePath),
            profileDir: this.#opts.profileDir ?? '',
            port,
            windowPosition: this.#opts.windowPosition,
            spawnImpl: this.#opts.spawnImpl,
          });
        } catch (err) {
          throw this.#fail(asCdpError(err, 'no-browser'));
        }
        this.#own = own;
      }
      try {
        await own.ensure(this.#opts.readyTimeoutMs ?? 30_000);
      } catch (err) {
        throw this.#fail(asCdpError(err, 'no-browser'));
      }
      // 拉起浏览器这 30 秒里可能已经 dispose 了：停在这里，#own 留给 dispose 去收尸。
      this.#abortIfDisposed();
    }
    const version = await probeVersion(port, 3000);
    if (!version) {
      throw this.#fail(
        new CdpError(
          'no-port',
          mode === 'own'
            ? `调试口 ${port} 没响应`
            : `127.0.0.1:${port} 上没有可连的调试口`,
          mode === 'own'
            ? '浏览器可能还在启动；再 ensure 一次，或看 profile 是否被占用'
            : 'attach 模式需要先手动启动浏览器并带 --remote-debugging-port=<端口>（Chrome 111 起还要 --remote-allow-origins=*）',
        ),
      );
    }
    const wire = new CdpWire({
      webSocket: this.#opts.webSocket,
      commandTimeoutMs: this.#opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      connectTimeoutMs: this.#opts.connectTimeoutMs ?? 10_000,
    });
    try {
      await wire.connect(version.wsUrl, this.#opts.connectTimeoutMs ?? 10_000);
    } catch (err) {
      throw this.#fail(asCdpError(err, 'ws-failed'));
    }
    // dispose 可能正好在 connect 期间跑完（它已经清过一轮状态）：这条刚建好的 ws
    // 必须就地关掉，否则它就是一条没人认领的连接（审计 P2-3）。
    if (this.#disposed) {
      try {
        await wire.close();
      } catch {
        // 关不掉也没有别人持有它了
      }
      this.#abortIfDisposed();
    }
    wire.browserLabel = version.browser;
    this.#wire = wire;
    this.#browserLabel = version.browser;
    this.#lastError = null;
    this.#pageEnabled.clear();
    // PLAN 要求用 setDiscoverTargets + attachToTarget{flatten} 这一套；装不上不影响主流程。
    try {
      await wire.send('Target.setDiscoverTargets', { discover: true }, undefined, 5000);
    } catch {
      // 有的实现直接拒；attach 仍然能用
    }
  }

  /** dispose 之后不该再继续建连接：每个 await 之后都过一下这里。 */
  #abortIfDisposed(): void {
    if (!this.#disposed) return;
    throw new CdpError(
      'not-connected',
      '引擎在连接过程中被 dispose 了',
      HINT['not-connected'],
    );
  }

  #fail(err: CdpError): CdpError {
    this.#lastError = err;
    return err;
  }

  #cmdTimeout(): number {
    return this.#opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  }

  /** 拿到一条可用连接；没连上就 ensure。 */
  async #ready(): Promise<CdpWire> {
    await this.ensure();
    const wire = this.#wire;
    if (!wire || !wire.isOpen) {
      throw new CdpError('not-connected', '浏览器没连上', HINT['not-connected']);
    }
    return wire;
  }

  /** 拿页面的扁平会话，顺手把 Page 域使能一次（截图/导航都靠它）。 */
  async #session(p: PageHandle): Promise<{ wire: CdpWire; sessionId: string }> {
    const wire = await this.#ready();
    const sessionId = await wire.sessionFor(p.targetId, this.#cmdTimeout());
    if (!this.#pageEnabled.has(p.targetId)) {
      this.#pageEnabled.add(p.targetId);
      try {
        await wire.send('Page.enable', {}, sessionId, 5000);
      } catch {
        // 装不上就算了：navigate/captureScreenshot 多数时候仍然能跑
      }
    }
    return { wire, sessionId };
  }

  // ——— 页面 ———

  async newPage(url: string): Promise<PageHandle> {
    const wire = await this.#ready();
    const target = url || 'about:blank';
    const background = this.#opts.backgroundTabs !== false;
    const result = await wire.send(
      'Target.createTarget',
      { url: target, background },
      undefined,
      this.#cmdTimeout(),
    );
    const targetId = typeof result.targetId === 'string' ? result.targetId : '';
    if (!targetId) {
      throw new CdpError('cdp-failed', 'Target.createTarget 没回 targetId', HINT['cdp-failed']);
    }
    if (!background) {
      // createTarget{background:false} 通常已经把它激活了；再补一次是保险——窗口在屏幕外、
      // 或浏览器刚启动时，头一次激活有时不生效，而这条能力全部意义就在"站点看到 visible"。
      try {
        await wire.send('Target.activateTarget', { targetId }, undefined, 5000);
      } catch {
        // 激活不了不影响页面本身：visibilityState 仍以页面自己报的为准
      }
    }
    return { targetId, url: target };
  }

  async goto(
    p: PageHandle,
    url: string,
    o?: { timeoutMs?: number },
  ): Promise<{ ok: boolean; url: string; note?: string }> {
    const { wire, sessionId } = await this.#session(p);
    const nav = await wire.send('Page.navigate', { url }, sessionId, this.#cmdTimeout());
    const navError = typeof nav.errorText === 'string' ? nav.errorText : '';
    // 等加载超时不算失败（PLAN）：返回 ok:false + note，页面仍留在那里。
    const settled = await this.#pollReady(sessionId, o?.timeoutMs ?? DEFAULT_WAIT_READY_MS);
    const actual = settled.url || url;
    p.url = actual;
    if (navError) {
      return { ok: false, url: actual, note: `浏览器报错：${navError}` };
    }
    if (!settled.ready) {
      return {
        ok: false,
        url: actual,
        note: `等加载超时（${clamp(o?.timeoutMs ?? DEFAULT_WAIT_READY_MS, 100, 120_000)} 毫秒内 document.readyState 没到 complete），页面可能还在加载`,
      };
    }
    return { ok: true, url: actual };
  }

  async waitReady(p: PageHandle, o?: { timeoutMs?: number }): Promise<boolean> {
    const { sessionId } = await this.#session(p);
    const settled = await this.#pollReady(sessionId, o?.timeoutMs ?? DEFAULT_WAIT_READY_MS);
    return settled.ready;
  }

  /** 每 500ms 问一次 readyState；预算用完返回 ready:false（不算失败）。 */
  async #pollReady(
    sessionId: string,
    budgetMs: number,
  ): Promise<{ ready: boolean; url: string }> {
    const wire = this.#wire;
    if (!wire) {
      throw new CdpError('not-connected', '浏览器没连上', HINT['not-connected']);
    }
    const deadline = Date.now() + clamp(budgetMs, 100, 120_000);
    let lastUrl = '';
    for (;;) {
      try {
        const result = await wire.send(
          'Runtime.evaluate',
          {
            expression: 'JSON.stringify({ready: document.readyState, url: location.href})',
            returnByValue: true,
          },
          sessionId,
          Math.min(this.#cmdTimeout(), 10_000),
        );
        const raw = result.result?.value;
        if (typeof raw === 'string') {
          const state = JSON.parse(raw) as { ready?: unknown; url?: unknown };
          if (typeof state.url === 'string') lastUrl = state.url;
          if (state.ready === 'complete') return { ready: true, url: lastUrl };
        }
      } catch (err) {
        // 连接级失败要立刻冒出去：不能把「浏览器断了」当成「页面还在加载」白等满预算。
        if (err instanceof CdpError && (err.code === 'not-connected' || err.code === 'ws-failed')) {
          throw err;
        }
        // 其余（页面正在导航、这条命令超时）这一轮跳过，下一轮再试
      }
      if (Date.now() >= deadline) return { ready: false, url: lastUrl };
      await sleep(READY_POLL_MS);
    }
  }

  // ——— 命令 ———

  async evaluate<T>(
    p: PageHandle,
    expr: string,
    o?: { awaitPromise?: boolean; timeoutMs?: number },
  ): Promise<T> {
    const { wire, sessionId } = await this.#session(p);
    let result: Record<string, any>;
    try {
      result = await wire.send(
        'Runtime.evaluate',
        {
          expression: expr,
          returnByValue: true,
          awaitPromise: o?.awaitPromise ?? true,
        },
        sessionId,
        clamp(o?.timeoutMs ?? this.#cmdTimeout(), 1, 120_000),
      );
    } catch (err) {
      // 「返回了不能序列化的值（DOM 节点、循环引用）」不是浏览器故障，是表达式写法问题。
      const message = describe(err);
      if (/couldn't be returned by value|Object reference chain|Unserializable|serialize/i.test(message)) {
        throw new CdpError(
          'page-failed',
          `页面里这段表达式没能带回结果：${message}`,
          '只返回字符串/数字/普通对象：DOM 节点请先取 .innerText/.outerHTML 这类值',
        );
      }
      throw err;
    }
    const details = result.exceptionDetails;
    if (details) {
      throw new CdpError(
        'page-failed',
        `页面里这段 JS 抛错：${detailText(details)}`,
        '这里只收表达式；要跑多行语句请自己包成 (async () => { … })() 并 return 一个值',
      );
    }
    return result.result?.value as T;
  }

  async text(p: PageHandle): Promise<string> {
    const value = await this.evaluate<unknown>(
      p,
      'document.body ? document.body.innerText : (document.documentElement ? document.documentElement.innerText : "")',
    );
    return typeof value === 'string' ? value : '';
  }

  async screenshot(p: PageHandle): Promise<Uint8Array> {
    const { wire, sessionId } = await this.#session(p);
    const result = await wire.send(
      'Page.captureScreenshot',
      { format: 'png' },
      sessionId,
      this.#cmdTimeout(),
    );
    if (typeof result.data !== 'string' || result.data === '') {
      throw new CdpError('cdp-failed', '截图没有回数据', HINT['cdp-failed']);
    }
    return new Uint8Array(Buffer.from(result.data, 'base64'));
  }

  async click(p: PageHandle, selector: string): Promise<void> {
    const outcome = await this.evaluate<{ ok?: boolean; tag?: string }>(
      p,
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { ok: false };
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.click();
        return { ok: true, tag: el.tagName };
      })()`,
    );
    if (!outcome || outcome.ok !== true) {
      throw new CdpError(
        'page-failed',
        `页面上找不到元素：${selector}`,
        '确认选择器在当前 DOM 里存在（先 text() 看一眼页面内容）',
      );
    }
  }

  async type(p: PageHandle, selector: string, text: string): Promise<void> {
    const outcome = await this.evaluate<{ ok?: boolean }>(
      p,
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { ok: false };
        el.focus();
        const value = ${JSON.stringify(text)};
        if (el.isContentEditable) {
          el.textContent = value;
        } else {
          const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
          if (desc && desc.set) desc.set.call(el, value); else el.value = value;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
      })()`,
    );
    if (!outcome || outcome.ok !== true) {
      throw new CdpError(
        'page-failed',
        `页面上找不到输入框：${selector}`,
        '确认选择器指向 input/textarea 或 contenteditable 元素',
      );
    }
  }

  async scroll(p: PageHandle, o?: { deltaY?: number; times?: number }): Promise<void> {
    const deltaY = Math.round(
      typeof o?.deltaY === 'number' && Number.isFinite(o.deltaY) ? o.deltaY : 3000,
    );
    const times = clamp(Math.round(o?.times ?? 1), 1, 50);
    for (let i = 0; i < times; i += 1) {
      await this.evaluate<unknown>(p, `window.scrollBy(0, ${deltaY}); null`);
      // 懒加载要时间：滚完立刻抽 DOM 会少几条（cwb 同样固定等 800ms）
      await sleep(SCROLL_SETTLE_MS);
    }
  }

  async closePage(p: PageHandle): Promise<void> {
    const wire = this.#wire;
    this.#pageEnabled.delete(p.targetId);
    if (!wire || !wire.isOpen) return; // 连接都没了，页面自然也没了
    try {
      await wire.send('Target.closeTarget', { targetId: p.targetId }, undefined, 5000);
    } catch {
      // 页面可能已经先一步没了：关不掉不算失败
    }
    wire.forget(p.targetId);
  }

  // ——— 停机 ———

  /** 幂等：等在飞的 ensure 落定，再关 ws、收尸自己拉起的浏览器。重复调用返回同一个 promise。 */
  async dispose(): Promise<void> {
    if (this.#disposeTask) return this.#disposeTask;
    // 先插门：在飞的 ensure 会在下一个检查点抛 not-connected 收手（不然它会把浏览器
    // 一路拉到就绪，而那时我们已经清完状态，那条 ws 和那只 Chrome 就没人认领了）。
    this.#disposed = true;
    this.#disposeTask = (async () => {
      const inFlight = this.#ensureTask;
      if (inFlight) {
        try {
          await inFlight;
        } catch {
          // ensure 自己失败不要紧：下面照样把 #wire / #own 收掉
        }
      }
      // 清理必须在 await 之后读状态：ensure 可能刚把 #wire / #own 建出来。
      const wire = this.#wire;
      this.#wire = null;
      this.#pageEnabled.clear();
      this.#browserLabel = '';
      // 停机之后没有"现状"可言：留着旧错误只会让上层在下一轮把历史当新闻报出去。
      // （要向上解释"为什么连不上"，请在 dispose 之前读 status()。）
      this.#lastError = null;
      try {
        await wire?.close();
      } catch {
        // 连不上就是关掉了
      }
      const own = this.#own;
      this.#own = null;
      try {
        await own?.stop();
      } catch {
        // 收尸失败不该把调用方带崩：进程若还在，下次探活会复用
      }
    })();
    return this.#disposeTask;
  }
}

/** 从 exceptionDetails 里挖一句人话（栈的第一行就够）。 */
function detailText(details: any): string {
  const description =
    typeof details?.exception?.description === 'string' ? details.exception.description : '';
  const first = description.split('\n')[0] ?? '';
  const text = first || (typeof details?.text === 'string' ? details.text : '');
  const clean = text.trim();
  return clean === '' ? '未知错误' : clean.slice(0, 500);
}
