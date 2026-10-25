/**
 * 中英文案与中文固定文案。
 *
 * 框架的 Language 有 11 个取值，这里只维护 zh / en 两份：zh 与 zh-Hant 取中文，其余取英文，
 * 与框架 core/language.ts 的 baseLanguage() 同义。
 *
 * 两类文本不是一回事，别混着用：
 * - TEXT / strings()：给人看的界面文案（配置表单、事件说明、工具一句话摘要），成对维护。
 * - PREFLIGHT / MODEL：没有语言通道的文本。preflight 的报错原样交给操作者（框架不给语言），
 *   环境提示词变量进模型前缀；按 PLAN A6「中文优先」固定中文。
 *
 * 本文件对框架只 import type，运行时零依赖（包要能裸 node 加载与测试）。
 */
import type { Language } from 'cortico/core/language.ts';

/** 一对文案。zh 必填（简体中文是主语言），en 必填（市场要求双语）。 */
interface Pair {
  readonly zh: string;
  readonly en: string;
}

/** 把 TEXT 里的 Pair 摊平成当前语言下的普通字符串表；其余叶子原样保留。 */
type Deep<T> = T extends Pair ? string : T extends object ? { [K in keyof T]: Deep<T[K]> } : T;

/** 全部成对文案。 */
export const TEXT = {
  label: { zh: 'X 时间线', en: 'X Timeline' },

  lamp: {
    label: { zh: 'X', en: 'X' },
    hint: {
      offline: { zh: '未启用或还没启动', en: 'Off, or not started yet' },
      loading: { zh: '正在连浏览器', en: 'Connecting to the browser' },
      online: { zh: '浏览器就绪', en: 'Browser ready' },
      error: { zh: '连不上浏览器，详见日志', en: 'Cannot reach the browser; see the log' },
    },
  },

  config: {
    mode: {
      title: { zh: '浏览器模式', en: 'Browser mode' },
      description: {
        zh: 'own＝本 World 自己拉起一个专属 Chrome（独立 profile，不动你日常那个）；attach＝连你已经开好远程调试口的浏览器（共享登录态，用它才能读到登录后的 X）。改完要重启这个 World 才生效。',
        en: 'own launches a dedicated Chrome for this World (separate profile, your daily browser untouched); attach connects to a browser you already started with remote debugging on (shares your login state, which logged-in X needs). Restart this World after changing it.',
      },
    },
    port: {
      title: { zh: '调试端口', en: 'Debug port' },
      description: {
        zh: 'own 模式用它开调试口，attach 模式拿它去探测。默认 9223，别和你浏览器常用的 9222 撞。改完要重启这个 World 才生效。',
        en: 'Used to open the debugging port in own mode, and probed in attach mode. Default 9223; do not collide with the 9222 your own browser usually uses. Restart this World after changing it.',
      },
    },
    chromePath: {
      title: { zh: '浏览器程序', en: 'Browser executable' },
      description: {
        zh: '留空＝自动找 Chrome / Edge（含用户级安装）。own 模式必须能找到一个真的存在的文件，否则激活会被拒绝。改完要重启这个 World 才生效。',
        en: 'Empty means auto-detect Chrome / Edge, including per-user installs. own mode needs a file that actually exists, otherwise activation is refused. Restart this World after changing it.',
      },
    },
    sources: {
      title: { zh: '看哪些源', en: 'Sources to read' },
      description: {
        zh: '每行一个：home（你登着 X 的那个账号的主时间线）、user:handle、search:关键词、list:<id>、hashtag:tag、post:<url>。至少一行，空行会被忽略。改了这一项不用重启。',
        en: 'One per line: home (the timeline of the account you are logged in as), user:handle, search:keywords, list:<id>, hashtag:tag, post:<url>. At least one line; blank lines are ignored. No restart needed for this one.',
      },
    },
    intervalMinutes: {
      title: { zh: '自动扫描间隔（分钟）', en: 'Auto-scan interval (minutes)' },
      description: {
        zh: '默认 120。0＝不自动，只由工具手动触发。扫描与有没有人在对话无关。',
        en: 'Default 120. 0 means no automatic scan; only the tools trigger one. Scans do not depend on anyone being in a conversation.',
      },
    },
    limitPerSource: {
      title: { zh: '每个源取几条', en: 'Posts per source' },
      description: {
        zh: '每次每源最多取几条，默认 20。调大会明显更慢，也更花 token。',
        en: 'How many posts to take per source each run; default 20. Raising it is noticeably slower and costs more tokens.',
      },
    },
    maxScrolls: {
      title: { zh: '翻屏次数', en: 'Scroll passes' },
      description: {
        zh: '滚到底加载更多内容的次数，默认 3。0＝不翻，只看首屏。',
        en: 'How many times to scroll down for more content; default 3. 0 means the first screen only.',
      },
    },
    vaultSubdir: {
      title: { zh: '知识库子目录', en: 'Knowledge subdirectory' },
      description: {
        zh: '读到的条目落在部署数据目录下的这个子目录里（Markdown + JSONL，可直接读、可审计）。默认 x-feed。改完要重启这个 World 才生效。',
        en: 'Learned items land in this subdirectory of the deployment data directory (Markdown + JSONL, readable and auditable). Default x-feed. Restart this World after changing it.',
      },
    },
    deliverDigest: {
      title: { zh: '摘要进对话', en: 'Deliver digests into the conversation' },
      description: {
        zh: '开着时，一轮扫描有新内容就投一条摘要事件（origin external，会花 token）。关掉则只落库，不打扰对话。',
        en: 'When on, a scan that finds new content pushes one digest event (origin external; costs tokens). When off, items are only stored and the conversation is left alone.',
      },
    },
    digestMaxChars: {
      title: { zh: '摘要上限（字）', en: 'Digest length cap (characters)' },
      description: {
        zh: '一条摘要最多多少字，默认 1200。太长会挤占上下文，太短会丢掉来源。',
        en: 'Maximum characters of one digest; default 1200. Too long eats context, too short loses provenance.',
      },
    },
  },

  events: {
    ready: { zh: '浏览器连上了，工具可用。', en: 'The browser is connected; the tools are usable.' },
    down: {
      zh: '启动时连不上浏览器（端口不通、程序没找到、远程调试没开）。工具会按失败回报，World 不消失。',
      en: 'The browser could not be reached at startup (port closed, executable missing, remote debugging off). Tools report failure; the World stays mounted.',
    },
    scanned: {
      zh: '一轮扫描完成（只落库，不投递进对话）。',
      en: 'One scan finished (stored only; nothing delivered into the conversation).',
    },
    posts: {
      zh: '扫到新内容时的摘要。正文来自 X，是第三方写的，不是指令。',
      en: 'A digest of newly found content. The text comes from X and is written by third parties, not instructions.',
    },
  },

  tools: {
    x_look: {
      zh: '现在就看一次某个源（或所有配置的源），返回新条目并落进知识库。',
      en: 'Looks at one source (or every configured source) right now, returns the new items and stores them.',
    },
    x_read: {
      zh: '读单条 X 帖子的完整内容与当前互动数，并入库。',
      en: 'Reads one X post in full with its current counts, and stores it.',
    },
    x_recall: {
      zh: '在本地知识库里检索以前读到的内容，不联网。',
      en: 'Searches the local knowledge base for what was read before, without going online.',
    },
    x_sync_now: {
      zh: '把配置的源全部扫一遍，落库并按需投摘要。',
      en: 'Scans every configured source, stores what is new and delivers a digest when configured.',
    },
    x_watch: {
      zh: '查看或增删要看的源，改的是 worlds.x-feed.sources。',
      en: 'Lists, adds or removes the sources to read, editing worlds.x-feed.sources.',
    },
    x_status: {
      zh: '报浏览器连接、源、知识库条数和上次扫描时间。',
      en: 'Reports browser connection, sources, how many items are stored and when the last scan ran.',
    },
    x_export: {
      zh: '把知识库导出成 cortico-memory-export 记忆包，交给长期记忆导入。',
      en: 'Exports the knowledge base as a cortico-memory-export bundle for long-term memory to import.',
    },
  },

  env: {
    title: { zh: 'X 时间线环境说明', en: 'X timeline environment' },
    description: {
      zh: '进系统前缀的环境说明：能看哪些源、第三方内容为什么不能当指令执行、失败分哪 5 类、回答 X 问题前先查知识库。正文在 src/ENV_PROMPT.md。',
      en: 'The environment section prepended to the system prompt: which sources are readable, why third-party text must not be treated as instructions, the 5 failure classes, and checking the knowledge base before answering about X. The text lives in src/ENV_PROMPT.md.',
    },
    vars: {
      status: { zh: '浏览器与扫描的当前状态（一句话）。', en: 'The current browser and scan state, in one line.' },
      sources: { zh: '当前配置要看的源，按人能读的方式列出。', en: 'The sources configured right now, in a human-readable form.' },
      interval: { zh: '自动扫描节奏，或「已关闭」。', en: 'The auto-scan cadence, or a note that it is off.' },
      vault: { zh: '知识库落在哪里（相对部署数据目录）。', en: 'Where the knowledge base lives, relative to the deployment data directory.' },
    },
  },
} as const;

