// PLAN §3.3 契约：本地知识库（存/检）+ 对话摘要 + 记忆包导出。
// 依赖方向：learn 不 import cdp/x，只吃纯数据（tools → world → { cdp, x, learn }）。

export interface LearnedItem {
  id: string;
  url: string;
  author?: string;
  text: string;
  createdAt?: string;
  learnedAt: string;
  source: string;
  metrics?: Record<string, number>;
}

export interface VaultStats {
  items: number;
  bytes: number;
  lastLearnedAt?: string;
  sources: Record<string, number>;
}

export interface Vault {
  has(id: string): Promise<boolean>;
  put(items: LearnedItem[]): Promise<{ added: number; skipped: number }>;
  search(q: string, o?: { limit?: number }): Promise<LearnedItem[]>;
  recent(limit?: number): Promise<LearnedItem[]>;
  stats(): Promise<VaultStats>;
}

export type MemoryExport = { version: number; kind: 'cortico-memory-export'; [k: string]: unknown };

export { createVault } from './vault.ts';
// 条目 id 规则的唯一出处：调用方要自己算 id（如入库前 has() 预检）时走这个，
// 不要各自复制 sha256(url) 逻辑，否则库里会出现两套 id。
export { learnedId } from './util.ts';
export { digest } from './digest.ts';
// 记忆包：返回值里 fixed 带 truncated / exported{items,chars,truncated,maxItems,maxChars}，
// 上层回执必须转达截断条数（默认上限 300 条 / 120k 字）。
export { memoryExport } from './memory.ts';
export type { MemoryExportOptions } from './memory.ts';
export { THIRD_PARTY_PREFIX, EXPORT_MAX_ITEMS, EXPORT_MAX_CHARS } from './memory.ts';
