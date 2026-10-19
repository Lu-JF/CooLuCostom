/**
 * 大肥鱼速评：提示词、解析、缓存。
 *
 * 只测纯函数与缓存行为；真的模型调用在 world.test.ts 里用假 fetch 串一遍。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_STARS,
  REVIEW_PROMPT_VERSION,
  buildReviewPrompt,
  parseReview,
  readReview,
  reviewItem,
  writeReview,
} from '../src/review.ts';
import type { NewsItem } from '../src/view-types.ts';

const ITEM: NewsItem = {
  id: 'abc12345',
  doi: '10.1016/j.ymssp.2026.123456',
  title: 'Bearing fault diagnosis under variable speed using a lightweight network',
  authors: ['Jane Doe'],
  team: null,
  journal: 'Mechanical Systems and Signal Processing',
  journalIssn: '0888-3270',
  tier: '中科院一区 · JCR Q1',
  issued: '2026-10-01',
  abstract: 'We propose a lightweight network for bearing fault diagnosis. Accuracy reaches 99.2% at 1200 rpm.',
  url: 'https://doi.org/10.1016/j.ymssp.2026.123456',
  pdfUrl: null,
  source: 'crossref',
  sourceDetail: 'crossref:0888-3270',
  foundAt: 1,
};

describe('提示词', () => {
  it('写清五个方面作为打分依据，但只要求输出一个总分', () => {
    const prompt = buildReviewPrompt(ITEM, ['bearing fault diagnosis', 'neural architecture search']);
    expect(prompt).toContain('大肥鱼');
    expect(prompt).toContain('创新点');
    expect(prompt).toContain('领域贡献度');
    expect(prompt).toContain('研究方向相关性');
    expect(prompt).toContain('实验设置');
    expect(prompt).toContain('写作质量');
    expect(prompt).toContain('不逐项输出');
    expect(prompt).toContain('总分：<0 到 10 的数字>');
    expect(prompt).toContain(ITEM.abstract);
  });

  it('带主人的研究方向，没配关键词时给默认方向', () => {
    expect(buildReviewPrompt(ITEM, ['edge computing'])).toContain('edge computing');
    expect(buildReviewPrompt(ITEM, [])).toContain('旋转机械故障诊断');
  });

  it('没有摘要时明说信息不足，别让模型瞎补', () => {
    const prompt = buildReviewPrompt({ ...ITEM, abstract: '' }, []);
    expect(prompt).toContain('源未提供摘要');
  });
});

describe('解析', () => {
  it('两行标准输出：评语与总分各归各位', () => {
    const out = parseReview('评价：方法不算新，但把变转速下的实测做扎实了，值得一读。\n总分：7.5');
    expect(out?.text).toBe('方法不算新，但把变转速下的实测做扎实了，值得一读。');
    expect(out?.total).toBe(7.5);
  });

  it('容忍代码围栏、多余前后缀与 /10 写法', () => {
    expect(parseReview('```\n点评：这个思路有点意思。\n评分：8/10\n```')?.total).toBe(8);
    expect(parseReview('评价：还可以。\n总分: 6')?.total).toBe(6);
  });

  it('五维分被模型写出来也不影响总分，且不会混进评语', () => {
    const out = parseReview('评价：挺扎实。\n创新点：8\n实验设置：6\n总分：7');
    expect(out?.text).toBe('挺扎实。');
    expect(out?.total).toBe(7);
  });

  it('没有总分就返回 null——宁可没有星星，也不编一个', () => {
    expect(parseReview('这篇还行，思路清楚。')).toBeNull();
    expect(parseReview('')).toBeNull();
  });

  it('分数超出范围时夹到 0–10', () => {
    expect(parseReview('评价：好。\n总分：13')?.total).toBe(MAX_STARS);
    expect(parseReview('评价：差。\n总分：0')?.total).toBe(0);
  });
});

describe('缓存', () => {
  it('写进去能读回来，版本对不上就不认', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ip-review-'));
    writeReview(dir, ITEM.id, { text: '挺扎实。', total: 7.5, version: REVIEW_PROMPT_VERSION, at: 123 });
    const back = readReview(dir, ITEM.id);
    expect(back).toEqual({ text: '挺扎实。', total: 7.5, version: REVIEW_PROMPT_VERSION, at: 123 });
    writeReview(dir, ITEM.id, { text: '挺扎实。', total: 7.5, version: REVIEW_PROMPT_VERSION + 1, at: 1 });
    expect(readReview(dir, ITEM.id)).toBeNull();
  });

  it('有缓存就不再调模型', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ip-review-'));
    writeReview(dir, ITEM.id, { text: '挺扎实。', total: 8, version: REVIEW_PROMPT_VERSION, at: 1 });
    let calls = 0;
    const state = await reviewItem(ITEM, {
      dataDir: dir,
      keywords: [],
      baseUrl: 'https://api.example.ai/v1',
      apiKey: 'k',
      model: 'm',
      fetchImpl: (async () => {
        calls += 1;
        return new Response('{}');
      }) as unknown as typeof fetch,
    });
    expect(calls).toBe(0);
    expect(state.ok).toBe(true);
    expect(state.cached).toBe(true);
    expect(state.total).toBe(8);
  });

  it('没有缓存就评一次并落盘，第二次走缓存', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ip-review-'));
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: '评价：做得扎实。\n总分：6.5' }] }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const deps = { dataDir: dir, keywords: [], baseUrl: 'https://api.example.ai/v1', apiKey: 'k', model: 'm', fetchImpl };
    const first = await reviewItem(ITEM, deps);
    expect(first.ok).toBe(true);
    expect(first.total).toBe(6.5);
    expect(first.cached).toBe(false);
    expect(calls).toBe(1);
    expect(readReview(dir, ITEM.id)?.total).toBe(6.5);
    const second = await reviewItem(ITEM, deps);
    expect(second.cached).toBe(true);
    expect(calls).toBe(1);
  });

  it('评分抠不出来时保留评语、不给分数', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ip-review-'));
    const state = await reviewItem(ITEM, {
      dataDir: dir,
      keywords: [],
      baseUrl: 'https://api.example.ai/v1',
      apiKey: 'k',
      model: 'm',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ output: [{ content: [{ type: 'output_text', text: '这篇挺有意思。' }] }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
    });
    expect(state.ok).toBe(false);
    expect(state.reason).toBe('unparsed-score');
    expect(state.text).toBe('这篇挺有意思。');
    expect(state.total).toBeNull();
  });

  it('没有端点就明说没有端点', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ip-review-'));
    const state = await reviewItem(ITEM, { dataDir: dir, keywords: [], baseUrl: '', apiKey: '', model: '' });
    expect(state.ok).toBe(false);
    expect(state.reason).toBe('no-endpoint');
  });
});
