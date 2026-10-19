/**
 * 自动推送时挑哪一条。抽成纯函数是为了单独测：World 里那条路径要么等窗口、要么等定时器，
 * 不好在单测里稳稳驱动，而「跳过已读/已推过/不感兴趣、优先有摘要」这几条规则本身值得单独钉住。
 *
 * 注意：面板上「立刻推一条」**不走这里**——它按页面上正在显示的那篇推，见 `world.ts`。
 */
import type { NewsItem } from './view-types.ts';

export interface PickOptions {
  read: string[];
  pushedIds: string[];
  dismissed: string[];
  requireAbstract: boolean;
}

export function pickPushCandidate(items: NewsItem[], opts: PickOptions): NewsItem | null {
  const skip = new Set([...opts.pushedIds, ...opts.dismissed, ...opts.read]);
  const pool = items.filter((i) => !skip.has(i.id));
  const withAbstract = pool.find((i) => i.abstract.trim() !== '');
  if (withAbstract !== undefined) return withAbstract;
  return opts.requireAbstract ? null : (pool[0] ?? null);
}
