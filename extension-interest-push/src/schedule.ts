/**
 * 推送节奏的判定（纯函数）。
 *
 * 两种模式：
 * - `fixed`：按配置的推送时刻，每个时刻最多一次。
 * - `random`：两次推送至少隔 `minIntervalMinutes`，超过之后越久越可能推；每天有上限。
 *
 * 这里只算「到点没有」「该不该推」，定时器由 World 负责。
 */

export type PushMode = 'fixed' | 'random';

export interface ScheduleConfig {
  mode: PushMode;
  /** 定时模式的时刻，`HH:MM`。 */
  pushTimes: string[];
  /** 随机模式的最小间隔（分钟）。 */
  minIntervalMinutes: number;
  /** 随机模式的每日上限。 */
  dailyCap: number;
  /** 允许打扰的星期（ISO：1 = 周一 … 7 = 周日）。 */
  pushDays: number[];
  /** 暂停到某个时刻（epoch ms，0 表示不暂停）。 */
  pausedUntil: number;
}

export interface ScheduleState {
  pushedToday: number;
  lastWindowKey: string | null;
  lastPushAt: number | null;
}

export type ScheduleReason =
  | 'ok'
  | 'paused'
  | 'outside-window'
  | 'window-used'
  | 'day-off'
  | 'daily-cap'
  | 'too-soon';

/** 命中窗口的宽度（分钟）。 */
const WINDOW_MINUTES = 5;

export interface Clock {
  h: number;
  m: number;
  label: string;
  minutes: number;
}

/** 解析 `HH:MM`；非法一律返回 null（调用方据此忽略该值）。 */
export function parseClock(text: string): Clock | null {
  if (typeof text !== 'string') return null;
  const matched = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!matched) return null;
  const h = Number(matched[1]);
  const m = Number(matched[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { h, m, label: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`, minutes: h * 60 + m };
}

/** 本地日期 `YYYY-MM-DD`。 */
export function localDate(now: Date): string {
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

/** ISO 星期：1 = 周一 … 7 = 周日。 */
export function isoDay(now: Date): number {
  const d = now.getDay();
  return d === 0 ? 7 : d;
}

/** now 落在某个时刻的 [HH:MM, HH:MM + 5 分钟) 内则返回该时刻标签，否则 null。 */
export function hitWindow(pushTimes: string[], now: Date): string | null {
  const minutes = now.getHours() * 60 + now.getMinutes();
  for (const raw of pushTimes) {
    const clock = parseClock(raw);
    if (!clock) continue;
    if (minutes >= clock.minutes && minutes < clock.minutes + WINDOW_MINUTES) return clock.label;
  }
  return null;
}

/** 定时模式：暂停 → 命中窗口 → 窗口用过 → 非推送日 → 放行。 */
export function decideFixed(
  cfg: ScheduleConfig,
  now: Date,
  state: ScheduleState,
): { push: boolean; windowKey: string | null; reason: ScheduleReason } {
  if (cfg.pausedUntil > now.getTime()) return { push: false, windowKey: null, reason: 'paused' };
  const hit = hitWindow(cfg.pushTimes, now);
  if (hit === null) return { push: false, windowKey: null, reason: 'outside-window' };
  const windowKey = `${localDate(now)}T${hit}`;
  if (windowKey === state.lastWindowKey) return { push: false, windowKey, reason: 'window-used' };
  if (!cfg.pushDays.includes(isoDay(now))) return { push: false, windowKey, reason: 'day-off' };
  return { push: true, windowKey, reason: 'ok' };
}

/**
 * 随机模式到点没到点：至少隔 `minIntervalMinutes`，之后每个检查点按剩余时间加权，
 * 越久越可能推；受星期、每日上限与暂停约束。
 */
export function decideRandom(
  cfg: ScheduleConfig,
  now: Date,
  state: ScheduleState,
  nextAt: number,
  rng: () => number = Math.random,
): { push: boolean; reason: ScheduleReason } {
  if (cfg.pausedUntil > now.getTime()) return { push: false, reason: 'paused' };
  if (!cfg.pushDays.includes(isoDay(now))) return { push: false, reason: 'day-off' };
  if (state.pushedToday >= cfg.dailyCap) return { push: false, reason: 'daily-cap' };
  if (now.getTime() < nextAt) return { push: false, reason: 'too-soon' };
  // 到点先掷一次骰子：基础概率 0.83，之后每超时一个最小间隔加 0.12，最多 0.95。
  const overdue = now.getTime() - nextAt;
  const minMs = Math.max(1, cfg.minIntervalMinutes) * 60_000;
  const chance = Math.min(0.95, 0.83 + (overdue / minMs) * 0.12);
  return rng() <= chance ? { push: true, reason: 'ok' } : { push: false, reason: 'too-soon' };
}

/**
 * 下一次随机推送不早于什么时候：最小间隔 + 指数分布的额外等待，
 * 额外等待的平均值是最小间隔的 0.3 倍——配合 0.83 的基础命中率，
 * 累计推送概率在最小间隔的 2.5 倍左右到 90%。
 */
export function randomNextAt(lastPushAt: number | null, minIntervalMinutes: number, now: number, rng: () => number = Math.random): number {
  const minMs = Math.max(1, minIntervalMinutes) * 60_000;
  const base = lastPushAt ?? now;
  const u = Math.min(0.999, Math.max(0.001, rng()));
  return Math.round(base + minMs + -Math.log(1 - u) * minMs * 0.3);
}

/** 定时模式下「下一个窗口」的时刻；没有可用的时刻返回 null。 */
export function nextWindowAt(pushTimes: string[], now: Date): number | null {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const seconds = now.getSeconds();
  let best: number | null = null;
  for (const raw of pushTimes) {
    const clock = parseClock(raw);
    if (!clock) continue;
    let delta = clock.minutes - minutes;
    if (delta < 0) delta += 24 * 60;
    const at = new Date(now.getTime() + delta * 60_000 - seconds * 1000);
    if (best === null || at.getTime() < best) best = at.getTime();
  }
  return best;
}
