/**
 * 期刊识别与校验：ISSN 校验位、Crossref 存在性、保存时试抓、全量检测。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INTEREST_PUSH_DEFAULTS, type InterestPushConfigSection } from '../src/config.ts';
import { normalizeIssn } from '../src/journal.ts';
import { InterestPushWorld } from '../src/world.ts';
import { FakeHost } from './helpers/fake-host.ts';

function makeWorld(fetchImpl: typeof fetch) {
  const dataDir = mkdtempSync(join(tmpdir(), 'ip-journal-'));
  const cfg: InterestPushConfigSection = {
    ...INTEREST_PUSH_DEFAULTS,
    journals: [{ label: 'Mechanical Systems and Signal Processing', issn: '0888-3270', tier: '中科院一区 · JCR Q1', tierBasis: 'x' }],
    keywords: ['bearing fault diagnosis'],
  };
  const world = new InterestPushWorld({
    cfg,
    timezone: 'Asia/Shanghai',
    dataDir,
    botDir: dataDir,
    persist: (patch) => Object.assign(cfg, patch),
    fetchImpl,
    now: () => Date.parse('2026-10-20T10:00:00+08:00'),
  });
  return { world, cfg, host: new FakeHost() };
}

/** Crossref 三件事：期刊元数据、最新一篇、最早一篇。 */
function crossrefMock(opts: { title?: string; latest?: string; missing?: boolean }): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (!url.includes('api.crossref.org')) return new Response('{}', { status: 404 });
    if (opts.missing === true) return new Response('{"status":"error"}', { status: 404 });
    const isWorks = url.includes('/works');
    if (!isWorks) {
      return new Response(JSON.stringify({ message: { title: opts.title ?? 'Measurement', ISSN: ['0263-2241'] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const newest = url.includes('order=desc');
    const items = newest
      ? [{ title: [opts.latest ?? 'A recent paper'], published: { 'date-parts': [[2026, 9, 1]] } }]
      : [{ title: ['An early paper'], published: { 'date-parts': [[2005, 1, 1]] } }];
    return new Response(JSON.stringify({ message: { items } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

describe('ISSN 规范化', () => {
  it('带不带连字符都收成 XXXX-XXXX', () => {
    expect(normalizeIssn('08883270')).toBe('0888-3270');
    expect(normalizeIssn(' 0888-3270 ')).toBe('0888-3270');
    expect(normalizeIssn('2049-3630')).toBe('2049-3630');
  });

  it('校验位不对、位数不对都拒绝', () => {
    expect(normalizeIssn('0888-3271')).toBeNull();
    expect(normalizeIssn('0888-327')).toBeNull();
    expect(normalizeIssn('abcd-efgh')).toBeNull();
  });
});

describe('新增期刊', () => {
  it('ISSN 有效时自动填刊名与分区，并试抓一篇后入库', async () => {
    const { world, cfg, host } = makeWorld(crossrefMock({ title: 'Measurement', latest: 'Rolling bearing fault diagnosis review' }));
    await world.start(host.asHost() as never);
    const out = (await world.invoke('settings', 'addJournal', ['02632241'], 'zh')) as { ok: boolean; reason?: string };
    expect(out.ok).toBe(true);
    expect(String(out.reason)).toContain('保存成功');
    expect(String(out.reason)).toContain('Measurement');
    expect(String(out.reason)).toContain('Rolling bearing fault diagnosis review');
    expect(cfg.journals.map((j) => j.issn)).toContain('0263-2241');
    const added = cfg.journals.find((j) => j.issn === '0263-2241');
    expect(added?.label).toBe('Measurement');
    expect(added?.tier).toBe('JCR Q1');
  });

  it('Crossref 没有这家刊就不入库', async () => {
    const { world, cfg, host } = makeWorld(crossrefMock({ missing: true }));
    await world.start(host.asHost() as never);
    const before = cfg.journals.length;
    const out = (await world.invoke('settings', 'addJournal', ['0263-2241'], 'zh')) as { ok: boolean; reason?: string };
    expect(out.ok).toBe(false);
    expect(String(out.reason)).toContain('0263-2241');
    expect(cfg.journals).toHaveLength(before);
  });

  it('ISSN 校验位不对直接拒绝，不打网络', async () => {
    let calls = 0;
    const counting = (async () => {
      calls += 1;
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    const { world, host } = makeWorld(counting);
    await world.start(host.asHost() as never);
    calls = 0; // 启动时自己会抓一轮，这里只数新增期刊打的请求
    const out = (await world.invoke('settings', 'addJournal', ['0888-3271'], 'zh')) as { ok: boolean };
    expect(out.ok).toBe(false);
    expect(calls).toBe(0);
  });

  it('重复的期刊不再添加', async () => {
    const { world, host } = makeWorld(crossrefMock({}));
    await world.start(host.asHost() as never);
    const out = (await world.invoke('settings', 'addJournal', ['0888-3270'], 'zh')) as { ok: boolean; reason?: string };
    expect(out.ok).toBe(false);
    expect(String(out.reason)).toContain('0888-3270');
  });
});

describe('检测全部期刊与增删', () => {
  it('检测结果给出可抓取的家数与逐条明细', async () => {
    const { world, cfg, host } = makeWorld(crossrefMock({}));
    await world.start(host.asHost() as never);
    cfg.journals = [
      { label: 'Good', issn: '0888-3270', tier: 'x', tierBasis: 'x' },
      { label: 'Bad', issn: '2049-3630', tier: 'x', tierBasis: 'x' },
    ];
    const out = (await world.invoke('settings', 'testJournals', [], 'zh')) as { ok: boolean; reason?: string };
    expect(out.ok).toBe(true);
    expect(String(out.reason)).toContain('2/2');
    expect(world.view('zh').journalTest.results).toHaveLength(2);
  });

  it('删除期刊与术语表增删都落到配置里', async () => {
    const { world, cfg, host } = makeWorld(crossrefMock({}));
    await world.start(host.asHost() as never);
    await world.invoke('settings', 'removeJournal', ['0888-3270'], 'zh');
    expect(cfg.journals).toHaveLength(0);

    await world.invoke('settings', 'addTerm', ['gearbox | 齿轮箱'], 'zh');
    expect(cfg.glossary).toContain('gearbox | 齿轮箱');
    const dup = (await world.invoke('settings', 'addTerm', ['gearbox | 齿轮箱'], 'zh')) as { ok: boolean };
    expect(dup.ok).toBe(false);

    await world.invoke('settings', 'removeTerm', ['gearbox | 齿轮箱'], 'zh');
    expect(cfg.glossary).not.toContain('gearbox | 齿轮箱');
  });
});
