/**
 * World 的集成测试：注入假网络与固定时钟，验证「抓取 → 去重落盘 → 推送事件 → 读回执 → 翻译」这条链路。
 * 宿主事件库与 pushEvent 由 `helpers/fake-host.ts` 提供。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INTEREST_PUSH_DEFAULTS, type InterestPushConfigSection } from '../src/config.ts';
import { InterestPushWorld } from '../src/world.ts';
import type { InterestPushView } from '../src/view-types.ts';
import { FakeHost } from './helpers/fake-host.ts';

const FIXED = Date.parse('2026-10-19T02:30:00Z'); // 北京时间 10:30

const CROSSREF_ITEM = {
  DOI: '10.1016/j.ymssp.2026.123456',
  title: ['Bearing fault diagnosis under variable speed using a lightweight network'],
  author: [
    { given: 'Jane', family: 'Doe', affiliation: [{ name: 'School of Instrument Science, Southeast University' }] },
    { given: 'Wei', family: 'Zhang' },
  ],
  'container-title': ['Mechanical Systems and Signal Processing'],
  abstract: '<jats:p>We propose a lightweight network for bearing fault diagnosis. Accuracy reaches 99.2% at 1200 rpm.</jats:p>',
  issued: { 'date-parts': [[2026, 10, 1]] },
  URL: 'https://doi.org/10.1016/j.ymssp.2026.123456',
  link: [{ URL: 'https://example.org/paper.pdf', 'content-type': 'application/pdf' }],
};

interface CallLog {
  crossref: number;
  model: number;
}

function makeDeps(log: CallLog): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    if (url.includes('api.crossref.org')) {
      log.crossref += 1;
      return new Response(JSON.stringify({ message: { items: [CROSSREF_ITEM] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/responses')) {
      log.model += 1;
      // 速评的提示词要求「总分：」，翻译没有：按这个区分两条链路，各回各的形状。
      const body = String(init?.body ?? '');
      const text = body.includes('总分：')
        ? '评价：方法不算新，但把变转速下的实测做扎实了，值得一读。\n总分：7.5'
        : '本文提出一种轻量网络，用于变转速下的轴承故障诊断，准确率 99.2%（1200 rpm）。';
      return new Response(JSON.stringify({ output: [{ content: [{ type: 'output_text', text }] }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
}

function makeBotDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ip-bot-'));
  const provider = join(dir, 'providers', 'CommandCode');
  mkdirSync(provider, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ activeProvider: 'CommandCode' }));
  writeFileSync(join(provider, 'config.json'), JSON.stringify({ baseUrl: 'https://api.example.ai/provider/v1', secret: 'TEST_KEY', spec: { model: 'test-model' } }));
  writeFileSync(join(provider, '.env'), 'TEST_KEY=sk-test\n');
  return dir;
}

function makeWorld(options?: {
  dataDir?: string;
  botDir?: string;
  log?: CallLog;
  persist?: (p: Partial<InterestPushConfigSection>) => void;
  fetchImpl?: typeof fetch;
}) {
  const dataDir = options?.dataDir ?? mkdtempSync(join(tmpdir(), 'ip-data-'));
  const botDir = options?.botDir ?? makeBotDir();
  const log = options?.log ?? { crossref: 0, model: 0 };
  const cfg: InterestPushConfigSection = {
    ...INTEREST_PUSH_DEFAULTS,
    keywords: ['bearing fault diagnosis'],
    journals: [{ label: 'Mechanical Systems and Signal Processing', issn: '0888-3270', tier: '中科院一区 · JCR Q1', tierBasis: '2025 中科院分区表 · JCR 2024', group: 'A' }],
    glossary: ['bearing | 轴承', 'fault diagnosis | 故障诊断'],
    pushTimes: ['10:30'],
    quiet: ['22:30', '08:30'],
  };
  const patches: Array<Partial<InterestPushConfigSection>> = [];
  const world = new InterestPushWorld({
    cfg,
    timezone: 'Asia/Shanghai',
    dataDir,
    botDir,
    persist: (patch) => {
      Object.assign(cfg, patch);
      patches.push(patch);
      options?.persist?.(patch);
    },
    fetchImpl: options?.fetchImpl ?? makeDeps(log),
    now: () => FIXED,
  });
  return { world, host: new FakeHost(), cfg, dataDir, botDir, log, patches };
}

const viewOf = (out: unknown): InterestPushView => (out as { view: InterestPushView }).view;

describe('抓取与列表', () => {
  it('抓到一条就进列表，字段与爬取源都对，并落盘', async () => {
    const { world, host, dataDir } = makeWorld();
    await world.start(host.asHost());
    const view = world.view('zh');
    expect(view.items).toHaveLength(1);
    const item = view.items[0]!;
    expect(item.title).toContain('Bearing fault diagnosis');
    expect(item.journal).toContain('Mechanical Systems');
    expect(item.tier).toContain('中科院一区');
    expect(item.unread).toBe(true);
    const saved = JSON.parse(readFileSync(join(dataDir, 'news', 'items.json'), 'utf8')) as unknown[];
    expect(saved).toHaveLength(1);
    expect(world.view('zh').lastError).toBeNull();
  });

  it('换一个实例读同一个数据目录，不会重复入库', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ip-data-'));
    const first = makeWorld({ dataDir: dir });
    await first.world.start(first.host.asHost());
    const second = makeWorld({ dataDir: dir, botDir: first.botDir });
    await second.world.start(second.host.asHost());
    expect(second.world.view('zh').items).toHaveLength(1);
  });
});

describe('推送与回执', () => {
  it('推一条就发一个 news.item 事件，正文带标题、DOI、爬取源与编号', async () => {
    const { world, host } = makeWorld();
    await world.start(host.asHost());
    await world.invoke('settings', 'pushNow', [], 'zh');
    const pushed = host.pushed.filter((e) => e.type === 'news.item');
    expect(pushed).toHaveLength(1);
    const text = pushed[0]!.text;
    expect(text).toContain('[研究] 订阅推送一条');
    expect(text).toContain('标题：Bearing fault diagnosis');
    expect(text).toContain('DOI：10.1016/j.ymssp.2026.123456');
    expect(text).toContain('爬取源：crossref:0888-3270');
    expect(text).toMatch(/编号 [0-9a-f]{8}/);
    expect(pushed[0]!.trigger).toBe('flush');
  });

  it('推完页签跟到刚推那篇；再点一次换下一篇，不连着推同一篇', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ip-follow-'));
    mkdirSync(join(dataDir, 'news'), { recursive: true });
    const base = {
      doi: null, authors: ['A'], affiliation: null, journal: 'Measurement', journalIssn: '0263-2241',
      tier: '中科院一区', url: 'https://example.org/x', pdfUrl: null, source: 'crossref' as const,
      sourceDetail: 'crossref:0263-2241', foundAt: 1, abstract: 'Abstract about bearings.',
    };
    const newest = { ...base, id: 'aaaa0001', title: 'Newest paper', issued: '2026-10-18' };
    const older = { ...base, id: 'bbbb0002', title: 'Older paper', issued: '2026-10-02' };
    writeFileSync(join(dataDir, 'news', 'items.json'), JSON.stringify([newest, older]));

    const { world, host } = makeWorld({ dataDir });
    await world.start(host.asHost());
    expect(world.view('zh').active?.id).toBe('aaaa0001');

    // 第一次：推页面上那篇，推完页签还是它（气泡讲的就是它）。
    await world.invoke('settings', 'pushNow', [], 'zh');
    let pushed = host.pushed.filter((e) => e.type === 'news.item');
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.senderKey).toBe('aaaa0001');
    expect(world.view('zh').active?.id).toBe('aaaa0001');

    // 第二次：这篇刚推过，换下一篇能推的；页签跟到新的那篇。
    await world.invoke('settings', 'pushNow', [], 'zh');
    pushed = host.pushed.filter((e) => e.type === 'news.item');
    expect(pushed).toHaveLength(2);
    expect(pushed[1]!.senderKey).toBe('bbbb0002');
    expect(world.view('zh').active?.id).toBe('bbbb0002');
  });

  it('页面上那篇没摘要时换下一篇能推的，页签跟过去', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ip-pref-'));
    const botDir = makeBotDir();
    const log = { crossref: 0, model: 0 };
    const withAbstract = { ...CROSSREF_ITEM, DOI: '10.1016/with-abstract', abstract: '<jats:p>Has an abstract.</jats:p>', issued: { 'date-parts': [[2026, 10, 2]] } };
    const without = { ...CROSSREF_ITEM, DOI: '10.1016/no-abstract', abstract: '', issued: { 'date-parts': [[2026, 10, 3]] } };
    const fake = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes('api.crossref.org')) {
        return new Response(JSON.stringify({ message: { items: [without, withAbstract] } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const cfg: InterestPushConfigSection = {
      ...INTEREST_PUSH_DEFAULTS,
      keywords: ['bearing fault diagnosis'],
      journals: [{ label: 'Mechanical Systems and Signal Processing', issn: '0888-3270', tier: 't', tierBasis: 'b', group: 'A' }],
      pushTimes: ['10:30'],
    };
    const world = new InterestPushWorld({
      cfg,
      timezone: 'Asia/Shanghai',
      dataDir,
      botDir,
      persist: (patch) => Object.assign(cfg, patch),
      fetchImpl: fake,
      now: () => FIXED,
    });
    const host = new FakeHost();
    await world.start(host.asHost());
    expect(world.view('zh').items).toHaveLength(2);
    await world.invoke('settings', 'pushNow', [], 'zh');
    const text = host.pushed.filter((e) => e.type === 'news.item')[0]?.text ?? '';
    // 页面上那篇是最新的（没有摘要），推不了：换下一篇有摘要的，页签跟过去。
    expect(world.view('zh').active?.doi).toBe('10.1016/with-abstract');
    expect(text).toContain('DOI：10.1016/with-abstract');
    expect(log.crossref).toBe(0);
  });

  it('没选过条目时，详情默认落在最新的一条上', async () => {
    const { world, host } = makeWorld();
    await world.start(host.asHost());
    const view = world.view('zh');
    expect(view.items).toHaveLength(1);
    expect(view.active?.id).toBe(view.items[0]!.id);
    await world.invoke('detail', 'state', [], 'zh');
    expect(world.view('zh').active?.id).toBe(view.items[0]!.id);
  });

  it('「换一篇」按列表顺序挪到下一条，末尾回到第一条', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ip-next-'));
    const botDir = makeBotDir();
    const first = { ...CROSSREF_ITEM, DOI: '10.1016/first', abstract: '<jats:p>First.</jats:p>', issued: { 'date-parts': [[2026, 10, 3]] } };
    const second = { ...CROSSREF_ITEM, DOI: '10.1016/second', abstract: '<jats:p>Second.</jats:p>', issued: { 'date-parts': [[2026, 10, 2]] } };
    const fake = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes('api.crossref.org')) {
        return new Response(JSON.stringify({ message: { items: [first, second] } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const cfg: InterestPushConfigSection = {
      ...INTEREST_PUSH_DEFAULTS,
      keywords: ['bearing fault diagnosis'],
      journals: [{ label: 'Mechanical Systems and Signal Processing', issn: '0888-3270', tier: 't', tierBasis: 'b', group: 'A' }],
      pushTimes: ['10:30'],
    };
    const world = new InterestPushWorld({ cfg, timezone: 'Asia/Shanghai', dataDir, botDir, persist: (patch) => Object.assign(cfg, patch), fetchImpl: fake, now: () => FIXED });
    const host = new FakeHost();
    await world.start(host.asHost());
    const rows = world.view('zh').items;
    expect(rows).toHaveLength(2);

    await world.invoke('detail', 'state', [rows[0]!.id], 'zh');
    const afterFirst = viewOf(await world.invoke('detail', 'next', [], 'zh'));
    expect(afterFirst.active?.id).toBe(rows[1]!.id);
    // 末条再点一次回到第一条
    const afterSecond = viewOf(await world.invoke('detail', 'next', [], 'zh'));
    expect(afterSecond.active?.id).toBe(rows[0]!.id);
  });

  it('「不感兴趣」的回执会记下，自动推送不再挑它；手动按钮仍以页面为准', async () => {
    const { world, host } = makeWorld();
    await world.start(host.asHost());
    await world.invoke('settings', 'pushNow', [], 'zh');
    // 真实回执长这样（实测）：[answer] Veil回答「这篇要细说吗?」:选了第 3 项「跳过」
    host.seed({ type: 'desktop-pet.answer', text: '[answer] Veil回答「这篇要细说吗?」:选了第 3 项「跳过」' });
    await world.invoke('settings', 'checkNow', [], 'zh');
    // 回执被认领：这条至少标成已读（自动挑条的规则见 pick.test.ts，跳过 dismissed 的那条在那里钉住）。
    expect(world.view('zh').items[0]!.unread).toBe(false);
    // 名单里只剩这一条且被判不感兴趣：手动推也换不出别的，明说没有可推的。
    const out = (await world.invoke('settings', 'pushNow', [], 'zh')) as { ok: boolean; reason: string | null };
    expect(out.ok).toBe(false);
    expect(host.pushed.filter((e) => e.type === 'news.item')).toHaveLength(1);
    expect(world.view('zh').items).toHaveLength(1);
  });
});

describe('补到的摘要会写回已有条目', () => {
  it('第二次抓取补上摘要时，名单里那条被更新', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ip-fill-'));
    const botDir = makeBotDir();
    let withAbstract = false;
    const fake = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes('api.crossref.org')) {
        const item = { ...CROSSREF_ITEM, DOI: '10.1016/late-abstract', abstract: withAbstract ? '<jats:p>Now with an abstract.</jats:p>' : '' };
        return new Response(JSON.stringify({ message: { items: [item] } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const cfg: InterestPushConfigSection = {
      ...INTEREST_PUSH_DEFAULTS,
      keywords: ['bearing fault diagnosis'],
      journals: [{ label: 'Measurement', issn: '0263-2241', tier: 't', tierBasis: 'b', group: 'B' }],
      pushTimes: ['10:30'],
    };
    const world = new InterestPushWorld({ cfg, timezone: 'Asia/Shanghai', dataDir, botDir, persist: (patch) => Object.assign(cfg, patch), fetchImpl: fake, now: () => FIXED });
    const host = new FakeHost();
    await world.start(host.asHost());
    expect(world.view('zh').items[0]!.hasAbstract).toBe(false);
    withAbstract = true;
    await world.invoke('settings', 'checkNow', [], 'zh');
    expect(world.view('zh').items).toHaveLength(1);
    expect(world.view('zh').items[0]!.hasAbstract).toBe(true);
  });
});

describe('兴趣记录', () => {
  it('收进记录、落盘、可移除', async () => {
    const { world, host, dataDir } = makeWorld();
    await world.start(host.asHost());
    const id = world.view('zh').items[0]!.id;
    await world.invoke('detail', 'state', [id], 'zh');
    const saved = viewOf(await world.invoke('detail', 'record', [], 'zh'));
    expect(saved.records).toHaveLength(1);
    expect(saved.records[0]!.id).toBe(id);
    const onDisk = JSON.parse(readFileSync(join(dataDir, 'news', 'records.json'), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(onDisk)).toEqual([id]);

    // 重复收一次不会多出一条
    await world.invoke('detail', 'record', [], 'zh');
    expect(world.view('zh').records).toHaveLength(1);

    const after = viewOf(await world.invoke('records', 'remove', [id], 'zh'));
    expect(after.records).toHaveLength(0);
  });

  it('没选中条目时收不进去也不抛错', async () => {
    const { world, host } = makeWorld();
    const out = (await world.invoke('detail', 'record', [], 'zh')) as { ok: boolean; view: InterestPushView };
    expect(out.ok).toBe(false);
    expect(out.view.records).toHaveLength(0);
    await world.start(host.asHost());
  });
});

describe('只推有摘要的条目', () => {
  it('名单里只有无摘要的条目：没有可推的就明说，不硬推一篇没内容的', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ip-noabs-'));
    const botDir = makeBotDir();
    const noAbstract = { ...CROSSREF_ITEM, DOI: '10.1016/no-abstract-only', abstract: '' };
    const fake = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes('api.crossref.org')) {
        return new Response(JSON.stringify({ message: { items: [noAbstract] } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const cfg: InterestPushConfigSection = {
      ...INTEREST_PUSH_DEFAULTS,
      keywords: ['bearing fault diagnosis'],
      journals: [{ label: 'Measurement', issn: '0263-2241', tier: 't', tierBasis: 'b', group: 'B' }],
      pushTimes: ['10:30'],
      requireAbstract: true,
    };
    const world = new InterestPushWorld({ cfg, timezone: 'Asia/Shanghai', dataDir, botDir, persist: (patch) => Object.assign(cfg, patch), fetchImpl: fake, now: () => FIXED });
    const host = new FakeHost();
    await world.start(host.asHost());
    expect(world.view('zh').items).toHaveLength(1);
    const out = (await world.invoke('settings', 'pushNow', [], 'zh')) as { ok: boolean; reason: string | null };
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('没有可推的条目');
    expect(host.pushed.filter((e) => e.type === 'news.item')).toHaveLength(0);
  });
});

describe('期刊延迟窗口', () => {
  it('太年轻又没摘要的期刊条目会从名单里清掉，够老或已有摘要的留下', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ip-delay-'));
    mkdirSync(join(dataDir, 'news'), { recursive: true });
    const base = {
      doi: '10.1/x', authors: ['A'], affiliation: null, journal: 'Measurement', journalIssn: '0263-2241',
      tier: 't', url: 'https://doi.org/10.1/x', pdfUrl: null, source: 'crossref' as const,
      sourceDetail: 'crossref:0263-2241?created:2026-09-01', foundAt: 1,
    };
    const young = { ...base, id: 'young001', title: 'Too fresh and no abstract', abstract: '', issued: '2026-10-18' };
    const old = { ...base, id: 'old00001', title: 'Old enough, still no abstract', abstract: '', issued: '2026-08-01' };
    const youngWithAbstract = { ...base, id: 'young002', title: 'Fresh but has an abstract', abstract: 'We propose...', issued: '2026-10-18' };
    writeFileSync(join(dataDir, 'news', 'items.json'), JSON.stringify([young, old, youngWithAbstract]));

    const { world, host } = makeWorld({ dataDir });
    await world.start(host.asHost());
    const ids = world.view('zh').items.map((i) => i.id);
    expect(ids).not.toContain('young001');       // 年轻 + 无摘要 → 等摘要，先不出现在名单里
    expect(ids).toContain('old00001');           // 够老 → 留着当线索
    expect(ids).toContain('young002');           // 有摘要 → 立刻可用
  });
});

describe('配置保存', () => {
  it('越界与非法值被夹紧后一次写回', async () => {
    const { world, host, cfg, patches } = makeWorld();
    await world.start(host.asHost());
    await world.invoke('settings', 'saveSettings', [
      {
        checkMinutes: 1,
        pushTimes: '25:00, 09:05',
        dailyCap: 99,
        quiet: 'abc',
        pushDays: ['9'],
        maxRounds: 9,
        keywords: 'bearing\n\ngearbox ',
        journals: [{ label: 'Measurement', issn: '0263-2241', tier: 'JCR Q1', tierBasis: 'x', group: 'B' }, { label: '', issn: 'x' }],
        glossary: 'bearing | 轴承\n',
        arxivCats: 'eess.SP, ',
        windowDays: 0,
        rowsPerJournal: 9999,
        journalDelayDays: 500,
        mailto: 'me@example.org',
        downloadDir: '',
      },
    ], 'zh');
    expect(patches).toHaveLength(1);
    expect(cfg.checkMinutes).toBe(5);
    expect(cfg.pushTimes).toEqual(['09:05']);
    expect(cfg.dailyCap).toBe(10);
    expect(cfg.maxRounds).toBe(5);
    expect(cfg.pushDays).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(cfg.keywords).toEqual(['bearing', 'gearbox']);
    expect(cfg.journals).toHaveLength(1);
    expect(cfg.journals[0]!.label).toBe('Measurement');
    expect(cfg.windowDays).toBe(1);
    expect(cfg.rowsPerJournal).toBe(200);
    expect(cfg.journalDelayDays).toBe(120);
    expect(cfg.arxivCats).toEqual(['eess.SP']);
  });
});

describe('翻译', () => {
  it('按桌宠端点调模型，译文进视图并落缓存；第二次不再花 token', async () => {
    const { world, host, log } = makeWorld();
    await world.start(host.asHost());
    const id = world.view('zh').items[0]!.id;
    await world.invoke('detail', 'state', [id], 'zh');
    const first = viewOf(await world.invoke('detail', 'translate', [], 'zh'));
    expect(first.translation?.ok).toBe(true);
    expect(first.translation?.text).toContain('轴承');
    expect(first.translation?.cached).toBe(false);
    expect(log.model).toBe(1);

    const second = viewOf(await world.invoke('detail', 'translate', [], 'zh'));
    expect(second.translation?.cached).toBe(true);
    expect(log.model).toBe(1);
  });

  it('找不到模型端点时给出原因，不抛错', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'ip-nobot-'));
    const { world, host } = makeWorld({ botDir: bare });
    await world.start(host.asHost());
    const id = world.view('zh').items[0]!.id;
    await world.invoke('detail', 'state', [id], 'zh');
    const out = (await world.invoke('detail', 'translate', [], 'zh')) as { ok: boolean; reason: string; view: InterestPushView };
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('模型端点');
    expect(out.view.translation?.ok).toBe(false);
  });
});

describe('控制台声明', () => {
  it('三个页签、提示词模板与读数都在', async () => {
    const { world, host } = makeWorld();
    await world.start(host.asHost());
    const decl = world.console('zh');
    expect(decl.label).toBe('兴趣推送');
    // 详情排第一：使用者真正要看的是这一页。
    expect(decl.panels?.map((p) => p.id)).toEqual(['detail', 'list', 'records', 'settings']);
    expect(decl.promptDocs?.[0]?.role).toBe('envPrompt');
    expect(decl.lamps?.length).toBe(3);
    // 选项卡上方只有期刊与关键词两个标签；「已暂停」只在真的暂停时才挂（避免「已暂停 off」这种双重否定）。
    expect(decl.badges?.map((b) => b.label)).toEqual(['期刊', '关键词']);
    expect(world.envPromptVars()['interestpush.status']).toContain('今日推送');
  });
});

describe('陈旧条目的清理', () => {
  it('早先按旧规则放进来的 Hugging Face 条目会按现在的相关性规则清掉', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ip-prune-'));
    mkdirSync(join(dataDir, 'news'), { recursive: true });
    const stale = {
      id: 'stale001', doi: null, title: 'StopWatch: Goal Grounding for Object-goal Navigation',
      authors: ['A'], affiliation: null, journal: 'Hugging Face Daily Papers', journalIssn: null, tier: null,
      issued: '2026-10-14', abstract: 'deployed on edge devices for efficient computing',
      url: 'https://huggingface.co/papers/stale001', pdfUrl: null, source: 'hf',
      sourceDetail: 'hf:daily_papers', foundAt: 1,
    };
    const keep = { ...stale, id: 'keep0001', title: 'Bearing fault diagnosis with a lightweight network', abstract: 'bearing fault diagnosis' };
    writeFileSync(join(dataDir, 'news', 'items.json'), JSON.stringify([stale, keep]));
    const { world, host } = makeWorld({ dataDir });
    await world.start(host.asHost());
    const ids = world.view('zh').items.map((i) => i.id);
    expect(ids).not.toContain('stale001');
    expect(ids).toContain('keep0001');
  });
});

describe('部分字段保存不清空名单', () => {
  it('只提交 quiet 时，期刊、关键词、术语表都保持原样', async () => {
    const { world, host } = makeWorld();
    await world.start(host.asHost());
    const before = world.view('zh').config;
    expect(before.journals.length).toBeGreaterThan(0);
    expect(before.glossary.length).toBeGreaterThan(0);
    await world.invoke('settings', 'saveSettings', [{ quiet: ['21:00', '07:00'] }], 'zh');
    const after = world.view('zh').config;
    expect(after.quiet).toEqual(['21:00', '07:00']);
    expect(after.journals.length).toBe(before.journals.length);
    expect(after.keywords).toEqual(before.keywords);
    expect(after.glossary).toEqual(before.glossary);
  });

  it('显式传空数组才会清空（使用者真要清空时）', async () => {
    const { world, host } = makeWorld();
    await world.start(host.asHost());
    await world.invoke('settings', 'saveSettings', [{ keywords: [] }], 'zh');
    expect(world.view('zh').config.keywords).toEqual([]);
  });
});

describe('静默时段保序', () => {
  it('跨夜时段 22:30 → 08:30 保存后不会被排成 08:30 → 22:30', async () => {
    const { world, host } = makeWorld();
    await world.start(host.asHost());
    await world.invoke('settings', 'saveSettings', [{ quiet: ['22:30', '08:30'] }], 'zh');
    expect(world.view('zh').config.quiet).toEqual(['22:30', '08:30']);
    // 反过来写也照原样保留（使用者可能就想设白天静默）
    await world.invoke('settings', 'saveSettings', [{ quiet: ['09:00', '17:00'] }], 'zh');
    expect(world.view('zh').config.quiet).toEqual(['09:00', '17:00']);
  });
});

describe('试推不计入今日次数', () => {
  it('「立刻推一条」不发消息也照样推，但不把今日计数顶上去', async () => {
    const { world, host } = makeWorld();
    await world.start(host.asHost());
    expect(world.view('zh').schedule.pushedToday).toBe(0);
    await world.invoke('settings', 'pushNow', [], 'zh');
    const view = world.view('zh');
    expect(host.pushed.filter((e) => e.type === 'news.item')).toHaveLength(1);
    expect(view.schedule.pushedToday).toBe(0);
  });
});

describe('大肥鱼速评', () => {
  it('推送页与列表共用同一份速评，第二次不再花 token', async () => {
    const { world, host, log } = makeWorld();
    await world.start(host.asHost());
    expect(world.view('zh').items[0]!.review).toBeNull();
    expect(world.view('zh').review?.reason).toBe('none');

    const first = viewOf(await world.invoke('detail', 'review', [], 'zh'));
    expect(first.review?.ok).toBe(true);
    expect(first.review?.total).toBe(7.5);
    expect(first.items[0]!.review?.total).toBe(7.5);
    expect(first.review?.text).toContain('值得一读');

    const calls = log.model;
    const again = viewOf(await world.invoke('list', 'review', [first.items[0]!.id], 'zh'));
    expect(log.model).toBe(calls);
    expect(again.review?.total).toBe(7.5);
  });

  it('推送正文先给速评与分数，再给题录', async () => {
    const { world, host } = makeWorld();
    await world.start(host.asHost());
    await world.invoke('settings', 'pushNow', [], 'zh');
    const pushed = host.pushed.filter((e) => e.type === 'news.item');
    const lines = pushed[0]!.text.split('\n');
    expect(lines[0]).toContain('大肥鱼速评');
    expect(lines[1]).toContain('速评（大肥鱼，7.5/10）');
    expect(lines[2]).toContain('标题：Bearing fault diagnosis');
  });

  it('「立即推一条」推的就是推送页正在看的那篇', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ip-pushnow-'));
    mkdirSync(join(dataDir, 'news'), { recursive: true });
    const base = {
      doi: null, authors: ['A'], affiliation: null, journal: 'Measurement', journalIssn: '0263-2241',
      tier: '中科院一区', url: 'https://example.org/x', pdfUrl: null, source: 'crossref' as const,
      sourceDetail: 'crossref:0263-2241', foundAt: 1, abstract: 'Abstract text about bearings.',
    };
    const newest = { ...base, id: 'aaaa0001', title: 'Newest paper', issued: '2026-10-18' };
    const older = { ...base, id: 'bbbb0002', title: 'Older paper', issued: '2026-10-02' };
    writeFileSync(join(dataDir, 'news', 'items.json'), JSON.stringify([newest, older]));

    const { world, host } = makeWorld({ dataDir });
    await world.start(host.asHost());
    expect(world.view('zh').active?.id).toBe('aaaa0001');

    // 换成看另一篇，再点「立刻推一条」：推的必须是这一篇，不能自己另挑。
    await world.invoke('detail', 'state', ['bbbb0002'], 'zh');
    await world.invoke('settings', 'pushNow', [], 'zh');
    const pushed = host.pushed.filter((e) => e.type === 'news.item');
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.senderKey).toBe('bbbb0002');
    expect(pushed[0]!.text).toContain('标题：Older paper');
  });
});

describe('配置生效与缓存收敛', () => {
  it('改轮数上限后，提示词里的轮数变量跟着变', async () => {
    const { world, host } = makeWorld();
    await world.start(host.asHost());
    expect(world.envPromptVars()['interestpush.rounds']).toBe('3');
    await world.invoke('settings', 'saveSettings', [{ maxRounds: 4 }], 'zh');
    expect(world.envPromptVars()['interestpush.rounds']).toBe('4');
  });

  it('新增推送时刻后，下一个窗口立刻按新配置计算', async () => {
    const { world, host } = makeWorld();
    await world.start(host.asHost());
    await world.invoke('settings', 'saveSettings', [{ pushTimes: ['10:30', '15:35', '19:30'] }], 'zh');
    const next = world.nextWindowAt();
    expect(next).not.toBeNull();
    // FIXED 是 2026-10-19 13:00（本地），下一个窗口应为 15:35
    const at = new Date(next!);
    expect([at.getHours(), at.getMinutes()]).toEqual([15, 35]);
  });

  it('保存「允许推缺摘要」这类开关也会落到配置里', async () => {
    const { world, host, cfg } = makeWorld();
    await world.start(host.asHost());
    expect(cfg.allowNoAbstractPush).toBe(false);
    await world.invoke('settings', 'saveSettings', [{ allowNoAbstractPush: true, requireAbstract: true }], 'zh');
    expect(cfg.allowNoAbstractPush).toBe(true);
    expect(world.view('zh').config.allowNoAbstractPush).toBe(true);
  });

  it('推送时刻落在静默时段时，视图会给出冲突清单', async () => {
    const { world, host } = makeWorld();
    await world.start(host.asHost());
    expect(world.view('zh').config.quietConflicts).toEqual([]);
    await world.invoke('settings', 'saveSettings', [{ quiet: ['10:00', '16:00'] }], 'zh');
    expect(world.view('zh').config.quietConflicts).toEqual(['10:30']);
  });

  it('配置被重置（期刊清空）时，启动会从快照恢复', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ip-snap-'));
    mkdirSync(join(dataDir, 'news'), { recursive: true });
    const journals = Array.from({ length: 6 }, (_, i) => ({
      label: `Journal ${i}`, issn: `0000-000${i}`, tier: 'Q1', tierBasis: 'b', group: 'A',
    }));
    writeFileSync(
      join(dataDir, 'news', 'config-snapshot.json'),
      JSON.stringify({ journals, pushTimes: ['10:30'], keywords: ['bearing'], maxRounds: 4 }),
    );
    const { world, host, cfg, patches } = makeWorld({ dataDir });
    cfg.journals = [];
    await world.start(host.asHost());
    expect(world.view('zh').config.journals.length).toBe(6);
    expect(patches.some((p) => (p.journals ?? []).length === 6)).toBe(true);
  });

  it('不在当前列表里的译文与速评缓存会被清掉', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ip-prune-'));
    for (const dir of ['reviews', 'translated']) {
      mkdirSync(join(dataDir, 'news', dir), { recursive: true });
      writeFileSync(join(dataDir, 'news', dir, 'gone0001.json'), '{}');
    }
    const { world, host } = makeWorld({ dataDir });
    await world.start(host.asHost());
    expect(existsSync(join(dataDir, 'news', 'reviews', 'gone0001.json'))).toBe(false);
    expect(existsSync(join(dataDir, 'news', 'translated', 'gone0001.json'))).toBe(false);
  });
});

describe('推送与面板同一条', () => {
  it('重启后仍停在刚推送的那篇，不改回最新一条', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ip-active-'));
    const first = makeWorld({ dataDir });
    await first.world.start(first.host.asHost());
    await first.world.invoke('detail', 'pushNow', [], 'zh');
    const pushed = first.world.view('zh').active?.id ?? null;
    expect(pushed).not.toBeNull();

    const again = makeWorld({ dataDir });
    await again.world.start(again.host.asHost());
    expect(again.world.view('zh').active?.id).toBe(pushed);
  });

  it('推送与抓取都会让 revision 变化', async () => {
    const { world, host } = makeWorld();
    await world.start(host.asHost());
    const before = world.view('zh').revision;
    await world.invoke('detail', 'pushNow', [], 'zh');
    expect(world.view('zh').revision).toBeGreaterThan(before);
  });
});

/** 两条期刊命中：一条带摘要、一条没有，用来看「无摘要」的兜底。 */
function depsWithBareItem(log: CallLog): typeof fetch {
  const bare = { ...CROSSREF_ITEM, DOI: '10.1000/bare.1', title: ['Bare record without abstract'] };
  delete (bare as Record<string, unknown>).abstract;
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    if (url.includes('api.crossref.org')) {
      log.crossref += 1;
      return new Response(JSON.stringify({ message: { items: [CROSSREF_ITEM, bare] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/responses')) return makeDeps(log)(input, init);
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
}

function markPushed(dataDir: string, ids: string[]): void {
  const file = join(dataDir, 'news', 'state.json');
  const state = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  state.pushedIds = ids;
  writeFileSync(file, JSON.stringify(state));
}

describe('作者机构', () => {
  it('条目没有机构时，按 DOI 从 OpenAlex 补上并写进条目', async () => {
    const log = { crossref: 0, model: 0 };
    const base = makeDeps(log);
    // Crossref 这条不给 affiliation，模拟 Elsevier 的常见情况。
    const bareCrossref = {
      ...CROSSREF_ITEM,
      DOI: '10.1016/j.ymssp.2026.777777',
      author: [{ given: 'Jane', family: 'Doe' }],
    };
    const seen: string[] = [];
    const mock = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      seen.push(url.slice(0, 70));
      if (url.includes('api.crossref.org')) {
        return new Response(JSON.stringify({ message: { items: [bareCrossref] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('api.openalex.org') && url.includes('authorships')) {
        return new Response(
          JSON.stringify({
            results: [
              {
                doi: 'https://doi.org/10.1016/j.ymssp.2026.777777',
                authorships: [
                  { institutions: [{ display_name: 'Southeast University' }] },
                  { institutions: [{ display_name: 'Nanjing University' }] },
                ],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('api.openalex.org')) {
        return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return base(input, init);
    }) as unknown as typeof fetch;

    const { world, host } = makeWorld({ fetchImpl: mock });
    await world.start(host.asHost());
    const item = world.view('zh').active;
    expect(seen.some((u) => u.includes('api.openalex.org'))).toBe(true);
    expect(item?.affiliation).toBe('Southeast University、Nanjing University');
  });
});

describe('可推池耗尽时的手动推送', () => {
  it('只剩无摘要的条目时，立刻推一条照样推出去并说明原因', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ip-bare-'));
    const probe = makeWorld({ dataDir, fetchImpl: depsWithBareItem({ crossref: 0, model: 0 }) });
    await probe.world.start(probe.host.asHost());
    const items = probe.world.view('zh').items;
    const withAbstract = items.filter((i) => i.hasAbstract).map((i) => i.id);
    expect(items.some((i) => !i.hasAbstract)).toBe(true);
    markPushed(dataDir, withAbstract);

    const { world, host, cfg } = makeWorld({ dataDir, fetchImpl: depsWithBareItem({ crossref: 0, model: 0 }) });
    cfg.allowNoAbstractPush = true;
    await world.start(host.asHost());
    const out = (await world.invoke('detail', 'pushNow', [], 'zh')) as { ok: boolean; reason?: string };
    expect(out.ok).toBe(true);
    expect(String(out.reason ?? '')).toContain('摘要');
    expect((world.view('zh').active?.abstract ?? 'x').trim()).toBe('');
    expect(cfg.requireAbstract).toBe(true);
  });

  it('全推过时，错误信息给出构成而不是一句「没有可推的」', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ip-empty-'));
    const probe = makeWorld({ dataDir });
    await probe.world.start(probe.host.asHost());
    markPushed(dataDir, probe.world.view('zh').items.map((i) => i.id));

    const { world, host } = makeWorld({ dataDir });
    await world.start(host.asHost());
    const out = (await world.invoke('detail', 'pushNow', [], 'zh')) as { ok: boolean; reason?: string };
    expect(out.ok).toBe(false);
    const reason = String(out.reason ?? '');
    expect(reason).toContain('已推');
    expect(reason).toMatch(/\d+ 条/);
  });
});
