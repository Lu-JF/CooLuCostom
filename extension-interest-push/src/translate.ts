/**
 * 摘要翻译：走**桌宠自己配置的模型端点**（`pet-model.ts` 解析出的 baseUrl / key / model），
 * **不带人设**——这是学术翻译，要求忠于原文、照顾领域专有名词，不是闲聊。
 *
 * 请求形状按桌宠 provider 模块的 `openai-responses-compat` 对齐：
 * `POST {baseUrl}/responses`，体 `{ model, input: [{ role, content: [{ type: 'input_text', text }] }], stream: false }`。
 *
 * 译文按条目落盘缓存：同一篇只花一次 token；改了术语表或换了模型，`promptHash` 变化即重译。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { glossaryHash, parseGlossary } from './glossary.ts';
import type { NewsItem, TranslationState } from './view-types.ts';

/** 提示词版本；改动措辞时加一，缓存随之失效。 */
export const PROMPT_VERSION = 1;

export interface TranslateDeps {
  dataDir: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  glossaryLines: string[];
  fetchImpl?: typeof fetch;
}

export function buildPrompt(abstract: string, glossaryLines: string[]): string {
  const pairs = parseGlossary(glossaryLines);
  const terms = pairs.map(([en, zh]) => `${en} = ${zh}`).join('；');
  return [
    '你是旋转机械故障诊断与健康管理领域的学术翻译。把下面的英文论文摘要译成简体中文。',
    '要求：',
    '1. 忠于原文，不增删、不解释、不评论、不添加原文没有的结论或数据。',
    '2. 数字、单位、公式、变量名、模型与方法的英文名、数据集名、期刊名保持原样；缩写首次出现写成「中文（英文缩写）」。',
    '3. 术语按下表统一，表中没有的按领域惯例翻译：' + terms,
    '4. 只输出译文本身，不要任何前言、标题、标注或说明。',
    '',
    '原文摘要：',
    abstract,
  ].join('\n');
}

/** 缓存键：提示词版本 + 模型 + 术语表内容。 */
export function promptHash(model: string, glossaryLines: string[]): string {
  return createHash('sha1')
    .update(`${PROMPT_VERSION}|${model}|${glossaryHash(glossaryLines)}`)
    .digest('hex')
    .slice(0, 12);
}

/** 原文里的数字/单位/缩写（首字母缩写），统计译文中缺失的个数，仅作提示。 */
export function missingTokens(original: string, translated: string): number {
  const pick = (text: string): Set<string> => {
    const out = new Set<string>();
    for (const m of text.matchAll(/\d+(?:\.\d+)?\s?(?:%|Hz|kHz|MHz|rpm|mm|cm|µm|um|N·m|Nm|N|W|kW|kWh|V|A|°C|K|s|ms|min|h|dB)?/g)) {
      const v = m[0].replace(/\s+/g, '');
      if (v.length > 1) out.add(v);
    }
    for (const m of text.matchAll(/\b[A-Z]{2,6}\b/g)) out.add(m[0]);
    return out;
  };
  const a = pick(original);
  const b = pick(translated);
  let missing = 0;
  for (const t of a) if (!b.has(t)) missing += 1;
  return missing;
}

function cachePath(dataDir: string, id: string): string {
  return join(dataDir, 'news', 'translated', `${id}.json`);
}

function readCache(dataDir: string, id: string): { text: string; promptHash: string } | null {
  try {
    const raw = JSON.parse(readFileSync(cachePath(dataDir, id), 'utf8')) as { text?: string; promptHash?: string };
    if (typeof raw.text === 'string' && raw.text.trim() !== '') return { text: raw.text, promptHash: String(raw.promptHash ?? '') };
  } catch {
    /* 没有缓存或坏了：当作没有 */
  }
  return null;
}

function writeCache(dataDir: string, id: string, text: string, hash: string): void {
  try {
    mkdirSync(join(dataDir, 'news', 'translated'), { recursive: true });
    writeFileSync(cachePath(dataDir, id), `${JSON.stringify({ text, promptHash: hash, at: Date.now() }, null, 2)}\n`, 'utf8');
  } catch {
    /* 落盘失败不影响本次返回 */
  }
}

/** 从 Responses 体里取正文，容忍几种形状。 */
export function extractText(body: unknown): string {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.output_text === 'string' && b.output_text.trim() !== '') return b.output_text.trim();
  const out = b.output;
  if (Array.isArray(out)) {
    const parts: string[] = [];
    for (const item of out) {
      const content = (item as Record<string, unknown>)?.content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        const t = (c as Record<string, unknown>)?.text;
        if (typeof t === 'string') parts.push(t);
      }
    }
    if (parts.length > 0) return parts.join('').trim();
  }
  const choices = b.choices;
  if (Array.isArray(choices)) {
    const first = choices[0] as Record<string, unknown> | undefined;
    const msg = first?.message as Record<string, unknown> | undefined;
    if (typeof msg?.content === 'string') return msg.content.trim();
  }
  return '';
}

export async function translate(item: NewsItem, deps: TranslateDeps): Promise<TranslationState> {
  const hash = promptHash(deps.model, deps.glossaryLines);
  const cached = readCache(deps.dataDir, item.id);
  if (cached && cached.promptHash === hash) {
    return { ok: true, text: cached.text, cached: true, missing: missingTokens(item.abstract, cached.text), reason: null };
  }
  if (item.abstract.trim() === '') return { ok: false, text: null, cached: false, missing: 0, reason: 'empty-abstract' };
  if (!deps.baseUrl || !deps.apiKey) return { ok: false, text: null, cached: false, missing: 0, reason: 'no-endpoint' };

  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${deps.baseUrl.replace(/\/$/, '')}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${deps.apiKey}` },
      body: JSON.stringify({
        model: deps.model,
        input: [{ role: 'user', content: [{ type: 'input_text', text: buildPrompt(item.abstract, deps.glossaryLines) }] }],
        stream: false,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, text: null, cached: false, missing: 0, reason: `http ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ''}` };
    }
    const text = extractText(await res.json());
    if (text === '') return { ok: false, text: null, cached: false, missing: 0, reason: 'empty-response' };
    writeCache(deps.dataDir, item.id, text, hash);
    return { ok: true, text, cached: false, missing: missingTokens(item.abstract, text), reason: null };
  } catch (err) {
    return { ok: false, text: null, cached: false, missing: 0, reason: String((err as Error)?.message ?? err) };
  }
}
