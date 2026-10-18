/**
 * 三个数据源的抓取与条件请求。全部通过 `deps.fetchImpl` 注入 fetch，便于单测；
 * 单个源失败一律返回空数组，不向调用方抛错。
 */
import { DEFAULT_JOURNALS } from './journals.ts';
import { normalizeArxiv, normalizeCrossref, normalizeHf } from './sources.ts';
import type { NewsItem } from './view-types.ts';

export interface FetchDeps {
  /** 注入的 fetch，缺省用全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** Crossref polite pool 邮箱。 */
  mailto: string;
}

/** 条件请求结果。 */
export type ConditionalResult =
  | { notModified: true }
  | { notModified: false; text: string; etag?: string; lastModified?: string };

/** 取实际使用的 fetch。 */
function resolveFetch(deps: FetchDeps): typeof fetch {
  return deps.fetchImpl ?? fetch;
}

/** Date → `YYYY-MM-DD`（UTC）。 */
function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** 最近 `days` 天的起始日 `YYYY-MM-DD`。 */
function daysAgo(days: number): string {
  const clamped = Number.isFinite(days) && days > 0 ? days : 0;
  return ymd(new Date(Date.now() - clamped * 86_400_000));
}

/** 把关键词写成 arXiv 搜索式：多词用 `all:"a b"`，单词用 `all:a`，词间用 AND（不能用 +，那是 OR）。 */
function arxivQueryExpression(keywords: string[]): string {
  return keywords
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => (/\s/.test(k) ? `all:"${k}"` : `all:${k}`))
    .join(' AND ');
}

/** 解码 RSS 里的常见实体。 */
function decodeXml(input: string): string {
  return input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/** 取 RSS 块里某个标签的文本（取第一个）。 */
function tagText(block: string, tag: string): string {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  return m ? decodeXml(m[1]).replace(/\s+/g, ' ').trim() : '';
}

/** 取 RSS 块里某个标签的全部文本。 */
function tagAll(block: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) out.push(decodeXml(m[1]).replace(/\s+/g, ' ').trim());
  return out;
}

/** 去掉 RSS description 的 announce 前缀，保留 Abstract 之后的正文。 */
function stripAnnouncePrefix(description: string): string {
  const idx = description.indexOf('Abstract:');
  return idx >= 0 ? description.slice(idx + 'Abstract:'.length).trim() : description.trim();
}

/** 解析 arXiv RSS，得到 normalizeArxiv 需要的条目形状。 */
function parseArxivRss(xml: string): Array<{ title: string; link: string; summary: string; published: string; authors: string[] }> {
  const items: Array<{ title: string; link: string; summary: string; published: string; authors: string[] }> = [];
  const re = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const publishedRaw = tagText(block, 'pubDate');
    const parsed = publishedRaw ? Date.parse(publishedRaw) : NaN;
    items.push({
      title: tagText(block, 'title'),
      link: tagText(block, 'link'),
      summary: stripAnnouncePrefix(tagText(block, 'description')),
      published: Number.isFinite(parsed) ? new Date(parsed).toISOString() : '',
      authors: tagAll(block, 'dc:creator'),
    });
  }
  return items;
}

/**
 * 抓一个期刊的最新作品（Crossref）。
 * 出错返回空数组；关键词为空时去掉 `query.bibliographic`。
 */
export async function fetchJournal(
  input: { issn: string; days: number; rows: number; keywords: string[] },
  deps: FetchDeps,
): Promise<NewsItem[]> {
  const doFetch = resolveFetch(deps);
  try {
    const from = daysAgo(input.days);
    const params = new URLSearchParams();
    params.set('filter', `from-pub-date:${from}`);
    params.set('rows', String(input.rows));
    params.set('sort', 'published');
    params.set('order', 'desc');
    params.set('select', 'DOI,title,author,container-title,abstract,issued,URL,link');
    const keywords = input.keywords.map((k) => k.trim()).filter(Boolean);
    if (keywords.length) params.set('query.bibliographic', keywords.join(' '));
    params.set('mailto', deps.mailto);
    const url = `https://api.crossref.org/journals/${encodeURIComponent(input.issn)}/works?${params.toString()}`;

    const res = await doFetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': `interest-push/0.1 (mailto:${deps.mailto})`,
      },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { message?: { items?: unknown[] } };
    const items = body?.message?.items;
    if (!Array.isArray(items)) return [];
    const tier = DEFAULT_JOURNALS.find((j) => j.issn === input.issn)?.tier ?? null;
    return items.map((item) => normalizeCrossref(item, { issn: input.issn, tier, query: from }));
  } catch {
    return [];
  }
}

/**
 * 抓若干 arXiv 分类的最新条目（官方 RSS）。分类多于一个时逐分类请求并合并去重。
 * 出错返回空数组。
 */
export async function fetchArxiv(
  input: { categories: string[]; keywords: string[] },
  deps: FetchDeps,
): Promise<NewsItem[]> {
  const doFetch = resolveFetch(deps);
  const expression = arxivQueryExpression(input.keywords);
  const out: NewsItem[] = [];
  const seen = new Set<string>();
  for (const category of input.categories) {
    const cat = category.trim();
    if (!cat) continue;
    try {
      const base = `https://rss.arxiv.org/rss/${encodeURIComponent(cat)}`;
      const url = expression ? `${base}?query=${encodeURIComponent(expression)}` : base;
      const res = await doFetch(url, { headers: { Accept: 'application/rss+xml, application/xml' } });
      if (!res.ok) continue;
      const xml = await res.text();
      for (const entry of parseArxivRss(xml)) {
        const item = normalizeArxiv(entry, { category: cat });
        if (item.id && !seen.has(item.id)) {
          seen.add(item.id);
          out.push(item);
        }
      }
    } catch {
      // 单个分类失败跳过，不影响其它分类。
    }
  }
  return out;
}

/** 抓 HuggingFace Daily Papers 当天列表。出错返回空数组。 */
export async function fetchHfDaily(deps: FetchDeps): Promise<NewsItem[]> {
  const doFetch = resolveFetch(deps);
  try {
    const res = await doFetch('https://huggingface.co/api/daily_papers', {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return [];
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => normalizeHf(row as never, null));
  } catch {
    return [];
  }
}

/**
 * 条件请求：带 `If-None-Match` / `If-Modified-Since`；304 返回 `{ notModified: true }`，
 * 200 返回文本与缓存头，其余失败返回空文本且不抛错。
 */
export async function fetchConditional(
  url: string,
  cache: Record<string, { etag?: string; lastModified?: string }>,
  deps: FetchDeps,
): Promise<ConditionalResult> {
  const doFetch = resolveFetch(deps);
  try {
    const headers: Record<string, string> = {};
    const cached = cache[url];
    if (cached?.etag) headers['If-None-Match'] = cached.etag;
    if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;
    const res = await doFetch(url, { headers });
    if (res.status === 304) return { notModified: true };
    if (!res.ok) return { notModified: false, text: '' };
    const text = await res.text();
    const etag = res.headers.get('etag') ?? undefined;
    const lastModified = res.headers.get('last-modified') ?? undefined;
    return { notModified: false, text, etag, lastModified };
  } catch {
    return { notModified: false, text: '' };
  }
}
