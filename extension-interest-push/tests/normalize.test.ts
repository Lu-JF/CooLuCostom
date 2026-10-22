/**
 * 规范化层单测：JATS/HTML 去标签、压空白、作者与团队提取、日期补全、id 与 sourceDetail。
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_JOURNALS } from '../src/journals.ts';
import { normalizeArxiv, normalizeCrossref, normalizeHf, sha1Short } from '../src/sources.ts';

/** 测试内独立计算的 sha1 前 8 位，用来对照实现。 */
function sha1_8(input: string): string {
  return createHash('sha1').update(input, 'utf8').digest('hex').slice(0, 8);
}

// query 就是 fetch.ts 传给 normalized 的窗口标注，抓取端写作 `created:<日期>`
const CTX = { issn: '0888-3270', tier: '中科院一区 · JCR Q1', query: 'created:2026-09-18' };

const CROSSREF_ITEM = {
  DOI: '10.1016/j.ymssp.2026.115080',
  title: ['<jats:italic>Rolling</jats:italic> bearing   <jats:bold>fault</jats:bold> diagnosis'],
  author: [
    { given: 'Zhipeng', family: 'Feng', affiliation: [{ name: "Xi'an Jiaotong University" }] },
    { given: 'Zhipeng', family: 'Feng', affiliation: [{ name: 'Duplicated Author' }] },
    { given: 'Zian', family: 'Li', affiliation: [] },
  ],
  'container-title': ['Mechanical Systems and Signal Processing'],
  abstract: '<jats:p>Fault   diagnosis   via   <jats:italic>deep</jats:italic> learning.</jats:p>',
  issued: { 'date-parts': [[2026, 9]] },
  URL: 'https://doi.org/10.1016/j.ymssp.2026.115080',
  link: [
    { URL: 'https://api.elsevier.com/content/article/PII:S0888327026012379?httpAccept=text/xml', 'content-type': 'text/xml' },
    { URL: 'https://arxiv.org/pdf/2601.00001', 'content-type': 'application/pdf' },
  ],
};

describe('sha1Short', () => {
  it('取 sha1 十六进制前 8 位', () => {
    expect(sha1Short('abc')).toBe('a9993e36');
    expect(sha1Short('abc')).toHaveLength(8);
  });
});

describe('DEFAULT_JOURNALS', () => {
  it('恰好 28 条，ISSN 唯一，tierBasis 统一', () => {
    expect(DEFAULT_JOURNALS).toHaveLength(28);
    expect(new Set(DEFAULT_JOURNALS.map((j) => j.issn)).size).toBe(28);
    expect(new Set(DEFAULT_JOURNALS.map((j) => j.tierBasis))).toEqual(new Set(['2025 中科院分区表 · JCR 2024']));
    expect(DEFAULT_JOURNALS.every((j) => ['A', 'B', 'C', 'D'].includes(j.group))).toBe(true);
  });
});

