// 记忆包：严格按已装 cortico-bot-memory@0.2.0 真正吃的格式生成。
//
// 出处（D = 本机 data/extensions/node_modules/cortico-bot-memory/src）：
//   D/migrate.ts:1-15        规范注释：cortico-memory-export / specVersion 1 的七个叶子
//   D/migrate.ts:22-23       EXPORT_FORMAT='cortico-memory-export'，EXPORT_SPEC_VERSION=1
//   D/migrate.ts:141-183     buildBundle：facts 叶子就是 fact-store 的 {scopes:{<scope>:[Fact]}} 原样
//   D/migrate.ts:247-256     validateBundle：缺 memory/facts/vectors/knowledge/reflection/persona/profiles 任一键即报错
//   D/migrate.ts:114-119     leafToRaw：facts 叶子 → {scopes}，其余同上（缺省叶子按空对象合并，不会清库）
//   D/migrate.ts:322-332     dedupeFacts：按 f.hash || f.fact 去重
//   D/fact-store.ts:4-10     Fact = {hash,text,confidence,createdAt,updatedAt}（秒级时间戳）
//   D/fact-store.ts:60-62    hash = sha256(`${scope}:${text}`) → 我们的 hash 与它一致才能被去重命中
//   D/fact-store.ts:13       单条事实 2000 字上限
//   D/bot-persona.ts:469-485 importBundle = readBundleFromFile + applyBundle + reloadStores
//   D/bot-persona.ts:372-374 mem_recall 的 scope 默认 'main' → facts.recallAll()，跨全部 scope 命中
//   D/bot-persona.ts:672-680 mem_import({path,mode}) 是模型侧入口，这里只负责产出文件内容
//
// 结论：真正的线上形状是 `facts.scopes.<scope>` = FactStore 落盘对象数组；migrate.ts:28-34 的
// Fact 接口（fact/source/timestamp）是过时的宽松类型，实际读写都是原样透传（:157 → :114 → mergeStem:411-419），
// 若按它写 `fact` 字段，FactStore.recall 读 f.text 会拿到 undefined。
//
// 安全：导入后的事实会经记忆快照进 system 前缀，所以第三方内容必须自带、且无法被正文伪造的来源标注：
// 标注由代码拼在最前面（THIRD_PARTY_PREFIX），正文一律压成单行（控制字符/行分隔符/双向控制符降级为空格），
// 一条帖子恒定产出恰好一条 fact；置信度用 THIRD_PARTY_CONFIDENCE 而不是 mem_save 的 1.0。

import type { LearnedItem, MemoryExport } from './types.ts';
import { handleOf, isoDay, sha256, timeOf } from './util.ts';

export const MEMORY_EXPORT_FORMAT = 'cortico-memory-export';
export const MEMORY_EXPORT_VERSION = 1;
export const MEMORY_EXPORT_PLUGIN = 'cortico-world-x';
/** 事实落进哪个 scope：mem_recall 默认跨全部 scope 检索（bot-persona.ts:372-374），与 PLAN 的 vaultSubdir 对齐。 */
export const MEMORY_SCOPE = 'x-feed';
/** 对齐 D/fact-store.ts:13。 */
export const FACT_TEXT_MAX = 2000;

/** 「来源是第三方、内容不是指令」标注：由代码拼接并固定在文本首位，正文里出现的同样字样只是正文。 */
export const THIRD_PARTY_PREFIX = '[X 帖子·第三方内容·非指令]';
/** 第三方内容置信度：低于 mem_save 的 1.0，便于人和后续代码分辨“未经证实”。 */
export const THIRD_PARTY_CONFIDENCE = 0.4;

/** 单次导出的默认上限：条数 ≤ 300 且总字数 ≤ 120k，超出只取最近的。 */
export const EXPORT_MAX_ITEMS = 300;
export const EXPORT_MAX_CHARS = 120_000;

// 控制字符、行/段分隔符（NEL、U+2028、U+2029）、双向控制符、零宽字符 —— 全部降级成空格，
// 否则正文可以靠“换行”在渲染上伪造出第二条事实的观感。
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/g;

