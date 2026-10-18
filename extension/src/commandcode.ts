/**
 * Command Code 的套餐额度。三个接口都是 CLI 自己用的内部接口，没有公开文档：
 *
 *   GET /alpha/billing/credits        月度额度余额 + 5 小时、每周两个滚动窗口
 *   GET /alpha/billing/subscriptions  套餐 id、状态、计费周期
 *   GET /alpha/whoami                 账号
 *
 * 所以解析一律容错：字段改名只是少一个数，不是崩。密钥来源依次是扩展配置、环境变量、
 * 命令行登录文件、.env 文件，与 CLI 自己的顺序一致（CLI 只认前两个和一个 login 文件）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { KeySourceKind } from './view-types.ts';

export interface CommandCodeWindow {
  used: number;
  cap: number;
  exceeded: boolean;
  /** 重置时刻（epoch 毫秒）。服务器给秒或毫秒都认。 */
  resetAt: number | null;
  /** used / cap，0–100。cap 为 0 时为 null。 */
  usedPercent: number | null;
}

export interface CommandCodeQuota {
  ok: boolean;
  /** 取不到时的原因（界面语言无关的英文短句，面板按语言换成自己的话）。 */
  reason: string | null;
  keySource: KeySourceKind;
  baseUrl: string;
  account: string | null;
  planId: string | null;
  planLabel: string | null;
  planStatus: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  /** 套餐剩余额度（美元）。 */
  monthlyCredits: number | null;
  purchasedCredits: number | null;
  freeCredits: number | null;
  /** 这个套餐每月有多少额度；未知为 null。 */
  monthlyAllowance: number | null;
  /** 本月已用百分比；额度未知时为 null。 */
  monthlyUsedPercent: number | null;
  fiveHour: CommandCodeWindow | null;
  weekly: CommandCodeWindow | null;
  fetchedAt: number;
}

export interface KeyResolutionOptions {
  configKey?: string;
  envFile?: string;
  authFile?: string;
  env?: Record<string, string | undefined>;
}

export interface ResolvedKey {
  key: string | null;
  source: KeySourceKind;
  /** 试过哪些位置，取不到时给使用者看。 */
  detail: string;
}

const ENV_NAMES = ['COMMAND_CODE_API_KEY', 'COMMANDCODE_API_KEY', 'COMMAND_CODE_KEY'] as const;

export function defaultAuthFile(): string {
  return join(homedir(), '.commandcode', 'auth.json');
}

/** 读一个 KEY=value 文件；不展开变量，不执行任何东西。 */
export function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value !== '') out[m[1]!] = value;
  }
  return out;
}

export function resolveKey(opts: KeyResolutionOptions): ResolvedKey {
  const tried: string[] = [];
  const configKey = opts.configKey?.trim();
  if (configKey) return { key: configKey, source: 'config', detail: 'config' };

  const env = opts.env ?? (typeof process === 'undefined' ? {} : process.env);
  for (const name of ENV_NAMES) {
    const value = env[name]?.trim();
    if (value) return { key: value, source: 'env', detail: name };
    tried.push(name);
  }

  const authFile = opts.authFile?.trim() || defaultAuthFile();
  if (existsSync(authFile)) {
    try {
      const parsed = JSON.parse(readFileSync(authFile, 'utf8')) as { apiKey?: unknown };
      const value = typeof parsed?.apiKey === 'string' ? parsed.apiKey.trim() : '';
      if (value) return { key: value, source: 'authFile', detail: authFile };
    } catch {
      /* 文件坏了就往下试 */
    }
    tried.push(authFile);
  }

  const envFile = opts.envFile?.trim();
  if (envFile && existsSync(envFile)) {
    const fromFile = readEnvFile(envFile);
    for (const name of ENV_NAMES) {
      const value = fromFile[name]?.trim();
      if (value) return { key: value, source: 'envFile', detail: `${envFile} :: ${name}` };
    }
    tried.push(envFile);
  }

  return { key: null, source: 'none', detail: tried.join(' | ') || 'no source declared' };
}

/** 套餐 id → 界面上的名字。未知 id 返回 null，面板就写原始 id。 */
const PLAN_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['individual-provider', 'Provider'],
  ['individual-goat', 'GOAT'],
  ['individual-go', 'Go'],
  ['individual-pro-v1', 'Pro'],
  ['individual-pro', 'Pro'],
  ['individual-max', 'Max'],
  ['individual-ultra', 'Ultra'],
  ['teams-pro', 'Team Pro'],
];

export function planLabelOf(planId: string | null): string | null {
  if (!planId) return null;
  const id = planId.trim().toLowerCase().replace(/_/g, '-');
  for (const [prefix, label] of PLAN_LABELS) {
    if (id.startsWith(prefix)) return label;
  }
  return null;
}

/**
 * 各套餐每月的额度（美元），取自 commandcode.ai 的套餐页与「Usage Limits」文档。
 * 只用于算「本月用了多少百分比」；套餐表变了就少一个百分比，不影响其余读数。
 */
const PLAN_ALLOWANCE: Readonly<Record<string, number>> = {
  Go: 10,
  GOAT: 70,
  Pro: 80,
  'Max 10x': 150,
  'Max 20x': 300,
  'Team Pro': 40,
};

