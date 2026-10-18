/**
 * commandcode.ai 的公开「计划页」与「全局价目页」→ 结构化的模型清单 / 单价 / 额度。
 *
 * 只读网页，不发任何带密钥的请求（两页都公开）：
 *   GET https://commandcode.ai/docs/plans/<slug>                计划页：各模型的单价 + 请求额度 + 月度额度
 *   GET https://commandcode.ai/docs/resources/pricing-limits    全局价目页：所有模型的单价
 *
 * 解析一律纯函数、容错：认不出的表格只是少一段数据，绝不抛错；解析不出来的部分写进 notes。
 * 抓取失败时退回缓存（过期的也读），再不行返回带 reason 的空结果。reason 是界面语言无关的英文短句，
 * 与 commandcode.ts 里的风格一致，面板按语言换成自己的话。
 *
 * 计划页的表格结构（实测，SSR 出来的真 HTML）：
 *   表一  Model | Context | Intelligence | Input | Output | Cache read | Cache write | Caps   (~65 行)
 *   表二  Model | Requests / 5 hours | Requests / week | Requests / month                    (按模型名对齐)
 *   表三+ Model | Input | Output | Cache Read | Cache Write | Monthly credits                (可能拆成几张，按名合并)
 * 全局价目页把整份目录塞在 Next.js 的 RSC JSON 里（`"rows":[...]`，93 个模型），
 * 渲染出来的表格是 CSS grid（不是 <table>），所以优先读 JSON，读不到再退回普通表格。
 */
import { readFileSync, writeFileSync } from 'node:fs';

export interface PlanModelRow {
  /** 模型显示名，如 'DeepSeek V4.1 Flash'。 */
  name: string;
  /** '1M' / '256K' / null。 */
  context: string | null;
  /** 智能分（页面上的字符串，如 '56.0'）；拿不到就 null。 */
  intelligence: string | null;
  /** 美元 / 百万 token；Free 记 0；'—' 记 null。 */
  inputPerM: number | null;
  outputPerM: number | null;
  cacheReadPerM: number | null;
  cacheWritePerM: number | null;
  /** Caps 列里的短标记，如 ['+1'] 展开成实际标记；没有就 []。 */
  caps: string[];
  /** 每 5 小时请求额度（按模型）。 */
  requests5h: number | null;
  requestsWeek: number | null;
  requestsMonth: number | null;
  /** 该模型每月可用美元额度。 */
  monthlyCredits: number | null;
  free: boolean;
}

export interface PlanPricing {
  planId: string | null;
  planLabel: string | null;
  slug: string;
  url: string;
  fetchedAt: number;
  models: PlanModelRow[];
  via: 'live' | 'cache';
  /** 抓不到时的英文短句。 */
  reason: string | null;
}

const PLAN_PAGE_BASE = 'https://commandcode.ai/docs/plans';
const PRICING_PAGE_URL = 'https://commandcode.ai/docs/resources/pricing-limits';
/** 缓存默认有效期：12 小时。 */
const DEFAULT_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const FETCH_HEADERS = { 'user-agent': 'Mozilla/5.0', accept: 'text/html' } as const;

// ---------------------------------------------------------------------------
// 套餐 id → slug / 界面名
// ---------------------------------------------------------------------------

/**
 * individual-goat -> 'goat'；认不出的返回 null。
 * 认：go / goat / pro / max / ultra / provider / teams-pro 及其变体（individual-pro-v1、individual-go-v1 之类）。
 */
export function planSlugFor(planId: string | null): string | null {
  if (!planId) return null;
  const id = planId.trim().toLowerCase().replace(/_/g, '-');
  if (!id) return null;
  const rest = id.replace(/^individual-/, '');
  // 顺序有讲究：goat 在 go 之前，provider 在 pro 之前，teams 在 pro 之前。
  if (/^goat/.test(rest)) return 'goat';
  if (/^provider/.test(rest)) return 'provider';
  if (/^teams-pro/.test(rest)) return 'teams-pro';
  if (/^teams/.test(rest)) return 'teams-pro';
  if (/^pro/.test(rest)) return 'pro';
  if (/^go/.test(rest)) return 'go';
  if (/^max/.test(rest)) return 'max';
  if (/^ultra/.test(rest)) return 'ultra';
  return null;
}

