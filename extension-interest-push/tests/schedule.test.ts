import { describe, expect, it } from 'vitest';
import { decideFixed, decideRandom, nextWindowAt, randomNextAt, type ScheduleConfig, type ScheduleState } from '../src/schedule.ts';

/** 基准配置：2026-10-19 是周一（ISO 1）。 */
function baseConfig(patch: Partial<ScheduleConfig> = {}): ScheduleConfig {
  return {
    mode: 'fixed',
    pushTimes: ['10:30', '13:00', '19:30'],
    minIntervalMinutes: 120,
    dailyCap: 2,
    pushDays: [1, 2, 3, 4, 5, 6, 7],
    pausedUntil: 0,
    ...patch,
  };
}

/** 2026-10-19（周一）本地时刻。 */
function at(hour: number, minute: number): Date {
  return new Date(2026, 9, 19, hour, minute, 0, 0);
}

function state(patch: Partial<ScheduleState> = {}): ScheduleState {
  return { pushedToday: 0, lastWindowKey: null, lastPushAt: null, ...patch };
}

describe('定时模式', () => {
  it('窗口内首推：放行 ok', () => {
    expect(decideFixed(baseConfig(), at(10, 30), state())).toEqual({
      push: true,
      windowKey: '2026-10-19T10:30',
      reason: 'ok',
    });
  });

  it('同一窗口第二次：window-used，仍返回 windowKey', () => {
    expect(decideFixed(baseConfig(), at(10, 32), state({ lastWindowKey: '2026-10-19T10:30' }))).toEqual({
      push: false,
      windowKey: '2026-10-19T10:30',
      reason: 'window-used',
    });
  });

  it('窗口外：outside-window，windowKey 为 null', () => {
    expect(decideFixed(baseConfig(), at(10, 40), state())).toEqual({
      push: false,
      windowKey: null,
      reason: 'outside-window',
    });
  });

  it('窗口边界：命中 5 分钟内，第 5 分钟起算窗口外', () => {
    expect(decideFixed(baseConfig(), at(10, 34), state()).reason).toBe('ok');
    expect(decideFixed(baseConfig(), at(10, 35), state()).reason).toBe('outside-window');
  });

  it('非推送日：day-off', () => {
    const cfg = baseConfig({ pushDays: [2, 3] });
    expect(decideFixed(cfg, at(10, 30), state()).reason).toBe('day-off');
  });

  it('定时模式不再有每日上限：设了几个时刻就推几条', () => {
    const cfg = baseConfig({ pushTimes: ['10:30', '13:00', '19:30'], dailyCap: 1 });
    expect(decideFixed(cfg, at(13, 0), state({ pushedToday: 2 })).push).toBe(true);
  });

  it('暂停中：paused', () => {
    const now = at(10, 30);
    const cfg = baseConfig({ pausedUntil: now.getTime() + 60_000 });
    expect(decideFixed(cfg, now, state())).toEqual({ push: false, windowKey: null, reason: 'paused' });
  });

  it('非法 pushTimes 被忽略，不抛错', () => {
    const cfg = baseConfig({ pushTimes: ['bad', '25:00', '10:30', ''] });
    const d = decideFixed(cfg, at(10, 30), state());
    expect(d.reason).toBe('ok');
    expect(d.windowKey).toBe('2026-10-19T10:30');
  });
});

describe('随机模式', () => {
  it('未到最小间隔：too-soon', () => {
    const now = at(12, 0).getTime();
    const d = decideRandom(baseConfig({ mode: 'random' }), at(12, 0), state(), now + 60_000, () => 0);
    expect(d.push).toBe(false);
    expect(d.reason).toBe('too-soon');
  });

  it('到点后掷骰子：rng 落在概率外就不推', () => {
    const now = at(12, 0).getTime();
    const d = decideRandom(baseConfig({ mode: 'random' }), at(12, 0), state(), now - 1_000, () => 0.99);
    expect(d.push).toBe(false);
    expect(d.reason).toBe('too-soon');
  });

  it('到点后掷骰子：命中就推', () => {
    const now = at(12, 0).getTime();
    const d = decideRandom(baseConfig({ mode: 'random' }), at(12, 0), state(), now - 1_000, () => 0.1);
    expect(d).toEqual({ push: true, reason: 'ok' });
    // 刚到点的基础概率是 0.6：0.59 命中，0.61 不命中
    expect(decideRandom(baseConfig({ mode: 'random' }), at(12, 0), state(), now, () => 0.59).push).toBe(true);
    expect(decideRandom(baseConfig({ mode: 'random' }), at(12, 0), state(), now, () => 0.61).push).toBe(false);
  });

  it('每日上限与星期在随机模式里仍然生效', () => {
    const now = at(12, 0).getTime();
    expect(decideRandom(baseConfig({ mode: 'random' }), at(12, 0), state({ pushedToday: 2 }), now - 1, () => 0).reason).toBe('daily-cap');
    expect(decideRandom(baseConfig({ mode: 'random', pushDays: [2] }), at(12, 0), state(), now - 1, () => 0).reason).toBe('day-off');
  });

  it('下一次时刻至少间隔最小值，且随机延后', () => {
    const last = at(10, 0).getTime();
    const minMs = 60 * 60_000;
    const early = randomNextAt(last, 60, last, () => 0.01);
    const late = randomNextAt(last, 60, last, () => 0.99);
    expect(early).toBeGreaterThanOrEqual(last + minMs);
    expect(late).toBeGreaterThan(early);
  });
});

describe('下一个定时窗口', () => {
  it('当天还有时刻就取最近的一个', () => {
    const next = nextWindowAt(['10:30', '13:00', '19:30'], at(11, 0));
    expect(new Date(next!).getHours()).toBe(13);
  });

  it('当天都过了就取次日第一个', () => {
    const next = nextWindowAt(['10:30', '13:00'], at(20, 0));
    expect(new Date(next!).getDate()).toBe(20);
    expect(new Date(next!).getHours()).toBe(10);
  });
});
