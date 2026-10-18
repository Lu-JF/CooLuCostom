import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fetchQuota,
  monthlyAllowanceOf,
  normalizeResetAt,
  parseQuota,
  planLabelOf,
  readEnvFile,
  resolveKey,
} from '../src/commandcode.ts';

/** 线上抓到的 5 小时窗口重置时刻：2026-10-13 21:44:10 (UTC+8) = 13:44:10Z。 */
const RESET_MS = 1791899050632;

const creditsBody = {
  credits: { belowThreshold: false, creditThreshold: 0, monthlyCredits: 54.6638050623, purchasedCredits: 0, freeCredits: 0 },
  windowLimits: {
    limited: true,
    exceeded: null,
    fiveHour: { used: 1.098582471, cap: 14, exceeded: false, resetAt: RESET_MS },
    weekly: { used: 5.778933055, cap: 35, exceeded: false, resetAt: 1792135838349 },
  },
  sandboxAccess: true,
};

const subscriptionBody = {
  success: true,
  data: {
    id: 'sub_x',
    status: 'active',
    planId: 'individual-goat',
    currentPeriodStart: '2026-09-16T07:45:21.000Z',
    currentPeriodEnd: '2026-10-16T07:45:21.000Z',
  },
};

const whoamiBody = { success: true, user: { id: 'u1', name: 'tester', email: 'test@gmail.com' }, org: null };

describe('parseQuota', () => {
  it('把三个响应拼成一份读数：窗口百分比、月度剩余与已用、套餐', () => {
    const q = parseQuota(creditsBody, subscriptionBody, whoamiBody, {
      baseUrl: 'https://api.commandcode.ai',
      keySource: 'envFile',
      monthlyAllowanceUsd: 0,
    });
    expect(q.ok).toBe(true);
    expect(q.account).toBe('test@gmail.com');
    expect(q.planLabel).toBe('GOAT');
    expect(q.monthlyCredits).toBeCloseTo(54.6638, 3);
    expect(q.monthlyAllowance).toBe(70);
    expect(q.monthlyUsedPercent).toBeCloseTo((70 - 54.6638050623) / 70 * 100, 3);
    expect(q.fiveHour?.usedPercent).toBeCloseTo(1.098582471 / 14 * 100, 3);
    expect(q.fiveHour?.resetAt).toBe(RESET_MS);
    expect(q.weekly?.cap).toBe(35);
    expect(q.periodEnd).toBe('2026-10-16T07:45:21.000Z');
  });

  it('字段缺、类型怪都只是少一个数，不当错误', () => {
    const q = parseQuota({ windowLimits: { fiveHour: { used: 'nope', cap: 14 } } }, null, null, {
      baseUrl: 'https://api.commandcode.ai',
      keySource: 'none',
      monthlyAllowanceUsd: 0,
    });
    expect(q.ok).toBe(true);
    expect(q.fiveHour).toBeNull();
    expect(q.monthlyCredits).toBeNull();
    expect(q.monthlyUsedPercent).toBeNull();
    expect(q.planLabel).toBeNull();
  });

  it('配置里写了月度额度就以它为准', () => {
    const q = parseQuota(creditsBody, subscriptionBody, whoamiBody, {
      baseUrl: 'https://api.commandcode.ai',
      keySource: 'config',
      monthlyAllowanceUsd: 100,
    });
    expect(q.monthlyAllowance).toBe(100);
    expect(q.monthlyUsedPercent).toBeCloseTo(45.336, 2);
  });
});

describe('套餐名与月度额度', () => {
  it('按前缀认套餐，认不出就返回 null', () => {
    expect(planLabelOf('individual-goat')).toBe('GOAT');
    expect(planLabelOf('individual-pro-v1')).toBe('Pro');
    expect(planLabelOf('teams-pro')).toBe('Team Pro');
    expect(planLabelOf('something-else')).toBeNull();
    expect(planLabelOf(null)).toBeNull();
  });

  it('公开了额度的套餐给出数字，没有的返回 null', () => {
    expect(monthlyAllowanceOf('individual-goat')).toBe(70);
    expect(monthlyAllowanceOf('individual-provider')).toBeNull();
  });
});

