/**
 * 提醒的判定：只做机械计算，文案在 world.ts 里按语言生成。
 *
 * 每个窗口一个游标（窗口 + 重置时刻 + 档位），同一个窗口的同一档只提醒一次；
 * 窗口重置后重置时刻变了，游标就是新的，下一轮照常提醒。
 */
import type { CommandCodeQuota } from './commandcode.ts';

export type AlertWindow = 'fiveHour' | 'weekly' | 'monthly';

export interface QuotaAlert {
  window: AlertWindow;
  kind: 'threshold' | 'exhausted';
  /** 已用百分比；月度额度未知时为 null。 */
  usedPercent: number | null;
  used: number | null;
  cap: number | null;
  /** 重置时刻（epoch 毫秒）；未知为 null。 */
  resetAt: number | null;
  /** 同窗口同档只报一次的游标。 */
  key: string;
}

const FIRED_MAX = 400;

export interface EvaluateOptions {
  /** 提醒阈值（百分比）；<= 0 表示关掉。 */
  thresholdPercent: number;
  /** 已经报过的游标；本函数会往里加新的。 */
  fired: Set<string>;
  /** 窗口重置时刻未知时用来给游标兜底，避免同一档反复报。 */
  periodKey?: string | null;
}

function add(alert: QuotaAlert, fired: Set<string>, out: QuotaAlert[]): void {
  if (fired.has(alert.key)) return;
  fired.add(alert.key);
  if (fired.size > FIRED_MAX) {
    const excess = fired.size - FIRED_MAX;
    let i = 0;
    for (const key of fired) {
      if (i++ >= excess) break;
      fired.delete(key);
    }
  }
  out.push(alert);
}

export function evaluateAlerts(quota: CommandCodeQuota, opts: EvaluateOptions): QuotaAlert[] {
  if (!quota.ok || opts.thresholdPercent <= 0) return [];
  const out: QuotaAlert[] = [];
  const fallback = opts.periodKey ?? 'period';

  for (const [window, value] of [['fiveHour', quota.fiveHour], ['weekly', quota.weekly]] as const) {
    if (!value) continue;
    const anchor = value.resetAt === null ? fallback : String(value.resetAt);
    if (value.exceeded) {
      add(
        {
          window,
          kind: 'exhausted',
          usedPercent: value.usedPercent,
          used: value.used,
          cap: value.cap,
          resetAt: value.resetAt,
          key: `${window}:${anchor}:exhausted`,
        },
        opts.fired,
        out,
      );
      continue;
    }
    if (value.usedPercent !== null && value.usedPercent >= opts.thresholdPercent) {
      add(
        {
          window,
          kind: 'threshold',
          usedPercent: value.usedPercent,
          used: value.used,
          cap: value.cap,
          resetAt: value.resetAt,
          key: `${window}:${anchor}:threshold`,
        },
        opts.fired,
        out,
      );
    }
  }

  const anchor = quota.periodEnd ?? fallback;
  if (quota.monthlyCredits !== null && quota.monthlyCredits <= 0.01) {
    add(
      {
        window: 'monthly',
        kind: 'exhausted',
        usedPercent: quota.monthlyUsedPercent,
        used: quota.monthlyAllowance === null ? null : quota.monthlyAllowance - quota.monthlyCredits,
        cap: quota.monthlyAllowance,
        resetAt: null,
        key: `monthly:${anchor}:exhausted`,
      },
      opts.fired,
      out,
    );
  } else if (quota.monthlyUsedPercent !== null && quota.monthlyUsedPercent >= opts.thresholdPercent) {
    add(
      {
        window: 'monthly',
        kind: 'threshold',
        usedPercent: quota.monthlyUsedPercent,
        used: quota.monthlyAllowance === null ? null : quota.monthlyAllowance - (quota.monthlyCredits ?? 0),
        cap: quota.monthlyAllowance,
        resetAt: null,
        key: `monthly:${anchor}:threshold`,
      },
      opts.fired,
      out,
    );
  }

  return out;
}

/** 最紧的那个窗口的已用百分比：面板的状态灯与徽标都用它。 */
export function busiestPercent(quota: CommandCodeQuota): number | null {
  if (!quota.ok) return null;
  const values = [quota.fiveHour?.usedPercent, quota.weekly?.usedPercent, quota.monthlyUsedPercent]
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return values.length === 0 ? null : Math.max(...values);
}

export function anyExhausted(quota: CommandCodeQuota): boolean {
  return Boolean(quota.fiveHour?.exceeded || quota.weekly?.exceeded || (quota.monthlyCredits !== null && quota.monthlyCredits <= 0.01));
}
