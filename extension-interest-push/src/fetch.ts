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
  /**
   * 可选配额密钥。OpenAlex 与 Semantic Scholar 的免费额度按 IP 共享，用的人多就会打出
   * 「Rate limit exceeded / Too Many Requests」。有 key 就带上（来自环境变量，不写进配置文件）。
   */
  openAlexKey?: string;
  semanticScholarKey?: string;
}

/** OpenAlex 的 key 走 query，Semantic Scholar 的走请求头。 */
function withOpenAlexKey(url: string, deps: FetchDeps): string {
  return deps.openAlexKey ? `${url}&api_key=${encodeURIComponent(deps.openAlexKey)}` : url;
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

/** 把 OpenAlex 的 `abstract_inverted_index` 还原成文本。 */
export function invertAbstract(index: unknown): string {
  if (!index || typeof index !== 'object') return '';
  const pairs: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(index as Record<string, unknown>)) {
    if (!Array.isArray(positions)) continue;
    for (const at of positions) {
      if (Number.isFinite(Number(at))) pairs.push([Number(at), word]);
    }
  }
  pairs.sort((a, b) => a[0] - b[0]);
  return pairs.map(([, word]) => word).join(' ').trim();
}

/**
 * 按 DOI 批量补摘要（OpenAlex，免费）。
 * Crossref 里 Elsevier 等出版社常不存摘要，这一层把缺的补上；单批失败只跳过这一批。
 */
export async function fetchOpenAlexAbstracts(dois: string[], deps: FetchDeps): Promise<Record<string, string>> {
  const doFetch = resolveFetch(deps);
  const out: Record<string, string> = {};
  const clean = [...new Set(dois.map((d) => d.trim().toLowerCase()).filter((d) => d !== ''))].slice(0, 60);
  for (let i = 0; i < clean.length; i += 25) {
    const chunk = clean.slice(i, i + 25);
    try {
      const filter = encodeURIComponent(`doi:${chunk.join('|')}`);
      const url = withOpenAlexKey(`https://api.openalex.org/works?filter=${filter}&per-page=50&select=doi,abstract_inverted_index&mailto=${encodeURIComponent(deps.mailto)}`, deps);
      const res = await doFetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) continue;
      const body = (await res.json()) as { results?: unknown[] };
      for (const row of body?.results ?? []) {
        const r = (row ?? {}) as Record<string, unknown>;
        const doi = String(r.doi ?? '').replace(/^https?:\/\/doi\.org\//i, '').toLowerCase();
        const text = invertAbstract(r.abstract_inverted_index);
        if (doi !== '' && text !== '') out[doi] = text;
      }
    } catch {
      /* 这一批失败就跳过 */
    }
  }
  return out;
}

/**
 * 按标题在 OpenAlex 找摘要。新上线的 Elsevier 文章常常「有记录但 DOI 索引还没对上」，
 * 按 DOI 查不到时改按标题检索。
 */
export async function fetchOpenAlexAbstractByTitle(
  title: string,
  deps: FetchDeps,
): Promise<string | null> {
  const clean = title.replace(/\s+/g, ' ').trim();
  if (clean.length < 12) return null;
  const doFetch = resolveFetch(deps);
  try {
    const url = withOpenAlexKey(
      'https://api.openalex.org/works?search=' +
        encodeURIComponent(clean) +
        `&per-page=3&select=doi,title,abstract_inverted_index&mailto=${encodeURIComponent(deps.mailto)}`,
      deps,
    );
    const res = await doFetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json()) as { results?: unknown[] };
    const norm = (v: unknown): string => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const want = norm(clean);
    for (const row of body?.results ?? []) {
      const r = (row ?? {}) as Record<string, unknown>;
      const got = norm(r.title);
      // 标题要对得上（完全一致或互相包含），免得抓错别人的摘要。
      if (got === '' || !(got === want || got.includes(want) || want.includes(got))) continue;
      const text = invertAbstract(r.abstract_inverted_index);
      if (text !== '') return text;
    }
  } catch {
    /* 查不到就算了 */
  }
  return null;
}

/**
 * 按 DOI 批量补摘要（Semantic Scholar，一次 POST 最多 500 个 DOI）。
 * Elsevier 等出版社在 Crossref 与 OpenAlex 里都没有摘要，这一层是最后一道兜底。
 */
export async function fetchSemanticScholarAbstracts(dois: string[], deps: FetchDeps): Promise<Record<string, string>> {
  const doFetch = resolveFetch(deps);
  const out: Record<string, string> = {};
  const clean = [...new Set(dois.map((d) => d.trim()).filter((d) => d !== ''))].slice(0, 200);
  if (clean.length === 0) return out;
  try {
    const res = await doFetch('https://api.semanticscholar.org/graph/v1/paper/batch?fields=abstract', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Accept: 'application/json',
        'User-Agent': `interest-push/0.1 (mailto:${deps.mailto})`,
        ...(deps.semanticScholarKey ? { 'x-api-key': deps.semanticScholarKey } : {}),
      },
      body: JSON.stringify({ ids: clean.map((d) => `DOI:${d}`) }),
    });
    if (!res.ok) return out;
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows)) return out;
    rows.forEach((row, at) => {
      const text = String((row as Record<string, unknown> | null)?.abstract ?? '').replace(/\s+/g, ' ').trim();
      const doi = clean[at];
      if (doi !== undefined && text !== '') out[doi.toLowerCase()] = text;
    });
  } catch {
    /* 整批失败就跳过 */
  }
  return out;
}

/**
 * 抓一个期刊的最新作品（Crossref）。
 * 出错返回空数组；关键词为空时去掉 `query.bibliographic`。
 */
export async function fetchJournal(
  input: { issn: string; days: number; delayDays?: number; rows: number; keywords: string[] },
  deps: FetchDeps,
): Promise<NewsItem[]> {
  const doFetch = resolveFetch(deps);
  try {
    const from = daysAgo(input.days);
    // 延迟窗口：这些刊在 Crossref 里基本不给摘要（IEEE/Elsevier 一律空），摘要来自 OpenAlex
    // 一类抓出版社页面的源，要过几天才抓得到。跳过最近 delayDays 天的文章，等摘要长出来再收。
    const delay = Math.max(0, Math.floor(input.delayDays ?? 0));
    const until = daysAgo(delay);
    const params = new URLSearchParams();
    // 按记录创建日期筛与排序：期刊常把期号标到明年，按期号会顶出一堆未来日期。
    params.set('filter', `from-created-date:${from},until-created-date:${until}`);
    params.set('rows', String(input.rows));
    params.set('sort', 'created');
    params.set('order', 'desc');
    params.set('select', 'DOI,title,author,container-title,abstract,issued,created,published-online,URL,link');
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
    return items.map((item) => normalizeCrossref(item, { issn: input.issn, tier, query: `created:${from}` }));
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
