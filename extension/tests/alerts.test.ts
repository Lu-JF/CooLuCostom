import { describe, expect, it } from 'vitest';
import { anyExhausted, busiestPercent, evaluateAlerts } from '../src/alerts.ts';
import { parseQuota } from '../src/commandcode.ts';

const base = (five: { used: number; cap: number; resetAt?: number }, weekly?: { used: number; cap: number; resetAt?: number }, credits = 50) =>
  parseQuota(
    {
      credits: { monthlyCredits: credits },
      windowLimits: {
        fiveHour: { used: five.used, cap: five.cap, exceeded: five.used >= five.cap, resetAt: five.resetAt ?? 1_000_000_000_000 },
        ...(weekly ? { weekly: { used: weekly.used, cap: weekly.cap, exceeded: weekly.used >= weekly.cap, resetAt: weekly.resetAt ?? 2_000_000_000_000 } } : {}),
      },
    },
    { data: { planId: 'individual-goat', status: 'active', currentPeriodEnd: '2026-10-16T07:45:21.000Z' } },
    null,
    { baseUrl: 'https://api.commandcode.ai', keySource: 'env', monthlyAllowanceUsd: 0 },
  );

describe('evaluateAlerts', () => {
  it('越过阈值报一次，之后不再重复', () => {
    const fired = new Set<string>();
    const quota = base({ used: 13, cap: 14 });
    const first = evaluateAlerts(quota, { thresholdPercent: 80, fired });
    expect(first.map((a) => `${a.window}:${a.kind}`)).toEqual(['fiveHour:threshold']);
    expect(evaluateAlerts(quota, { thresholdPercent: 80, fired })).toEqual([]);
  });

  it('没到阈值就不报', () => {
    expect(evaluateAlerts(base({ used: 1, cap: 14 }, { used: 5.78, cap: 35 }), { thresholdPercent: 80, fired: new Set() })).toEqual([]);
  });

  it('窗口打满时按「用完」报，而不是「到阈值」', () => {
    const fired = new Set<string>();
    const alerts = evaluateAlerts(base({ used: 14, cap: 14 }), { thresholdPercent: 80, fired });
    expect(alerts.map((a) => a.kind)).toEqual(['exhausted']);
  });

  it('窗口重置后（重置时刻换了）可以再报一次', () => {
    const fired = new Set<string>();
    expect(evaluateAlerts(base({ used: 13, cap: 14, resetAt: 1_790_000_000_000 }), { thresholdPercent: 80, fired }).length).toBe(1);
    expect(evaluateAlerts(base({ used: 13, cap: 14, resetAt: 1_790_100_000_000 }), { thresholdPercent: 80, fired }).length).toBe(1);
    expect(fired.size).toBe(2);
  });

  it('阈值 0 或没取到数时不报', () => {
    expect(evaluateAlerts(base({ used: 14, cap: 14 }), { thresholdPercent: 0, fired: new Set() })).toEqual([]);
    const failed = { ...base({ used: 1, cap: 14 }), ok: false };
    expect(evaluateAlerts(failed, { thresholdPercent: 80, fired: new Set() })).toEqual([]);
  });

  it('月度额度按已用比例报，剩余为零时报用完', () => {
    const fired = new Set<string>();
    const spent = evaluateAlerts(base({ used: 1, cap: 14 }, undefined, 10), { thresholdPercent: 80, fired });
    expect(spent.map((a) => `${a.window}:${a.kind}`)).toEqual(['monthly:threshold']);
    const empty = evaluateAlerts(base({ used: 1, cap: 14 }, undefined, 0), { thresholdPercent: 80, fired: new Set() });
    expect(empty.map((a) => `${a.window}:${a.kind}`)).toEqual(['monthly:exhausted']);
  });
});

describe('最紧的窗口', () => {
  it('取三个读数里最大的百分比', () => {
    expect(busiestPercent(base({ used: 7, cap: 14 }, { used: 35, cap: 35 }))).toBe(100);
    expect(anyExhausted(base({ used: 7, cap: 14 }, { used: 35, cap: 35 }))).toBe(true);
    expect(anyExhausted(base({ used: 7, cap: 14 }, { used: 5, cap: 35 }))).toBe(false);
  });
});
