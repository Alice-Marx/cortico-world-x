// 本地知识库：一个目录三件套
//   index.jsonl       每行一条 LearnedItem，只追加（append-only，权威数据）
//   notes/<YYYY-MM>.md 人读中文镜像，按月分片、按天小节，每次写入整体重写
//   meta.json          条数 / 字节 / 最后学习时间 / 各源计数（派生镜像，原子写）
//
// 并发：同一 Vault 实例内的写入串行（#chain 队列），一批 put 只发一次 write + fsync，
// 因此并发 put 不会把 JSONL 行撕成两半；多实例时靠 stat 大小变化重新加载。

import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { LearnedItem, Vault, VaultStats } from './types.ts';
import { scoreItem, snippet, tokenize } from './search.ts';
import { handleOf, isoClock, isoDay, isoMonth, learnedId, nowIso, singleLine, timeOf } from './util.ts';

export const INDEX_FILE = 'index.jsonl';
export const NOTES_DIR = 'notes';
export const META_FILE = 'meta.json';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

function clampLimit(value: number | undefined): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(n));
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + '.' + randomUUID() + '.tmp';
  let renamed = false;
  try {
    const fh = await open(tmp, 'w');
    try {
      await fh.writeFile(content, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path); // 同卷 rename 原子（Windows 上 Node 用 MOVEFILE_REPLACE_EXISTING）
    renamed = true;
  } finally {
    // 失败路径不留 *.tmp：vault 目录会被反复扫描，堆垃圾文件比报错还难查
    if (!renamed) await unlink(tmp).catch(() => {});
  }
}

/** 落盘前把条目补全/清洗；不合法直接抛（宁可早炸，也不往库里塞残条）。 */
function normalizeIncoming(raw: LearnedItem, fallbackLearnedAt: string): LearnedItem {
  if (!raw || typeof raw !== 'object') throw new TypeError('LearnedItem 必须是对象');
  const url = String(raw.url ?? '').trim();
  if (!url) throw new TypeError('LearnedItem.url 不能为空');
  const text = String(raw.text ?? '').trim();
  if (!text) throw new TypeError('LearnedItem.text 不能为空');
  const id = String(raw.id ?? '').trim() || learnedId(url);
  const item: LearnedItem = {
    id,
    url,
    text,
    learnedAt: String(raw.learnedAt ?? '').trim() || fallbackLearnedAt,
    source: String(raw.source ?? '').trim() || 'unknown',
  };
  const author = String(raw.author ?? '').trim();
  if (author) item.author = author;
  const createdAt = String(raw.createdAt ?? '').trim();
  if (createdAt) item.createdAt = createdAt;
  const metrics = raw.metrics;
  if (metrics && typeof metrics === 'object') {
    const clean: Record<string, number> = {};
    for (const [key, value] of Object.entries(metrics)) {
      const n = Number(value);
      if (Number.isFinite(n)) clean[key] = n;
    }
    if (Object.keys(clean).length) item.metrics = clean;
  }
  return item;
}

/** 从 JSONL 行还原条目（宽松：坏行跳过，不拖垮整个库）。 */
function normalizeStored(raw: unknown): LearnedItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const id = String(rec.id ?? '').trim();
  const url = String(rec.url ?? '').trim();
  const text = String(rec.text ?? '').trim();
  if (!id || !url || !text) return null;
  const item: LearnedItem = {
    id,
    url,
    text,
    learnedAt: String(rec.learnedAt ?? '').trim(),
    source: String(rec.source ?? '').trim() || 'unknown',
  };
  const author = String(rec.author ?? '').trim();
  if (author) item.author = author;
  const createdAt = String(rec.createdAt ?? '').trim();
  if (createdAt) item.createdAt = createdAt;
  if (rec.metrics && typeof rec.metrics === 'object') item.metrics = rec.metrics as Record<string, number>;
  return item;
}

