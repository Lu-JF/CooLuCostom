/**
 * 本机 Hermes 的 token 统计。数据在 `state.db` 的 `session_model_usage` 表：每个
 * (会话, 模型, 计费端点, 任务) 一行，累计调用次数与各类 token。
 *
 * 只读打开，不写、不锁；Hermes 在跑时 WAL 库读不动就复制一份副本再读。
 * `node:sqlite` 不可用时（宿主 Node 太旧）退回读 `<hermes 数据目录>/quota-usage.json`，
 * 那份文件由她这边的导出脚本写（见 README）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export interface HermesModelRow {
  model: string;
  provider: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** 输入 + 输出 + 缓存读 + 缓存写 + 推理，用作「一共走过多少 token」。 */
  totalTokens: number;
  costUsd: number;
}

export interface HermesDayRow {
  day: string;
  calls: number;
  totalTokens: number;
}

export interface HermesUsage {
  available: boolean;
  /** 读不到时的原因（英文短句）。 */
  reason: string | null;
  /** 实际读的是哪个文件，以及走的是哪条路（sqlite / 导出文件）。 */
  dbPath: string;
  via: 'sqlite' | 'export' | 'none';
  days: number;
  models: HermesModelRow[];
  daily: HermesDayRow[];
  total: HermesModelRow | null;
  sessions: number;
  firstSeen: number | null;
  lastSeen: number | null;
}

export function resolveHermesHome(configHome: string, env: Record<string, string | undefined> = process.env): string {
  const declared = configHome.trim();
  if (declared) return declared;
  const fromEnv = (env.HERMES_HOME ?? '').trim();
  if (fromEnv) return fromEnv;
  const local = (env.LOCALAPPDATA ?? '').trim();
  if (local) return join(local, 'hermes');
  return join(homedir(), '.hermes');
}

function emptyUsage(reason: string, dbPath: string, days: number): HermesUsage {
  return {
    available: false,
    reason,
    dbPath,
    via: 'none',
    days,
    models: [],
    daily: [],
    total: null,
    sessions: 0,
    firstSeen: null,
    lastSeen: null,
  };
}

const TOTALS_SQL = `
  sum(api_call_count) AS calls,
  sum(input_tokens) AS input_tokens,
  sum(output_tokens) AS output_tokens,
  sum(cache_read_tokens) AS cache_read_tokens,
  sum(cache_write_tokens) AS cache_write_tokens,
  sum(reasoning_tokens) AS reasoning_tokens,
  sum(coalesce(nullif(actual_cost_usd, 0), estimated_cost_usd, 0)) AS cost_usd
`;

interface RawRow {
  model?: unknown;
  provider?: unknown;
  calls?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_tokens?: unknown;
  cache_write_tokens?: unknown;
  reasoning_tokens?: unknown;
  cost_usd?: unknown;
  day?: unknown;
}

const n = (v: unknown): number => {
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
};

/** 导出文件用驼峰、库里用下划线，两种写法都认。 */
function field(raw: Record<string, unknown>, snake: string, camel: string): unknown {
  return raw[snake] ?? raw[camel];
}

function modelRow(raw: RawRow): HermesModelRow {
  const row = raw as Record<string, unknown>;
  const inputTokens = n(field(row, 'input_tokens', 'inputTokens'));
  const outputTokens = n(field(row, 'output_tokens', 'outputTokens'));
  const cacheReadTokens = n(field(row, 'cache_read_tokens', 'cacheReadTokens'));
  const cacheWriteTokens = n(field(row, 'cache_write_tokens', 'cacheWriteTokens'));
  const reasoningTokens = n(field(row, 'reasoning_tokens', 'reasoningTokens'));
  return {
    model: String(raw.model ?? ''),
    provider: String(raw.provider ?? ''),
    calls: n(raw.calls),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens + reasoningTokens,
    costUsd: n(field(row, 'cost_usd', 'costUsd')),
  };
}

