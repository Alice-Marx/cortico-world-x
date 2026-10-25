// 小工具：时间、哈希、文本归一化。learn 模块只依赖 node 内建模块。

import { createHash } from 'node:crypto';

export function nowIso(): string {
  return new Date().toISOString();
}

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** 条目 id：调用方给了 X status id 就用它，否则退回 sha256(url)（PLAN §3.3 去重语义）。 */
export function learnedId(url: string): string {
  return sha256(url.trim());
}

/** createdAt 优先、learnedAt 兜底，统一换成毫秒；解析不出来返回 0。 */
export function timeOf(item: { createdAt?: string; learnedAt?: string }): number {
  for (const raw of [item.createdAt, item.learnedAt]) {
    if (typeof raw !== 'string' || !raw) continue;
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return ms;
  }
  return 0;
}

/** 'YYYY-MM-DD'（UTC）。解析不出来时退回原字符串的前 10 位。 */
export function isoDay(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  if (Number.isFinite(ms)) return new Date(ms).toISOString().slice(0, 10);
  const head = raw.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(head) ? head : undefined;
}

/** 'YYYY-MM'（UTC），用于 notes/<YYYY-MM>.md 分片。 */
export function isoMonth(raw: string | undefined): string {
  const day = isoDay(raw);
  return day ? day.slice(0, 7) : 'unknown';
}

/** 'HH:MM'（UTC），用于人读镜像。 */
export function isoClock(raw: string | undefined): string {
  if (!raw) return '--:--';
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return '--:--';
  const d = new Date(ms);
  return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
}

export function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

/** 压成一行并截断；用于摘要/事实文本，避免多行正文把排版打散。 */
export function singleLine(text: string, max = Number.POSITIVE_INFINITY): string {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  return one.slice(0, Math.max(0, max - 1)) + '…';
}

/** '@handle'（作者可能已经带 @，也可能不带）。 */
export function handleOf(author: string | undefined): string {
  const a = (author ?? '').trim();
  if (!a) return '';
  return a.startsWith('@') ? a : '@' + a;
}
