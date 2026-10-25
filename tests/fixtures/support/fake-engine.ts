import type { BrowserEngine } from '../../../src/cdp/types.ts';
import { runInFixture } from './mini-dom.ts';

export interface FakeEngineOptions {
  /** page HTML per extraction round; the last round repeats once scrolling runs out */
  rounds: string[];
  navOk?: boolean;
  navNote?: string;
}

export function makeFakeEngine(opts: FakeEngineOptions) {
  const calls = {
    newPage: 0,
    goto: [] as string[],
    waitReady: 0,
    evaluate: 0,
    scroll: 0,
    closePage: 0,
    expressions: [] as string[],
  };
  let round = 0;
  const page = { targetId: 'fake-page-1', url: 'about:blank' };
  const html = () => opts.rounds[Math.min(round, opts.rounds.length - 1)] ?? '';

  const engine = {
    status: () => ({ connected: true, mode: 'own' }),
    ensure: async () => undefined,
    newPage: async (url: string) => {
      calls.newPage += 1;
      page.url = url;
      return { targetId: page.targetId, url: page.url };
    },
    goto: async (_p: unknown, url: string) => {
      calls.goto.push(url);
      page.url = url;
      return { ok: opts.navOk !== false, url, note: opts.navNote };
    },
    waitReady: async () => {
      calls.waitReady += 1;
      return true;
    },
    evaluate: async (_p: unknown, expr: string) => {
      calls.evaluate += 1;
      calls.expressions.push(expr);
      return runInFixture(html(), expr);
    },
    text: async () => '',
    screenshot: async () => new Uint8Array(0),
    click: async () => undefined,
    type: async () => undefined,
    scroll: async () => {
      calls.scroll += 1;
      round += 1;
    },
    closePage: async () => {
      calls.closePage += 1;
    },
    dispose: async () => undefined,
  };

  return { engine: engine as unknown as BrowserEngine, calls, page };
}

/** An engine whose page evaluates to whatever the test hands over. */
export function makeScriptedEngine(envelope: unknown, nav?: { ok: boolean; note?: string }) {
  const calls = { newPage: 0, goto: [] as string[], evaluate: 0, closePage: 0 };
  const engine = {
    status: () => ({ connected: true, mode: 'own' }),
    ensure: async () => undefined,
    newPage: async (url: string) => {
      calls.newPage += 1;
      return { targetId: 'fake-page-2', url };
    },
    goto: async (_p: unknown, url: string) => {
      calls.goto.push(url);
      return { ok: nav ? nav.ok : true, url, note: nav ? nav.note : undefined };
    },
    waitReady: async () => true,
    evaluate: async () => {
      calls.evaluate += 1;
      return envelope;
    },
    text: async () => '',
    screenshot: async () => new Uint8Array(0),
    click: async () => undefined,
    type: async () => undefined,
    scroll: async () => undefined,
    closePage: async () => {
      calls.closePage += 1;
    },
    dispose: async () => undefined,
  };
  return { engine: engine as unknown as BrowserEngine, calls };
}
