/**
 * 推送挑条的规则（纯函数）。
 *
 * 两条路都靠这里判：
 * - **自动推送**（定时窗口）：从名单里跳已读 / 已推过 / 判过「不感兴趣」的，优先有摘要那条。
 * - **手动「立刻推一条」**：先看「推送」页正在显示的那篇；推得了就推它，推不了（已推过、没摘要、
 *   判过不感兴趣）就换下一篇能推的——推完页签跟到那篇，所以页签与气泡永远一致，也不会连着推同一篇。
 */
import type { NewsItem } from './view-types.ts';

export interface PickOptions {
  read: string[];
  pushedIds: string[];
  dismissed: string[];
  requireAbstract: boolean;
}

/** 这一条现在能不能推。 */
export function isPushable(item: NewsItem, opts: PickOptions): boolean {
  if (opts.pushedIds.includes(item.id)) return false;
  if (opts.dismissed.includes(item.id)) return false;
  if (opts.requireAbstract && item.abstract.trim() === '') return false;
  return true;
}

export function pickPushCandidate(items: NewsItem[], opts: PickOptions): NewsItem | null {
  const skip = new Set([...opts.pushedIds, ...opts.dismissed, ...opts.read]);
  const pool = items.filter((i) => !skip.has(i.id));
  const withAbstract = pool.find((i) => i.abstract.trim() !== '');
  if (withAbstract !== undefined) return withAbstract;
  return opts.requireAbstract ? null : (pool[0] ?? null);
}

/**
 * 「立刻推一条」挑哪条：优先页面上那篇（推得了就推它），否则按列表顺序找下一篇能推的；
 * 都推不了返回 null。
 */
export function pickManualCandidate(items: NewsItem[], active: NewsItem | null, opts: PickOptions): NewsItem | null {
  if (active !== null && isPushable(active, opts)) return active;
  const at = active === null ? -1 : items.findIndex((i) => i.id === active.id);
  const ordered = at === -1 ? items : [...items.slice(at + 1), ...items.slice(0, at + 1)];
  return ordered.find((i) => isPushable(i, opts)) ?? null;
}
