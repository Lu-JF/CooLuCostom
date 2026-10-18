/**
 * 两处共用的数字与时间格式化。纯函数，不碰 node 也不碰 DOM，所以服务端与面板 bundle 都能用。
 */

export function money(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `$${value.toFixed(digits)}`;
}

export function percent(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

/** 1234567 → `1.2M`；12345 → `12.3k`；987 → `987`。 */
export function compactCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const n = Math.round(value);
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

const DAY_MS = 86_400_000;

/** 距某个时刻还有多久：`2 天 3 小时` / `5 小时 12 分钟` / `42 分钟` / `不到 1 分钟`。 */
export function durationText(ms: number | null | undefined, language?: string): string {
  const zh = String(language ?? 'zh').toLowerCase().startsWith('zh');
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return zh ? '—' : '—';
  if (ms <= 0) return zh ? '已到' : 'now';
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (zh) {
    if (days >= 1) return `${days} 天 ${hours % 24} 小时`;
    if (hours >= 1) return `${hours} 小时 ${minutes % 60} 分钟`;
    if (minutes >= 1) return `${minutes} 分钟`;
    return '不到 1 分钟';
  }
  if (days >= 1) return `${days}d ${hours % 24}h`;
  if (hours >= 1) return `${hours}h ${minutes % 60}m`;
  if (minutes >= 1) return `${minutes}m`;
  return 'under a minute';
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** 本机时区里的 `10-16 15:30`；`withYear` 时写成 `2026-10-16 15:30`。 */
export function clockText(ms: number | null | undefined, opts: { withYear?: boolean } = {}): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const date = `${opts.withYear ? `${d.getFullYear()}-` : ''}${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 面板里的相对时间：`刚刚` / `3 分钟前` / `2 小时前`。 */
export function agoText(ms: number | null | undefined, language?: string, now = Date.now()): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const zh = String(language ?? 'zh').toLowerCase().startsWith('zh');
  const diff = now - ms;
  if (diff < 60_000) return zh ? '刚刚' : 'just now';
  if (diff < 3_600_000) {
    const m = Math.floor(diff / 60_000);
    return zh ? `${m} 分钟前` : `${m} min ago`;
  }
  if (diff < DAY_MS) {
    const h = Math.floor(diff / 3_600_000);
    return zh ? `${h} 小时前` : `${h} h ago`;
  }
  const d = Math.floor(diff / DAY_MS);
  return zh ? `${d} 天前` : `${d} d ago`;
}
