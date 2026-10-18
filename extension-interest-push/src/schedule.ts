/**
 * 调度决策：给定配置、当前时刻与今日状态，回答「要不要检查 / 要不要打扰」。
 * 纯函数，不含定时器——检查频率由调用方的定时器控制，这里只做时刻判断。
 */

export interface ScheduleConfig {
  checkMinutes: number;
  /** 允许打扰的时刻，`HH:MM`。每个时刻最多打扰一次。 */
  pushTimes: string[];
  /** 每天最多推送条数。 */
  dailyCap: number;
  /** 静默时段 `[起, 止]`，`HH:MM`，可能跨午夜：期间只检查不打扰。 */
  quiet: string[];
  /** 允许打扰的星期（ISO：1 = 周一 … 7 = 周日）。 */
  pushDays: number[];
  maxRounds: number;
  /** 暂停到某个时刻（epoch ms，0 表示不暂停）。 */
  pausedUntil: number;
}

export interface ScheduleState {
  pushedToday: number;
  lastWindowKey: string | null;
}

export interface ScheduleDecision {
  check: boolean;
  push: boolean;
  windowKey: string | null;
  reason: string;
}

/** 命中窗口的宽度（分钟）。 */
const WINDOW_MINUTES = 5;

interface Clock {
  h: number;
  m: number;
  label: string;
  minutes: number;
}

/** 解析 `HH:MM`；非法一律返回 null（调用方据此忽略该值）。 */
function parseClock(text: string): Clock | null {
  if (typeof text !== 'string') return null;
  const matched = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!matched) return null;
  const h = Number(matched[1]);
  const m = Number(matched[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { h, m, label: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`, minutes: h * 60 + m };
}

/** 本地日期 `YYYY-MM-DD`。 */
function localDate(now: Date): string {
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

/** ISO 星期：1 = 周一 … 7 = 周日。 */
function isoDay(now: Date): number {
  const d = now.getDay();
  return d === 0 ? 7 : d;
}

/** now 的本地时间落在 [HH:MM, HH:MM + 5 分钟) 内则返回该时刻标签，否则 null。 */
function hitWindow(pushTimes: string[], minutes: number): string | null {
  for (const raw of pushTimes) {
    const clock = parseClock(raw);
    if (!clock) continue;
    if (minutes >= clock.minutes && minutes < clock.minutes + WINDOW_MINUTES) return clock.label;
  }
  return null;
}

/** 是否处于静默时段（支持跨午夜）。非法或不成对的静默值忽略。 */
function inQuiet(quiet: string[], minutes: number): boolean {
  const start = parseClock(quiet?.[0] ?? '');
  const end = parseClock(quiet?.[1] ?? '');
  if (!start || !end) return false;
  if (start.minutes <= end.minutes) return minutes >= start.minutes && minutes < end.minutes;
  return minutes >= start.minutes || minutes < end.minutes;
}

/**
 * 决策顺序：暂停 → 是否命中窗口 → 窗口是否用过 → 静默 → 非推送日 → 每日上限 → 放行。
 * `check` 仅在暂停时为 false，其余一律 true。
 */
export function decide(cfg: ScheduleConfig, now: Date, state: ScheduleState): ScheduleDecision {
  if (cfg.pausedUntil > now.getTime()) {
    return { check: false, push: false, windowKey: null, reason: 'paused' };
  }

  const minutes = now.getHours() * 60 + now.getMinutes();
  const hit = hitWindow(cfg.pushTimes ?? [], minutes);
  if (hit === null) {
    return { check: true, push: false, windowKey: null, reason: 'outside-window' };
  }

  const windowKey = `${localDate(now)}T${hit}`;
  if (windowKey === state.lastWindowKey) {
    return { check: true, push: false, windowKey, reason: 'window-used' };
  }
  if (inQuiet(cfg.quiet ?? [], minutes)) {
    return { check: true, push: false, windowKey, reason: 'quiet' };
  }
  if (!(cfg.pushDays ?? []).includes(isoDay(now))) {
    return { check: true, push: false, windowKey, reason: 'day-off' };
  }
  if (state.pushedToday >= cfg.dailyCap) {
    return { check: true, push: false, windowKey, reason: 'daily-cap' };
  }
  return { check: true, push: true, windowKey, reason: 'ok' };
}
