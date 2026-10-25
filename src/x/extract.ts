import type { XPost } from './types.ts';

/** What the in-page extractor reports about the page itself. */
export interface PageState {
  /** top-level `article` nodes (nested quote/embed articles are not counted) */
  articles: number;
  /** whitespace-collapsed sample of the page text (first 600 chars) */
  text: string;
  /** x.com is showing a sign-in wall (testid / copy based; the URL is judged separately) */
  loginWall: boolean;
  /** rate-limit copy was visible */
  rateLimited: boolean;
  /** document.location.href at extract time: the hardest login-wall signal available */
  href: string;
  /** document.documentElement.innerHTML.length: a big page with no visible text never rendered */
  htmlLength: number;
}

export interface ExtractEnvelope {
  /** raw page rows, one per article; feed them to normalizePosts() */
  posts: unknown[];
  state: PageState;
}

/**
 * Runs inside the page (engine.evaluate). Returns { posts, state }.
 * Touches document only, so a fixture test can drive it with a fake DOM.
 *
 * Two extraction channels, chosen per article:
 *   A. legacy: `[data-testid="tweetText"]` / `[data-testid="User-Name"]` (older or cached renders)
 *   B. structural: the 2026 frontend, which ships no testids at all - plain spans, dates as link
 *      text, counts under `[data-engagement-action]`, avatars under `/profile_images/`.
 */
