/**
 * 供应商登记表：这个面板现在只会查 Command Code，别的家只留**接缝与界面**。
 *
 * 每家的额度/价目/模型来源不一样（有的有余额接口、有的只有控制台页面、有的得用管理密钥调账单接口），
 * 所以这里把「怎么查」封成一个 `QuotaSource`：`implemented` 为假的那些只有说明，切过去只会看到
 * 「未实现」和将来打算用的接口。要接新供应商，就在这里加一条并实现 `fetchQuota` 等三个方法，
 * 面板与 World 都不用改。
 */
import { fetchQuota, type CommandCodeQuota } from './commandcode.ts';

export interface QuotaSourceInput {
  baseUrl: string;
  key: string;
  keySource: string;
  monthlyAllowanceUsd: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  contextLength: number | null;
  /** 这个模型支持哪些端点，如 `['/chat/completions', '/responses']`。 */
  endpoints: string[];
}

export interface QuotaSource {
  id: string;
  label: string;
  /** 有实现吗。假的时候下面三个方法都不存在，界面只显示 `needs` 与 `plan`。 */
  implemented: boolean;
  /** 查额度需要什么（一句，给界面）。 */
  needs: string;
  /** 未实现时：将来打算从哪儿查（接口名或页面），留给后续实现。 */
  plan: string;
  defaultBaseUrl: string;
  fetchQuota?(input: QuotaSourceInput): Promise<CommandCodeQuota>;
  fetchModels?(input: { baseUrl: string; key: string; fetchImpl?: typeof fetch }): Promise<ModelInfo[]>;
  /** 计划页地址（实现了爬取的供应商才给）：面板把它当「价目来源」的链接与抓取目标。 */
  planPageUrl?(planId: string | null): string | null;
}

interface RawModel {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  supported_endpoints?: unknown;
}

export const COMMANDCODE_SOURCE: QuotaSource = {
  id: 'commandcode',
  label: 'Command Code',
  implemented: true,
  needs: 'API Key（同一个 Key 就能查额度、模型与价目）',
  plan: '额度走 /alpha/billing/*，模型走 /provider/v1/models，计划与价目爬官网计划页。',
  defaultBaseUrl: 'https://api.commandcode.ai',
  fetchQuota: (input) =>
    fetchQuota({
      baseUrl: input.baseUrl,
      key: input.key,
      keySource: input.keySource as never,
      monthlyAllowanceUsd: input.monthlyAllowanceUsd,
      fetchImpl: input.fetchImpl,
      timeoutMs: input.timeoutMs,
    }),
  fetchModels: async ({ baseUrl, key, fetchImpl }) => {
    const res = await (fetchImpl ?? fetch)(`${baseUrl.replace(/\/+$/, '')}/provider/v1/models`, {
      headers: { Accept: 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`models returned HTTP ${res.status}`);
    const body = (await res.json()) as { data?: RawModel[] };
    return (body.data ?? []).map((m) => ({
      id: String(m.id ?? ''),
      name: String(m.name ?? m.id ?? ''),
      contextLength: typeof m.context_length === 'number' ? m.context_length : null,
      endpoints: Array.isArray(m.supported_endpoints) ? m.supported_endpoints.map(String) : [],
    }));
  },
  planPageUrl: (planId) => {
    const slug = (planId ?? '').toLowerCase();
    const hit = ['ultra', 'max', 'pro', 'goat', 'go', 'provider'].find((s) => slug.includes(s));
    return hit ? `https://commandcode.ai/docs/plans/${hit}` : null;
  },
};

/** 只写了说明、没有实现的家。`plan` 是将来要接时该走的接口（多数待核实）。 */
const STUBS: readonly QuotaSource[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    implemented: false,
    needs: '管理密钥（Admin Key）才能读组织账单',
    plan: '候选接口 GET /v1/organization/costs 与 /v1/organization/usage/completions；普通 Key 读不了。',
    defaultBaseUrl: 'https://api.openai.com/v1',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    implemented: false,
    needs: '管理密钥（Admin Key）',
    plan: '候选接口 GET /v1/organizations/cost_report 与 /usage_report/messages；额度本身只在 Console 看。',
    defaultBaseUrl: 'https://api.anthropic.com',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    implemented: false,
    needs: 'API Key',
    plan: '候选接口 GET /user/balance，返回余额与币种；价目从官网价目页抓。',
    defaultBaseUrl: 'https://api.deepseek.com',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    implemented: false,
    needs: 'API Key',
    plan: '候选接口 GET /api/v1/credits（已用/总额）与 GET /api/v1/key（当前 Key 限额）；模型价目 GET /api/v1/models 自带价格字段。',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
  },
  {
    id: 'kimi',
    label: 'Kimi / Moonshot',
    implemented: false,
    needs: 'API Key',
    plan: '候选接口 GET /v1/users/me/balance。',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
  },
  {
    id: 'glm',
    label: '智谱 GLM',
    implemented: false,
    needs: 'API Key（余额只在控制台）',
    plan: '没有公开的余额接口，要在控制台看；将来或按网页抓取，登录态会过期。',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  },
  {
    id: 'qwen',
    label: '通义千问 / 百炼',
    implemented: false,
    needs: 'API Key + 阿里云账号（账单在控制台）',
    plan: '百炼没有公开的余额接口，用量走阿里云账单；将来或按账单页抓取。',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  {
    id: 'custom',
    label: '自定义（OpenAI 兼容）',
    implemented: false,
    needs: 'Base URL + API Key，以及这家额度在哪儿看',
    plan: '留给中转站：多数只给 OpenAI 兼容的模型列表，额度要么没有接口、要么得填一个自定义取数脚本。',
    defaultBaseUrl: '',
  },
];

export const SOURCES: readonly QuotaSource[] = [COMMANDCODE_SOURCE, ...STUBS];

export function sourceById(id: string | null | undefined): QuotaSource | null {
  if (!id) return null;
  return SOURCES.find((s) => s.id === id) ?? null;
}
