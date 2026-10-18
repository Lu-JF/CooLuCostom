/**
 * 抓取层单测：Crossref 查询参数、arXiv 搜索式与合并、容错、条件请求 304/200/失败分支。
 */
import { describe, expect, it } from 'vitest';
import { fetchArxiv, fetchConditional, fetchHfDaily, fetchJournal, type FetchDeps } from '../src/fetch.ts';

/** 造一个类 Response 的返回。 */
function mockResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const status = init.status ?? 200;
  const headers = new Map(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

/** 造一个只回文本的返回。 */
function textResponse(text: string): Response {
  return mockResponse(text, { status: 200 });
}

describe('fetchJournal', () => {
  it('Crossref URL 带上必需参数（filter/sort/order/select/关键词/mailto）', async () => {
    let captured = '';
    const deps: FetchDeps = {
      mailto: 'me@example.com',
      fetchImpl: (async (url: string) => {
        captured = String(url);
        return mockResponse({ message: { items: [] } });
      }) as unknown as typeof fetch,
    };

    const out = await fetchJournal(
      { issn: '0888-3270', days: 30, rows: 50, keywords: ['bearing fault diagnosis', 'rotor'] },
      deps,
    );
    expect(out).toEqual([]);

    const url = new URL(captured);
    expect(`${url.origin}${url.pathname}`).toBe('https://api.crossref.org/journals/0888-3270/works');
    expect(url.searchParams.get('filter')).toMatch(/^from-pub-date:\d{4}-\d{2}-\d{2}$/);
    expect(url.searchParams.get('rows')).toBe('50');
    expect(url.searchParams.get('sort')).toBe('published');
    expect(url.searchParams.get('order')).toBe('desc');
    expect(url.searchParams.get('select')).toBe('DOI,title,author,container-title,abstract,issued,URL,link');
    expect(url.searchParams.get('query.bibliographic')).toBe('bearing fault diagnosis rotor');
    expect(url.searchParams.get('mailto')).toBe('me@example.com');
  });

  it('关键词为空时去掉 query.bibliographic', async () => {
    let captured = '';
    const deps: FetchDeps = {
      mailto: 'me@example.com',
      fetchImpl: (async (url: string) => {
        captured = String(url);
        return mockResponse({ message: { items: [] } });
      }) as unknown as typeof fetch,
    };

    await fetchJournal({ issn: '0888-3270', days: 7, rows: 20, keywords: [] }, deps);
    expect(new URL(captured).searchParams.has('query.bibliographic')).toBe(false);
  });

  it('解析条目并注入期刊分区', async () => {
    const deps: FetchDeps = {
      mailto: 'me@example.com',
      fetchImpl: (async () =>
        mockResponse({
          message: {
            items: [
              {
                DOI: '10.1016/j.ymssp.2026.115080',
                title: ['Rolling bearing fault diagnosis'],
                author: [{ given: 'Zhipeng', family: 'Feng' }],
                'container-title': ['Mechanical Systems and Signal Processing'],
                issued: { 'date-parts': [[2026, 9, 18]] },
                URL: 'https://doi.org/10.1016/j.ymssp.2026.115080',
              },
            ],
          },
        })) as unknown as typeof fetch,
    };

    const out = await fetchJournal({ issn: '0888-3270', days: 30, rows: 50, keywords: ['bearing'] }, deps);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('Rolling bearing fault diagnosis');
    expect(out[0].tier).toBe('中科院一区 · JCR Q1');
    expect(out[0].source).toBe('crossref');
  });

  it('单个源报错返回空数组', async () => {
    const deps: FetchDeps = {
      mailto: 'me@example.com',
      fetchImpl: (async () => {
        throw new Error('network down');
      }) as unknown as typeof fetch,
    };
    await expect(fetchJournal({ issn: '0888-3270', days: 30, rows: 50, keywords: ['x'] }, deps)).resolves.toEqual([]);
  });

  it('非 2xx 返回空数组', async () => {
    const deps: FetchDeps = {
      mailto: 'me@example.com',
      fetchImpl: (async () => mockResponse({ message: { items: [] } }, { status: 500 })) as unknown as typeof fetch,
    };
    await expect(fetchJournal({ issn: '0888-3270', days: 30, rows: 50, keywords: ['x'] }, deps)).resolves.toEqual([]);
  });
});

describe('fetchArxiv', () => {
  const RSS = [
    '<rss><channel>',
    '<item>',
    '<title>Fault diagnosis <b>of</b> bearings</title>',
    '<link>https://arxiv.org/abs/2601.00001</link>',
    '<description>arXiv:2601.00001v1 Announce Type: new Abstract: We study bearings.</description>',
    '<pubDate>Fri, 16 Oct 2026 00:00:00 +0000</pubDate>',
    '<dc:creator>Jane Roe</dc:creator>',
    '<dc:creator>Jane Roe</dc:creator>',
    '<dc:creator>John Doe</dc:creator>',
    '</item>',
    '</channel></rss>',
  ].join('');

  it('多词写成 all:"a b" 并用 AND 连接（不能用 +）', async () => {
    let captured = '';
    const deps: FetchDeps = {
      mailto: 'me@example.com',
      fetchImpl: (async (url: string) => {
        captured = String(url);
        return textResponse(RSS);
      }) as unknown as typeof fetch,
    };

    const out = await fetchArxiv({ categories: ['eess.SP'], keywords: ['bearing', 'fault diagnosis'] }, deps);

    expect(captured.startsWith('https://rss.arxiv.org/rss/eess.SP?query=')).toBe(true);
    expect(decodeURIComponent(captured)).toContain('all:bearing AND all:"fault diagnosis"');
    expect(captured).not.toContain('+');
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('Fault diagnosis of bearings');
    expect(out[0].abstract).toBe('We study bearings.');
    expect(out[0].authors).toEqual(['Jane Roe', 'John Doe']);
    expect(out[0].issued).toBe('2026-10-16');
    expect(out[0].pdfUrl).toBe('https://arxiv.org/pdf/2601.00001');
  });

  it('多分类逐分类请求并合并', async () => {
    const urls: string[] = [];
    const deps: FetchDeps = {
      mailto: 'me@example.com',
      fetchImpl: (async (url: string) => {
        urls.push(String(url));
        return textResponse(RSS.replace('Fault diagnosis <b>of</b> bearings', `Title ${urls.length}`));
      }) as unknown as typeof fetch,
    };

    const out = await fetchArxiv({ categories: ['eess.SP', 'eess.AS'], keywords: ['bearing'] }, deps);
    expect(urls).toHaveLength(2);
    expect(out).toHaveLength(2);
  });

  it('单个分类报错不影响其它分类', async () => {
    let n = 0;
    const deps: FetchDeps = {
      mailto: 'me@example.com',
      fetchImpl: (async () => {
        n += 1;
        if (n === 1) throw new Error('boom');
        return textResponse(RSS);
      }) as unknown as typeof fetch,
    };

    const out = await fetchArxiv({ categories: ['eess.SP', 'eess.AS'], keywords: ['bearing'] }, deps);
    expect(out).toHaveLength(1);
  });

  it('全部分类报错返回空数组', async () => {
    const deps: FetchDeps = {
      mailto: 'me@example.com',
      fetchImpl: (async () => {
        throw new Error('boom');
      }) as unknown as typeof fetch,
    };
    await expect(fetchArxiv({ categories: ['eess.SP'], keywords: ['bearing'] }, deps)).resolves.toEqual([]);
  });
});

describe('fetchHfDaily', () => {
  it('解析 Daily Papers 列表', async () => {
    const deps: FetchDeps = {
      mailto: 'me@example.com',
      fetchImpl: (async () =>
        mockResponse([
          {
            paper: { id: '2610.21185', title: 'A Title', authors: [{ name: 'K T' }], summary: 'hello' },
            publishedAt: '2026-10-15T00:00:00.000Z',
          },
        ])) as unknown as typeof fetch,
    };

    const out = await fetchHfDaily(deps);
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('hf');
    expect(out[0].url).toBe('https://huggingface.co/papers/2610.21185');
  });

  it('报错返回空数组', async () => {
    const deps: FetchDeps = {
      mailto: 'me@example.com',
      fetchImpl: (async () => {
        throw new Error('boom');
      }) as unknown as typeof fetch,
    };
    await expect(fetchHfDaily(deps)).resolves.toEqual([]);
  });
});

describe('fetchConditional', () => {
  it('304 返回 notModified，并带上条件头', async () => {
    let sentHeaders: Record<string, string> = {};
    const deps: FetchDeps = {
      mailto: 'me@example.com',
      fetchImpl: (async (_url: string, init: RequestInit) => {
        sentHeaders = (init?.headers ?? {}) as Record<string, string>;
        return mockResponse('', { status: 304 });
      }) as unknown as typeof fetch,
    };

    const res = await fetchConditional(
      'https://example.com/feed',
      { 'https://example.com/feed': { etag: 'W/"1"', lastModified: 'Mon, 01 Jan 2026 00:00:00 GMT' } },
      deps,
    );
    expect(res).toEqual({ notModified: true });
    expect(sentHeaders['If-None-Match']).toBe('W/"1"');
    expect(sentHeaders['If-Modified-Since']).toBe('Mon, 01 Jan 2026 00:00:00 GMT');
  });

  it('200 返回文本与缓存头', async () => {
    const deps: FetchDeps = {
      mailto: 'me@example.com',
      fetchImpl: (async () =>
        mockResponse('<rss/>', { status: 200, headers: { etag: '"abc"', 'last-modified': 'Tue, 02 Jan 2026 00:00:00 GMT' } })) as unknown as typeof fetch,
    };

    const res = await fetchConditional('https://example.com/feed', {}, deps);
    expect(res).toEqual({
      notModified: false,
      text: '<rss/>',
      etag: '"abc"',
      lastModified: 'Tue, 02 Jan 2026 00:00:00 GMT',
    });
  });

  it('失败不抛错，返回空文本', async () => {
    const deps: FetchDeps = {
      mailto: 'me@example.com',
      fetchImpl: (async () => {
        throw new Error('boom');
      }) as unknown as typeof fetch,
    };
    await expect(fetchConditional('https://example.com/feed', {}, deps)).resolves.toEqual({
      notModified: false,
      text: '',
    });
  });

  it('非 2xx 且非 304 返回空文本', async () => {
    const deps: FetchDeps = {
      mailto: 'me@example.com',
      fetchImpl: (async () => mockResponse('oops', { status: 500 })) as unknown as typeof fetch,
    };
    await expect(fetchConditional('https://example.com/feed', {}, deps)).resolves.toEqual({
      notModified: false,
      text: '',
    });
  });
});
