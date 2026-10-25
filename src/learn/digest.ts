// 对话摘要：紧凑中文行，给事件文本/timeline 用，超预算即截断并标注省略条数。

import type { LearnedItem } from './types.ts';
import { handleOf, isoDay, singleLine } from './util.ts';

/** 与配置项 digestMaxChars 默认值一致（PLAN §4）。 */
export const DIGEST_MAX_CHARS = 1200;
/** 单行正文上限，防止一条长推占满整段摘要。 */
export const DIGEST_LINE_TEXT_MAX = 120;

function renderLine(item: LearnedItem): string {
  const who = handleOf(item.author) || (item.source || '未知来源');
  const day = isoDay(item.createdAt) ?? isoDay(item.learnedAt);
  const body = singleLine(item.text, DIGEST_LINE_TEXT_MAX);
  return ['·', who, day, body].filter((p) => p !== undefined && p !== '').join(' ');
}

function footer(omitted: number): string {
  return '…（另有 ' + omitted + ' 条未显示）';
}

/**
 * items 顺序原样保留；每条一行 `· @handle YYYY-MM-DD 正文…`。
 * 空数组返回 ''（没有内容就不该产生事件文本）。
 */
export function digest(items: LearnedItem[], o: { maxChars?: number } = {}): string {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return '';
  const raw = Number(o.maxChars);
  const maxChars = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DIGEST_MAX_CHARS;

  const lines: string[] = [];
  for (const item of list) {
    const line = renderLine(item);
    if (line.trim()) lines.push(line);
  }
  if (!lines.length) return '';

  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const extra = (out.length ? 1 : 0) + lines[i].length;
    const omitted = lines.length - (out.length + 1);
    const reserve = omitted > 0 ? footer(omitted).length + 1 : 0;
    if (used + extra + reserve > maxChars) break;
    out.push(lines[i]);
    used += extra;
  }

  const omitted = lines.length - out.length;
  if (!out.length) {
    const only = footer(omitted);
    return only.length <= maxChars ? only : '';
  }
  let text = out.join('\n');
  if (omitted > 0) {
    const f = '\n' + footer(omitted);
    if (text.length + f.length <= maxChars) text += f;
  }
  return text;
}
