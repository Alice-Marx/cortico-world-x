import type { BrowserEngine } from '../cdp/types.ts';
import { EXTRACT_JS, normalizePosts, toEnvelope, type ExtractEnvelope } from './extract.ts';

export type XSourceKind = 'home' | 'user' | 'search' | 'list' | 'hashtag' | 'post';

export interface XSource {
  kind: XSourceKind;
  value: string;
}

export interface XPost {
  id?: string;
  url: string;
  author?: { handle: string; name?: string };
  text: string;
  createdAt?: string;
  metrics?: { replies?: number; reposts?: number; likes?: number; views?: number };
  media?: { type: 'image' | 'video' | 'link'; url: string }[];
  quoted?: { handle?: string; text: string };
}

export type XErrorCode = 'login-required' | 'empty' | 'parse-failed' | 'ratelimited' | 'render-blocked';

const X_ERROR_MESSAGES: Record<XErrorCode, string> = {
  'login-required': 'x.com is asking for a login',
  empty: 'nothing on the page',
  'parse-failed': 'could not read the page',
  ratelimited: 'x.com is rate limiting this browser',
  'render-blocked':
    'the page never rendered visible content - the tab may be throttled in the background, or x.com failed to boot',
};

/**
 * x.com's own login / onboarding flow. This is the hardest signal we have: when the browser is
 * logged out, x.com navigates here and the resulting page has no testids and no visible text, so
 * looking for buttons or the word "log in" alone misses it.
 */
