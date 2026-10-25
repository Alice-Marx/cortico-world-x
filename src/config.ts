/**
 * worlds.x-feed 的默认值与设置界面声明。
 *
 * 契约（框架 extensions/dry-mount.ts:47-63）：ConfigGroup 的每个键必须落在 worlds.<id>.
 * 段内，且 defaults() 里有同名项——否则 WebUI 能改、能写进 config.json，代码却读自己那处兜底值。
 *
 * enabled 不在这里声明：它是装配层给所有 World 通用渲染的开关，重复声明等于多一个开关。
 * defaults() 里仍然必须有它，且必须是 false（dry-mount.ts:141-143）。
 */
import type { ConfigGroup } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { strings } from './i18n.ts';
import { parseSource, type XSource } from './x/index.ts';

/** World id。定义、实例、事件名与配置段前缀都从它派生。 */
export const WORLD_ID = 'x-feed';

/** 本 World 配置段的点分前缀。 */
export const CONFIG_PREFIX = 'worlds.' + WORLD_ID + '.';

/** 配置组 id 与 owner：框架要求 owner 恰好是 world:<id>（dry-mount.ts:216）。 */
export const CONFIG_ID = 'world:' + WORLD_ID;
export const CONFIG_OWNER = 'world:' + WORLD_ID;

/** 浏览器来源：own＝本 World 自己拉起一个；attach＝连操作员已开好调试口的那个。 */
export type BrowserMode = 'own' | 'attach';

/** 源种类。W3 的 src/x/types.ts 是语法权威，这里只做 preflight 的形状检查。 */
export const SOURCE_KINDS = ['home', 'user', 'search', 'list', 'hashtag', 'post'] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];

/** config.json 里的 worlds.x-feed 段。 */
export interface XFeedConfigSection {
  /** 装配层按它决定挂载；默认必须 false。 */
  enabled: boolean;
  mode: BrowserMode;
  port: number;
  /** 空＝自动探测 Chrome / Edge。 */
  chromePath: string;
  /** 多行文本，每行一个源。 */
  sources: string;
  /** 0＝不自动扫描。 */
  intervalMinutes: number;
  limitPerSource: number;
  maxScrolls: number;
  vaultSubdir: string;
  deliverDigest: boolean;
  digestMaxChars: number;
}

/** 默认配置（PLAN 第 4 节的 11 项）。defaults() 每次返回它的深拷贝。 */
export const X_FEED_DEFAULTS: XFeedConfigSection = {
  enabled: false,
  mode: 'own',
  port: 9223,
  chromePath: '',
  sources: 'home',
  intervalMinutes: 120,
  limitPerSource: 20,
  maxScrolls: 3,
  vaultSubdir: WORLD_ID,
  deliverDigest: true,
  digestMaxChars: 1200,
};

/** 除 enabled 之外、由本 World 自己声明的 10 项；键集由 tests/manifest.test.ts 守住。 */
export const X_FEED_DECLARED_KEYS: readonly string[] = [
  'mode',
  'port',
  'chromePath',
  'sources',
  'intervalMinutes',
  'limitPerSource',
  'maxScrolls',
  'vaultSubdir',
  'deliverDigest',
  'digestMaxChars',
];

/**
 * 多行文本拆成行：去空白、丢空行、丢注释行（以 # 开头）。
 *
 * 注释是这个键唯一的"说明位"：配置表单只有一个多行输入框，写不起作用的一行说明比留空更好读。
 * preflight 与实例共用同一处，别再各写一份。
 */
export function sourceLines(raw: unknown): string[] {
  const text = String(raw === null || raw === undefined ? '' : raw);
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    out.push(trimmed);
  }
  return out;
}

/**
 * 一行源解析的结果。失败也带得走：reason 直接进 preflight 的报错，不静默丢。
 * source 是 W3 的 XSource，本文件不再持有第二份语法。
 */
export type SourceLineResult =
  | { ok: true; line: string; source: XSource }
  | { ok: false; line: string; reason: string };

/**
 * 一行的解析：**全部转交 W3 的 parseSource**（src/x/types.ts:63-101）。
 *
 * 这里只做两件 parseSource 不做的事：
 * 1) 把 null 变成带 reason 的失败，好让 preflight 点名是哪一行、为什么；
 * 2) 保留原始行文本，报错时原样回给操作者。
 * 语法（@handle、裸 URL、大小写、list 的 id 写法）一律以 parseSource 为准。
 */
