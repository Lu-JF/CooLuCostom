/**
 * 自动推送的挑条规则（纯函数）：
 * 跳过已读 / 已推过 / 判过「不感兴趣」的，优先挑有摘要的那条；开了「只推有摘要」时，
 * 没有带摘要的就一个都不推。
 */
import { describe, expect, it } from 'vitest';
import { pickPushCandidate } from '../src/pick.ts';
import type { NewsItem } from '../src/view-types.ts';

const base = {
  doi: null, title: 'T', authors: [], team: null, journal: 'Measurement', journalIssn: null, tier: null,
  issued: '2026-10-01', url: 'https://example.org', pdfUrl: null, source: 'crossref' as const,
  sourceDetail: 'crossref', foundAt: 1, abstract: 'Abstract.',
};

const item = (id: string, abstract = 'Abstract.'): NewsItem => ({ ...base, id, abstract });
const none = { read: [] as string[], pushedIds: [] as string[], dismissed: [] as string[], requireAbstract: true };

describe('自动推送的挑条', () => {
  it('跳过已读、已推过与判过不感兴趣的', () => {
    const items = [item('a'), item('b'), item('c')];
    expect(pickPushCandidate(items, { ...none, read: ['a'] })?.id).toBe('b');
    expect(pickPushCandidate(items, { ...none, pushedIds: ['a', 'b'] })?.id).toBe('c');
    expect(pickPushCandidate(items, { ...none, dismissed: ['a', 'b'] })?.id).toBe('c');
    expect(pickPushCandidate(items, { ...none, read: ['a'], pushedIds: ['b'], dismissed: ['c'] })).toBeNull();
  });

  it('优先挑有摘要的那条，即便它排在后面', () => {
    const items = [item('no-ab', ''), item('with-ab')];
    expect(pickPushCandidate(items, none)?.id).toBe('with-ab');
  });

  it('只推有摘要时，没有一条带摘要就不推', () => {
    expect(pickPushCandidate([item('x', ''), item('y', '')], none)).toBeNull();
  });

  it('关掉「只推有摘要」才退而推最新那条', () => {
    expect(pickPushCandidate([item('x', '')], { ...none, requireAbstract: false })?.id).toBe('x');
  });

  it('空名单返回 null', () => {
    expect(pickPushCandidate([], none)).toBeNull();
  });
});
