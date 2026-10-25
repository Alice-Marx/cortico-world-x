// 零依赖检索：中文按字/子串（不分词）、英文按词，命中数 + 作者命中 + 时间衰减。
// 不引任何分词库：CJK 用 2 字滑窗当伪词，ASCII 用词边界正则。

import type { LearnedItem } from './types.ts';
import { timeOf } from './util.ts';

/** 单条返回文本上限：避免一次检索把 token 打爆。 */
export const SNIPPET_MAX = 400;
/** 一次最多参与打分的 token 数。 */
const MAX_TOKENS = 16;
/** 时间衰减半衰期（天）与最大加分。 */
const HALF_LIFE_DAYS = 30;
const RECENCY_MAX = 1.5;

const LATIN_RE = /[a-z0-9][a-z0-9_.'#/+-]*/g;
// 汉字（含扩展A/兼容区）、日文假名、韩文
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/g;

export function tokenize(query: string): string[] {
  const low = String(query ?? '').toLowerCase().trim();
  if (!low) return [];
  const out: string[] = [];
  const push = (t: string): void => {
    const v = t.trim();
    if (!v || out.includes(v)) return;
    out.push(v);
  };
  for (const m of low.match(LATIN_RE) ?? []) if (m.length >= 2) push(m);
  for (const run of low.match(CJK_RE) ?? []) {
    // 1~2 字整段命中；3 字以上只用 2 字滑窗（整段长串几乎不会命中，白占 token 预算）
    if (run.length <= 2) push(run);
    else for (let i = 0; i + 2 <= run.length; i++) push(run.slice(i, i + 2));
  }
  if (!out.length) push(low);
  return out.slice(0, MAX_TOKENS);
}

function hits(haystack: string, needle: string, cap = 5): number {
  if (!needle || !haystack) return 0;
  let n = 0;
  let from = 0;
  while (n < cap) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    n++;
    from = at + needle.length;
  }
  return n;
}

/**
 * 评分 = 正文/作者命中分 + 时间衰减加分；为 0 表示不相关（会被过滤）。
 * - 整串子串命中正文 +6
 * - 每个 token 首次命中 +2，重复命中每多一次 +0.5（单 token 上限 +4）
 * - token 命中作者 +3；命中链接（token 长度 ≥4，避免噪声）+1
 * - 衰减 1.5 * 0.5^(ageDays/30)，30 天半衰期，只加分不给负分
 */
export function scoreItem(item: LearnedItem, tokens: string[], fullQuery: string, nowMs: number): number {
  const text = String(item.text ?? '').toLowerCase();
  const author = String(item.author ?? '').toLowerCase();
  const url = String(item.url ?? '').toLowerCase();
  let base = 0;
  if (fullQuery.length >= 2 && text.includes(fullQuery)) base += 6;
  for (const t of tokens) {
    const n = hits(text, t);
    if (n > 0) base += 2 + Math.min(2, (n - 1) * 0.5);
    if (t.length >= 2 && hits(author, t, 1) > 0) base += 3;
    if (t.length >= 4 && hits(url, t, 1) > 0) base += 1;
  }
  if (base <= 0) return 0;
  const ms = timeOf(item);
  const ageDays = ms > 0 ? Math.max(0, (nowMs - ms) / 86400000) : 365;
  base += RECENCY_MAX * Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
  return base;
}

/** 返回条目副本，正文按 SNIPPET_MAX 截断（绝不改库里的原文）。 */
export function snippet(item: LearnedItem): LearnedItem {
  const text = String(item.text ?? '');
  if (text.length <= SNIPPET_MAX) return { ...item };
  return { ...item, text: text.slice(0, SNIPPET_MAX - 1) + '…' };
}