describe('重置时刻', () => {
  it('秒、毫秒与 ISO 都认', () => {
    expect(normalizeResetAt(1791899050)).toBe(1791899050000);
    expect(normalizeResetAt(RESET_MS)).toBe(RESET_MS);
    expect(normalizeResetAt('2026-10-13T13:44:10.632Z')).toBe(RESET_MS);
    expect(normalizeResetAt('')).toBeNull();
    expect(normalizeResetAt(0)).toBeNull();
  });
});

describe('密钥来源', () => {
  const env = { COMMANDCODE_API_KEY: 'from-env', COMMAND_CODE_API_KEY: '' };

  it('配置里的密钥优先', () => {
    expect(resolveKey({ configKey: ' from-config ', env }).source).toBe('config');
    expect(resolveKey({ configKey: 'from-config', env }).key).toBe('from-config');
  });

  it('其次环境变量（CLI 的名字排在前面）', () => {
    const resolved = resolveKey({ env: { COMMAND_CODE_API_KEY: 'cli-name', COMMANDCODE_API_KEY: 'hermes-name' } });
    expect(resolved.key).toBe('cli-name');
    expect(resolved.source).toBe('env');
  });

  it('再次命令行登录文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'quota-key-'));
    const authFile = join(dir, 'auth.json');
    writeFileSync(authFile, JSON.stringify({ apiKey: 'from-auth-file' }));
    const resolved = resolveKey({ env: {}, authFile });
    expect(resolved).toEqual({ key: 'from-auth-file', source: 'authFile', detail: authFile });
  });

  it('最后是 .env 文件，认引号与 export', () => {
    const dir = mkdtempSync(join(tmpdir(), 'quota-env-'));
    const envFile = join(dir, '.env');
    writeFileSync(envFile, 'OTHER=1\nexport COMMANDCODE_API_KEY="from-dotenv"\n');
    const parsed = readEnvFile(envFile);
    expect(parsed.COMMANDCODE_API_KEY).toBe('from-dotenv');
    const resolved = resolveKey({ env: {}, envFile });
    expect(resolved.key).toBe('from-dotenv');
    expect(resolved.source).toBe('envFile');
  });

  it('哪儿都没有时返回 none 并记下试过哪些位置', () => {
    const dir = mkdtempSync(join(tmpdir(), 'quota-none-'));
    const resolved = resolveKey({ env: {}, authFile: join(dir, 'missing.json') });
    expect(resolved.key).toBeNull();
    expect(resolved.source).toBe('none');
    expect(resolved.detail).toContain('COMMAND_CODE_API_KEY');
  });
});

describe('fetchQuota', () => {
  const stub = (responses: Record<string, { status: number; body: unknown }>): typeof fetch =>
    (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      const hit = Object.entries(responses).find(([path]) => url.endsWith(path));
      if (!hit) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(hit[1].body), { status: hit[1].status, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

  it('成功后给出读数，并保留密钥来源', async () => {
    const quota = await fetchQuota({
      baseUrl: 'https://api.commandcode.ai',
      key: 'k',
      keySource: 'env',
      monthlyAllowanceUsd: 0,
      fetchImpl: stub({
        '/alpha/billing/credits': { status: 200, body: creditsBody },
        '/alpha/billing/subscriptions': { status: 200, body: subscriptionBody },
        '/alpha/whoami': { status: 200, body: whoamiBody },
      }),
    });
    expect(quota.ok).toBe(true);
    expect(quota.keySource).toBe('env');
    expect(quota.planLabel).toBe('GOAT');
  });

  it('401 说出来是密钥的问题', async () => {
    const quota = await fetchQuota({
      baseUrl: 'https://api.commandcode.ai',
      key: 'bad',
      keySource: 'config',
      monthlyAllowanceUsd: 0,
      fetchImpl: stub({ '/alpha/billing/credits': { status: 401, body: { success: false } } }),
    });
    expect(quota.ok).toBe(false);
    expect(quota.reason).toContain('rejected the key');
    expect(quota.fiveHour).toBeNull();
  });

  it('网络断了也只是读数带原因', async () => {
    const quota = await fetchQuota({
      baseUrl: 'https://api.commandcode.ai',
      key: 'k',
      keySource: 'env',
      monthlyAllowanceUsd: 0,
      fetchImpl: (async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      }) as unknown as typeof fetch,
    });
    expect(quota.ok).toBe(false);
    expect(quota.reason).toContain('ENOTFOUND');
  });
});
