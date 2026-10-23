/**
 * 期刊的识别与校验。
 *
 * 期刊在抓取里只有 ISSN 有用：Crossref 的 `journals/<ISSN>/works` 只认 ISSN，
 * 刊名与分区都是展示用的。所以新增一家刊时先验 ISSN（校验位 + Crossref 是否存在），
 * 再试抓一条确认真的能取到论文，最后才写进配置。
 */
import { DEFAULT_JOURNALS } from './journals.ts';
import type { FetchDeps } from './fetch.ts';
import { resolveFetch } from './fetch.ts';

/** 把用户输入的 ISSN 收成 `XXXX-XXXX`；校验位不对就返回 null。 */
export function normalizeIssn(input: string): string | null {
  const digits = input.toUpperCase().replace(/[^0-9X]/g, '');
  if (digits.length !== 8) return null;
  const body = digits.slice(0, 7);
  if (!/^\d{7}$/.test(body)) return null;
  const check = digits[7]!;
  let sum = 0;
  for (let i = 0; i < 7; i += 1) sum += Number(body[i]) * (8 - i);
  const rest = (11 - (sum % 11)) % 11;
  const expected = rest === 10 ? 'X' : String(rest);
  if (check !== expected) return null;
  return `${digits.slice(0, 4)}-${digits.slice(4)}`;
}

export interface JournalMeta {
  /** Crossref 给的刊名。 */
  title: string;
  /** Crossref 列出的全部 ISSN（印刷版与电子版）。 */
  issns: string[];
}

/** 问 Crossref 这家刊存在不存在。 */
export async function lookupJournal(issn: string, deps: FetchDeps): Promise<JournalMeta | null> {
  const doFetch = resolveFetch(deps);
  try {
    const res = await doFetch(`https://api.crossref.org/journals/${encodeURIComponent(issn)}?mailto=${encodeURIComponent(deps.mailto)}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { message?: { title?: unknown; ISSN?: unknown } };
    const title = String(body?.message?.title ?? '').trim();
    if (title === '') return null;
    const issns = Array.isArray(body?.message?.ISSN) ? (body.message!.ISSN as unknown[]).map((v) => String(v).toUpperCase()) : [];
    return { title, issns };
  } catch {
    return null;
  }
}

/** 内置表里的分区（这些年期刊是人工核实过的）。 */
function bundledTier(issn: string): { tier: string; tierBasis: string } | null {
  const hit = DEFAULT_JOURNALS.find((j) => j.issn.replace(/[^0-9X]/gi, '').toUpperCase() === issn.replace(/[^0-9X]/gi, '').toUpperCase());
  return hit === undefined ? null : { tier: hit.tier, tierBasis: hit.tierBasis };
}

/**
 * 分区：内置表优先；表里没有的，看这家刊最早一篇是不是近四年内——
 * 是就标「新锐期刊」，否则「未标注」。免费接口拿不到中科院分区表，不猜。
 */
export async function resolveTier(issn: string, deps: FetchDeps): Promise<{ tier: string; tierBasis: string }> {
  const known = bundledTier(issn);
  if (known !== null) return known;
  const doFetch = resolveFetch(deps);
  try {
    const url =
      `https://api.crossref.org/journals/${encodeURIComponent(issn)}/works` +
      `?sort=published&order=asc&rows=1&select=published&mailto=${encodeURIComponent(deps.mailto)}`;
    const res = await doFetch(url, { headers: { Accept: 'application/json' } });
    if (res.ok) {
      const body = (await res.json()) as { message?: { items?: Array<{ published?: { 'date-parts'?: number[][] } }> } };
      const parts = body?.message?.items?.[0]?.published?.['date-parts']?.[0];
      const year = Array.isArray(parts) ? Number(parts[0]) : NaN;
      if (Number.isFinite(year) && new Date().getFullYear() - year <= 4) {
        return { tier: '新锐期刊', tierBasis: `Crossref 最早一篇 ${year} 年，暂无分区` };
      }
    }
  } catch {
    /* 查不到就按未标注 */
  }
  return { tier: '未标注', tierBasis: '免费接口没有分区数据，可人工在说明里补充' };
}

/** 试抓一条：证明这个 ISSN 真能取到论文。 */
export async function probeLatest(
  issn: string,
  deps: FetchDeps,
): Promise<{ title: string; issued: string } | null> {
  const doFetch = resolveFetch(deps);
  try {
    const url =
      `https://api.crossref.org/journals/${encodeURIComponent(issn)}/works` +
      `?rows=1&sort=published&order=desc&select=title,published&mailto=${encodeURIComponent(deps.mailto)}`;
    // Crossref 对突发请求会回 429：退避后重试两次，别把限流当成「这家刊抓不到」。
    let res = await doFetch(url, { headers: { Accept: 'application/json' } });
    for (const wait of [1_200, 3_000]) {
      if (res.ok || (res.status !== 429 && res.status < 500)) break;
      await new Promise((resolve) => setTimeout(resolve, wait));
      res = await doFetch(url, { headers: { Accept: 'application/json' } });
    }
    if (!res.ok) return null;
    const body = (await res.json()) as {
      message?: { items?: Array<{ title?: unknown; published?: { 'date-parts'?: number[][] } }> };
    };
    const item = body?.message?.items?.[0];
    if (item === undefined) return null;
    const title = Array.isArray(item.title) ? String(item.title[0] ?? '').trim() : String(item.title ?? '').trim();
    if (title === '') return null;
    const parts = item.published?.['date-parts']?.[0];
    const issued = Array.isArray(parts) ? parts.filter((n) => Number.isFinite(Number(n))).map((n) => String(n).padStart(2, '0')).join('-') : '';
    return { title, issued };
  } catch {
    return null;
  }
}