/** `node:sqlite` 打不开库时（常见的只有 WAL 库正在被写）复制一份副本再读。 */
function copyForRead(dbPath: string): string {
  const dir = join(tmpdir(), `cortico-quota-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const copy = join(dir, 'state.db');
  for (const suffix of ['', '-wal', '-shm']) {
    const from = dbPath + suffix;
    if (existsSync(from)) copyFileSync(from, copy + suffix);
  }
  return copy;
}

interface DatabaseLike {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
}

/**
 * `node:sqlite` 经 createRequire 拿：动态 import 它会让 vite（vitest 的转译）去解析一个叫
 * `sqlite` 的包，而它是 Node 的内建模块。宿主 Node 没有它时这里抛错，由调用方兜底。
 */
const nodeRequire = createRequire(import.meta.url);

function loadSqlite(): { DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => DatabaseLike } {
  return nodeRequire('node:sqlite') as {
    DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => DatabaseLike;
  };
}

function openDatabase(dbPath: string): { db: DatabaseLike; cleanup: () => void } {
  const { DatabaseSync } = loadSqlite();
  try {
    return { db: new DatabaseSync(dbPath, { readOnly: true }), cleanup: () => {} };
  } catch (first) {
    const copy = copyForRead(dbPath);
    try {
      return { db: new DatabaseSync(copy, { readOnly: true }), cleanup: () => rmSync(copy, { force: true }) };
    } catch {
      throw first;
    }
  }
}

export interface ReadHermesOptions {
  home: string;
  days: number;
  now?: number;
}

export async function readHermesUsage(opts: ReadHermesOptions): Promise<HermesUsage> {
  const dbPath = join(opts.home, 'state.db');
  const days = Math.max(1, Math.min(365, Math.round(opts.days)));
  const now = opts.now ?? Date.now();
  const since = now / 1000 - days * 86_400;

  if (!existsSync(dbPath)) {
    const exported = await readExport(opts.home, days);
    if (exported) return exported;
    return emptyUsage(`no state.db under ${opts.home}`, dbPath, days);
  }

  let opened: { db: DatabaseLike; cleanup: () => void };
  try {
    opened = openDatabase(dbPath);
  } catch (err) {
    const exported = await readExport(opts.home, days);
    if (exported) return exported;
    const message = err instanceof Error ? err.message : String(err);
    return emptyUsage(message.slice(0, 200), dbPath, days);
  }

  try {
    const { db, cleanup } = opened;
    const models = (db
      .prepare(
        `SELECT model, billing_provider AS provider, ${TOTALS_SQL}
         FROM session_model_usage WHERE last_seen >= ?1
         GROUP BY model, billing_provider ORDER BY calls DESC`,
      )
      .all(since) as RawRow[]).map(modelRow);

    const daily = (db
      .prepare(
        `SELECT date(last_seen, 'unixepoch', 'localtime') AS day, ${TOTALS_SQL}
         FROM session_model_usage WHERE last_seen >= ?1
         GROUP BY day ORDER BY day DESC`,
      )
      .all(since) as RawRow[]).map((raw) => ({
        day: String(raw.day ?? ''),
        calls: n(raw.calls),
        totalTokens: modelRow(raw).totalTokens,
      }));

    const head = (db
      .prepare(
        `SELECT count(DISTINCT session_id) AS sessions, min(first_seen) AS first_seen, max(last_seen) AS last_seen
         FROM session_model_usage`,
      )
      .all() as Array<{ sessions?: unknown; first_seen?: unknown; last_seen?: unknown }>)[0] ?? {};

    const total = models.length === 0
      ? null
      : models.reduce<HermesModelRow>(
          (acc, row) => ({
            model: '',
            provider: '',
            calls: acc.calls + row.calls,
            inputTokens: acc.inputTokens + row.inputTokens,
            outputTokens: acc.outputTokens + row.outputTokens,
            cacheReadTokens: acc.cacheReadTokens + row.cacheReadTokens,
            cacheWriteTokens: acc.cacheWriteTokens + row.cacheWriteTokens,
            reasoningTokens: acc.reasoningTokens + row.reasoningTokens,
            totalTokens: acc.totalTokens + row.totalTokens,
            costUsd: acc.costUsd + row.costUsd,
          }),
          {
            model: '',
            provider: '',
            calls: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            totalTokens: 0,
            costUsd: 0,
          },
        );

    cleanup();
    db.close();
    return {
      available: true,
      reason: null,
      dbPath,
      via: 'sqlite',
      days,
      models,
      daily,
      total,
      sessions: n(head.sessions),
      firstSeen: n(head.first_seen) || null,
      lastSeen: n(head.last_seen) || null,
    };
  } catch (err) {
    opened.cleanup();
    const message = err instanceof Error ? err.message : String(err);
    return emptyUsage(message.slice(0, 200), dbPath, days);
  }
}

/**
 * 逃生通道：Hermes 这边用导出脚本写的 JSON 快照，形状就是上面 `HermesUsage` 的子集。
 * 只在 sqlite 读不到时看它。
 */
async function readExport(home: string, days: number): Promise<HermesUsage | null> {
  const file = join(home, 'quota-usage.json');
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<HermesUsage> & { generatedAt?: number };
    if (!Array.isArray(raw.models)) return null;
    const models = raw.models.map((row) => modelRow(row as RawRow));
    return {
      available: true,
      reason: null,
      dbPath: file,
      via: 'export',
      days,
      models,
      daily: Array.isArray(raw.daily)
        ? (raw.daily as unknown as Array<Record<string, unknown>>).map((row) => ({
            day: String(row.day ?? ''),
            calls: n(row.calls),
            totalTokens: n(field(row, 'total_tokens', 'totalTokens')),
          }))
        : [],
      total: models.reduce<HermesModelRow | null>(
        (acc, row) =>
          acc === null
            ? row
            : {
                model: '',
                provider: '',
                calls: acc.calls + row.calls,
                inputTokens: acc.inputTokens + row.inputTokens,
                outputTokens: acc.outputTokens + row.outputTokens,
                cacheReadTokens: acc.cacheReadTokens + row.cacheReadTokens,
                cacheWriteTokens: acc.cacheWriteTokens + row.cacheWriteTokens,
                reasoningTokens: acc.reasoningTokens + row.reasoningTokens,
                totalTokens: acc.totalTokens + row.totalTokens,
                costUsd: acc.costUsd + row.costUsd,
              },
        null,
      ),
      sessions: n(raw.sessions),
      firstSeen: raw.firstSeen ?? null,
      lastSeen: raw.lastSeen ?? null,
    };
  } catch {
    return null;
  }
}