export function parseSourceLine(line: string): SourceLineResult {
  const raw = String(line === null || line === undefined ? '' : line).trim();
  if (raw === '') return { ok: false, line: raw, reason: '这一行是空的。' };
  const source = parseSource(raw);
  if (source !== null) return { ok: true, line: raw, source };
  return { ok: false, line: raw, reason: explainBadSource(raw) };
}

/** 只解释"为什么读不懂"，不重做解析。 */
function explainBadSource(line: string): string {
  const colon = line.indexOf(':');
  const head = (colon === -1 ? line : line.slice(0, colon)).trim().toLowerCase();
  const forms = SOURCE_KINDS.join(' / ');
  if (colon !== -1 && (SOURCE_KINDS as readonly string[]).includes(head) && head !== 'home') {
    return '种类「' + head + '」后面没有可用的值。写成 ' + head + ':…，例如 ' + EXAMPLE_SOURCES[head] + '。';
  }
  return (
    '读不懂这一行。种类只能是 ' + forms + '，也可以直接写 @handle 或帖子 URL；' +
    '例如 home、user:elonmusk、search:AI agents、hashtag:rustlang。'
  );
}

/** 报错里给例子用：每种源的写法各一条。 */
const EXAMPLE_SOURCES: Record<Exclude<SourceKind, 'home'>, string> = {
  user: 'user:elonmusk',
  search: 'search:AI agents',
  list: 'list:1234567890',
  hashtag: 'hashtag:rustlang',
  post: 'post:https://x.com/a/status/1',
};

/** 本 World 的设置界面声明。每个键都是 worlds.x-feed.*，与 defaults() 一一对应。 */
export function xFeedConfigGroups(language?: Language): ConfigGroup[] {
  const s = strings(language);
  return [
    {
      id: CONFIG_ID,
      owner: CONFIG_OWNER,
      schema: {
        type: 'object',
        title: s.label,
        properties: {
          'worlds.x-feed.mode': {
            type: 'string',
            title: s.config.mode.title,
            description: s.config.mode.description,
            enum: ['own', 'attach'],
            'x-hot': false,
          },
          'worlds.x-feed.port': {
            type: 'integer',
            title: s.config.port.title,
            description: s.config.port.description,
            minimum: 1,
            maximum: 65535,
            'x-hot': false,
          },
          'worlds.x-feed.chromePath': {
            type: 'string',
            title: s.config.chromePath.title,
            description: s.config.chromePath.description,
            'x-path': { kind: 'file', extensions: ['.exe'] },
            'x-hot': false,
          },
          'worlds.x-feed.sources': {
            type: 'string',
            title: s.config.sources.title,
            description: s.config.sources.description,
            'x-hot': true,
          },
          'worlds.x-feed.intervalMinutes': {
            type: 'integer',
            title: s.config.intervalMinutes.title,
            description: s.config.intervalMinutes.description,
            minimum: 0,
            maximum: 1440,
            'x-hot': true,
          },
          'worlds.x-feed.limitPerSource': {
            type: 'integer',
            title: s.config.limitPerSource.title,
            description: s.config.limitPerSource.description,
            minimum: 1,
            maximum: 100,
            'x-hot': true,
          },
          'worlds.x-feed.maxScrolls': {
            type: 'integer',
            title: s.config.maxScrolls.title,
            description: s.config.maxScrolls.description,
            minimum: 0,
            maximum: 20,
            'x-hot': true,
          },
          'worlds.x-feed.vaultSubdir': {
            type: 'string',
            title: s.config.vaultSubdir.title,
            description: s.config.vaultSubdir.description,
            'x-hot': false,
          },
          'worlds.x-feed.deliverDigest': {
            type: 'boolean',
            title: s.config.deliverDigest.title,
            description: s.config.deliverDigest.description,
            'x-hot': true,
          },
          'worlds.x-feed.digestMaxChars': {
            type: 'integer',
            title: s.config.digestMaxChars.title,
            description: s.config.digestMaxChars.description,
            minimum: 200,
            maximum: 8000,
            'x-hot': true,
          },
        },
      },
    },
  ];
}
