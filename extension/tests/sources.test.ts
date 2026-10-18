import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMMANDCODE_SOURCE, SOURCES, sourceById } from '../src/sources.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('供应商登记表', () => {
  it('只有 Command Code 有实现，其余都是带说明的接缝', () => {
    expect(SOURCES[0]?.id).toBe('commandcode');
    expect(COMMANDCODE_SOURCE.implemented).toBe(true);
    expect(COMMANDCODE_SOURCE.defaultBaseUrl).toBe('https://api.commandcode.ai');

    const others = SOURCES.filter((s) => s.id !== 'commandcode');
    expect(others.length).toBeGreaterThanOrEqual(6);
    for (const source of others) {
      expect(source.implemented).toBe(false);
      // 未实现的家必须写清「要什么」与「将来从哪儿查」，否则界面没东西可说
      expect(source.needs.length).toBeGreaterThan(0);
      expect(source.plan.length).toBeGreaterThan(0);
      expect(source.fetchQuota).toBeUndefined();
      expect(source.fetchModels).toBeUndefined();
    }
  });

  it('供应商 id 不重复，查得到也查得空', () => {
    const ids = SOURCES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(sourceById('commandcode')?.label).toBe('Command Code');
    expect(sourceById('nope')).toBeNull();
  });

  it('Command Code 的取数就调它那几个端点，并把模型清单归一化', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = String(input);
        seen.push(url);
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer k');
        const body = url.includes('/models')
          ? { data: [{ id: 'vendor/model-1', name: 'Model 1', context_length: 200_000, supported_endpoints: ['/chat/completions'] }, { id: 'vendor/odd' }] }
          : url.includes('/subscriptions')
            ? { success: true, data: { planId: 'individual-goat' } }
            : url.includes('/whoami')
              ? { user: { email: 'a@b.c' } }
              : { credits: { monthlyCredits: 1 }, windowLimits: { fiveHour: { used: 1, cap: 2 } } };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as unknown as typeof fetch,
    );

    const quota = await COMMANDCODE_SOURCE.fetchQuota!({
      baseUrl: COMMANDCODE_SOURCE.defaultBaseUrl,
      key: 'k',
      keySource: 'account',
      monthlyAllowanceUsd: 70,
    });
    expect(quota.ok).toBe(true);
    expect(quota.planId).toBe('individual-goat');
    expect(quota.monthlyCredits).toBe(1);
    expect(quota.fiveHour?.cap).toBe(2);

    const models = await COMMANDCODE_SOURCE.fetchModels!({ baseUrl: COMMANDCODE_SOURCE.defaultBaseUrl, key: 'k' });
    expect(models.map((m) => m.id)).toEqual(['vendor/model-1', 'vendor/odd']);
    expect(models[0]?.contextLength).toBe(200_000);
    expect(models[1]?.contextLength).toBeNull();
    expect(seen.every((u) => u.startsWith('https://api.commandcode.ai/'))).toBe(true);
  });
});