/** slug 或 planId → 界面上的名字；未知返回 null。与 commandcode.ts 的命名保持一致。 */
const SLUG_LABELS: Readonly<Record<string, string>> = {
  provider: 'Provider',
  goat: 'GOAT',
  go: 'Go',
  pro: 'Pro',
  max: 'Max',
  ultra: 'Ultra',
  'teams-pro': 'Team Pro',
};

function planLabelFor(planId: string | null): string | null {
  const slug = planSlugFor(planId);
  return slug ? SLUG_LABELS[slug] ?? null : null;
}

// ---------------------------------------------------------------------------
// 文本 / 单元格工具（纯函数）
// ---------------------------------------------------------------------------

/** HTML 实体 → 文本。先处理数字实体，再处理命名实体，`&amp;` 放最后避免二次解码。 */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&(?:#39|apos);/g, "'")
    .replace(/&amp;/g, '&');
}

/** 去注释 + 去标签 + 折叠空白 + 解码实体。 */
function textOf(html: string): string {
  const noComments = html.replace(/<!--[\s\S]*?-->/g, ' ');
  const noTags = noComments.replace(/<[^>]*>/g, ' ');
  return decodeEntities(noTags).replace(/\s+/g, ' ').trim();
}

interface TableRow {
  /** 该行原始 HTML（用来找 <a> 里的干净模型名 / aria-label）。 */
  html: string;
  /** 每个 <td>/<th> 的纯文本。 */
  cells: string[];
}

interface Table {
  rows: TableRow[];
}

/** 从一个 <tr> 里取所有 <td>/<th> 的纯文本。不处理嵌套表格（这两页没有）。 */
function cellsOf(rowHtml: string): string[] {
  const cells: string[] = [];
  const re = /<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rowHtml))) cells.push(textOf(m[2] ?? ''));
  return cells;
}

/** 抽出页面里所有的 <table>。<table> 未闭合（截断 HTML）就不会命中，返回空。 */
function extractTables(html: string): Table[] {
  const tables: Table[] = [];
  const tre = /<table\b[^>]*>([\s\S]*?)<\/table>/g;
  let t: RegExpExecArray | null;
  while ((t = tre.exec(html))) {
    const rows: TableRow[] = [];
    const rre = /<tr\b[^>]*>([\s\S]*?)<\/tr>/g;
    let r: RegExpExecArray | null;
    while ((r = rre.exec(t[1] ?? ''))) rows.push({ html: r[0], cells: cellsOf(r[0]) });
    tables.push({ rows });
  }
  return tables;
}

/** 取单元格里的模型名：优先用 /models/... 链接的文本（最干净，不含脚注与尾注）。 */
function nameFromCell(cellHtml: string, fallback: string): string {
  const a = cellHtml.match(/<a\b[^>]*href="[^"]*\/models\/[^"]*"[^>]*>([\s\S]*?)<\/a>/);
  if (a) {
    const t = textOf(a[1] ?? '');
    if (t) return t;
  }
  const s = cellHtml.match(/<span\b[^>]*class="[^"]*truncate[^"]*"[^>]*>([\s\S]*?)<\/span>/);
  if (s) {
    const t = textOf(s[1] ?? '');
    if (t) return t;
  }
  return fallback;
}

