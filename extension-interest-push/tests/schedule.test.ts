import { describe, expect, it } from 'vitest';
import { decide, type ScheduleConfig, type ScheduleState } from '../src/schedule.ts';

/** 基准配置：2026-10-19 是周一（ISO 1）。 */
function baseConfig(patch: Partial<ScheduleConfig> = {}): ScheduleConfig {
  return {
    checkMinutes: 30,
    pushTimes: ['10:30', '13:00', '19:30'],
    dailyCap: 2,
    quiet: ['22:30', '08:30'],
    pushDays: [1, 2, 3, 4, 5, 6, 7],
    maxRounds: 3,
    pausedUntil: 0,
    ...patch,
  };
}

/** 2026-10-19（周一）本地时刻。 */
function at(hour: number, minute: number): Date {
  return new Date(2026, 9, 19, hour, minute, 0, 0);
}

function state(patch: Partial<ScheduleState> = {}): ScheduleState {
  return { pushedToday: 0, lastWindowKey: null, ...patch };
}

describe('decide', () => {
  it('窗口内首推：放行 ok', () => {
    expect(decide(baseConfig(), at(10, 30), state())).toEqual({
      check: true,
      push: true,
      windowKey: '2026-10-19T10:30',
      reason: 'ok',
    });
  });

  it('同一窗口第二次：window-used，仍返回 windowKey', () => {
    expect(decide(baseConfig(), at(10, 32), state({ lastWindowKey: '2026-10-19T10:30' }))).toEqual({
      check: true,
      push: false,
      windowKey: '2026-10-19T10:30',
      reason: 'window-used',
    });
  });

  it('窗口外：outside-window，windowKey 为 null', () => {
    expect(decide(baseConfig(), at(10, 40), state())).toEqual({
      check: true,
      push: false,
      windowKey: null,
      reason: 'outside-window',
    });
  });

  it('窗口边界：命中 5 分钟内，第 5 分钟起算窗口外', () => {
    expect(decide(baseConfig(), at(10, 34), state()).reason).toBe('ok');
    expect(decide(baseConfig(), at(10, 35), state()).reason).toBe('outside-window');
  });

  it('静默时段（跨午夜）：quiet', () => {
    const cfg = baseConfig({ pushTimes: ['23:30'] });
    expect(decide(cfg, at(23, 30), state())).toEqual({
      check: true,
      push: false,
      windowKey: '2026-10-19T23:30',
      reason: 'quiet',
    });
  });

  it('非推送日：day-off', () => {
    const cfg = baseConfig({ pushDays: [2, 3] });
    expect(decide(cfg, at(10, 30), state())).toEqual({
      check: true,
      push: false,
      windowKey: '2026-10-19T10:30',
      reason: 'day-off',
    });
  });

  it('达到每日上限：daily-cap', () => {
    expect(decide(baseConfig(), at(10, 30), state({ pushedToday: 2 }))).toEqual({
      check: true,
      push: false,
      windowKey: '2026-10-19T10:30',
      reason: 'daily-cap',
    });
  });

  it('暂停中：paused，check 为 false', () => {
    const now = at(10, 30);
    const cfg = baseConfig({ pausedUntil: now.getTime() + 60_000 });
    expect(decide(cfg, now, state())).toEqual({
      check: false,
      push: false,
      windowKey: null,
      reason: 'paused',
    });
  });

  it('暂停已过期不影响放行', () => {
    const now = at(10, 30);
    const cfg = baseConfig({ pausedUntil: now.getTime() - 1 });
    expect(decide(cfg, now, state()).reason).toBe('ok');
  });

  it('非法 pushTimes / quiet 值被忽略，不抛错', () => {
    const cfg = baseConfig({ pushTimes: ['bad', '25:00', '10:30', ''] , quiet: ['oops'] });
    const d = decide(cfg, at(10, 30), state());
    expect(d.reason).toBe('ok');
    expect(d.windowKey).toBe('2026-10-19T10:30');
  });

  it('check 仅在暂停时为 false，其余分支均为 true', () => {
    expect(decide(baseConfig(), at(10, 40), state()).check).toBe(true);
    expect(decide(baseConfig(), at(10, 30), state({ pushedToday: 5 })).check).toBe(true);
    expect(decide(baseConfig({ pushDays: [] }), at(10, 30), state()).check).toBe(true);
  });
});
