/** 翻译：提示词约束、只取正文不取推理、缓存与术语表变更。 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPrompt, missingTokens, promptHash, splitTranslated, translate } from '../src/translate.ts';
import type { NewsItem } from '../src/view-types.ts';

const ITEM: NewsItem = {
  id: 'abc12345',
  doi: '10.1109/TIE.2026.1',
  title: 'A lightweight network for bearing fault diagnosis',
  authors: ['Jane Doe'],
  team: null,
  journal: 'IEEE Transactions on Industrial Electronics',
  journalIssn: '0278-0046',
  tier: '中科院一区 · JCR Q1',
  issued: '2026-10-16',
  abstract: 'We propose a lightweight network. Accuracy reaches 99.2% at 1200 rpm.',
  url: 'https://doi.org/10.1109/TIE.2026.1',
  pdfUrl: null,
  source: 'crossref',
  sourceDetail: 'crossref:0278-0046?created:2026-09-18',
  foundAt: 1,
};

const RESPONSE_WITH_REASONING = {
  output: [
    { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'We need translate the abstract. First consider terms...' }] },
    { type: 'message', content: [{ type: 'output_text', text: '本文提出一种轻量网络，在 1200 rpm 下准确率达 99.2%。' }] },
  ],
};

describe('译文提取', () => {
  it('只取 message 的 output_text，扔掉 reasoning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ip-tr-'));
    const state = await translate(ITEM, {
      dataDir: dir,
      baseUrl: 'https://api.example.ai/v1',
      apiKey: 'k',
      model: 'm',
      glossaryLines: [],
      fetchImpl: (async () =>
        new Response(JSON.stringify(RESPONSE_WITH_REASONING), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
    });
    expect(state.ok).toBe(true);
    expect(state.text).toContain('轻量网络');
    expect(state.text ?? '').not.toContain('We need translate');
  });
});

describe('提示词', () => {
  it('写明忠于原文、缩写与术语表，标题也一并翻，且不带人设措辞', () => {
    const prompt = buildPrompt(ITEM, ['bearing | 轴承', 'fault diagnosis | 故障诊断']);
    expect(prompt).toContain('bearing = 轴承');
    expect(prompt).toContain('不增删');
    expect(prompt).toContain('首行只写标题译文');
    expect(prompt).toContain(`标题：${ITEM.title}`);
    expect(prompt).toContain(ITEM.abstract);
    expect(prompt).not.toContain('气泡');
    expect(prompt).not.toContain('桌宠');
  });

  it('译文按「标题 + 空行 + 摘要」拆开，并去掉模型自带的字样', () => {
    const both = splitTranslated('变转速下的轴承故障诊断\n\n本文提出一种轻量网络，准确率 99.2%。');
    expect(both.title).toBe('变转速下的轴承故障诊断');
    expect(both.text).toBe('本文提出一种轻量网络，准确率 99.2%。');
    const labeled = splitTranslated('标题：变转速下的轴承故障诊断\n\n摘要：本文提出一种轻量网络。');
    expect(labeled.title).toBe('变转速下的轴承故障诊断');
    expect(labeled.text).toBe('本文提出一种轻量网络。');
    const onlyBody = splitTranslated('只有一段摘要译文。');
    expect(onlyBody.title).toBe('');
    expect(onlyBody.text).toBe('只有一段摘要译文。');
    // 源没给摘要：请求里没有摘要，模型只会给一行标题译文，那行就是标题。
    const titleOnly = splitTranslated('变转速下的轴承故障诊断', false);
    expect(titleOnly.title).toBe('变转速下的轴承故障诊断');
    expect(titleOnly.text).toBe('');
  });

  it('术语表变化会让缓存键变化', () => {
    const a = promptHash('m', ['bearing | 轴承']);
    const b = promptHash('m', ['bearing | 轴承', 'gearbox | 齿轮箱']);
    const c = promptHash('m2', ['bearing | 轴承']);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('忠实度提示', () => {
  it('数字与缩写的缺失会被数出来', () => {
    expect(missingTokens('99.2% at 1200 rpm, use CNN', '准确率 99.2%，转速 1200 rpm，用卷积网络')).toBe(1);
    expect(missingTokens('99.2%', '99.2%')).toBe(0);
  });
});

describe('翻译调用', () => {
  it('写入缓存后第二次不再请求模型', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ip-tr-'));
    let calls = 0;
    const fake = (async () => {
      calls += 1;
      return new Response(JSON.stringify(RESPONSE_WITH_REASONING), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const deps = { dataDir, baseUrl: 'https://api.example.ai/provider/v1', apiKey: 'k', model: 'm', glossaryLines: ['bearing | 轴承'], fetchImpl: fake };

    const first = await translate(ITEM, deps);
    expect(first.ok).toBe(true);
    expect(first.text).toContain('轻量网络');
    expect(first.title).toBe('');
    expect(first.cached).toBe(false);
    expect(calls).toBe(1);
    expect(readFileSync(join(dataDir, 'news', 'translated', `${ITEM.id}.json`), 'utf8')).toContain('轻量网络');

    const second = await translate(ITEM, deps);
    expect(second.cached).toBe(true);
    expect(calls).toBe(1);
  });

  it('没有摘要或没有端点时给出原因', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ip-tr2-'));
    const empty = await translate({ ...ITEM, title: '   ', abstract: '   ' }, { dataDir, baseUrl: 'x', apiKey: 'y', model: 'm', glossaryLines: [] });
    expect(empty.reason).toBe('empty-abstract');
    const noKey = await translate(ITEM, { dataDir, baseUrl: '', apiKey: '', model: 'm', glossaryLines: [] });
    expect(noKey.reason).toBe('no-endpoint');
  });

  it('HTTP 非 2xx 时带上状态与片段，不抛错', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ip-tr3-'));
    const fake = (async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch;
    const out = await translate(ITEM, { dataDir, baseUrl: 'https://x/provider/v1', apiKey: 'k', model: 'm', glossaryLines: [], fetchImpl: fake });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('429');
  });
});
