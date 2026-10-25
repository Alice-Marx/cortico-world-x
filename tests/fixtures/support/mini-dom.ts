/**
 * A tiny HTML parser + DOM stub, just enough for EXTRACT_JS:
 * querySelector/querySelectorAll (tag, [attr], [attr="v"], [attr^="v"], [attr*="v"], [attr$="v"],
 * descendant chains, comma lists), closest, matches, textContent.
 * Fixtures only - it is not a browser.
 */

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', hellip: '\u2026', mdash: '\u2014',
};

export class MiniElement {
  tag: string;
  attrs: Record<string, string>;
  /** mixed children, text nodes included - the parser's own storage */
  nodes: (MiniElement | string)[];
  parent: MiniElement | null;

  constructor(tag: string, attrs: Record<string, string> = {}) {
    this.tag = tag.toLowerCase();
    this.attrs = attrs;
    this.nodes = [];
    this.parent = null;
  }

  get textContent(): string {
    let out = '';
    for (const child of this.nodes) {
      out += typeof child === 'string' ? child : child.textContent;
    }
    return out;
  }

  /** DOM children: elements only, like a browser. */
  get children(): MiniElement[] {
    const out: MiniElement[] = [];
    for (const node of this.nodes) {
      if (typeof node !== 'string') out.push(node);
    }
    return out;
  }

  get tagName(): string {
    return this.tag.toUpperCase();
  }

  get parentElement(): MiniElement | null {
    return this.parent;
  }

  get previousElementSibling(): MiniElement | null {
    const parent = this.parent;
    if (!parent) return null;
    const kids = parent.children;
    const at = kids.indexOf(this);
    return at > 0 ? kids[at - 1] : null;
  }

  get nodeName(): string {
    return this.tag.toUpperCase();
  }

  get nodeValue(): null {
    return null;
  }

  get childNodes(): unknown[] {
    return this.nodes.map((child) =>
      typeof child === 'string' ? { nodeName: '#text', nodeValue: child, childNodes: [] } : child,
    );
  }

  getAttribute(name: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }

  /** Node.contains: true when other is this element or inside it. */
  contains(other: MiniElement | null): boolean {
    let node: MiniElement | null = other;
    while (node) {
      if (node === this) return true;
      node = node.parent;
    }
    return false;
  }

  matches(selector: string): boolean {
    return parseSelectorList(selector).some((chain) => matchChain(this, chain));
  }

  closest(selector: string): MiniElement | null {
    const chains = parseSelectorList(selector);
    let node: MiniElement | null = this;
    while (node) {
      const current: MiniElement = node;
      if (chains.some((chain) => matchChain(current, chain))) return current;
      node = node.parent;
    }
    return null;
  }

  querySelector(selector: string): MiniElement | null {
    const all = this.querySelectorAll(selector);
    return all.length ? all[0] : null;
  }

  querySelectorAll(selector: string): MiniElement[] {
    const chains = parseSelectorList(selector);
    const out: MiniElement[] = [];
    walk(this, (el) => {
      if (chains.some((chain) => matchChain(el, chain))) out.push(el);
    });
    return out;
  }
}

interface AttrMatcher {
  name: string;
  op?: string;
  value?: string;
}

interface Compound {
  tag: string | null;
  attrs: AttrMatcher[];
}

type Chain = Compound[];

function walk(root: MiniElement, visit: (el: MiniElement) => void): void {
  for (const child of root.children) {
    visit(child);
    walk(child, visit);
  }
}

function matchChain(el: MiniElement, chain: Chain): boolean {
  if (!matchCompound(el, chain[chain.length - 1])) return false;
  let node: MiniElement | null = el.parent;
  for (let i = chain.length - 2; i >= 0; i--) {
    while (node && !matchCompound(node, chain[i])) node = node.parent;
    if (!node) return false;
    node = node.parent;
  }
  return true;
}

function matchCompound(el: MiniElement, compound: Compound): boolean {
  if (compound.tag && compound.tag !== '*' && el.tag !== compound.tag) return false;
  for (const attr of compound.attrs) {
    const value = el.attrs[attr.name];
    if (value === undefined) return false;
    if (attr.op === undefined) continue;
    const want = attr.value ?? '';
    if (attr.op === '=' && value !== want) return false;
    if (attr.op === '^=' && !value.startsWith(want)) return false;
    if (attr.op === '*=' && !value.includes(want)) return false;
    if (attr.op === '$=' && !value.endsWith(want)) return false;
    if (attr.op === '~=' && !value.split(/\s+/).includes(want)) return false;
  }
  return true;
}

function parseSelectorList(selector: string): Chain[] {
  return splitTop(selector, ',')
    .map((part) => parseChain(part.trim()))
    .filter((chain) => chain.length > 0);
}

