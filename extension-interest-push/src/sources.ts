/**
 * 数据规范化：把 Crossref 条目、arXiv RSS 条目、HuggingFace Daily Papers 行
 * 统一成 `NewsItem`。全部是纯函数，不做 IO，便于单测直接喂样例。
 */
import { createHash } from 'node:crypto';
import type { NewsItem } from './view-types.ts';

/** sha1 十六进制取前 8 位，作为稳定 id。 */
export function sha1Short(input: string): string {
  return createHash('sha1').update(input, 'utf8').digest('hex').slice(0, 8);
}

/** 实体名 → 字符。 */
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** 解码常见 HTML/XML 实体（含数字实体）。 */
function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

/** 去掉 JATS/HTML 标签；标签处补一个空格，避免相邻词粘连。 */
function stripTags(input: string): string {
  return input.replace(/<[^>]*>/g, ' ');
}

/**
 * 通用文本清洗：数组取第一个、去标签、解实体、连续空白压成单空格、去首尾空白。
 */
function normalizeText(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw == null) return '';
  const text = typeof raw === 'string' ? raw : String(raw);
  return decodeEntities(stripTags(text)).replace(/\s+/g, ' ').trim();
}

/** 两位补零。 */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `date-parts` → `YYYY-MM-DD`；月或日缺失补 01。 */
function datePartsToISO(issued: unknown): string {
  if (issued && typeof issued === 'object') {
    const parts = (issued as { 'date-parts'?: unknown })['date-parts'];
    if (Array.isArray(parts) && Array.isArray(parts[0])) {
      const [y, m, d] = parts[0] as number[];
      if (Number.isFinite(Number(y))) {
        return `${String(Number(y)).padStart(4, '0')}-${pad2(Number.isFinite(Number(m)) ? Number(m) : 1)}-${pad2(Number.isFinite(Number(d)) ? Number(d) : 1)}`;
      }
    }
    const dt = (issued as { 'date-time'?: unknown })['date-time'];
    if (typeof dt === 'string' && dt.length >= 10) return dt.slice(0, 10);
  }
  return '';
}

/** 任意日期字符串 → `YYYY-MM-DD`；无法解析返回空串。 */
function toISODate(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toISOString().slice(0, 10);
}

