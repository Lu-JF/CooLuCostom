/**
 * 大肥鱼速评：桌宠读完标题与摘要后给的两三句评价 + 一个总分（10 星制）。
 *
 * - 走**桌宠自己的模型端点**（`model.ts`），带一点桌宠的口吻，但要给出专业判断。
 * - 五个方面（创新点、领域贡献度、研究方向相关性、实验设置、写作质量）只写进提示词里
 *   让模型综合着考虑，**输出只要一个总分**——界面上也只显示一个分数，不摊开维度分。
 * - 每篇只评一次：结果按条目 id 落盘（`news/reviews/<id>.json`），推送页、列表页、气泡都用同一份，
 *   不会因为换页签或重复点按钮再花一次 token。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { askModel, type ModelEndpoint } from './model.ts';
import type { NewsItem, ReviewState } from './view-types.ts';

/** 提示词版本：改措辞或打分口径时加一，旧缓存失效。 */
export const REVIEW_PROMPT_VERSION = 1;

/** 打分的满分（星数）。 */
export const MAX_STARS = 10;

export interface Review {
  text: string;
  /** 0–10，一位小数。 */
  total: number;
  version: number;
  at: number;
}

export interface ReviewDeps extends ModelEndpoint {
  dataDir: string;
  keywords: string[];
  fetchImpl?: typeof fetch;
}

export function buildReviewPrompt(item: Pick<NewsItem, 'title' | 'abstract' | 'journal'>, keywords: string[]): string {
  const field = keywords.slice(0, 12).join('、') || '旋转机械故障诊断、神经架构搜索、边缘计算';
  return [
    '你是「大肥鱼」，负责为使用者筛选旋转机械故障诊断与健康管理方向的论文。语气简短、直接。',
    '',
    '读下面的标题与摘要，输出两部分：',
    '1. 两三句中文评价：是否值得阅读，理由。不用列表，不复述摘要原文。',
    '2. 一个总分，0 到 10，可含 0.5。评分时综合创新点、领域贡献度、研究方向相关性、实验设置、写作质量，不逐项输出。',
    `方向相关性以下列方向为准：${field}。`,
    '摘要缺失时按标题判断，不臆测原文内容。',
    '',
    '严格按两行格式输出，不要其他内容：',
    '评价：<两三句>',
    '总分：<0 到 10 的数字>',
    '',
    `标题：${item.title}`,
    item.journal ? `期刊：${item.journal}` : '',
    '',
    '摘要：',
    item.abstract.trim() === '' ? '（源未提供摘要）' : item.abstract,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** 从模型输出里抠出评价与总分；抠不到总分返回 null（宁可不显示分数，也不编一个）。 */
export function parseReview(raw: string): { text: string; total: number } | null {
  const text = raw.replace(/\r\n/g, '\n').replace(/```[a-z]*\n?/gi, '').trim();
  if (text === '') return null;
  const m = text.match(/(?:总分|评分|得分|Score)\s*[:：]?\s*(\d{1,2}(?:\.\d)?)\s*(?:\/\s*10)?/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const total = Math.round(Math.min(MAX_STARS, Math.max(0, n)) * 10) / 10;
  const at = text.search(/(?:总分|评分|得分|Score)\s*[:：]/i);
  const head = at === -1 ? text : text.slice(0, at);
  const body = head
    .replace(/^\s*(评价|点评|总评|Review)\s*[:：]\s*/i, '')
    // 模型有时顺手把维度分也写出来：整行「某维度：数字」不是评语，剔掉。
    .split('\n')
    .filter((line) => !/^\s*\S{2,8}\s*[:：]\s*\d{1,2}(?:\.\d)?\s*$/.test(line))
    .join('\n')
    .trim();
  return { text: body, total };
}

function cachePath(dataDir: string, id: string): string {
  return join(dataDir, 'news', 'reviews', `${id}.json`);
}

export function readReview(dataDir: string, id: string): Review | null {
  try {
    const raw = JSON.parse(readFileSync(cachePath(dataDir, id), 'utf8')) as Partial<Review>;
    if (typeof raw.text === 'string' && raw.text.trim() !== '' && typeof raw.total === 'number') {
      if (raw.version !== REVIEW_PROMPT_VERSION) return null;
      return { text: raw.text, total: raw.total, version: REVIEW_PROMPT_VERSION, at: Number(raw.at ?? 0) };
    }
  } catch {
    /* 没有缓存或坏了：当作没有 */
  }
  return null;
}

export function writeReview(dataDir: string, id: string, review: Review): void {
  try {
    mkdirSync(join(dataDir, 'news', 'reviews'), { recursive: true });
    writeFileSync(cachePath(dataDir, id), `${JSON.stringify(review, null, 2)}\n`, 'utf8');
  } catch {
    /* 落盘失败不影响本次返回 */
  }
}

/** 已有缓存就返回，没有就调一次模型并落盘。 */
export async function reviewItem(item: NewsItem, deps: ReviewDeps): Promise<ReviewState> {
  const cached = readReview(deps.dataDir, item.id);
  if (cached) return { ok: true, cached: true, reason: null, text: cached.text, total: cached.total, at: cached.at };

  const out = await askModel(deps, buildReviewPrompt(item, deps.keywords), deps.fetchImpl);
  if (!out.ok) {
    const reason = out.reason === 'no-endpoint' ? 'no-endpoint' : (out.reason ?? 'failed');
    return { ok: false, cached: false, reason, text: '', total: null, at: 0 };
  }
  const parsed = parseReview(out.text);
  if (!parsed) {
    // 分数抠不出来时，至少把评价留在界面上（宁可没有星星，也不显示假分数）。
    return { ok: false, cached: false, reason: 'unparsed-score', text: out.text, total: null, at: 0 };
  }
  const review: Review = { text: parsed.text, total: parsed.total, version: REVIEW_PROMPT_VERSION, at: Date.now() };
  writeReview(deps.dataDir, item.id, review);
  return { ok: true, cached: false, reason: null, text: review.text, total: review.total, at: review.at };
}
