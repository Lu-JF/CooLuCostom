/**
 * 调端点的公共件：取正文的规则，以及「网络类错误重试一次」。
 */
import { describe, expect, it } from 'vitest';
import { askModel, extractText } from '../src/model.ts';

const endpoint = { baseUrl: 'https://api.example.ai/v1', apiKey: 'k', model: 'm' };
const okBody = JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: '正文' }] }] });

describe('extractText', () => {
  it('只取 type:message 里的 output_text，不把推理当正文', () => {
    const body = {
      output: [
        { type: 'reasoning', content: [{ type: 'reasoning_text', text: '思考过程' }] },
        { type: 'message', content: [{ type: 'output_text', text: '真正的答案' }] },
      ],
    };
    expect(extractText(body)).toBe('真正的答案');
  });

  it('兼容 output_text 字段与 chat completions 形状', () => {
    expect(extractText({ output_text: ' 直接给 ' })).toBe('直接给');
    expect(extractText({ choices: [{ message: { content: '老形状' } }] })).toBe('老形状');
    expect(extractText({})).toBe('');
  });
});

describe('askModel', () => {
  it('成功时返回正文', async () => {
    const out = await askModel(endpoint, 'hi', (async () => new Response(okBody, { status: 200 })) as unknown as typeof fetch);
    expect(out).toEqual({ ok: true, text: '正文', reason: null });
  });

  it('网络类错误重试一次，第二次成功就算成功', async () => {
    let calls = 0;
    const fake = (async () => {
      calls += 1;
      if (calls === 1) throw new Error('fetch failed');
      return new Response(okBody, { status: 200 });
    }) as unknown as typeof fetch;
    const out = await askModel(endpoint, 'hi', fake);
    expect(out.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('两次都断就报错，且只重试一次', async () => {
    let calls = 0;
    const fake = (async () => {
      calls += 1;
      throw new Error('fetch failed');
    }) as unknown as typeof fetch;
    const out = await askModel(endpoint, 'hi', fake);
    expect(out.ok).toBe(false);
    expect(calls).toBe(2);
  });

  it('HTTP 5xx 不重试（不是网络问题，重试也白搭）', async () => {
    let calls = 0;
    const fake = (async () => {
      calls += 1;
      return new Response('boom', { status: 500 });
    }) as unknown as typeof fetch;
    const out = await askModel(endpoint, 'hi', fake);
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('http 500');
    expect(calls).toBe(1);
  });

  it('没有端点直接回 no-endpoint', async () => {
    const out = await askModel({ baseUrl: '', apiKey: '', model: '' }, 'hi');
    expect(out.reason).toBe('no-endpoint');
  });
});
