/**
 * 服务端与面板之间的数据形状（面板 `ctx.invoke` 回来的东西）。纯类型，不 import 任何
 * 带 node 依赖的模块，所以浏览器侧的 tsconfig 也能编它。
 *
 * `world.ts` 的 `view()` 返回的就是 `QuotaView`：结构对不上会在 typecheck 时露出来。
 */

/** 密钥从哪儿来；`commandcode.ts` 与面板共用这一份。 */
export type KeySourceKind = 'config' | 'env' | 'authFile' | 'envFile' | 'none';

export interface WindowWire {
  used: number;
  cap: number;
  exceeded: boolean;
  /** epoch 毫秒；未知为 null。 */
  resetAt: number | null;
  usedPercent: number | null;
}

export interface QuotaWire {
  ok: boolean;
  reason: string | null;
  keySource: string;
  baseUrl: string;
  account: string | null;
  planId: string | null;
  planLabel: string | null;
  planStatus: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  monthlyCredits: number | null;
  purchasedCredits: number | null;
  freeCredits: number | null;
  monthlyAllowance: number | null;
  monthlyUsedPercent: number | null;
  fiveHour: WindowWire | null;
  weekly: WindowWire | null;
  fetchedAt: number;
}

export interface ModelWire {
  model: string;
  provider: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface DayWire {
  day: string;
  calls: number;
  totalTokens: number;
}

export interface HermesWire {
  available: boolean;
  reason: string | null;
  dbPath: string;
  via: 'sqlite' | 'export' | 'none';
  days: number;
  models: ModelWire[];
  daily: DayWire[];
  total: ModelWire | null;
  sessions: number;
  firstSeen: number | null;
  lastSeen: number | null;
}

/** 一个查额度的账号（密钥要么来自桌宠自己的端点，要么是面板里手动加的）。 */
export interface AccountWire {
  id: string;
  label: string;
  source: string;
  /** `native` = 桌宠里配的端点（推荐）；`manual` = 面板里手动加的。 */
  origin: 'native' | 'manual';
  keyHint: string;
  email: string | null;
  planId: string | null;
  planLabel: string | null;
  active: boolean;
  /** 桌宠正在用这个端点说话。 */
  inUse: boolean;
  addedAt: number;
  lastCheckedAt: number | null;
  lastError: string | null;
}

/** 供应商登记表里的一条；未实现的家只有 needs/plan 两句说明。 */
export interface SourceWire {
  id: string;
  label: string;
  implemented: boolean;
  needs: string;
  plan: string;
  current: boolean;
}

/** 供应商给的模型清单里的一项。 */
export interface ModelInfoWire {
  id: string;
  name: string;
  contextLength: number | null;
  endpoints: string[];
}

/** 计划页里的一行：模型 + 单价 + 该计划给它的额度。 */
export interface PlanModelWire {
  name: string;
  context: string | null;
  intelligence: string | null;
  inputPerM: number | null;
  outputPerM: number | null;
  cacheReadPerM: number | null;
  cacheWritePerM: number | null;
  caps: string[];
  requests5h: number | null;
  requestsWeek: number | null;
  requestsMonth: number | null;
  monthlyCredits: number | null;
  free: boolean;
}

export interface PlanPricingWire {
  planId: string | null;
  planLabel: string | null;
  slug: string;
  url: string;
  fetchedAt: number;
  models: PlanModelWire[];
  via: 'live' | 'cache';
  reason: string | null;
}

export interface QuotaView {
  quota: QuotaWire;
  hermes: HermesWire;
  key: { source: string; detail: string; accountLabel: string | null };
  config: {
    source: string;
    alerts: boolean;
    alertPercent: number;
    pollMinutes: number;
    hermesDays: number;
    hermesHome: string;
    envFile: string;
    authFile: string;
    baseUrl: string;
    /** 直接填在配置里的密钥尾四位；没填是空串（面板只显示这个，不回传完整密钥）。 */
    keyHint: string;
    /** 月度额度的美元数；0 表示按套餐名自动取。 */
    monthlyAllowanceUsd: number;
  };
  language: string;
  /** 已提醒过、还没重置的游标，例如 `fiveHour:1791899050632:threshold`。 */
  alerted: string[];
  accounts: { activeId: string | null; list: AccountWire[] };
  sources: SourceWire[];
  models: ModelInfoWire[];
  /** 计划页抓来的价目与额度；没抓过、或这家没实现时为 null。 */
  pricing: PlanPricingWire | null;
}
