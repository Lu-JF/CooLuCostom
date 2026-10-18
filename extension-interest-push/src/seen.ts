/**
 * 已见条目存储：按 DOI（无 DOI 退化为 id）去重，落盘到 `<dataDir>/news/seen.json`。
 * 构造时读文件；文件缺失或损坏一律当作空表，读写失败都不抛错。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 一条已见记录。`key` 是它在表里的主键（DOI 优先，否则 id）。 */
interface SeenRecord {
  id: string;
  foundAt: number;
}

export class SeenStore {
  private readonly file: string;
  private readonly records = new Map<string, SeenRecord>();
  /** 所有出现过的 id，用于「按 id 去重」时不必遍历全表。 */
  private readonly ids = new Set<string>();

  constructor(dataDir: string) {
    this.file = join(dataDir, 'news', 'seen.json');
    this.load();
  }

  /** 读文件；不存在或 JSON 损坏 → 保持空表。兼容对象表与数组两种历史形状。 */
  private load(): void {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch {
      return;
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return;
    }
    if (data === null || typeof data !== 'object') return;

    if (Array.isArray(data)) {
      for (const raw of data) this.put(raw as Partial<SeenRecord> & { doi?: string | null });
      return;
    }
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      this.put(value as Partial<SeenRecord>, key);
    }
  }

  /** 把一条原始记录并入内存表；形状不对就忽略。`key` 缺省时退化为 id（或数组形状里的 doi）。 */
  private put(raw: (Partial<SeenRecord> & { doi?: string | null }) | null | undefined, key?: string): void {
    if (!raw || typeof raw.id !== 'string' || raw.id === '') return;
    const primary = key && key !== '' ? key : (typeof raw.doi === 'string' && raw.doi !== '' ? raw.doi : raw.id);
    const foundAt = typeof raw.foundAt === 'number' ? raw.foundAt : 0;
    this.records.set(primary, { id: raw.id, foundAt });
    this.ids.add(raw.id);
  }

  /** id 或（以该 id 为主键的记录）是否已见。 */
  has(id: string): boolean {
    return this.records.has(id) || this.ids.has(id);
  }

  /**
   * 记录一条已见条目。新条目 → true；按 DOI 或 id 任一命中已见 → false。
   * 主键优先用 doi，无 doi 时用 id。
   */
  add(item: { id: string; doi: string | null; foundAt: number }): boolean {
    const doi = typeof item.doi === 'string' && item.doi !== '' ? item.doi : null;
    if ((doi && this.has(doi)) || this.has(item.id)) return false;
    const key = doi ?? item.id;
    this.records.set(key, { id: item.id, foundAt: item.foundAt });
    this.ids.add(item.id);
    return true;
  }

  /** 已见条目数。 */
  size(): number {
    return this.records.size;
  }

  /** 落盘；目录不存在先递归创建，任何失败都吞掉不抛。 */
  save(): void {
    try {
      mkdirSync(join(this.file, '..'), { recursive: true });
      const data: Record<string, SeenRecord> = {};
      for (const [key, record] of this.records) data[key] = record;
      writeFileSync(this.file, JSON.stringify(data, null, 2), 'utf8');
    } catch {
      // 存储失败不应影响调度主流程。
    }
  }
}
