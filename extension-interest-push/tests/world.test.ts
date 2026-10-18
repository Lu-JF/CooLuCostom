/**
 * World 的集成测试：注入假网络与固定时钟，验证「抓取 → 去重落盘 → 推送事件 → 读回执 → 翻译」这条链路。
 * 宿主事件库与 pushEvent 由 `helpers/fake-host.ts` 提供。
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
      return new Response(JSON.stringify({ output: [{ content: [{ type: 'output_text', text: '本文提出一种轻量网络，用于变转速下的轴承故障诊断，准确率 99.2%（1200 rpm）。' }] }] }), {
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

function makeWorld(options?: { dataDir?: string; botDir?: string; log?: CallLog; persist?: (p: Partial<InterestPushConfigSection>) => void }) {
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
    fetchImpl: makeDeps(log),
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
    expect(text).toContain('[研究] Bearing fault diagnosis');
    expect(text).toContain('DOI：10.1016/j.ymssp.2026.123456');
    expect(text).toContain('爬取源：crossref:0888-3270');
    expect(text).toMatch(/编号 [0-9a-f]{8}/);
    expect(pushed[0]!.trigger).toBe('flush');
  });

  it('再点一次不会把同一条推第二遍', async () => {
    const { world, host } = makeWorld();
    await world.start(host.asHost());
    await world.invoke('settings', 'pushNow', [], 'zh');
    await world.invoke('settings', 'pushNow', [], 'zh');
    expect(host.pushed.filter((e) => e.type === 'news.item')).toHaveLength(1);
  });

  it('收到「不感兴趣」的回执后，这条不再被推送', async () => {
    const { world, host } = makeWorld();
    await world.start(host.asHost());
    await world.invoke('settings', 'pushNow', [], 'zh');
    host.seed({ type: 'desktop-pet.answer', text: '不感兴趣' });
    await world.invoke('settings', 'checkNow', [], 'zh');
    await world.invoke('settings', 'pushNow', [], 'zh');
    expect(host.pushed.filter((e) => e.type === 'news.item')).toHaveLength(1);
    expect(world.view('zh').items).toHaveLength(1);
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
    expect(decl.panels?.map((p) => p.id)).toEqual(['list', 'detail', 'settings']);
    expect(decl.promptDocs?.[0]?.role).toBe('envPrompt');
    expect(decl.lamps?.length).toBe(3);
    expect(decl.badges?.[0]?.label).toBe('未读');
    expect(world.envPromptVars()['interest-push.status']).toContain('今日推送');
  });
});