export function monthlyAllowanceOf(planId: string | null): number | null {
  const label = planLabelOf(planId);
  if (!label) return null;
  const key = Object.keys(PLAN_ALLOWANCE).find((k) => k.toLowerCase().startsWith(label.toLowerCase()));
  return key ? PLAN_ALLOWANCE[key]! : null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim());
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** 秒或毫秒都认；都在 2001 年之后、2100 年之前才要。 */
export function normalizeResetAt(value: unknown): number | null {
  const n = num(value);
  if (n !== null) {
    const ms = n > 10_000_000_000 ? n : n * 1000;
    if (ms > 978_307_200_000 && ms < 4_102_444_800_000) return Math.round(ms);
  }
  const text = str(value);
  if (text) {
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function windowOf(raw: unknown): CommandCodeWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as Record<string, unknown>;
  const used = num(w.used ?? w.usedUsd);
  const cap = num(w.cap ?? w.total ?? w.limit);
  if (used === null || cap === null || cap <= 0 || used < 0) return null;
  return {
    used,
    cap,
    exceeded: w.exceeded === true || used >= cap,
    resetAt: normalizeResetAt(w.resetAt ?? w.reset_at ?? w.reset),
    usedPercent: Math.min(100, Math.max(0, (used / cap) * 100)),
  };
}

/** 把两个接口的响应拼成一份读数；字段缺就留 null。 */
export function parseQuota(
  creditsRaw: unknown,
  subscriptionRaw: unknown,
  whoamiRaw: unknown,
  opts: { baseUrl: string; keySource: KeySourceKind; monthlyAllowanceUsd: number; now?: number },
): CommandCodeQuota {
  const credits = (creditsRaw ?? {}) as Record<string, any>;
  const balance = (credits.credits ?? {}) as Record<string, unknown>;
  const limits = (credits.windowLimits ?? {}) as Record<string, unknown>;
  const sub = ((subscriptionRaw as any)?.data ?? {}) as Record<string, unknown>;
  const user = ((whoamiRaw as any)?.user ?? {}) as Record<string, unknown>;

  const planId = str(sub.planId);
  const monthlyCredits = num(balance.monthlyCredits);
  const allowance = opts.monthlyAllowanceUsd > 0
    ? opts.monthlyAllowanceUsd
    : monthlyAllowanceOf(planId);
  const spent = allowance !== null && monthlyCredits !== null ? Math.max(0, allowance - monthlyCredits) : null;
  const monthlyUsedPercent = allowance !== null && allowance > 0 && spent !== null
    ? Math.min(100, (spent / allowance) * 100)
    : null;

  return {
    ok: true,
    reason: null,
    keySource: opts.keySource,
    baseUrl: opts.baseUrl,
    account: str(user.email) ?? str(user.userName) ?? str(user.name),
    planId,
    planLabel: planLabelOf(planId),
    planStatus: str(sub.status),
    periodStart: str(sub.currentPeriodStart),
    periodEnd: str(sub.currentPeriodEnd),
    monthlyCredits,
    purchasedCredits: num(balance.purchasedCredits),
    freeCredits: num(balance.freeCredits),
    monthlyAllowance: allowance,
    monthlyUsedPercent,
    fiveHour: windowOf(limits.fiveHour ?? limits.five_hour),
    weekly: windowOf(limits.weekly),
    fetchedAt: opts.now ?? Date.now(),
  };
}

export function emptyQuota(reason: string, opts: { baseUrl: string; keySource: KeySourceKind; now?: number }): CommandCodeQuota {
  return {
    ok: false,
    reason,
    keySource: opts.keySource,
    baseUrl: opts.baseUrl,
    account: null,
    planId: null,
    planLabel: null,
    planStatus: null,
    periodStart: null,
    periodEnd: null,
    monthlyCredits: null,
    purchasedCredits: null,
    freeCredits: null,
    monthlyAllowance: null,
    monthlyUsedPercent: null,
    fiveHour: null,
    weekly: null,
    fetchedAt: opts.now ?? Date.now(),
  };
}

export interface FetchQuotaOptions {
  baseUrl: string;
  key: string;
  keySource: KeySourceKind;
  monthlyAllowanceUsd: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

async function getJson(url: string, key: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<{ status: number; body: unknown }> {
  const res = await fetchImpl(url, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text.slice(0, 400);
  }
  return { status: res.status, body };
}

/** 取一次额度。网络、鉴权、解析任何一种失败都回来一份带 reason 的读数。 */
export async function fetchQuota(opts: FetchQuotaOptions): Promise<CommandCodeQuota> {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const head = { baseUrl: base, keySource: opts.keySource };
  try {
    const credits = await getJson(`${base}/alpha/billing/credits`, opts.key, fetchImpl, timeoutMs);
    if (credits.status === 401 || credits.status === 403) return emptyQuota('command code rejected the key', head);
    if (credits.status < 200 || credits.status >= 300) return emptyQuota(`credits returned HTTP ${credits.status}`, head);
    const [sub, who] = await Promise.all([
      getJson(`${base}/alpha/billing/subscriptions`, opts.key, fetchImpl, timeoutMs).catch(() => ({ status: 0, body: null })),
      getJson(`${base}/alpha/whoami`, opts.key, fetchImpl, timeoutMs).catch(() => ({ status: 0, body: null })),
    ]);
    return parseQuota(credits.body, sub.body, who.body, {
      baseUrl: base,
      keySource: opts.keySource,
      monthlyAllowanceUsd: opts.monthlyAllowanceUsd,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return emptyQuota(message.slice(0, 200), head);
  }
}
