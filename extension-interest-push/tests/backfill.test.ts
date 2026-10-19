/**
 * 三处取数修正的回归：OpenAlex 摘要回填、Crossref 用记录创建日期、桌宠端点查找路径。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fetchJournal, fetchOpenAlexAbstractByTitle, fetchOpenAlexAbstracts, fetchSemanticScholarAbstracts, invertAbstract } from '../src/fetch.ts';
import { providersRoots, resolvePetModel } from '../src/pet-model.ts';

describe('OpenAlex 摘要回填', () => {
  it('倒排索引能还原成连贯文本', () => {
    const text = invertAbstract({ Bearing: [0], fault: [1], diagnosis: [2], at: [3], '1200': [4], rpm: [5] });
    expect(text).toBe('Bearing fault diagnosis at 1200 rpm');
  });

  it('空索引与非对象都返回空串', () => {
    expect(invertAbstract(null)).toBe('');
    expect(invertAbstract({ a: 'x' })).toBe('');
  });

  it('按 DOI 取回摘要，键统一成小写且去掉 https://doi.org/ 前缀', async () => {
    const calls: string[] = [];
    const fake = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      calls.push(url);
      return new Response(
        JSON.stringify({
          results: [
            { doi: 'https://doi.org/10.1016/j.ymssp.2026.1', abstract_inverted_index: { Lightweight: [0], network: [1] } },
            { doi: '10.1109/TIE.2026.2', abstract_inverted_index: { Edge: [0], computing: [1] } },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const out = await fetchOpenAlexAbstracts(['10.1016/J.YMSSP.2026.1', '10.1109/TIE.2026.2'], { fetchImpl: fake, mailto: 'me@example.org' });
    expect(out['10.1016/j.ymssp.2026.1']).toBe('Lightweight network');
    expect(out['10.1109/tie.2026.2']).toBe('Edge computing');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('api.openalex.org');
  });
});

describe('Crossref 查询参数', () => {
  it('按记录创建日期筛与排序，不再按期号日期', async () => {
    let seen = '';
    const fake = (async (input: Parameters<typeof fetch>[0]) => {
      seen = String(input);
      return new Response(JSON.stringify({ message: { items: [] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    await fetchJournal({ issn: '0888-3270', days: 30, rows: 50, keywords: ['bearing'] }, { fetchImpl: fake, mailto: 'me@example.org' });
    expect(seen).toContain('from-created-date');
    expect(seen).toContain('until-created-date');
    expect(seen).toContain('sort=created');
    expect(seen).not.toContain('from-pub-date');
    expect(seen).toContain('query.bibliographic=bearing');
  });
});

describe('桌宠端点查找', () => {
  it('providers 候选路径包含 <botDir>/../providers', () => {
    const roots = providersRoots(join(tmpdir(), 'home', 'companion'));
    expect(roots[0]).toBe(join(tmpdir(), 'home', 'providers'));
  });

  it('能读到位在 botDir 旁边的端点配置与密钥', () => {
    const home = mkdtempSync(join(tmpdir(), 'ip-home-'));
    const botDir = join(home, 'companion');
    const provider = join(home, 'providers', 'CommandCode');
    mkdirSync(botDir, { recursive: true });
    mkdirSync(provider, { recursive: true });
    writeFileSync(join(botDir, 'config.json'), JSON.stringify({ activeProvider: 'CommandCode' }));
    writeFileSync(join(provider, 'config.json'), JSON.stringify({ baseUrl: 'https://api.example.ai/provider/v1', secret: 'SOME_KEY', spec: { model: 'm-1' } }));
    writeFileSync(join(provider, '.env'), 'SOME_KEY=sk-from-env\n');

    const model = resolvePetModel(botDir);
    expect(model).not.toBeNull();
    expect(model!.name).toBe('CommandCode');
    expect(model!.baseUrl).toBe('https://api.example.ai/provider/v1');
    expect(model!.model).toBe('m-1');
    expect(model!.apiKey).toBe('sk-from-env');
  });

  it('找不到端点时返回 null', () => {
    const home = mkdtempSync(join(tmpdir(), 'ip-none-'));
    mkdirSync(join(home, 'companion'), { recursive: true });
    expect(resolvePetModel(join(home, 'companion'))).toBeNull();
  });
});

describe('Semantic Scholar 摘要兜底', () => {
  it('一次 POST 带上所有 DOI，按位置回收摘要', async () => {
    let body = '';
    let url = '';
    const fake = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      url = String(input);
      body = String(init?.body ?? '');
      return new Response(JSON.stringify([{ abstract: 'A lightweight network for bearings.' }, { abstract: null }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const out = await fetchSemanticScholarAbstracts(['10.1016/a', '10.1016/b'], { fetchImpl: fake, mailto: 'me@example.org' });
    expect(url).toContain('/graph/v1/paper/batch');
    expect(JSON.parse(body)).toEqual({ ids: ['DOI:10.1016/a', 'DOI:10.1016/b'] });
    expect(out['10.1016/a']).toBe('A lightweight network for bearings.');
    expect(out['10.1016/b']).toBeUndefined();
  });

  it('批次失败不抛错，返回空表', async () => {
    const fake = (async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch;
    await expect(fetchSemanticScholarAbstracts(['10.1/x'], { fetchImpl: fake, mailto: 'me@example.org' })).resolves.toEqual({});
  });
});

describe('按标题补摘要', () => {
  it('标题对得上才采用，对不上就不要', async () => {
    const fake = (async () =>
      new Response(
        JSON.stringify({
          results: [
            { doi: 'https://doi.org/10.1/x', title: 'Something completely different about birds', abstract_inverted_index: { birds: [0] } },
            { doi: 'https://doi.org/10.1/y', title: 'Bearing fault diagnosis under variable speed', abstract_inverted_index: { We: [0], propose: [1], a: [2], lightweight: [3], network: [4] } },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;
    const text = await fetchOpenAlexAbstractByTitle('Bearing fault diagnosis under variable speed', { fetchImpl: fake, mailto: 'me@example.org' });
    expect(text).toBe('We propose a lightweight network');
  });

  it('查不到或标题太短就返回 null', async () => {
    const empty = (async () => new Response(JSON.stringify({ results: [] }), { status: 200 })) as unknown as typeof fetch;
    await expect(fetchOpenAlexAbstractByTitle('Nothing here matches at all', { fetchImpl: empty, mailto: 'me@example.org' })).resolves.toBeNull();
    await expect(fetchOpenAlexAbstractByTitle('Short', { fetchImpl: empty, mailto: 'me@example.org' })).resolves.toBeNull();
  });
});

describe('可选的配额密钥', () => {
  it('OpenAlex 带 api_key、Semantic Scholar 带 x-api-key', async () => {
    const seen: Array<{ url: string; key: string | null }> = [];
    const fake = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push({ url: String(input), key: headers['x-api-key'] ?? null });
      return new Response(JSON.stringify({ results: [], message: '' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    await fetchOpenAlexAbstracts(['10.1/a'], { fetchImpl: fake, mailto: 'me@example.org', openAlexKey: 'OA-KEY' });
    await fetchOpenAlexAbstractByTitle('A paper title long enough', { fetchImpl: fake, mailto: 'me@example.org', openAlexKey: 'OA-KEY' });
    await fetchSemanticScholarAbstracts(['10.1/a'], { fetchImpl: fake, mailto: 'me@example.org', semanticScholarKey: 'S2-KEY' });

    expect(seen[0]!.url).toContain('api_key=OA-KEY');
    expect(seen[1]!.url).toContain('api_key=OA-KEY');
    expect(seen[2]!.key).toBe('S2-KEY');
  });

  it('不给 key 就不带参数', async () => {
    let url = '';
    const fake = (async (input: Parameters<typeof fetch>[0]) => {
      url = String(input);
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchOpenAlexAbstracts(['10.1/a'], { fetchImpl: fake, mailto: 'me@example.org' });
    expect(url).not.toContain('api_key');
  });
});