/** 有序去重。 */
function dedupe(list: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (item && !seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

/** Crossref 的 `author` → `given family`，有序去重。 */
function joinAuthors(author: unknown): string[] {
  if (!Array.isArray(author)) return [];
  const names = author.map((a) => {
    if (!a || typeof a !== 'object') return '';
    const given = normalizeText((a as { given?: unknown }).given);
    const family = normalizeText((a as { family?: unknown }).family);
    const name = normalizeText((a as { name?: unknown }).name);
    return [given, family].filter(Boolean).join(' ') || name;
  });
  return dedupe(names);
}

/** 第一个非空 `affiliation[0].name`。 */
function firstAffiliation(author: unknown): string | null {
  if (!Array.isArray(author)) return null;
  for (const a of author) {
    const affiliation = (a as { affiliation?: unknown } | null)?.affiliation;
    if (Array.isArray(affiliation)) {
      for (const entry of affiliation) {
        const name = normalizeText((entry as { name?: unknown } | null)?.name);
        if (name) return name;
      }
    }
  }
  return null;
}

/** 可公开访问 PDF 的域名白名单。 */
const OPEN_PDF_HOSTS = ['arxiv.org', 'ncbi.nlm.nih.gov', 'doaj.org'];

/** URL 是否指向公开可取的 PDF。 */
function isPublicPdf(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (OPEN_PDF_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return true;
  return parsed.pathname.toLowerCase().endsWith('.pdf');
}

/** 从 Crossref `link` 里挑一条公开的 PDF 链接，否则 null。 */
function pickPdfUrl(link: unknown): string | null {
  if (!Array.isArray(link)) return null;
  for (const entry of link) {
    const contentType = String((entry as { 'content-type'?: unknown } | null)?.['content-type'] ?? '').toLowerCase();
    const url = (entry as { URL?: unknown } | null)?.URL;
    if (typeof url === 'string' && contentType.includes('pdf') && isPublicPdf(url)) return url;
  }
  return null;
}

/** 兼容整段响应：给出 `message.items` 或 `items` 时取第一条。 */
function unwrapWork(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') {
    const message = (raw as { message?: { items?: unknown } }).message;
    if (message && Array.isArray(message.items) && message.items.length) {
      return message.items[0] as Record<string, unknown>;
    }
    const items = (raw as { items?: unknown }).items;
    if (Array.isArray(items) && items.length) return items[0] as Record<string, unknown>;
  }
  return (raw ?? {}) as Record<string, unknown>;
}

/** 规范化一条 Crossref 作品。 */
export function normalizeCrossref(
  raw: unknown,
  ctx: { issn: string; tier: string | null; query: string },
): NewsItem {
  const work = unwrapWork(raw);
  const title = normalizeText(work.title);
  const issued = datePartsToISO(work.issued);
  const doiRaw = typeof work.DOI === 'string' ? work.DOI.trim() : '';
  const doi = doiRaw || null;
  const rawUrl = typeof work.URL === 'string' ? work.URL.trim() : '';
  return {
    id: sha1Short(doi ?? title + issued),
    doi,
    title,
    authors: joinAuthors(work.author),
    team: firstAffiliation(work.author),
    journal: normalizeText(work['container-title']),
    journalIssn: ctx.issn ? ctx.issn : null,
    tier: ctx.tier,
    issued,
    abstract: normalizeText(work.abstract),
    url: rawUrl || (doi ? `https://doi.org/${doi}` : ''),
    pdfUrl: pickPdfUrl(work.link),
    source: 'crossref',
    sourceDetail: `crossref:${ctx.issn}?from-pub-date:${ctx.query}`,
    foundAt: Date.now(),
  };
}

/** 规范化一条 arXiv RSS 条目。 */
export function normalizeArxiv(
  entry: { title: string; link: string; summary: string; published: string; authors: string[] },
  ctx: { category: string },
): NewsItem {
  const title = normalizeText(entry?.title);
  const issued = toISODate(entry?.published);
  const link = normalizeText(entry?.link);
  const authors = dedupe((entry?.authors ?? []).map((a) => normalizeText(a)));
  return {
    id: sha1Short(title + issued),
    doi: null,
    title,
    authors,
    team: null,
    journal: ctx.category ? `arXiv ${ctx.category}` : 'arXiv',
    journalIssn: null,
    tier: null,
    issued,
    abstract: normalizeText(entry?.summary),
    url: link,
    // arXiv 一律开放获取：abs 页对应 pdf 页。
    pdfUrl: link.includes('/abs/') ? link.replace('/abs/', '/pdf/') : null,
    source: 'arxiv',
    sourceDetail: `arxiv:${ctx.category}`,
    foundAt: Date.now(),
  };
}

/** 规范化一条 HuggingFace Daily Papers 行。 */
export function normalizeHf(
  row: { paper: { id: string; title: string; authors?: Array<{ name: string }>; summary?: string }; publishedAt?: string },
  _ctx: unknown,
): NewsItem {
  const paper = row?.paper ?? { id: '', title: '' };
  const paperId = normalizeText(paper.id);
  const title = normalizeText(paper.title);
  const issued = toISODate(row?.publishedAt);
  const authors = dedupe((paper.authors ?? []).map((a) => normalizeText(a?.name)));
  // HF 的 paper.id 是 arXiv id（如 2610.21185），对应公开 PDF。
  const pdfUrl = /^\d{4}\.\d{4,5}$/.test(paperId) ? `https://arxiv.org/pdf/${paperId}` : null;
  return {
    id: sha1Short(title + issued),
    doi: null,
    title,
    authors,
    team: null,
    journal: 'Hugging Face Daily Papers',
    journalIssn: null,
    tier: null,
    issued,
    abstract: normalizeText(paper.summary),
    url: paperId ? `https://huggingface.co/papers/${paperId}` : 'https://huggingface.co/papers',
    pdfUrl,
    source: 'hf',
    sourceDetail: 'hf:daily_papers',
    foundAt: Date.now(),
  };
}
