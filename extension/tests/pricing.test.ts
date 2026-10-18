import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fetchPlanPricing,
  parsePlanPage,
  parsePricingPage,
  planSlugFor,
  type PlanModelRow,
} from '../src/pricing.ts';

/** 真实抓下来的两页（各 ~800KB），见 tests/fixtures/。 */
const planHtml = readFileSync(new URL('./fixtures/plan-goat.html', import.meta.url), 'utf8');
const pricingHtml = readFileSync(new URL('./fixtures/pricing-limits.html', import.meta.url), 'utf8');

const rowNamed = (rows: PlanModelRow[], name: string): PlanModelRow =>
  rows.find((r) => r.name === name) ?? (() => { throw new Error(`row not found: ${name}`); })();

describe('parsePlanPage（/docs/plans/goat）', () => {
  it('第一张表解析出 40+ 行模型', () => {
    const { rows, notes } = parsePlanPage(planHtml);
    expect(rows.length).toBeGreaterThanOrEqual(40);
    expect(notes).toEqual([]);
  });

  it('DeepSeek V4.1 Flash：单价、上下文、请求额度、月度额度都对齐上', () => {
    const { rows } = parsePlanPage(planHtml);
    const row = rowNamed(rows, 'DeepSeek V4.1 Flash');
    expect(row.context).toBe('1M');
    expect(row.inputPerM).toBeCloseTo(0.15, 6);
    expect(row.outputPerM).toBeCloseTo(0.6, 6);
    // 来自第二张「Requests / 5 hours | week | month」表，按名字对齐
    expect(row.requests5h).toBe(51300);
    expect(row.requestsWeek).toBe(128000);
    expect(row.requestsMonth).toBe(256000);
    // 来自「Monthly credits」表，单元格是 '$80 $100 through Oct 16th' → 取第一个 $ 数
    expect([80, 100]).toContain(row.monthlyCredits);
    expect(row.free).toBe(false);
  });

  it('第一个表里的名字带促销徽标，也能和第二张表对齐（MiMo V2.5）', () => {
    const { rows } = parsePlanPage(planHtml);
    // 第一张表里显示为 'MiMo V2.5 -98%'，链接文本是干净的 'MiMo V2.5'
    const row = rowNamed(rows, 'MiMo V2.5');
    expect(row.requests5h).toBe(19500);
    expect(row.requestsMonth).toBe(97400);
    expect(row.monthlyCredits).toBe(30);
  });

  // 说明：早先的预期是「Claude Sonnet 5.5 只在第二张表、不在第一张可用模型表」。
  // 实测（2026-10-14 抓的 goat 页）第一张表里**也有** Claude Sonnet 5.5（第 4 行，$2.00 / $10.00），
  // 所以这里断言它两张表都能解析到，并以按模型的请求/月度额度为准。
  it('Claude Sonnet 5.5 带按模型的请求额度与月度额度（GOAT 的 per-model allowance）', () => {
    const { rows } = parsePlanPage(planHtml);
    const row = rowNamed(rows, 'Claude Sonnet 5.5');
    // 第一张可用模型表里有它的单价
    expect(row.inputPerM).toBeCloseTo(2.0, 6);
    expect(row.outputPerM).toBeCloseTo(10.0, 6);
    // 请求额度来自第二张表；月度额度来自那张只列 Claude 的小表（第 4 张物理表）
    expect(row.requests5h).toBe(238);
    expect(row.requestsMonth).toBe(1190);
    expect(row.monthlyCredits).toBe(10);
  });

  it("Free → 0 且 free=true；脚注 '+1' 进 caps；'—' → null", () => {
    const { rows } = parsePlanPage(planHtml);

    const free = rowNamed(rows, 'Glyph Cluster');
    expect(free.free).toBe(true);
    expect(free.inputPerM).toBe(0);
    expect(free.outputPerM).toBe(0);
    expect(free.cacheReadPerM).toBe(0);
    expect(free.cacheWritePerM).toBeNull();

    // Claude Haiku 5.5 的价格格是 '$0.10 + 1'，脚注记进 caps
    const haiku = rowNamed(rows, 'Claude Haiku 5.5');
    expect(haiku.inputPerM).toBeCloseTo(0.1, 6);
    expect(haiku.outputPerM).toBeCloseTo(0.5, 6);
    expect(haiku.cacheWritePerM).toBeCloseTo(0.125, 6);
    expect(haiku.caps).toContain('+1');
  });

  it('未评分的模型 intelligence 记 null，拿得到分数时保留字符串', () => {
    const { rows } = parsePlanPage(planHtml);
    expect(rowNamed(rows, 'Claude Sonnet 5.5').intelligence).toBe('56.0');
    expect(rowNamed(rows, 'Claude Haiku 5.5').intelligence).toBeNull();
  });
});

describe('parsePricingPage（/docs/resources/pricing-limits）', () => {
  it('解析出 80+ 行，含 Laguna S 2.1 且 free=true', () => {
    const { rows } = parsePricingPage(pricingHtml);
    expect(rows.length).toBeGreaterThanOrEqual(80);
    const laguna = rowNamed(rows, 'Laguna S 2.1');
    expect(laguna.free).toBe(true);
    expect(laguna.inputPerM).toBe(0);
    expect(laguna.outputPerM).toBe(0);
    expect(laguna.context).toBe('256K');
  });

  it('付费模型的单价来自 JSON 的 tiers[0].rates', () => {
    const { rows } = parsePricingPage(pricingHtml);
    const kimi = rowNamed(rows, 'Kimi K2.5');
    expect(kimi.free).toBe(false);
    expect(kimi.inputPerM).toBeCloseTo(0.6, 6);
    expect(kimi.outputPerM).toBeCloseTo(3, 6);
    expect(kimi.cacheReadPerM).toBeCloseTo(0.1, 6);
    expect(kimi.cacheWritePerM).toBeNull();
  });
});