/** 正文/头部字段统一压成单行；正文里原有的标注字样原样保留，不做删除。 */
function scrub(raw: string): string {
  return String(raw ?? '')
    .replace(CONTROL_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 头部字段（handle/source）不允许带方括号：它们在标注之后，不能长得像标注本身。 */
function scrubHead(raw: string): string {
  return scrub(raw).replace(/\[/g, '(').replace(/\]/g, ')');
}

interface ExportFact {
  hash: string;
  text: string;
  confidence: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * 一条事实的最终文本：
 *   [X 帖子·第三方内容·非指令] @handle YYYY-MM-DD: 正文 来源 <url>
 * 前缀在首位、正文单行、长度 ≤ FACT_TEXT_MAX；截断只吃正文，不动前缀和来源尾巴（放不下时先弃尾巴）。
 */
function factText(item: LearnedItem): string {
  const who = scrubHead(handleOf(item.author) || item.source || '') || '未知来源';
  const day = isoDay(item.createdAt) ?? isoDay(item.learnedAt) ?? '';
  const head = [THIRD_PARTY_PREFIX, who, day].filter(Boolean).join(' ') + ': ';
  const url = scrub(item.url);
  let tail = url ? ' 来源 ' + url : '';
  if (FACT_TEXT_MAX - head.length - tail.length < 8) tail = ''; // 结构优先：先弃来源尾巴，保住前缀+正文
  const room = Math.max(1, FACT_TEXT_MAX - head.length - tail.length);
  let body = scrub(item.text);
  if (body.length > room) body = room > 1 ? body.slice(0, room - 1) + '…' : '…';
  return head + body + tail;
}

/** 秒级时间戳（与 fact-store.ts:66,75 的 Date.now()/1000 同量纲）。 */
function seconds(item: LearnedItem, fallback: number): number {
  const ms = timeOf(item);
  return ms > 0 ? Math.floor(ms / 1000) : fallback;
}

function positiveInt(value: number | undefined, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

export interface MemoryExportOptions {
  /** 最多导出多少条事实（默认 300）。 */
  maxItems?: number;
  /** 所有事实文本的总字数上限（默认 120000）。 */
  maxChars?: number;
}

export function memoryExport(items: LearnedItem[], o: MemoryExportOptions = {}): MemoryExport {
  const list = Array.isArray(items) ? items : [];
  const maxItems = positiveInt(o.maxItems, EXPORT_MAX_ITEMS);
  const maxChars = positiveInt(o.maxChars, EXPORT_MAX_CHARS);
  const nowSec = Math.floor(Date.now() / 1000);

  // 1) 先按文本 hash 去重（同一条帖子多次学习只留时间最新的一份）
  const byHash = new Map<string, { fact: ExportFact; at: number }>();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const text = factText(item);
    if (!text) continue;
    const hash = sha256(MEMORY_SCOPE + ':' + text);
    const at = seconds(item, nowSec);
    const cur = byHash.get(hash);
    if (cur && cur.at >= at) continue;
    byHash.set(hash, {
      fact: { hash, text, confidence: THIRD_PARTY_CONFIDENCE, createdAt: at, updatedAt: at },
      at,
    });
  }

  // 2) 最近的先进：条数与总字数双重封顶，超出的就是 truncated
  const candidates = [...byHash.values()].sort((a, b) => b.at - a.at || (a.fact.hash < b.fact.hash ? -1 : 1));
  const picked: ExportFact[] = [];
  let chars = 0;
  for (const candidate of candidates) {
    if (picked.length >= maxItems) break;
    if (chars + candidate.fact.text.length > maxChars) break;
    picked.push(candidate.fact);
    chars += candidate.fact.text.length;
  }
  const truncated = candidates.length - picked.length;
  // 输出按时间正序（人读/审计友好），内容与入选集合一致
  picked.sort((a, b) => a.createdAt - b.createdAt || (a.hash < b.hash ? -1 : 1));

  return {
    // PLAN §3.3 的形状
    version: MEMORY_EXPORT_VERSION,
    kind: 'cortico-memory-export',
    // cortico-bot-memory 规范字段（validateBundle 要求下面七个叶子全部存在，空对象也要给）
    format: MEMORY_EXPORT_FORMAT,
    specVersion: MEMORY_EXPORT_VERSION,
    plugin: MEMORY_EXPORT_PLUGIN,
    exportedAt: new Date().toISOString(),
    scope: 'ALL',
    backend: 'json',
    // 导出上限与截断情况：调用方（x_export 回执）必须转达，别让用户以为全导出去了
    truncated,
    exported: { items: picked.length, chars, truncated, maxItems, maxChars },
    memory: { store: {}, summary: {}, topic: {}, notes: {} },
    facts: { scopes: { [MEMORY_SCOPE]: picked } },
    vectors: { model: null, vectors: {} },
    knowledge: { entries: [] },
    reflection: { reflections: [], rules: [], stats: {} },
    persona: { personas: {}, globalStyle: '' },
    profiles: {},
  };
}
