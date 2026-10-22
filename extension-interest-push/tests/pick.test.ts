/**
 * 自动推送的挑条规则（纯函数）：
 * 跳过已读 / 已推过 / 判过「不感兴趣」的，优先挑有摘要的那条；开了「只推有摘要」时，
 * 没有带摘要的就一个都不推。
 */
import { describe, expect, it } from 'vitest';
import { isPushable, keepsInPool, pickManualCandidate, pickPushCandidate, sortForList } from '../src/pick.ts';
import type { NewsItem } from '../src/view-types.ts';

const base = {
  doi: null, title: 'T', authors: [], affiliation: null,
    venue: null, journal: 'Measurement', journalIssn: null, tier: null,
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

describe('「立刻推一条」挑哪条', () => {
  it('页面上那篇能推就推它', () => {
    const items = [item('a'), item('b')];
    expect(pickManualCandidate(items, items[0]!, none)?.id).toBe('a');
  });

  it('页面上那篇推过 / 判过不感兴趣了，就顺延下一篇', () => {
    const items = [item('a'), item('b'), item('c')];
    expect(pickManualCandidate(items, items[0]!, { ...none, pushedIds: ['a'] })?.id).toBe('b');
    expect(pickManualCandidate(items, items[1]!, { ...none, dismissed: ['b'] })?.id).toBe('c');
  });

  it('页面上那篇没摘要，换成下一篇有摘要的', () => {
    const items = [item('no-ab', ''), item('with-ab')];
    expect(pickManualCandidate(items, items[0]!, none)?.id).toBe('with-ab');
  });

  it('从当前这篇往后找，末尾绕回名单开头', () => {
    const items = [item('a'), item('b'), item('c')];
    // 当前是最后一条且推不了：绕回第一条能推的
    expect(pickManualCandidate(items, items[2]!, { ...none, pushedIds: ['c'] })?.id).toBe('a');
  });

  it('一条都推不了返回 null', () => {
    const items = [item('a', ''), item('b', '')];
    expect(pickManualCandidate(items, items[0]!, none)).toBeNull();
  });

  it('isPushable 单独判：推过、判过不感兴趣、没摘要（按设置）都不行', () => {
    expect(isPushable(item('a'), none)).toBe(true);
    expect(isPushable(item('a'), { ...none, pushedIds: ['a'] })).toBe(false);
    expect(isPushable(item('a'), { ...none, dismissed: ['a'] })).toBe(false);
    expect(isPushable(item('a', ''), none)).toBe(false);
    expect(isPushable(item('a', ''), { ...none, requireAbstract: false })).toBe(true);
  });
});

describe('列表排序与候选池', () => {
  const base = { doi: null, title: 'T', authors: [], affiliation: 'X', venue: null, journal: 'Measurement', journalIssn: null, tier: null, issued: '2026-10-01', abstract: 'A', url: 'u', pdfUrl: null, source: 'crossref' as const, sourceDetail: 'd', foundAt: 0 };

  it('已见刊的排在预印本前面，同组内按上线日期倒序', () => {
    const items = [
      { ...base, id: 'a', venue: null, issued: '2026-10-19' },
      { ...base, id: 'b', venue: 'Measurement', issued: '2026-09-30' },
      { ...base, id: 'c', venue: null, issued: '2026-10-10' },
    ];
    expect(sortForList(items).map((i) => i.id)).toEqual(['b', 'a', 'c']);
  });

  it('机构查过但没有的条目出池，没查过的与已推过的保留', () => {
    expect(keepsInPool({ ...base, id: 'a', affiliation: null, affiliationChecked: true }, [])).toBe(false);
    expect(keepsInPool({ ...base, id: 'b', affiliation: null }, [])).toBe(true);
    expect(keepsInPool({ ...base, id: 'c', affiliation: null, affiliationChecked: true }, ['c'])).toBe(true);
    expect(keepsInPool({ ...base, id: 'd', affiliation: 'Southeast University', affiliationChecked: true }, [])).toBe(true);
  });
});