function splitTop(selector: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '[' || ch === '(') depth++;
    else if (ch === ']' || ch === ')') depth--;
    else if (ch === sep && depth === 0) {
      out.push(selector.slice(start, i));
      start = i + 1;
    }
  }
  out.push(selector.slice(start));
  return out;
}

function parseChain(text: string): Chain {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (depth === 0 && (ch === ' ' || ch === '\t' || ch === '\n')) {
      if (current) { parts.push(current); current = ''; }
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  return parts.map(parseCompound).filter((c): c is Compound => c !== null);
}

function parseCompound(text: string): Compound | null {
  let rest = text.trim();
  if (!rest) return null;
  let tag: string | null = null;
  const tagMatch = /^([A-Za-z][\w-]*|\*)/.exec(rest);
  if (tagMatch) {
    tag = tagMatch[1].toLowerCase();
    rest = rest.slice(tagMatch[0].length);
  }
  const attrs: AttrMatcher[] = [];
  const attrRe = /^\[\s*([^\s\]=~^$*]+)\s*(?:([~^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*)))?\s*\]/;
  while (rest.startsWith('[')) {
    const m = attrRe.exec(rest);
    if (!m) break;
    const op = m[2];
    const value = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5];
    attrs.push({ name: m[1], op, value });
    rest = rest.slice(m[0].length);
  }
  return { tag, attrs };
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const named = ENTITIES[body];
    return named === undefined ? whole : named;
  });
}

function findTagEnd(html: string, from: number): number {
  let quote = '';
  for (let i = from; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '>') return i;
  }
  return -1;
}

function parseTag(inner: string): { tag: string; attrs: Record<string, string> } {
  const nameMatch = /^([A-Za-z][\w:-]*)/.exec(inner);
  const tag = nameMatch ? nameMatch[1] : 'div';
  const attrs: Record<string, string> = {};
  const rest = inner.slice(nameMatch ? nameMatch[0].length : 0);
  const attrRe = /([^\s"'=<>\/\x60]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>\x60]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(rest))) {
    const value = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
    attrs[m[1].toLowerCase()] = decodeEntities(value);
  }
  return { tag: tag.toLowerCase(), attrs };
}

export function parseHtml(html: string): MiniElement {
  const root = new MiniElement('#document');
  const stack: MiniElement[] = [root];
  const top = () => stack[stack.length - 1];
  const pushText = (text: string) => {
    if (text) top().nodes.push(decodeEntities(text));
  };
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { pushText(html.slice(i)); break; }
    if (lt > i) pushText(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    const closing = html.startsWith('</', lt);
    const end = findTagEnd(html, lt + (closing ? 2 : 1));
    if (end < 0) { pushText(html.slice(lt)); break; }
    const inner = html.slice(lt + (closing ? 2 : 1), end).trim();
    i = end + 1;
    if (closing) {
      const name = inner.split(/[\s>]/)[0].toLowerCase();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === name) { stack.length = k; break; }
      }
      continue;
    }
    const selfClosing = inner.endsWith('/');
    const { tag, attrs } = parseTag(selfClosing ? inner.slice(0, -1) : inner);
    const el = new MiniElement(tag, attrs);
    const parent = top();
    el.parent = parent;
    parent.nodes.push(el);
    if (VOID_TAGS.has(tag) || selfClosing) continue;
    if (tag === 'script' || tag === 'style') {
      const closeAt = html.toLowerCase().indexOf('</' + tag, i);
      i = closeAt < 0 ? html.length : closeAt;
      continue;
    }
    stack.push(el);
  }
  return root;
}

export interface MiniDocument {
  body: MiniElement;
  documentElement: MiniElement;
  location: { href: string };
  querySelector(selector: string): MiniElement | null;
  querySelectorAll(selector: string): MiniElement[];
}

function findTag(root: MiniElement, tag: string): MiniElement | null {
  if (root.tag === tag) return root;
  for (const child of root.children) {
    const found = findTag(child, tag);
    if (found) return found;
  }
  return null;
}

export function parseDocument(html: string, opts: { href?: string } = {}): MiniDocument {
  const root = parseHtml(html);
  const body = findTag(root, 'body') ?? root;
  return {
    body,
    documentElement: root,
    location: { href: opts.href ?? '' },
    querySelector: (selector: string) => root.querySelector(selector),
    querySelectorAll: (selector: string) => root.querySelectorAll(selector),
  };
}

/** Evaluate an in-page expression against a fixture. */
export function runInFixture(html: string, expression: string, opts: { href?: string } = {}): unknown {
  const doc = parseDocument(html, opts);
  const fn = new Function('document', 'return (' + expression + ');') as (d: unknown) => unknown;
  return fn(doc);
}