const LOGIN_URL_PATTERNS: RegExp[] = [
  /\/i\/flow\/login(?:[/?#]|$)/,
  /\/i\/jf\/onboarding/,
  /[?&]mode=login\b/,
  /[?&]redirect_after_login=/,
];

export function isLoginUrl(href: string): boolean {
  if (typeof href !== 'string' || !href) return false;
  return LOGIN_URL_PATTERNS.some((pattern) => pattern.test(href));
}

export class XError extends Error {
  readonly code: XErrorCode;

  constructor(code: XErrorCode, message?: string) {
    super(message && message.trim() ? message.trim() : X_ERROR_MESSAGES[code]);
    this.name = 'XError';
    this.code = code;
  }
}

export const X_HOME_URL = 'https://x.com/home';
export const DEFAULT_LIMIT = 20;
export const DEFAULT_SCROLLS = 3;

const MAX_LIMIT = 200;
const MAX_SCROLLS = 20;
const DEFAULT_SETTLE_MS = 800;
const EMPTY_RETRIES = 2;

interface ReadStats {
  rows: number;
  text: number;
  media: number;
  bare: number;
}

export interface ReadOptions {
  /** how many posts to keep (1..200, default 20) */
  limit?: number;
  /** how many extra screens to scroll (0..20, default 3) */
  scrolls?: number;
  /** pause after a scroll / before retrying an empty page (default 800ms, set 0 in tests) */
  settleMs?: number;
}

/**
 * "home" | "user:elonmusk" | "search:ai agents" | "list:123" | "hashtag:ai" | "post:<url>".
 * A bare post URL and a bare "@handle" are accepted as shortcuts. Unrecognised input -> null.
 */
export function parseSource(spec: string): XSource | null {
  if (typeof spec !== 'string') return null;
  const raw = spec.trim();
  if (!raw) return null;
  if (raw.toLowerCase() === 'home') return { kind: 'home', value: '' };
  const asPost = postSourceOf(raw);
  if (asPost) return asPost;
  const colon = raw.indexOf(':');
  if (colon < 0) {
    const handle = normalizeHandle(raw);
    return handle && raw.startsWith('@') ? { kind: 'user', value: handle } : null;
  }
  const kind = raw.slice(0, colon).trim().toLowerCase();
  const value = raw.slice(colon + 1).trim();
  switch (kind) {
    case 'home':
      return value ? null : { kind: 'home', value: '' };
    case 'user': {
      const handle = normalizeHandle(value);
      return handle ? { kind: 'user', value: handle } : null;
    }
    case 'search': {
      const query = value.replace(/\s+/g, ' ').trim();
      return query && query.length <= 512 ? { kind: 'search', value: query } : null;
    }
    case 'list': {
      const id = listIdOf(value);
      return id ? { kind: 'list', value: id } : null;
    }
    case 'hashtag': {
      const tag = normalizeTag(value);
      return tag ? { kind: 'hashtag', value: tag } : null;
    }
    case 'post':
      return postSourceOf(value);
    default:
      return null;
  }
}

/** Inverse of parseSource, for logging and for the vault "source" column. */
export function formatSource(s: XSource): string {
  if (!s || typeof s !== 'object') return '';
  return s.kind === 'home' ? 'home' : s.kind + ':' + s.value;
}

export function sourceUrl(s: XSource): string {
  if (!s || typeof s !== 'object') return '';
  const value = typeof s.value === 'string' ? s.value.trim() : '';
  switch (s.kind) {
    case 'home':
      return X_HOME_URL;
    case 'user': {
      const handle = normalizeHandle(value);
      return handle ? 'https://x.com/' + handle : '';
    }
    case 'search': {
      const query = value.replace(/\s+/g, ' ').trim();
      return query ? 'https://x.com/search?q=' + encodeURIComponent(query) + '&f=live' : '';
    }
    case 'list': {
      const id = listIdOf(value);
      return id ? 'https://x.com/i/lists/' + id : '';
    }
    case 'hashtag': {
      const tag = normalizeTag(value);
      return tag ? 'https://x.com/hashtag/' + encodeURIComponent(tag) + '?f=live' : '';
    }
    case 'post':
      return canonicalPostUrl(withScheme(value)) ?? '';
    default:
      return '';
  }
}

export function isPostUrl(u: string): boolean {
  if (typeof u !== 'string') return false;
  const trimmed = u.trim();
  if (!/^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\//i.test(trimmed)) return false;
  return statusIdFromUrl(trimmed) !== null;
}

/** "https://x.com/foo/status/123" or "/foo/status/123" -> "123"; otherwise null. */
export function statusIdFromUrl(u: string): string | null {
  if (typeof u !== 'string') return null;
  const m = /^(?:(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com)?\/(?:i\/web\/|[A-Za-z0-9_]{1,15}\/)?status(?:es)?\/(\d+)(?:[/?#].*)?$/i.exec(
    u.trim(),
  );
  return m ? m[1] : null;
}

/** Canonical, handle-free permalink: https://x.com/i/status/<id>. */
export function canonicalPostUrl(u: string): string | null {
  const id = statusIdFromUrl(u);
  return id ? 'https://x.com/i/status/' + id : null;
}

/**
 * Opens one tab, waits for it, extracts, scrolls while short of the limit, de-dupes by
 * status id and truncates to limit. Callers connect the engine first (engine.ensure()).
 */
export async function readSource(
  engine: BrowserEngine,
  s: XSource,
  o: ReadOptions = {},
): Promise<XPost[]> {
  const limit = clampInt(o.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const scrolls = clampInt(o.scrolls, DEFAULT_SCROLLS, 0, MAX_SCROLLS);
  const settle = o.settleMs === undefined ? DEFAULT_SETTLE_MS : clampInt(o.settleMs, DEFAULT_SETTLE_MS, 0, 15_000);
  const url = sourceUrl(s);
  if (!url) throw new XError('parse-failed', 'unrecognised source: ' + formatSource(s));

  const page = await engine.newPage('about:blank');
  const collected: XPost[] = [];
  const seen = new Set<string>();
  const stats: ReadStats = { rows: 0, text: 0, media: 0, bare: 0 };
  try {
    const nav = await engine.goto(page, url);
    await engine.waitReady(page);

    let env = await extractPage(engine, page);
    for (let i = 0; i < EMPTY_RETRIES; i++) {
      if (env.posts.length || env.state.loginWall || env.state.rateLimited) break;
      await sleep(settle);
      env = await extractPage(engine, page);
    }
    classify(env, url, nav);
    absorb(env, collected, seen, stats);

    for (let i = 0; i < scrolls; i++) {
      if (collected.length >= limit) break;
      const before = collected.length;
      await engine.scroll(page, { deltaY: 1600, times: 1 });
      await sleep(settle);
      const next = await extractPage(engine, page);
      classify(next, url, nav);
      absorb(next, collected, seen, stats);
      if (collected.length === before) {
        await sleep(settle);
        const again = await extractPage(engine, page);
        classify(again, url, nav);
        absorb(again, collected, seen, stats);
        if (collected.length === before) break;
      }
    }
    // Only a page where nothing at all produced text is evidence of a broken selector.
    // One good post is worth more than a loud error that throws the whole read away.
    if (stats.text === 0 && stats.bare >= 3) {
      throw new XError(
        'parse-failed',
        '疑似页面改版：正文选择器已失效（' +
          stats.bare +
          ' 行既无正文也无媒体，本轮没有一条抽出正文）at ' +
          url +
          ' - the tweetText selector probably changed',
      );
    }
    return collected.slice(0, limit);
  } finally {
    try {
      await engine.closePage(page);
    } catch {
      // the tab is already gone; nothing to clean up
    }
  }
}

/** One post, or null when the page shows no post (deleted, wrong url, logged out shell). */
export async function readPost(engine: BrowserEngine, url: string): Promise<XPost | null> {
  if (!isPostUrl(url)) return null;
  const id = statusIdFromUrl(url);
  const target = url.trim();
  const page = await engine.newPage('about:blank');
  try {
    const nav = await engine.goto(page, target);
    await engine.waitReady(page);
    let env = await extractPage(engine, page);
    for (let i = 0; i < EMPTY_RETRIES; i++) {
      if (env.posts.length || env.state.loginWall || env.state.rateLimited) break;
      await sleep(DEFAULT_SETTLE_MS);
      env = await extractPage(engine, page);
    }
    classify(env, target, nav);
    const posts = normalizePosts(env.posts);
    if (!posts.length) return null;
    return posts.find((p) => p.id === id) ?? posts[0];
  } finally {
    try {
      await engine.closePage(page);
    } catch {
      // the tab is already gone
    }
  }
}

async function extractPage(engine: BrowserEngine, page: Parameters<BrowserEngine['evaluate']>[0]): Promise<ExtractEnvelope> {
  let value: unknown;
  try {
    value = await engine.evaluate<unknown>(page, EXTRACT_JS);
  } catch (err) {
    throw new XError('parse-failed', 'page extraction failed: ' + errorText(err));
  }
  const env = toEnvelope(value);
  if (!env) {
    throw new XError('parse-failed', 'page returned an unexpected extract result: ' + typeof value);
  }
  return env;
}

function classify(
  env: ExtractEnvelope,
  url: string,
  nav: { ok: boolean; note?: string } | undefined,
): void {
  if (env.state.articles === 0) {
    if (env.state.rateLimited) {
      throw new XError('ratelimited', env.state.text || 'x.com returned a rate-limit page for ' + url);
    }
    if (isLoginUrl(env.state.href)) {
      throw new XError('login-required', 'x.com redirected to its login flow: ' + env.state.href);
    }
    if (env.state.loginWall) {
      throw new XError('login-required', env.state.text || 'x.com asked for a login at ' + url);
    }
    if (env.state.text.trim() === '' && env.state.htmlLength > 1000) {
      throw new XError(
        'render-blocked',
        '页面没有渲染出可见内容（' +
          env.state.htmlLength +
          ' 字符 DOM 但没有可见文本）：可能是后台标签页被浏览器节流，或 X 的前端没加载出来 at ' +
          (env.state.href || url),
      );
    }
    if (nav && nav.ok === false) {
      throw new XError('parse-failed', 'navigation to ' + url + ' did not finish: ' + (nav.note ?? 'timeout'));
    }
    return;
  }
  if (!env.posts.length) {
    throw new XError(
      'parse-failed',
      'found ' + env.state.articles + ' posts on ' + url + ' but parsed none - the page markup probably changed',
    );
  }
}

function absorb(env: ExtractEnvelope, into: XPost[], seen: Set<string>, stats: ReadStats): void {
  for (const post of normalizePosts(env.posts)) {
    const key = post.id ?? post.url;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    stats.rows += 1;
    if (post.text) {
      stats.text += 1;
      into.push(post);
    } else if (post.media && post.media.length) {
      stats.media += 1;
      into.push(post);
    } else {
      // A row with neither text nor media is unusable; it is only evidence of a broken
      // selector once nothing else on the page produced text.
      stats.bare += 1;
    }
  }
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fallback;
  return Math.min(max, Math.max(min, n));
}

function sleep(ms: number): Promise<void> {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });
}

function postSourceOf(raw: string): XSource | null {
  const url = withScheme(raw);
  return url && statusIdFromUrl(url) ? { kind: 'post', value: url } : null;
}

/** Adds https:// to a bare "x.com/..." host form; leaves anything else alone. */
function withScheme(raw: string): string {
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^(?:www\.|mobile\.)?(?:x|twitter)\.com\//i.test(trimmed)) return 'https://' + trimmed;
  return '';
}

function normalizeHandle(v: string): string | null {
  let s = v.trim();
  if (!s) return null;
  if (s.includes('/')) {
    const parts = s.replace(/[?#].*$/, '').split('/').filter(Boolean);
    s = parts.length ? parts[parts.length - 1] : '';
  }
  s = s.replace(/^@+/, '').trim();
  return /^[A-Za-z0-9_]{1,15}$/.test(s) ? s : null;
}

function normalizeTag(v: string): string | null {
  const tag = v.trim().replace(/^#+/, '').trim();
  return tag && !/\s/.test(tag) && tag.length <= 100 ? tag : null;
}

function listIdOf(v: string): string | null {
  const trimmed = v.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const m = /lists\/(\d+)/.exec(trimmed);
  return m ? m[1] : null;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : String(err);
}