class FileVault implements Vault {
  readonly dir: string;
  #items: Map<string, LearnedItem> | null = null;
  #size = -1;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    if (!dir || typeof dir !== 'string') throw new TypeError('createVault(dir) 需要目录路径');
    this.dir = dir;
  }

  #indexPath(): string {
    return join(this.dir, INDEX_FILE);
  }

  #metaPath(): string {
    return join(this.dir, META_FILE);
  }

  /** 串行化写入：前一次失败也继续排队。 */
  #enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(fn, fn);
    this.#chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async #load(): Promise<Map<string, LearnedItem>> {
    const items = new Map<string, LearnedItem>();
    let buf: Buffer;
    try {
      buf = await readFile(this.#indexPath());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      this.#items = items;
      this.#size = 0;
      return items;
    }
    for (const line of buf.toString('utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue; // 半截行/手工改坏的行：跳过
      }
      const item = normalizeStored(parsed);
      if (!item) continue;
      if (!items.has(item.id)) items.set(item.id, item); // 先写先得
    }
    this.#items = items;
    this.#size = buf.length;
    return items;
  }

  /** 惰性加载 + 外部追加检测（大小变了就重读，append-only 所以只需比大小）。 */
  async #sync(): Promise<Map<string, LearnedItem>> {
    if (!this.#items) return this.#load();
    const st = await stat(this.#indexPath()).catch(() => null);
    if (!st) {
      this.#items = new Map();
      this.#size = 0;
      return this.#items;
    }
    if (st.size !== this.#size) return this.#load();
    return this.#items;
  }

  async has(id: string): Promise<boolean> {
    const key = String(id ?? '').trim();
    if (!key) return false;
    return (await this.#sync()).has(key);
  }

  async put(items: LearnedItem[]): Promise<{ added: number; skipped: number }> {
    const incoming = (Array.isArray(items) ? items : []).map((it) => normalizeIncoming(it, nowIso()));
    return this.#enqueue(async () => {
      const map = await this.#sync();
      const fresh: LearnedItem[] = [];
      const seen = new Set<string>();
      let skipped = 0;
      for (const item of incoming) {
        if (map.has(item.id) || seen.has(item.id)) {
          skipped++;
          continue;
        }
        seen.add(item.id);
        fresh.push(item);
      }
      if (!fresh.length) return { added: 0, skipped };

      const payload = fresh.map((item) => JSON.stringify(item)).join('\n') + '\n';
      await mkdir(this.dir, { recursive: true });
      const fh = await open(this.#indexPath(), 'a');
      try {
        await fh.write(payload);
        await fh.sync(); // 落到盘再回话，重启后不丢
      } finally {
        await fh.close();
      }
      for (const item of fresh) map.set(item.id, item);
      this.#size = (this.#size < 0 ? 0 : this.#size) + Buffer.byteLength(payload, 'utf8');

      // 镜像（notes/meta）是派生物：index.jsonl 已经 fsync 落盘，镜像写失败不该把这次入库判成失败
      // （否则调用方重试会被 skipped 掉，反而以为没写进去）。下一次 put 会按内存全量重建。
      await this.#writeNotes(fresh).catch(() => {});
      await this.#writeMeta(map).catch(() => {});
      return { added: fresh.length, skipped };
    });
  }

  async search(q: string, o: { limit?: number } = {}): Promise<LearnedItem[]> {
    const query = String(q ?? '').trim();
    const limit = clampLimit(o.limit);
    const map = await this.#sync();
    if (!query) return this.#recentOf(map, limit);
    const tokens = tokenize(query);
    const full = query.toLowerCase();
    const now = Date.now();
    const scored: { item: LearnedItem; score: number }[] = [];
    for (const item of map.values()) {
      const score = scoreItem(item, tokens, full, now);
      if (score > 0) scored.push({ item, score });
    }
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        timeOf(b.item) - timeOf(a.item) ||
        (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0),
    );
    return scored.slice(0, limit).map((x) => snippet(x.item));
  }

  async recent(limit?: number): Promise<LearnedItem[]> {
    const map = await this.#sync();
    return this.#recentOf(map, clampLimit(limit));
  }

  #recentOf(map: Map<string, LearnedItem>, limit: number): LearnedItem[] {
    const arr = [...map.values()].sort(
      (a, b) =>
        timeOf(b) - timeOf(a) ||
        (b.learnedAt < a.learnedAt ? -1 : b.learnedAt > a.learnedAt ? 1 : 0) ||
        (a.id < b.id ? -1 : 1),
    );
    return arr.slice(0, limit).map((item) => ({ ...item }));
  }

  async stats(): Promise<VaultStats> {
    const map = await this.#sync();
    return this.#statsOf(map);
  }

  #statsOf(map: Map<string, LearnedItem>): VaultStats {
    const sources: Record<string, number> = {};
    let last = '';
    for (const item of map.values()) {
      sources[item.source] = (sources[item.source] ?? 0) + 1;
      if (item.learnedAt > last) last = item.learnedAt;
    }
    return last
      ? { items: map.size, bytes: this.#size < 0 ? 0 : this.#size, lastLearnedAt: last, sources }
      : { items: map.size, bytes: this.#size < 0 ? 0 : this.#size, sources };
  }

  async #writeMeta(map: Map<string, LearnedItem>): Promise<void> {
    const stats = this.#statsOf(map);
    await writeAtomic(this.#metaPath(), JSON.stringify(stats, null, 2) + '\n');
  }

  /** 只重写本次新增条目涉及到的月份镜像（内容仍从全量内存重建，保证不漂）。 */
  async #writeNotes(fresh: LearnedItem[]): Promise<void> {
    const map = this.#items ?? new Map<string, LearnedItem>();
    const months = new Set(fresh.map((item) => isoMonth(item.learnedAt)));
    for (const month of months) {
      const rows = [...map.values()]
        .filter((item) => isoMonth(item.learnedAt) === month)
        .sort((a, b) => timeOf(a) - timeOf(b) || (a.id < b.id ? -1 : 1));
      const lines: string[] = [
        '# ' + month + ' · x-feed 学习笔记',
        '',
        '> 由 cortico-world-x 自动生成，每次写入整体重写；权威数据在 `../' + INDEX_FILE + '`。时间均为 UTC。',
        '',
      ];
      let day = '';
      for (const item of rows) {
        const itemDay = isoDay(item.learnedAt) ?? '未知日期';
        if (itemDay !== day) {
          lines.push('## ' + itemDay, '');
          day = itemDay;
        }
        const who = handleOf(item.author) || item.source;
        lines.push('- ' + isoClock(item.learnedAt) + ' · ' + who + ' · ' + item.source);
        lines.push('  ' + singleLine(item.text, 600));
        if (item.url) lines.push('  链接：' + item.url);
        lines.push('');
      }
      await writeAtomic(join(this.dir, NOTES_DIR, month + '.md'), lines.join('\n'));
    }
  }
}

export function createVault(dir: string): Vault {
  return new FileVault(dir);
}
