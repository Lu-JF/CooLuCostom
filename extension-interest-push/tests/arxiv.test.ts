/** arXiv 检索式、Atom 解析与相关性过滤的回归。 */
import { describe, expect, it } from 'vitest';
import { arxivSearchExpression, fetchArxivSearch, parseArxivAtom } from '../src/arxiv.ts';
import { relevant, relevanceTokens } from '../src/relevance.ts';

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2610.01234v1</id>
    <title>A lightweight network for
      bearing fault diagnosis</title>
    <summary>  We propose a lightweight network for bearing fault diagnosis under
      variable speed.  </summary>
    <published>2026-10-16T18:00:00Z</published>
    <author><name>Jane Doe</name></author>
    <author><name>Wei Zhang</name></author>
    <link href="http://arxiv.org/abs/2610.01234v1" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/2610.01234v1" rel="related" type="application/pdf"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2610.05555v1</id>
    <title>Edge deployment of prognostic models</title>
    <summary>Remaining useful life estimation on microcontrollers.</summary>
    <published>2026-10-15T10:00:00Z</published>
    <author><name>Li Ming</name></author>
    <link href="http://arxiv.org/abs/2610.05555v1" rel="alternate" type="text/html"/>
  </entry>
</feed>`;

describe('arXiv 检索', () => {
  it('检索式把每个关键词做成 all:"短语"，之间用 OR', () => {
    expect(arxivSearchExpression(['bearing fault diagnosis', ' edge computing '])).toBe('all:"bearing fault diagnosis" OR all:"edge computing"');
    expect(arxivSearchExpression(['  ', ''])).toBe('');
  });

  it('Atom 条目解析出标题/链接/摘要/时间/作者', () => {
    const entries = parseArxivAtom(ATOM);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.title).toBe('A lightweight network for bearing fault diagnosis');
    expect(entries[0]!.link).toBe('http://arxiv.org/abs/2610.01234v1');
    expect(entries[0]!.published).toBe('2026-10-16T18:00:00Z');
    expect(entries[0]!.authors).toEqual(['Jane Doe', 'Wei Zhang']);
    expect(entries[0]!.summary).toContain('variable speed');
  });

  it('走官方检索 API，返回规范化后的条目并带上 PDF 地址', async () => {
    let seen = '';
    const fake = (async (input: Parameters<typeof fetch>[0]) => {
      seen = String(input);
      return new Response(ATOM, { status: 200, headers: { 'content-type': 'application/atom+xml' } });
    }) as unknown as typeof fetch;

    const items = await fetchArxivSearch({ keywords: ['bearing fault diagnosis'], categories: ['eess.SP'], max: 10 }, { fetchImpl: fake, mailto: 'me@example.org' });
    expect(seen).toContain('export.arxiv.org/api/query');
    expect(seen).toContain('sortBy=submittedDate');
    expect(seen).toContain(encodeURIComponent('all:"bearing fault diagnosis"'));
    expect(items).toHaveLength(2);
    expect(items[0]!.source).toBe('arxiv');
    expect(items[0]!.pdfUrl).toBe('http://arxiv.org/pdf/2610.01234v1');
    expect(items[0]!.issued).toBe('2026-10-16');
  });

  it('关键词为空时退回分类 RSS', async () => {
    const fake = (async () => new Response('<rss><channel></channel></rss>', { status: 200 })) as unknown as typeof fetch;
    const items = await fetchArxivSearch({ keywords: [], categories: ['eess.SP'] }, { fetchImpl: fake, mailto: 'me@example.org' });
    expect(items).toEqual([]);
  });
});

describe('相关性过滤', () => {
  const keywords = ['bearing fault diagnosis', 'rotating machinery', 'neural architecture search', 'edge computing'];

  it('命中短语即相关', () => {
    expect(relevant('A survey on rotating machinery monitoring', keywords)).toBe(true);
  });

  it('两个词根也算相关', () => {
    expect(relevant('Fault diagnosis of wind turbine bearings', keywords)).toBe(true);
  });

  it('通用 AI 标题被挡掉', () => {
    expect(relevant('Reward-Specific Token-level Preference Optimization for LLM Alignment', keywords)).toBe(false);
    expect(relevant('StopWatch: Goal Grounding for Object-goal Navigation, deployed on edge devices for efficient computing', keywords)).toBe(false);
    expect(relevant('', keywords)).toBe(false);
  });

  it('领域词兜底能放行故障诊断类条目', () => {
    expect(relevant('Prognostics and health management for gearbox vibration signals', ['xyz'])).toBe(true);
  });

  it('词根里不含虚词与过泛的词', () => {
    const tokens = relevanceTokens(['neural architecture search', 'learning based method']);
    expect(tokens).toContain('neural');
    expect(tokens).not.toContain('based');
    expect(tokens).not.toContain('learning');
  });
});