describe('normalizeCrossref', () => {
  it('去 JATS 标签并压缩连续空白', () => {
    const item = normalizeCrossref(CROSSREF_ITEM, CTX);
    expect(item.title).toBe('Rolling bearing fault diagnosis');
    expect(item.abstract).toBe('Fault diagnosis via deep learning.');
    expect(item.journal).toBe('Mechanical Systems and Signal Processing');
  });

  it('作者按 given family 拼接并去重，机构取第一个非空 affiliation', () => {
    const item = normalizeCrossref(CROSSREF_ITEM, CTX);
    expect(item.authors).toEqual(['Zhipeng Feng', 'Zian Li']);
    expect(item.affiliation).toBe("Xi'an Jiaotong University");
  });

  it('date-parts 缺月日时补 01', () => {
    expect(normalizeCrossref({ ...CROSSREF_ITEM, issued: { 'date-parts': [[2026, 9]] } }, CTX).issued).toBe('2026-09-01');
    expect(normalizeCrossref({ ...CROSSREF_ITEM, issued: { 'date-parts': [[2026]] } }, CTX).issued).toBe('2026-01-01');
    expect(normalizeCrossref({ ...CROSSREF_ITEM, issued: { 'date-parts': [[2026, 9, 3]] } }, CTX).issued).toBe('2026-09-03');
  });

  it('id 为 sha1 前 8 位，优先用 DOI', () => {
    const item = normalizeCrossref(CROSSREF_ITEM, CTX);
    expect(item.id).toBe(sha1_8('10.1016/j.ymssp.2026.115080'));
    expect(item.id).toHaveLength(8);
  });

  it('无 DOI 时 id 用标题+日期，doi 为 null', () => {
    const item = normalizeCrossref({ title: ['No DOI here'], issued: { 'date-parts': [[2026, 1, 2]] } }, CTX);
    expect(item.id).toBe(sha1_8('No DOI here2026-01-02'));
    expect(item.doi).toBeNull();
    expect(item.url).toBe('');
  });

  it('sourceDetail 带上 issn 与 query', () => {
    expect(normalizeCrossref(CROSSREF_ITEM, CTX).sourceDetail).toBe('crossref:0888-3270?created:2026-09-18');
  });

  it('pdfUrl：仅公开域名或 .pdf 结尾的 PDF 链接', () => {
    expect(normalizeCrossref(CROSSREF_ITEM, CTX).pdfUrl).toBe('https://arxiv.org/pdf/2601.00001');
    const xmlOnly = { ...CROSSREF_ITEM, link: [{ URL: 'https://api.elsevier.com/x?httpAccept=text/xml', 'content-type': 'text/xml' }] };
    expect(normalizeCrossref(xmlOnly, CTX).pdfUrl).toBeNull();
    const publisherPdf = { ...CROSSREF_ITEM, link: [{ URL: 'https://onlinelibrary.wiley.com/doi/pdf/10.1002/x', 'content-type': 'application/pdf' }] };
    expect(normalizeCrossref(publisherPdf, CTX).pdfUrl).toBeNull();
    const doajPdf = { ...CROSSREF_ITEM, link: [{ URL: 'https://doaj.org/article/x/download', 'content-type': 'application/pdf' }] };
    expect(normalizeCrossref(doajPdf, CTX).pdfUrl).toBe('https://doaj.org/article/x/download');
  });

  it('abstract 为空串时算空', () => {
    expect(normalizeCrossref({ ...CROSSREF_ITEM, abstract: '' }, CTX).abstract).toBe('');
  });

  it('接受整段 Crossref 响应并取第一条', () => {
    const item = normalizeCrossref({ message: { items: [CROSSREF_ITEM] } }, CTX);
    expect(item.title).toBe('Rolling bearing fault diagnosis');
  });
});

describe('normalizeArxiv', () => {
  it('规范化标题/作者/日期并给出 pdfUrl 与 sourceDetail', () => {
    const item = normalizeArxiv(
      {
        title: 'Fault   diagnosis of <b>bearings</b>',
        link: 'https://arxiv.org/abs/2601.12345',
        summary: 'We  study  bearings.',
        published: '2026-09-18T00:00:00Z',
        authors: ['A B', 'A B', 'C D'],
      },
      { category: 'eess.SP' },
    );
    expect(item.title).toBe('Fault diagnosis of bearings');
    expect(item.authors).toEqual(['A B', 'C D']);
    expect(item.issued).toBe('2026-09-18');
    expect(item.pdfUrl).toBe('https://arxiv.org/pdf/2601.12345');
    expect(item.journal).toBe('arXiv eess.SP');
    expect(item.source).toBe('arxiv');
    expect(item.sourceDetail).toBe('arxiv:eess.SP');
    expect(item.id).toBe(sha1_8('Fault diagnosis of bearings2026-09-18'));
  });
});

describe('normalizeHf', () => {
  it('规范化 Daily Papers 行', () => {
    const item = normalizeHf(
      {
        paper: {
          id: '2610.21185',
          title: 'A  Title',
          authors: [{ name: 'K T' }, { name: 'K T' }, { name: 'M S' }],
          summary: '  summary  ',
        },
        publishedAt: '2026-10-15T00:00:00.000Z',
      },
      null,
    );
    expect(item.title).toBe('A Title');
    expect(item.authors).toEqual(['K T', 'M S']);
    expect(item.issued).toBe('2026-10-15');
    expect(item.url).toBe('https://huggingface.co/papers/2610.21185');
    expect(item.pdfUrl).toBe('https://arxiv.org/pdf/2610.21185');
    expect(item.journal).toBe('Hugging Face Daily Papers');
    expect(item.source).toBe('hf');
    expect(item.sourceDetail).toBe('hf:daily_papers');
  });
});