export const EXTRACT_JS = `(() => {
  const row = [];

  const attr = (el, name) => (el && el.getAttribute ? (el.getAttribute(name) || '') : '');
  const rich = (node) => {
    if (!node) return '';
    if (node.nodeName === 'IMG') return node.getAttribute ? (node.getAttribute('alt') || '') : '';
    if (node.nodeName === 'BR') return '\\n';
    const kids = node.childNodes;
    if (!kids || !kids.length) return node.nodeValue || '';
    let out = '';
    for (let i = 0; i < kids.length; i++) out += rich(kids[i]);
    return out;
  };
  const flat = (el) => {
    if (!el) return '';
    return rich(el).replace(/\\s+/g, ' ').trim();
  };
  const plain = (el) => {
    if (!el || typeof el.textContent !== 'string') return '';
    return el.textContent.replace(/\\s+/g, ' ').trim();
  };
  const block = (el) => {
    if (!el) return '';
    const tidy = rich(el)
      .replace(/\\r/g, '')
      .replace(/[ \\t\\u00a0]+/g, ' ')
      .replace(/ *\\n */g, '\\n')
      .replace(/\\n{3,}/g, '\\n\\n');
    return tidy.trim();
  };
  const count = (raw) => {
    if (raw === null || raw === undefined) return undefined;
    const s = String(raw).replace(/[,\\s]/g, '');
    if (!s) return undefined;
    const m = /^(\\d+(?:\\.\\d+)?)([KkMmBbGgWw\\u4e07\\u4ebf])?/.exec(s);
    if (!m) return undefined;
    const n = parseFloat(m[1]);
    if (!isFinite(n)) return undefined;
    const unit = m[2] || '';
    let mult = 1;
    if (unit === 'K' || unit === 'k') mult = 1000;
    else if (unit === 'M' || unit === 'm') mult = 1000000;
    else if (unit === 'B' || unit === 'b' || unit === 'G' || unit === 'g') mult = 1000000000;
    else if (unit === 'W' || unit === 'w' || unit === '\u4e07') mult = 10000;
    else if (unit === '\u4ebf') mult = 100000000;
    return Math.round(n * mult);
  };
  const metric = (el) => {
    if (!el) return undefined;
    const label = attr(el, 'aria-label');
    if (label) {
      const fromLabel = count(label);
      if (fromLabel !== undefined) return fromLabel;
    }
    return count(flat(el));
  };

  const HANDLE_RE = /^@[A-Za-z0-9_]{1,15}$/;
  const DATE_RE = /^(\\d{1,2}\u6708\\d{1,2}\u65e5|\\d{4}\u5e74\\d{1,2}\u6708\\d{1,2}\u65e5|\u6628\u5929|\u4eca\u5929|\\d+\\s*(\u79d2|\u5206\u949f|\u5c0f\u65f6|\u5929|\u5468)\u524d?|\\d+[smhd])$/;
  const COUNT_RE = /^[\\d.,]+\\s*(\u4e07|\u4ebf|K|k|M|m|B|b)?$/;
  const NOISE_RE = /^(\u5df2\u7f6e\u9876|Show more|\u663e\u793a\u66f4\u591a|\u7ffb\u8bd1|Translate|\u5173\u6ce8|\u6b63\u5728\u5173\u6ce8|\u56de\u590d|\u8f6c\u5e16|\u559c\u6b22|\u4e66\u7b7e|\u5206\u4eab|\u66f4\u591a|\u67e5\u770b|Follow|Reply|Repost|Like|Bookmark|Share|More)$/;

  const inNestedArticle = (el, root) => {
    let p = el.parentElement;
    while (p && p !== root) {
      if (p.tagName === 'ARTICLE') return true;
      p = p.parentElement;
    }
    return false;
  };
  const scoped = (root, selector) => {
    const all = root.querySelectorAll(selector);
    const out = [];
    for (let i = 0; i < all.length; i++) {
      if (!inNestedArticle(all[i], root)) out.push(all[i]);
    }
    return out;
  };
  const scopedFirst = (root, selector) => {
    const list = scoped(root, selector);
    return list.length ? list[0] : null;
  };
  const statusIdOf = (href) => {
    const m = String(href === null || href === undefined ? '' : href).match(/\\/status(?:es)?\\/(\\d+)/);
    return m ? m[1] : '';
  };
  const boxCount = (start, levels) => {
    let box = start;
    for (let k = 0; k < levels && box; k++) {
      const t = flat(box);
      if (COUNT_RE.test(t)) return count(t);
      box = box.parentElement;
    }
    return undefined;
  };
  const keepImage = (img) => {
    const src = attr(img, 'src');
    if (src.indexOf('pbs.twimg.com') < 0) return '';
    if (src.indexOf('/profile_images/') >= 0) return '';
    const nw = typeof img.naturalWidth === 'number' ? img.naturalWidth : 0;
    if (nw > 0 && nw <= 80) return '';
    return src;
  };

  // channel A: old markup (data-testid), still used by logged-in / cached renders
  const handleOf = (box) => {
    if (!box) return { handle: '', name: '' };
    const links = box.querySelectorAll('a[href^="/"]');
    for (let i = 0; i < links.length; i++) {
      const href = attr(links[i], 'href');
      if (/^\\/[A-Za-z0-9_]{1,15}$/.test(href)) {
        return { handle: href.slice(1), name: flat(links[i]) };
      }
    }
    return { handle: '', name: '' };
  };

  const legacyRow = (art) => {
    const texts = scoped(art, '[data-testid="tweetText"]');
    const names = scoped(art, '[data-testid="User-Name"]');
    const me = handleOf(names[0]);
    const other = names.length > 1 ? handleOf(names[1]) : { handle: '', name: '' };
    const time = scopedFirst(art, 'time[datetime]');
    let href = '';
    if (time && time.closest) {
      const link = time.closest('a[href*="/status/"]');
      if (link) href = attr(link, 'href');
    }
    if (!href) {
      const links = scoped(art, 'a[href*="/status/"]');
      if (links.length) href = attr(links[0], 'href');
    }
    const media = [];
    const imgs = scoped(art, 'img');
    for (let i = 0; i < imgs.length; i++) {
      const src = keepImage(imgs[i]);
      if (src) media.push({ type: 'image', url: src });
    }
    const hasVideo = !!(scopedFirst(art, '[data-testid="videoComponent"]') || scopedFirst(art, 'video'));
    if (hasVideo) {
      if (media.length) media[media.length - 1].type = 'video';
      else media.push({ type: 'video', url: '' });
    }
    const group = scopedFirst(art, '[role="group"]') || art;
    let views;
    const labelled = group.querySelectorAll('[aria-label]');
    for (let i = 0; i < labelled.length; i++) {
      const label = attr(labelled[i], 'aria-label');
      if (/view/i.test(label)) {
        const n = count(label);
        if (n !== undefined) { views = n; break; }
      }
    }
    const quotedText = texts.length > 1 ? block(texts[1]) : '';
    const out = {
      id: statusIdOf(href),
      url: href,
      handle: me.handle,
      name: me.name,
      text: texts.length ? block(texts[0]) : '',
      createdAt: attr(time, 'datetime'),
      replies: metric(scopedFirst(art, '[data-testid="reply"]')),
      reposts: metric(scopedFirst(art, '[data-testid="retweet"], [data-testid="unretweet"]')),
      likes: metric(scopedFirst(art, '[data-testid="like"], [data-testid="unlike"]')),
      media: media,
      quotedText: quotedText,
      quotedHandle: quotedText ? other.handle : '',
      quotedName: quotedText ? other.name : ''
    };
    if (views !== undefined) out.views = views;
    return out;
  };

  // --- composition helpers (channel B) ------------------------------------------------------
  const tidyText = (raw) =>
    String(raw === null || raw === undefined ? '' : raw)
      .replace(/\\r/g, '')
      .replace(/[ \\t\\u00a0]+/g, ' ')
      .replace(/ *\\n */g, '\\n')
      .replace(/\\n{3,}/g, '\\n\\n')
      .trim();

  // Text this element owns directly (text nodes only), used to pick candidates without
  // letting a container swallow the header.
  const directText = (el) => {
    if (!el) return '';
    const kids = el.childNodes || [];
    let out = '';
    for (let i = 0; i < kids.length; i++) {
      if (kids[i].nodeName === '#text') out += kids[i].nodeValue || '';
    }
    return out.replace(/\\s+/g, ' ').trim();
  };

  // Compose the final body from the selected node only: inline <a> text (mentions, hashtags,
  // links) and emoji alt come along, while skip-listed subtrees (name/handle/date/noise/
  // engagement/buttons/quoted articles) are dropped.
  const composeNode = (root, skips) => {
    if (!root) return '';
    const walkCompose = (node, isRoot) => {
      if (!node) return '';
      const name = node.nodeName;
      if (name === '#text') return node.nodeValue || '';
      if (name === 'IMG') return node.getAttribute ? (node.getAttribute('alt') || '') : '';
      if (name === 'BR') return '\\n';
      if (!isRoot) {
        if (name === 'ARTICLE') return '';
        if (name === 'BUTTON' || name === 'SVG' || name === 'USE' || name === 'PATH') return '';
        if (node.getAttribute && node.getAttribute('data-engagement-action')) return '';
        for (let i = 0; i < skips.length; i++) {
          if (node === skips[i]) return '';
          if (node.contains && node.contains(skips[i])) return '';
        }
      }
      let out = '';
      const kids = node.childNodes || [];
      for (let i = 0; i < kids.length; i++) out += walkCompose(kids[i], false);
      return out;
    };
    return tidyText(walkCompose(root, true));
  };

  // Rise at most two levels, but never into a container that already holds header/date noise.
  const pickBlock = (el, guards) => {
    let best = el;
    for (let i = 0; i < 2; i++) {
      const up = best.parentElement;
      if (!up) break;
      let blocked = false;
      for (let k = 0; k < guards.length; k++) {
        if (guards[k] && up.contains && up.contains(guards[k])) { blocked = true; break; }
      }
      if (!blocked && up.querySelector && up.querySelector('[data-engagement-action]')) blocked = true;
      if (blocked) break;
      best = up;
    }
    return best;
  };

  // channel B: the 2026 frontend - no testids at all, structure + data-attributes only
  const structuralRow = (art) => {
    const statusLink = scopedFirst(art, 'a[href*="/status/"]');
    const href = statusLink ? attr(statusLink, 'href') : '';

    const scan = scoped(art, 'a, span');
    let handleEl = null;
    for (let i = 0; i < scan.length; i++) {
      if (HANDLE_RE.test(plain(scan[i]))) { handleEl = scan[i]; break; }
    }
    const handle = handleEl ? plain(handleEl).slice(1) : '';

    let name = '';
    let nameEl = null;
    let node = handleEl;
    for (let i = 0; i < 6 && node && !name; i++) {
      const prev = node.previousElementSibling;
      if (prev) {
        const t = plain(prev);
        if (t && !HANDLE_RE.test(t) && !DATE_RE.test(t) && !COUNT_RE.test(t) && !NOISE_RE.test(t) && t.length <= 80) {
          name = t;
          nameEl = prev;
        }
      }
      node = node.parentElement;
    }

    let createdAt = '';
    let dateEl = null;
    const timeEl = scopedFirst(art, 'time[datetime]');
    if (timeEl) {
      createdAt = attr(timeEl, 'datetime');
      dateEl = timeEl;
    }
    if (!createdAt) {
      for (let i = 0; i < scan.length; i++) {
        const t = plain(scan[i]);
        if (DATE_RE.test(t)) {
          createdAt = t;
          dateEl = scan[i];
          break;
        }
      }
    }

    // Candidates are elements that OWN at least two characters of text: never containers, never
    // UI chrome. "Cool", "True" and single emoji must survive - short replies are normal posts.
    const nameText = name || '';
    const handleText = handle ? '@' + handle : '';
    const cands = [];
    const leaves = scoped(art, 'span, div');
    for (let i = 0; i < leaves.length; i++) {
      const el = leaves[i];
      const own = directText(el);
      if (own.length < 2) continue;
      if (HANDLE_RE.test(own) || DATE_RE.test(own) || COUNT_RE.test(own) || NOISE_RE.test(own)) continue;
      if (nameText && own === nameText) continue;
      if (handleText && own === handleText) continue;
      if (el.closest && (el.closest('a') || el.closest('button'))) continue;
      cands.push({ el: el, text: own, index: i });
    }

    let body = '';
    if (cands.length) {
      const byLength = cands.slice().sort((a, b) => b.text.length - a.text.length);
      const primary = byLength[0];
      const skips = [];
      if (handleEl) skips.push(handleEl);
      if (nameEl) skips.push(nameEl);
      if (dateEl) skips.push(dateEl);
      const noiseEls = scoped(art, 'span, div');
      for (let i = 0; i < noiseEls.length; i++) {
        if (NOISE_RE.test(plain(noiseEls[i]))) skips.push(noiseEls[i]);
      }
      const parts = [];
      const pushPart = (textPart) => {
        if (!textPart) return;
        for (let i = 0; i < parts.length; i++) if (parts[i].indexOf(textPart) >= 0) return;
        for (let i = parts.length - 1; i >= 0; i--) if (textPart.indexOf(parts[i]) >= 0) parts.splice(i, 1);
        parts.push(textPart);
      };
      pushPart(composeNode(pickBlock(primary.el, skips), skips) || flat(primary.el));
      for (let i = 0; i < cands.length; i++) {
        if (cands[i].index <= primary.index) continue;
        pushPart(composeNode(pickBlock(cands[i].el, skips), skips) || flat(cands[i].el));
      }
      body = parts.join('\\n');
    }

    const media = [];
    const imgs = scoped(art, 'img');
    for (let i = 0; i < imgs.length; i++) {
      const src = keepImage(imgs[i]);
      if (src) media.push({ type: 'image', url: src });
    }
    const videos = scoped(art, 'video');
    for (let i = 0; i < videos.length; i++) media.push({ type: 'video', url: attr(videos[i], 'poster') });

    const actionCount = (action) => {
      const groups = scoped(art, '[data-engagement-action="' + action + '"]');
      for (let i = 0; i < groups.length; i++) {
        const n = boxCount(groups[i], 4);
        if (n !== undefined) return n;
      }
      return undefined;
    };
    let views;
    const groups = scoped(art, '[data-engagement-action]');
    for (let i = 0; i < groups.length; i++) {
      const action = attr(groups[i], 'data-engagement-action');
      if (action === 'reply' || action === 'retweet' || action === 'repost' || action === 'like') continue;
      let label = attr(groups[i], 'aria-label');
      if (!label) {
        const labelled = scoped(groups[i], '[aria-label]');
        for (let k = 0; k < labelled.length; k++) {
          const l = attr(labelled[k], 'aria-label');
          if (l) { label = l; break; }
        }
      }
      if (!/views?|\u67e5\u770b\u6b21\u6570|\u9605\u8bfb/i.test(label)) continue;
      const n = boxCount(groups[i], 4);
      if (n !== undefined) { views = n; break; }
    }

    const reposts = actionCount('retweet') !== undefined ? actionCount('retweet') : actionCount('repost');
    const out = {
      id: statusIdOf(href),
      url: href,
      handle: handle,
      name: name,
      text: body,
      createdAt: createdAt,
      replies: actionCount('reply'),
      reposts: reposts,
      likes: actionCount('like'),
      media: media,
      quotedText: '',
      quotedHandle: '',
      quotedName: ''
    };
    if (views !== undefined) out.views = views;
    return out;
  };

  const articles = document.querySelectorAll('article');
  const tops = [];
  for (let i = 0; i < articles.length; i++) {
    if (!inNestedArticle(articles[i], null)) tops.push(articles[i]);
  }
  for (let i = 0; i < tops.length; i++) {
    const art = tops[i];
    const legacy = !!(scopedFirst(art, '[data-testid="tweetText"]') || scopedFirst(art, '[data-testid="User-Name"]'));
    row.push(legacy ? legacyRow(art) : structuralRow(art));
  }

  const bodyText = document.body
    ? (typeof document.body.innerText === 'string' ? document.body.innerText : (document.body.textContent || ''))
    : '';
  const head = bodyText.slice(0, 4000).replace(/\\s+/g, ' ').trim();
  let href = '';
  if (document.location && document.location.href) href = document.location.href;
  else if (typeof location !== 'undefined' && location.href) href = location.href;
  const htmlLength = document.documentElement && typeof document.documentElement.innerHTML === 'string'
    ? document.documentElement.innerHTML.length
    : 0;
  const state = {
    articles: tops.length,
    text: head.slice(0, 600),
    href: String(href || ''),
    htmlLength: htmlLength,
    loginWall: !!document.querySelector('[data-testid="loginButton"]') || /(?:Log in|Sign in|\u767b\u5f55|\u767b\u5165)/i.test(head),
    rateLimited: /(?:rate limit|too many requests|something went wrong|over the daily limit|\u7a0d\u540e\u518d\u8bd5|\u64cd\u4f5c\u9891\u7e41|Try again later|\u8d85\u51fa\u9650\u5236|\u5df2\u8fbe\u4e0a\u9650)/i.test(head)
  };
  return { posts: row, state: state };
})()`;