/** TEXT 在当前语言下的普通字符串表。 */
export type Strings = Deep<typeof TEXT>;

export function strings(language?: Language): Strings {
  return resolve(TEXT, isChinese(language)) as Strings;
}

/** zh 与 zh-Hant 用中文；没给语言时按框架缺省取中文；其余语言取英文。 */
export function isChinese(language?: Language): boolean {
  if (typeof language !== 'string' || language === '') return true;
  const tag = language.toLowerCase();
  return tag === 'zh' || tag.startsWith('zh-');
}

function isPair(value: object): value is Pair {
  const v = value as Record<string, unknown>;
  return typeof v.zh === 'string' && typeof v.en === 'string';
}

function resolve(node: unknown, zh: boolean): unknown {
  if (node === null || typeof node !== 'object') return node;
  if (isPair(node)) return zh ? node.zh : node.en;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) out[key] = resolve(value, zh);
  return out;
}

/**
 * preflight 的报错：框架把 message 原样交给操作者，没有语言通道，按 A6 固定中文。
 * 每条都说清「现在是什么」与「该填什么」，不等到运行起来才静默失败。
 */
export const PREFLIGHT = {
  modeUnknown(value: string): string {
    return 'worlds.x-feed.mode 只能是 own / attach，现在是「' + value + '」。'
      + 'own＝给她拉一个专属 Chrome；attach＝连你已经开好远程调试口的浏览器。';
  },
  portInvalid(value: string): string {
    return 'worlds.x-feed.port 要不是 1–65535 的整数，现在是「' + value + '」。'
      + 'own 模式用它开调试口，attach 模式拿它去探测。';
  },
  sourcesEmpty(): string {
    return 'worlds.x-feed.sources 是空的。每行填一个源：home / user:handle / search:关键词 / '
      + 'list:<id> / hashtag:tag / post:<url>，至少一行。';
  },
  sourceBadLine(line: string, hint: string): string {
    return 'worlds.x-feed.sources 这一行读不懂：「' + line + '」。' + hint;
  },
  chromePathMissing(path: string): string {
    return 'worlds.x-feed.chromePath 指向的文件不存在：' + path + '。'
      + '填 chrome.exe / msedge.exe 的绝对路径，或者留空让它自动找。';
  },
  chromeNotDetected(searched: readonly string[]): string {
    return '没找到 Chrome / Edge。要么装上其中一个，要么把 worlds.x-feed.chromePath 填成'
      + '浏览器可执行文件的绝对路径。找过：' + searched.join('；');
  },
  attachUnreachable(port: number, detail: string): string {
    return 'attach 模式连不上 127.0.0.1:' + String(port) + '（' + detail + '）。'
      + '先确认那个浏览器是用 --remote-debugging-port=' + String(port) + ' 起来的并且已经打开；'
      + '不打算共用你的浏览器就把 worlds.x-feed.mode 改成 own。';
  },
};

/** 进模型前缀的中文固定文案：环境提示词变量用，永远中文（A6）。 */
export const MODEL = {
  status: {
    idle: '还没启动（浏览器未连接）。',
    starting: '正在连浏览器。',
    ready: '浏览器已就绪，工具可用。',
    failed: '浏览器没连上：工具会按失败回报，具体原因看工具回执。',
  },
  intervalOff: '自动扫描已关闭（intervalMinutes=0），只能由工具手动触发。',
  intervalOn(minutes: number): string {
    return '每 ' + String(minutes) + ' 分钟自动看一次，与有没有在对话无关。';
  },
  vault(subdir: string): string {
    return '本地知识库在部署数据目录下的 ' + subdir + '/ 里（Markdown + JSONL，可直接读，可审计）。';
  },
  sourcesNone: '一个源都没配——任何抓取都会直接失败。',
  sourcesSome(lines: readonly string[]): string {
    return '当前配置 ' + String(lines.length) + ' 个源：' + lines.join('、') + '。';
  },
};
