/**
 * 调桌宠自己配置的模型端点（`pet-model.ts` 解析出的 baseUrl / key / model）。
 *
 * 请求形状按 `openai-responses-compat` 对齐：`POST {baseUrl}/responses`，
 * 体 `{ model, input: [{ role, content: [{ type: 'input_text', text }] }], stream: false }`。
 *
 * 响应里**推理与正文是两类 item**：`{type:'reasoning', content:[{type:'reasoning_text'}]}` 与
 * `{type:'message', content:[{type:'output_text'}]}`。只取后者——全都拼起来会把思考过程当答案。
 */
import type { PetModel } from './pet-model.ts';

export type ModelEndpoint = Pick<PetModel, 'baseUrl' | 'apiKey' | 'model'>;

/** 从 Responses 体里取正文，另兼容 `output_text` 字段与 chat completions 形状。 */
export function extractText(body: unknown): string {
  const b = (body ?? {}) as Record<string, unknown>;
  const out = b.output;
  if (Array.isArray(out)) {
    const parts: string[] = [];
    for (const item of out) {
      const rec = (item ?? {}) as Record<string, unknown>;
      if (rec.type !== undefined && rec.type !== 'message') continue;
      const content = rec.content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        const part = (c ?? {}) as Record<string, unknown>;
        if (part.type !== undefined && part.type !== 'output_text') continue;
        if (typeof part.text === 'string') parts.push(part.text);
      }
    }
    const text = parts.join('').trim();
    if (text !== '') return text;
  }
  if (typeof b.output_text === 'string' && b.output_text.trim() !== '') return b.output_text.trim();
  const choices = b.choices;
  if (Array.isArray(choices)) {
    const first = (choices[0] ?? {}) as Record<string, unknown>;
    const msg = (first.message ?? {}) as Record<string, unknown>;
    if (typeof msg.content === 'string') return msg.content.trim();
  }
  return '';
}

export interface ModelResult {
  ok: boolean;
  text: string;
  reason: string | null;
}

/** 一次非流式调用。失败不抛错，返回 ok=false 与原因。网络类错误自动重试一次。 */
export async function askModel(
  endpoint: ModelEndpoint,
  prompt: string,
  fetchImpl?: typeof fetch,
): Promise<ModelResult> {
  if (!endpoint.baseUrl || !endpoint.apiKey) return { ok: false, text: '', reason: 'no-endpoint' };
  const doFetch = fetchImpl ?? fetch;
  const once = async (): Promise<ModelResult> => {
    try {
      const res = await doFetch(`${endpoint.baseUrl.replace(/\/$/, '')}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.apiKey}` },
        body: JSON.stringify({
          model: endpoint.model,
          input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
          stream: false,
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return { ok: false, text: '', reason: `http ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ''}` };
      }
      const text = extractText(await res.json());
      if (text === '') return { ok: false, text: '', reason: 'empty-response' };
      return { ok: true, text, reason: null };
    } catch (err) {
      return { ok: false, text: '', reason: String((err as Error)?.message ?? err) };
    }
  };
  const first = await once();
  // 端点偶尔 `fetch failed`（连接被对端掐断，实测过一次）：这种网络错重试一次，别让气泡少了速评。
  if (first.ok || !/fetch failed|socket|ECONNRESET|ETIMEDOUT/i.test(first.reason ?? '')) return first;
  await new Promise((r) => setTimeout(r, 800));
  return await once();
}