/** 价格单元格 → { 金额, 是否 Free, 脚注标记 }。'$0.10 + 1' → 0.10 + ['+1']；Free → 0；'—'/'-'/'' → null。 */
function moneyOf(value: string): { amount: number | null; free: boolean; footnotes: string[] } {
  const footnotes: string[] = [];
  let text = value.replace(/\s+/g, ' ').trim();
  // 剥掉脚注：'+ 1' / '+1'
  text = text
    .replace(/\+\s*(\d+)/g, (_m, n: string) => {
      footnotes.push(`+${n}`);
      return ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();
  if (/free/i.test(text)) return { amount: 0, free: true, footnotes };
  if (text === '' || /^[—–-]+$/.test(text)) return { amount: null, free: false, footnotes };
  const m = text.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!m) return { amount: null, free: false, footnotes };
  const n = Number(m[0]);
  return { amount: Number.isFinite(n) ? n : null, free: false, footnotes };
}

/** 去掉千分位逗号的整数（'51,300' → 51300）；空 / '—' → null。 */
function countOf(value: string): number | null {
  const t = value.replace(/,/g, '').trim();
  if (!t || /^[—–-]+$/.test(t)) return null;
  const m = t.match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** 取字符串里第一个 `$数字`（'$80 $100 through Oct 16th' → 80；'$70' → 70）。 */
function firstDollar(value: string): number | null {
  const m = value.match(/\$\s*([\d,]+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number((m[1] ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function contextOf(value: string): string | null {
  const t = value.trim();
  if (!t || /^[—–-]+$/.test(t)) return null;
  return t;
}

function intelligenceOf(value: string): string | null {
  const t = value.trim();
  if (!t || /not\s+yet\s+scored/i.test(t)) return null;
  return t;
}

/** 匹配用的名字：小写、去空白、去掉括号里的结尾说明。 */
function normName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 把 ' + 1' / '+1' 之类的短标记归一化进 caps。 */
function pushCap(caps: string[], raw: string): void {
  const t = raw.replace(/\s+/g, '').trim();
  if (t && !caps.includes(t)) caps.push(t);
}

/** Caps 单元格 → 短标记列表；顺带从 aria-label 里取能力标签。 */
function capsTokensOf(cellText: string, cellHtml: string, caps: string[]): void {
  const t = cellText.trim();
  if (t) {
    for (const f of t.match(/\+\s*\d+/g) ?? []) pushCap(caps, f);
    const rest = t.replace(/\+\s*\d+/g, '').trim();
    if (rest) pushCap(caps, rest);
  }
  const al = cellHtml.match(/aria-label="Capabilities:\s*([^"]*)"/);
  if (al) {
    for (const part of (al[1] ?? '').split(',')) {
      const p = part.trim();
      if (p) pushCap(caps, p);
    }
  }
}

// ---------------------------------------------------------------------------
// 计划页
// ---------------------------------------------------------------------------

function headerText(cells: string[]): string {
  return (cells[0] ? cells.join(' ') : '').toLowerCase();
}

function isModelTable(cells: string[]): boolean {
  const h = headerText(cells);
  return h.includes('model') && h.includes('context') && h.includes('caps');
}

function isRequestsTable(cells: string[]): boolean {
  const h = headerText(cells);
  return h.includes('model') && h.includes('requests /') && h.includes('week') && h.includes('month');
}

function isCreditsTable(cells: string[]): boolean {
  const h = headerText(cells);
  return h.includes('model') && h.includes('monthly credit');
}

function buildModels(table: Table): PlanModelRow[] {
  const header = (table.rows[0]?.cells ?? []).map((c) => c.toLowerCase());
  const find = (prefix: string): number => header.findIndex((h) => h.startsWith(prefix));
  const iContext = find('context');
  const iIntel = find('intelligence');
  const iInput = find('input');
  const iOutput = find('output');
  const iCacheRead = find('cache read');
  const iCacheWrite = find('cache write');
  const iCaps = find('caps');

  const models: PlanModelRow[] = [];
  for (let r = 1; r < table.rows.length; r++) {
    const row = table.rows[r];
    if (!row) continue;
    const cells = row.cells;
    if (!cells.length || !cells[0]) continue;
    const name = nameFromCell(row.html, cells[0] ?? '');
    if (!name) continue;

    const inp = moneyOf(iInput >= 0 ? cells[iInput] ?? '' : '');
    const out = moneyOf(iOutput >= 0 ? cells[iOutput] ?? '' : '');
    const cr = moneyOf(iCacheRead >= 0 ? cells[iCacheRead] ?? '' : '');
    const cw = moneyOf(iCacheWrite >= 0 ? cells[iCacheWrite] ?? '' : '');
    const caps: string[] = [];
    for (const f of [...inp.footnotes, ...out.footnotes, ...cr.footnotes, ...cw.footnotes]) pushCap(caps, f);
    if (iCaps >= 0) capsTokensOf(cells[iCaps] ?? '', row.html, caps);

    models.push({
      name,
      context: iContext >= 0 ? contextOf(cells[iContext] ?? '') : null,
      intelligence: iIntel >= 0 ? intelligenceOf(cells[iIntel] ?? '') : null,
      inputPerM: inp.amount,
      outputPerM: out.amount,
      cacheReadPerM: cr.amount,
      cacheWritePerM: cw.amount,
      caps,
      requests5h: null,
      requestsWeek: null,
      requestsMonth: null,
      monthlyCredits: null,
      free: inp.free || out.free || cr.free || cw.free,
    });
  }
  return models;
}

function mergeRequests(models: PlanModelRow[], table: Table): void {
  const header = (table.rows[0]?.cells ?? []).map((c) => c.toLowerCase());
  const i5 = header.findIndex((h) => h.includes('5 hour') || h.includes('5-hour'));
  const iWeek = header.findIndex((h) => h.includes('week'));
  const iMonth = header.findIndex((h) => h.includes('month'));
  const byName = new Map(models.map((m) => [normName(m.name), m]));
  for (let r = 1; r < table.rows.length; r++) {
    const cells = table.rows[r]?.cells ?? [];
    const target = byName.get(normName(cells[0] ?? ''));
    if (!target) continue;
    target.requests5h = i5 >= 0 ? countOf(cells[i5] ?? '') : null;
    target.requestsWeek = iWeek >= 0 ? countOf(cells[iWeek] ?? '') : null;
    target.requestsMonth = iMonth >= 0 ? countOf(cells[iMonth] ?? '') : null;
  }
}

function mergeCredits(models: PlanModelRow[], table: Table): void {
  const header = (table.rows[0]?.cells ?? []).map((c) => c.toLowerCase());
  const iCredits = header.findIndex((h) => h.includes('monthly credit'));
  if (iCredits < 0) return;
  const byName = new Map(models.map((m) => [normName(m.name), m]));
  for (let r = 1; r < table.rows.length; r++) {
    const cells = table.rows[r]?.cells ?? [];
    const target = byName.get(normName(cells[0] ?? ''));
    if (!target) continue;
    const credits = firstDollar(cells[iCredits] ?? '');
    if (credits !== null) target.monthlyCredits = credits;
  }
}

/** 纯函数：把计划页 HTML 解析成行。不抛错；解析不出来就返回空数组 + notes 说明缺了什么。 */
export function parsePlanPage(html: string): { rows: PlanModelRow[]; notes: string[] } {
  const notes: string[] = [];
  try {
    if (typeof html !== 'string' || !html) return { rows: [], notes: ['empty html'] };
    const tables = extractTables(html);
    if (!tables.length) return { rows: [], notes: ['no <table> found in the plan page'] };

    const modelTable = tables.find((t) => isModelTable(t.rows[0]?.cells ?? []));
    if (!modelTable) return { rows: [], notes: ['model table (Model / Context / ... / Caps) not found'] };
    const models = buildModels(modelTable);
    if (!models.length) return { rows: [], notes: ['model table had no data rows'] };

    let quotaTables = 0;
    for (const t of tables) {
      const head = t.rows[0]?.cells ?? [];
      if (isRequestsTable(head)) {
        mergeRequests(models, t);
        quotaTables++;
      } else if (isCreditsTable(head)) {
        mergeCredits(models, t);
        quotaTables++;
      }
    }
    if (!quotaTables) notes.push('no requests / monthly-credits tables found; quota fields left null');
    return { rows: models, notes };
  } catch (err) {
    return { rows: [], notes: [`parse failed: ${err instanceof Error ? err.message : String(err)}`] };
  }
}

// ---------------------------------------------------------------------------
// 全局价目页（数据在 Next.js 的 RSC JSON 里）
// ---------------------------------------------------------------------------

/** 把页面里所有 self.__next_f.push([1,"..."]) 的字符串拼成完整的 RSC 负载。 */
function readRscPayload(html: string): string {
  let payload = '';
  const re = /self\.__next_f\.push\(([\s\S]*?)\)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      const arr = JSON.parse(m[1] ?? '');
      if (Array.isArray(arr) && typeof arr[1] === 'string') payload += arr[1];
    } catch {
      /* 坏块跳过 */
    }
  }
  return payload;
}

/** 在 RSC 负载里找 `"rows":[` 并按括号配对取出数组（字符串里的括号不算）。 */
function extractRowsArray(payload: string): unknown[] | null {
  const key = '"rows":[';
  const at = payload.indexOf(key);
  if (at < 0) return null;
  const start = at + key.length - 1; // 指向 '['
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < payload.length; i++) {
    const c = payload[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(payload.slice(start, i + 1));
          return Array.isArray(parsed) ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** contextWindow 数字 → '1M' / '256K'；空值 → null。 */
function contextFromWindow(n: unknown): string | null {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  if (n >= 1_000_000) return `${Math.round((n / 1_000_000) * 10) / 10}M`;
  return `${Math.round(n / 1000)}K`;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 从 RSC JSON 的 rows 数组造行。额度字段留 null。 */
function modelsFromRsc(rows: unknown[]): PlanModelRow[] {
  const out: PlanModelRow[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    if (!name) continue;
    const tiers = Array.isArray(r.tiers) ? r.tiers : [];
    const firstTier = tiers[0] && typeof tiers[0] === 'object' ? (tiers[0] as Record<string, unknown>) : null;
    const rates = (firstTier?.rates && typeof firstTier.rates === 'object' ? firstTier.rates : {}) as Record<string, unknown>;
    const caps: string[] = [];
    if (r.caps && typeof r.caps === 'object') {
      for (const k of Object.keys(r.caps as Record<string, unknown>)) {
        if ((r.caps as Record<string, unknown>)[k]) pushCap(caps, k);
      }
    }
    const inputPerM = numOrNull(rates.input);
    const outputPerM = numOrNull(rates.output);
    const deal = r.deal && typeof r.deal === 'object' ? (r.deal as Record<string, unknown>) : null;
    const free = deal?.free === true || (inputPerM === 0 && outputPerM === 0);
    out.push({
      name,
      context: contextFromWindow(r.contextWindow),
      intelligence: null,
      inputPerM,
      outputPerM,
      cacheReadPerM: numOrNull(rates.cacheRead),
      cacheWritePerM: numOrNull(rates.cacheWrite),
      caps,
      requests5h: null,
      requestsWeek: null,
      requestsMonth: null,
      monthlyCredits: null,
      free,
    });
  }
  return out;
}

/**
 * 纯函数：把全局价目页解析成行（93 个模型）。
 * 主要读页面内嵌的 RSC JSON；读不到就退回普通 <table>；都没有则空数组 + notes。
 */
export function parsePricingPage(html: string): { rows: PlanModelRow[]; notes: string[] } {
  const notes: string[] = [];
  try {
    if (typeof html !== 'string' || !html) return { rows: [], notes: ['empty html'] };

    const payload = readRscPayload(html);
    if (payload) {
      const rows = extractRowsArray(payload);
      if (rows) {
        const models = modelsFromRsc(rows);
        if (models.length) return { rows: models, notes };
        notes.push('embedded model list was present but empty');
      } else {
        notes.push('embedded JSON found but no "rows" array');
      }
    } else {
      notes.push('no embedded JSON payload found');
    }

    const tables = extractTables(html);
    const modelTable = tables.find((t) => isModelTable(t.rows[0]?.cells ?? []));
    if (modelTable) {
      const rows = buildModels(modelTable);
      if (rows.length) {
        notes.push('parsed from an HTML table, not the embedded JSON');
        return { rows, notes };
      }
    }
    notes.push('no model catalog found in the pricing page');
    return { rows: [], notes };
  } catch (err) {
    return { rows: [], notes: [`parse failed: ${err instanceof Error ? err.message : String(err)}`] };
  }
}

// ---------------------------------------------------------------------------
// 抓取 + 缓存
// ---------------------------------------------------------------------------

export interface FetchPlanPricingOptions {
  planId: string | null;
  /** 缓存 JSON 的绝对路径，由调用方给。 */
  cacheFile: string;
  /** 默认 12 小时。 */
  maxAgeMs?: number;
  fetchImpl?: typeof fetch;
  now?: number;
}

function emptyPricing(fields: {
  planId: string | null;
  planLabel: string | null;
  slug: string;
  url: string;
  fetchedAt: number;
  via: 'live' | 'cache';
  reason: string | null;
}): PlanPricing {
  return { ...fields, models: [] };
}

function readCache(file: string): PlanPricing | null {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (!data || !Array.isArray(data.models)) return null;
    return {
      planId: typeof data.planId === 'string' ? data.planId : null,
      planLabel: typeof data.planLabel === 'string' ? data.planLabel : null,
      slug: typeof data.slug === 'string' ? data.slug : 'pricing-limits',
      url: typeof data.url === 'string' ? data.url : PRICING_PAGE_URL,
      fetchedAt: typeof data.fetchedAt === 'number' ? data.fetchedAt : 0,
      models: data.models as PlanModelRow[],
      via: 'cache',
      reason: null,
    };
  } catch {
    return null;
  }
}

function writeCache(file: string, data: PlanPricing): void {
  try {
    writeFileSync(
      file,
      JSON.stringify({
        planId: data.planId,
        planLabel: data.planLabel,
        slug: data.slug,
        url: data.url,
        fetchedAt: data.fetchedAt,
        models: data.models,
      }),
      'utf8',
    );
  } catch {
    /* 写不了就算了，下次再抓 */
  }
}

/** 抓一次并落缓存。fetch 失败时读缓存（过期的也读），都失败就返回带 reason 的空结果。 */
export async function fetchPlanPricing(opts: FetchPlanPricingOptions): Promise<PlanPricing> {
  const now = opts.now ?? Date.now();
  const maxAge = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const slug = planSlugFor(opts.planId);
  const planLabel = planLabelFor(opts.planId);
  const url = slug ? `${PLAN_PAGE_BASE}/${slug}` : PRICING_PAGE_URL;
  const cacheSlug = slug ?? 'pricing-limits';

  const cached = readCache(opts.cacheFile);
  // 缓存还新鲜就直接用，省一次网络。
  if (cached && now - cached.fetchedAt < maxAge) {
    return { ...cached, planId: opts.planId, planLabel, via: 'cache', reason: 'served from cache' };
  }

  try {
    const res = await fetchImpl(url, { headers: { ...FETCH_HEADERS } });
    if (!res.ok) throw new Error(`command code returned HTTP ${res.status}`);
    const html = await res.text();
    const parsed = slug ? parsePlanPage(html) : parsePricingPage(html);
    if (!parsed.rows.length) throw new Error(parsed.notes[0] ?? 'no model rows parsed');
    const result: PlanPricing = {
      planId: opts.planId,
      planLabel,
      slug: cacheSlug,
      url,
      fetchedAt: now,
      models: parsed.rows,
      via: 'live',
      reason: null,
    };
    writeCache(opts.cacheFile, result);
    return result;
  } catch (err) {
    const reason = (err instanceof Error ? err.message : String(err)).slice(0, 200) || 'fetch failed';
    if (cached) {
      return { ...cached, planId: opts.planId, planLabel, via: 'cache', reason };
    }
    return emptyPricing({ planId: opts.planId, planLabel, slug: cacheSlug, url, fetchedAt: now, via: 'live', reason });
  }
}
