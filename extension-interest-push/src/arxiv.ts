/**
 * arXiv 检索。
 *
 * 分类 RSS（`rss.arxiv.org/rss/<cat>`）只给「该分类今天的新条目」，不接受检索式，
 * 而且周末不出新；关键词有内容时改走官方检索 API：
 * `export.arxiv.org/api/query?search_query=…&sortBy=submittedDate`，短语之间用 OR。
 * 关键词为空时退回分类 RSS，至少还能看到当日更新。
 */
import { fetchArxiv, type FetchDeps } from './fetch.ts';
import { normalizeArxiv } from './sources.ts';
import type { NewsItem } from './view-types.ts';

/** 关键词 → arXiv 检索式：每个短语一个 `all:"…"`，之间 OR。 */
export function arxivSearchExpression(keywords: string[]): string {
  return keywords
    .map((k) => k.trim())
    .filter((k) => k !== '')
    .map((k) => `all:"${k}"`)
    .join(' OR ');
}

interface AtomEntry {
  title: string;
  link: string;
  summary: string;
  published: string;
  authors: string[];
  /** 主分类，例如 eess.SP；取不到时为空串。 */
  category: string;
}

/** 取某个标签的文本（去标签、压空白）；没有返回空串。 */
function tag(block: string, name: string): string {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? m[1]!.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

/** 取所有同名标签的文本。 */
function tags(block: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) out.push(m[1]!.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  return out;
}

/** 解析 arXiv 检索 API 的 Atom 条目。 */
export function parseArxivAtom(xml: string): AtomEntry[] {
  const out: AtomEntry[] = [];
  const re = /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const block = m[1]!;
    const id = tag(block, 'id');
    const alternate = /<link[^>]*rel="alternate"[^>]*href="([^"]+)"/i.exec(block)?.[1]
      ?? /<link[^>]*href="([^"]+)"[^>]*rel="alternate"/i.exec(block)?.[1]
      ?? '';
    const category =
      /<arxiv:primary_category[^>]*term="([^"]+)"/i.exec(block)?.[1]
      ?? /<category[^>]*term="([^"]+)"/i.exec(block)?.[1]
      ?? '';
    out.push({
      title: tag(block, 'title'),
      link: alternate || id,
      summary: tag(block, 'summary'),
      published: tag(block, 'published'),
      authors: tags(block, 'name'),
      category: category.trim(),
    });
  }
  return out;
}

/** 按检索式抓 arXiv；关键词为空时退回分类 RSS。 */
export async function fetchArxivSearch(
  input: { keywords: string[]; categories: string[]; max?: number },
  deps: FetchDeps,
): Promise<NewsItem[]> {
  const expression = arxivSearchExpression(input.keywords);
  if (expression === '') return fetchArxiv({ categories: input.categories, keywords: [] }, deps);
  const doFetch = deps.fetchImpl ?? fetch;
  const max = Math.min(100, Math.max(5, input.max ?? 40));
  const url =
    'https://export.arxiv.org/api/query?search_query=' +
    encodeURIComponent(expression) +
    `&sortBy=submittedDate&sortOrder=descending&start=0&max_results=${max}`;
  try {
    const res = await doFetch(url, { headers: { Accept: 'application/atom+xml' } });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseArxivAtom(xml).map((entry) => normalizeArxiv(entry, { category: entry.category || 'search' }));
  } catch {
    return [];
  }
}