const MAX_TEXT = 4000;
const MAX_QUOTED = 1200;
const MAX_NAME = 80;
const MAX_MEDIA = 12;

/** "1.2K" -> 1200, "1,234" -> 1234, "1.2万" -> 12000, garbage -> undefined. */
export function parseCount(v: unknown): number | undefined {
  if (typeof v === 'number') {
    return Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
  }
  if (typeof v !== 'string') return undefined;
  const s = v.replace(/[,\s]/g, '');
  const m = /^(\d+(?:\.\d+)?)([KkMmBbGgWw万亿])?/.exec(s);
  if (!m) return undefined;
  const n = Number.parseFloat(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const unit = m[2] ?? '';
  let mult = 1;
  if (unit === 'K' || unit === 'k') mult = 1_000;
  else if (unit === 'M' || unit === 'm') mult = 1_000_000;
  else if (unit === 'B' || unit === 'b' || unit === 'G' || unit === 'g') mult = 1_000_000_000;
  else if (unit === 'W' || unit === 'w' || unit === '万') mult = 10_000;
  else if (unit === '亿') mult = 100_000_000;
  return Math.round(n * mult);
}

/** Turns page rows (whatever the DOM gave us) into XPost objects. Never throws. */
export function normalizePosts(raw: unknown[]): XPost[] {
  const list: unknown[] = Array.isArray(raw) ? raw : [];
  const out: XPost[] = [];
  for (const entry of list) {
    const post = normalizePost(entry);
    if (post) out.push(post);
  }
  return out;
}

/** Accepts either the {posts, state} envelope from EXTRACT_JS or a bare row array. */
export function toEnvelope(value: unknown): ExtractEnvelope | null {
  if (Array.isArray(value)) {
    return {
      posts: value,
      state: { articles: value.length, text: '', loginWall: false, rateLimited: false, href: '', htmlLength: 0 },
    };
  }
  const rec = asRecord(value);
  if (!rec || !Array.isArray(rec.posts)) return null;
  const state = asRecord(rec.state) ?? {};
  return {
    posts: rec.posts,
    state: {
      articles: typeof state.articles === 'number' ? state.articles : rec.posts.length,
      text: typeof state.text === 'string' ? state.text : '',
      loginWall: state.loginWall === true,
      rateLimited: state.rateLimited === true,
      href: typeof state.href === 'string' ? state.href : '',
      htmlLength:
        typeof state.htmlLength === 'number'
          ? state.htmlLength
          : typeof state.htmlLen === 'number'
            ? state.htmlLen
            : 0,
    },
  };
}

function normalizePost(entry: unknown): XPost | null {
  const rec = asRecord(entry);
  if (!rec) return null;
  const rawUrl = asString(rec.url).trim();
  let id = numericId(rec.id);
  if (!id && rawUrl) id = statusIdFromUrlLocal(rawUrl);
  const url = rawUrl ? absolutize(rawUrl) : id ? 'https://x.com/i/status/' + id : '';
  if (!url) return null;
  return compact({
    id: id ?? undefined,
    url,
    author: authorOf(rec),
    text: cleanText(asString(rec.text), MAX_TEXT),
    createdAt: asString(rec.createdAt).trim() || undefined,
    metrics: metricsOf(rec),
    media: mediaOf(rec.media),
    quoted: quotedOf(rec),
  });
}

function authorOf(rec: Record<string, unknown>): XPost['author'] {
  const nested = asRecord(rec.author) ?? {};
  const handle = cleanHandle(asString(nested.handle ?? rec.handle));
  const name = cleanText(asString(nested.name ?? rec.name), MAX_NAME);
  if (!handle && !name) return undefined;
  return compact({ handle, name: name || undefined });
}

function metricsOf(rec: Record<string, unknown>): XPost['metrics'] {
  const nested = asRecord(rec.metrics) ?? {};
  const replies = parseCount(nested.replies ?? rec.replies);
  const reposts = parseCount(nested.reposts ?? rec.reposts ?? rec.retweets);
  const likes = parseCount(nested.likes ?? rec.likes);
  const views = parseCount(nested.views ?? rec.views);
  if (replies === undefined && reposts === undefined && likes === undefined && views === undefined) {
    return undefined;
  }
  return compact({ replies, reposts, likes, views });
}

function mediaOf(raw: unknown): XPost['media'] {
  const list = Array.isArray(raw) ? raw : [];
  const out: { type: 'image' | 'video' | 'link'; url: string }[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const rec = asRecord(item);
    const url = normalizeMediaUrl(rec ? asString(rec.url ?? rec.src) : asString(item));
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const declared = rec ? asString(rec.type).trim().toLowerCase() : '';
    const type = declared === 'image' || declared === 'video' || declared === 'link'
      ? declared
      : inferMediaType(url);
    out.push({ type, url });
    if (out.length >= MAX_MEDIA) break;
  }
  return out.length ? out : undefined;
}

function quotedOf(rec: Record<string, unknown>): XPost['quoted'] {
  const nested = asRecord(rec.quoted);
  const fromString = typeof rec.quoted === 'string' ? rec.quoted : '';
  const text = cleanText(asString((nested && nested.text) ?? rec.quotedText ?? fromString), MAX_QUOTED);
  if (!text) return undefined;
  const handle = cleanHandle(asString((nested && nested.handle) ?? rec.quotedHandle));
  return compact({ handle: handle || undefined, text });
}

function inferMediaType(url: string): 'image' | 'video' {
  if (/video\.twimg\.com/i.test(url)) return 'video';
  return /\.(?:mp4|m3u8|webm)(?:[?#]|$)/i.test(url) ? 'video' : 'image';
}

function normalizeMediaUrl(raw: string): string {
  let url = absolutize(raw.trim());
  if (!/^https?:\/\//i.test(url)) return '';
  if (/pbs\.twimg\.com/i.test(url)) {
    if (/[?&]name=/.test(url)) url = url.replace(/([?&])name=[^&]*/, '$1name=large');
    else url += (url.includes('?') ? '&' : '?') + 'name=large';
  }
  return url;
}

function absolutize(raw: string): string {
  if (!raw) return '';
  if (raw.startsWith('//')) return 'https:' + raw;
  if (raw.startsWith('/')) return 'https://x.com' + raw;
  if (/^https?:\/\//i.test(raw)) return raw;
  return raw;
}

function statusIdFromUrlLocal(u: string): string | null {
  const m = /^(?:(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com)?\/(?:i\/web\/|[A-Za-z0-9_]{1,15}\/)?status(?:es)?\/(\d+)(?:[/?#].*)?$/i.exec(
    u.trim(),
  );
  return m ? m[1] : null;
}

function numericId(v: unknown): string | null {
  const s = asString(v).trim();
  return /^\d{1,25}$/.test(s) ? s : null;
}

function cleanHandle(v: string): string {
  const m = /^@?([A-Za-z0-9_]{1,15})/.exec(v.trim());
  return m ? m[1] : '';
}

function cleanText(v: string, max: number): string {
  const out = v
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return out.length > max ? out.slice(0, max) : out;
}

function asString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function compact<T extends Record<string, unknown>>(o: T): T {
  for (const key of Object.keys(o)) {
    if (o[key] === undefined) delete o[key];
  }
  return o;
}