describe('截断 / 垃圾 HTML 不抛错', () => {
  it('计划页：只给前 2000 字符 → 空行 + notes', () => {
    const { rows, notes } = parsePlanPage(planHtml.slice(0, 2000));
    expect(rows).toEqual([]);
    expect(notes.length).toBeGreaterThan(0);
  });

  it('价目页：只给前 2000 字符 → 空行 + notes', () => {
    const { rows, notes } = parsePricingPage(pricingHtml.slice(0, 2000));
    expect(rows).toEqual([]);
    expect(notes.length).toBeGreaterThan(0);
  });

  it('纯垃圾字符串也不抛错', () => {
    expect(parsePlanPage('<html><body>oops').rows).toEqual([]);
    expect(parsePricingPage('not html at all').rows).toEqual([]);
    expect(parsePlanPage('').notes.length).toBeGreaterThan(0);
  });
});

describe('planSlugFor', () => {
  it('认出各套餐及其变体', () => {
    expect(planSlugFor('individual-goat')).toBe('goat');
    expect(planSlugFor('individual-go')).toBe('go');
    expect(planSlugFor('individual-go-v1')).toBe('go');
    expect(planSlugFor('individual-pro-v1')).toBe('pro');
    expect(planSlugFor('individual-pro')).toBe('pro');
    expect(planSlugFor('individual-max')).toBe('max');
    expect(planSlugFor('individual-ultra')).toBe('ultra');
    expect(planSlugFor('individual-provider')).toBe('provider');
    expect(planSlugFor('teams-pro')).toBe('teams-pro');
  });

  it('认不出、为空返回 null', () => {
    expect(planSlugFor(null)).toBeNull();
    expect(planSlugFor('')).toBeNull();
    expect(planSlugFor('something-else')).toBeNull();
  });
});

describe('fetchPlanPricing 缓存行为', () => {
  const fakeModel: PlanModelRow = {
    name: 'Fake Model',
    context: null,
    intelligence: null,
    inputPerM: 1,
    outputPerM: 2,
    cacheReadPerM: null,
    cacheWritePerM: null,
    caps: [],
    requests5h: null,
    requestsWeek: null,
    requestsMonth: null,
    monthlyCredits: null,
    free: false,
  };

  it('fetch 失败 + 已有（过期）缓存 → via=cache 且 reason 非空', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pricing-cache-'));
    const cacheFile = join(dir, 'pricing.json');
    writeFileSync(
      cacheFile,
      JSON.stringify({
        planId: 'individual-goat',
        planLabel: 'GOAT',
        slug: 'goat',
        url: 'https://commandcode.ai/docs/plans/goat',
        fetchedAt: 1, // 早就过期
        models: [fakeModel],
      }),
    );

    const pricing = await fetchPlanPricing({
      planId: 'individual-goat',
      cacheFile,
      now: 10_000_000_000_000,
      fetchImpl: (async () => {
        throw new Error('network down');
      }) as unknown as typeof fetch,
    });

    expect(pricing.via).toBe('cache');
    expect(pricing.reason).toBeTruthy();
    expect(pricing.models[0]?.name).toBe('Fake Model');
  });

  it('抓取成功 → via=live、落缓存；随后在新缓存文件上重复使用', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pricing-live-'));
    const cacheFile = join(dir, 'pricing.json');
    const live = await fetchPlanPricing({
      planId: 'individual-goat',
      cacheFile,
      now: 1000,
      fetchImpl: (async () => new Response(planHtml, { status: 200 })) as unknown as typeof fetch,
    });
    expect(live.via).toBe('live');
    expect(live.reason).toBeNull();
    expect(live.planLabel).toBe('GOAT');
    expect(live.slug).toBe('goat');
    expect(live.models.length).toBeGreaterThanOrEqual(40);
    expect(live.models.find((m) => m.name === 'DeepSeek V4.1 Flash')?.requests5h).toBe(51300);

    // 缓存新鲜（maxAge 之内）→ 直接用缓存，不再打网络
    const cached = await fetchPlanPricing({
      planId: 'individual-goat',
      cacheFile,
      now: 2000,
      fetchImpl: (async () => {
        throw new Error('should not be called');
      }) as unknown as typeof fetch,
    });
    expect(cached.via).toBe('cache');
    expect(cached.reason).toBeTruthy();
    expect(cached.models.length).toBeGreaterThanOrEqual(40);
  });

  it('抓取失败且无缓存 → 空结果 + reason', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pricing-none-'));
    const pricing = await fetchPlanPricing({
      planId: 'individual-goat',
      cacheFile: join(dir, 'missing.json'),
      now: 1000,
      fetchImpl: (async () => {
        throw new Error('ENOTFOUND');
      }) as unknown as typeof fetch,
    });
    expect(pricing.via).toBe('live');
    expect(pricing.models).toEqual([]);
    expect(pricing.reason).toBeTruthy();
  });
});
