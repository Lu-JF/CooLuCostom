import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readHermesUsage, resolveHermesHome } from '../src/hermes.ts';

/** `node:sqlite` 经 createRequire 拿：静态 import 它会让 vitest 的转译去解析一个叫 `sqlite` 的包。 */
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const DAY = 86_400;

/** 建一个与 Hermes 同形状的库；只列这个扩展读到的列。 */
function makeDb(rows: Array<Partial<Record<string, unknown>>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'quota-hermes-'));
  dirs.push(dir);
  const db = new DatabaseSync(join(dir, 'state.db'));
  db.exec(`
    CREATE TABLE session_model_usage (
      session_id TEXT NOT NULL,
      model TEXT NOT NULL,
      billing_provider TEXT DEFAULT '',
      billing_base_url TEXT DEFAULT '',
      billing_mode TEXT DEFAULT '',
      task TEXT DEFAULT '',
      api_call_count INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      estimated_cost_usd REAL DEFAULT 0,
      actual_cost_usd REAL DEFAULT 0,
      cost_status TEXT,
      cost_source TEXT,
      first_seen REAL NOT NULL,
      last_seen REAL NOT NULL,
      PRIMARY KEY (session_id, model, billing_provider, billing_base_url, task)
    )`);
  const insert = db.prepare(
    `INSERT INTO session_model_usage
       (session_id, model, billing_provider, task, api_call_count, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_cost_usd, actual_cost_usd, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(
      String(row.session_id ?? 's1'),
      String(row.model ?? 'deepseek-v4.1-flash'),
      String(row.billing_provider ?? 'commandcode'),
      String(row.task ?? ''),
      Number(row.api_call_count ?? 1),
      Number(row.input_tokens ?? 0),
      Number(row.output_tokens ?? 0),
      Number(row.cache_read_tokens ?? 0),
      Number(row.cache_write_tokens ?? 0),
      Number(row.reasoning_tokens ?? 0),
      Number(row.estimated_cost_usd ?? 0),
      Number(row.actual_cost_usd ?? 0),
      Number(row.first_seen ?? 0),
      Number(row.last_seen ?? 0),
    );
  }
  db.close();
  return dir;
}

describe('resolveHermesHome', () => {
  it('配置 > HERMES_HOME > %LOCALAPPDATA%\\hermes', () => {
    expect(resolveHermesHome('D:\\h', { LOCALAPPDATA: 'C:\\x' })).toBe('D:\\h');
    expect(resolveHermesHome('', { HERMES_HOME: 'E:\\hh', LOCALAPPDATA: 'C:\\x' })).toBe('E:\\hh');
    expect(resolveHermesHome('', { LOCALAPPDATA: 'C:\\x' })).toBe(join('C:\\x', 'hermes'));
  });
});

describe('readHermesUsage', () => {
  const now = Math.floor(Date.now() / 1000);

  it('按模型和端点分组求和，只算窗口内的行', async () => {
    const home = makeDb([
      { model: 'deepseek-v4.1-flash', session_id: 's1', api_call_count: 470, input_tokens: 2_095_056, output_tokens: 635_109, cache_read_tokens: 93_253_248, reasoning_tokens: 355_914, last_seen: now - DAY },
      { model: 'deepseek-v4.1-flash', session_id: 's2', api_call_count: 30, input_tokens: 1_000, output_tokens: 500, last_seen: now - 2 * DAY },
      { model: 'gemini-3.8-flash', session_id: 's3', billing_provider: 'opencode-go', api_call_count: 5, input_tokens: 100, output_tokens: 50, last_seen: now - 3 * DAY },
      { model: 'old-model', session_id: 's4', api_call_count: 9, input_tokens: 9, last_seen: now - 40 * DAY },
    ]);
    const usage = await readHermesUsage({ home, days: 7 });
    expect(usage.available).toBe(true);
    expect(usage.via).toBe('sqlite');
    expect(usage.models.map((m) => `${m.provider}/${m.model}`)).toEqual([
      'commandcode/deepseek-v4.1-flash',
      'opencode-go/gemini-3.8-flash',
    ]);
    const first = usage.models[0]!;
    expect(first.calls).toBe(500);
    expect(first.inputTokens).toBe(2_096_056);
    expect(first.outputTokens).toBe(635_609);
    expect(first.totalTokens).toBe(
      first.inputTokens + first.outputTokens + first.cacheReadTokens + first.cacheWriteTokens + first.reasoningTokens,
    );
    expect(usage.total?.calls).toBe(505);
    expect(usage.total?.totalTokens).toBe(usage.models.reduce((sum, row) => sum + row.totalTokens, 0));
    expect(usage.daily.length).toBe(3);
    expect(usage.sessions).toBe(4);
    // 窗口外的行不进模型表，但会话总数是整库的
    expect(usage.models.some((m) => m.model === 'old-model')).toBe(false);
  });

  it('库不在时报不可用，并保留路径', async () => {
    const home = mkdtempSync(join(tmpdir(), 'quota-hermes-empty-'));
    dirs.push(home);
    const usage = await readHermesUsage({ home, days: 7 });
    expect(usage.available).toBe(false);
    expect(usage.reason).toContain('no state.db');
    expect(usage.dbPath).toBe(join(home, 'state.db'));
  });

  it('读不到 sqlite 时退回导出文件', async () => {
    const home = mkdtempSync(join(tmpdir(), 'quota-hermes-export-'));
    dirs.push(home);
    writeFileSync(
      join(home, 'quota-usage.json'),
      JSON.stringify({
        models: [{ model: 'm', provider: 'commandcode', calls: 3, inputTokens: 10, outputTokens: 5 }],
        daily: [{ day: '2026-10-13', calls: 3, totalTokens: 15 }],
        sessions: 1,
        lastSeen: now,
      }),
    );
    const usage = await readHermesUsage({ home, days: 7 });
    expect(usage.available).toBe(true);
    expect(usage.via).toBe('export');
    expect(usage.models[0]?.calls).toBe(3);
    expect(usage.total?.totalTokens).toBe(15);
  });
});
