/**
 * 这个 World：把当前供应商的套餐额度、计划可用的模型与价目，和本机 Hermes 的 token 统计放到控制台一页，
 * 并在窗口用量越过阈值时给 bot 发一条提醒事件（由桌宠用气泡说出来）。
 *
 * 多账号：账号表在部署数据目录的 `quota/accounts.json`，密钥经框架的秘密存储写进部署 `.env`。
 * 供应商：`sources.ts` 里登记；只有 Command Code 有实现，切到别家只会看到「未实现」和将来的接口。
 *
 * 只做机械计算：取数、算百分比、算重置倒计时。说什么、什么时候说，交给 bot 判断
 * （ENV_PROMPT.md 只交代事件与工具的用法）。
 */
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Language } from 'cortico/core/language.ts';
import type { ToolDef, World, WorldWebUiDecl, WorldHost } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import {
  accountsPath,
  activateAccount,
  activeAccount,
  addAccount as addAccountToFile,
  buildAccount,
  loadAccounts,
  maskKey,
  nativeAccountId,
  removeAccount as removeAccountFromFile,
  saveAccounts,
  upsertNativeAccount,
  type AccountsFile,
  type QuotaAccount,
  type SecretBackend,
} from './accounts.ts';
import { anyExhausted, busiestPercent, evaluateAlerts, type QuotaAlert } from './alerts.ts';
import { emptyQuota, resolveKey, type CommandCodeQuota } from './commandcode.ts';
import { type QuotaConfigSection } from './config.ts';
import { clockText, compactCount, durationText, money, percent } from './format.ts';
import { readHermesUsage, resolveHermesHome, type HermesUsage } from './hermes.ts';
import { endpointsFor, type NativeEndpoint } from './native.ts';
import { fetchPlanPricing, planSlugFor } from './pricing.ts';
import { quotaText, type QuotaText } from './i18n.ts';
import { COMMANDCODE_SOURCE, sourceById, SOURCES, type ModelInfo, type QuotaSource } from './sources.ts';
import type { AccountWire, ModelInfoWire, PlanPricingWire, QuotaView, SourceWire } from './view-types.ts';
import { QUOTA_HERMES_PARAMETERS, QUOTA_STATUS_PARAMETERS, QUOTA_TOOL_TAGS } from './tool-spec.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
/** 面板每问一次都重取太频繁；这个窗口内的读数直接用缓存。 */
const CACHE_MS = 30_000;

export interface QuotaWorldOptions {
  cfg: QuotaConfigSection;
  timezone: string;
  /** 部署数据目录：账号表（`quota/accounts.json`）放这里。 */
  dataDir: string;
  /** bot 安装目录：桌宠的 `providers/` 与 `config.json` 在它旁边/里面。 */
  botDir: string;
  /** 框架给的秘密存储：写部署 `.env`，读回同一个变量名。 */
  secrets: SecretBackend;
  /**
   * 写回自己配置段（框架的 WorldContext.persist）。
   * 面板上的「保存」走它：一次写回、当场校验，不经过框架配置页那个防抖自动保存。
   */
  persist: (patch: Partial<QuotaConfigSection>) => void;
}

export class QuotaWorld implements World {
  readonly id = 'quota';

  private host: WorldHost | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private quota: CommandCodeQuota;
  private hermes: HermesUsage | null = null;
  private models: ModelInfo[] = [];
  private pricing: PlanPricingWire | null = null;
  private accounts: AccountsFile;
  /** 桌宠里指向这一家的端点（= 使用者在桌宠里配的账号），每轮取数前重新看一遍。 */
  private native: NativeEndpoint[] = [];
  /** 桌宠当前让它说话的那个端点名（`config.json` 的 activeProvider）。 */
  private activeProvider = '';
  private keyInfo = { source: 'none', detail: '', accountLabel: null as string | null };
  /** 提醒游标按账号分开：换个账号，同一个窗口该重新提醒。 */
  private readonly firedByAccount = new Map<string, Set<string>>();
  private inflight: Promise<void> | null = null;

  constructor(private readonly opts: QuotaWorldOptions) {
    this.quota = emptyQuota('not read yet', { baseUrl: this.baseUrlFor(COMMANDCODE_SOURCE), keySource: 'none' });
    this.accounts = loadAccounts(accountsPath(opts.dataDir));
  }

  // ---------------------------------------------------------------- 基础

  private currentSource(): QuotaSource {
    return sourceById(this.opts.cfg.source) ?? COMMANDCODE_SOURCE;
  }

  private baseUrlFor(source: QuotaSource): string {
    const declared = source.id === 'commandcode'
      ? (this.opts.cfg.commandcodeBaseUrl || '').trim()
      : '';
    return (declared || source.defaultBaseUrl).replace(/\/+$/, '');
  }

  private hermesHome(): string {
    return resolveHermesHome(this.opts.cfg.hermesHome ?? '');
  }

  private envFile(): string {
    const declared = (this.opts.cfg.envFile ?? '').trim();
    return declared || `${this.hermesHome()}\\.env`;
  }

  private fired(): Set<string> {
    const key = this.accounts.activeId ?? 'default';
    let set = this.firedByAccount.get(key);
    if (!set) {
      set = new Set<string>();
      this.firedByAccount.set(key, set);
    }
    return set;
  }

  private persistAccounts(): void {
    try {
      saveAccounts(accountsPath(this.opts.dataDir), this.accounts);
    } catch {
      /* 写不进去不该让取数循环掉线；界面拿到的仍是内存里这份 */
    }
  }

  /** 桌宠当前在用哪个端点说话（`<botDir>/config.json` 的 activeProvider）。 */
  private readActiveProvider(): void {
    try {
      const cfg = JSON.parse(readFileSync(join(this.opts.botDir, 'config.json'), 'utf8')) as { activeProvider?: unknown };
      this.activeProvider = typeof cfg.activeProvider === 'string' ? cfg.activeProvider : '';
    } catch {
      this.activeProvider = '';
    }
  }

  /**
   * 看一遍桌宠里的端点，把指向这一家的那些记成账号（有就更新、没有就加）——
   * 使用者不用在面板里再贴一次 Key，换号就是「在桌宠里换端点」。
   */
  private syncNativeAccounts(): void {
    this.native = endpointsFor(this.opts.botDir, 'commandcode.ai');
    this.readActiveProvider();
    const before = JSON.stringify(this.accounts);
    for (const endpoint of this.native) {
      this.accounts = upsertNativeAccount(this.accounts, {
        name: endpoint.name,
        dir: endpoint.dir,
        secretName: endpoint.secretName,
        keyHint: endpoint.key ? maskKey(endpoint.key) : '—',
      });
    }
    if (JSON.stringify(this.accounts) !== before) this.persistAccounts();
  }

  /**
   * 当前账号的密钥，顺序：
   * ① 原生端点（桌宠里配的那个端点的 `.env`，每轮重读，桌宠里换了这里就跟着换）
   * ② 手动加的账号（部署 `.env` 里的变量名）
   * ③ 配置里手填的 Key → 环境变量 → 登录文件 → 指定的 `.env`
   */
  private resolveKey(): { key: string | null; source: string; detail: string; account: QuotaAccount | null } {
    const account = activeAccount(this.accounts);
    if (account?.origin === 'native') {
      const endpoint = this.native.find((e) => e.dir === account.providerDir)
        ?? this.native.find((e) => nativeAccountId(e.name) === account.id);
      const key = endpoint?.key?.trim();
      if (key) {
        return { key, source: `account:${account.label}`, detail: endpoint?.secretName ?? account.secretName, account };
      }
    }
    if (account) {
      const value = this.opts.secrets.read(account.secretName)?.trim();
      if (value) return { key: value, source: `account:${account.label}`, detail: account.secretName, account };
    }
    const resolved = resolveKey({
      configKey: this.opts.cfg.commandcodeKey,
      envFile: this.envFile(),
      authFile: this.opts.cfg.authFile,
    });
    return { key: resolved.key, source: resolved.source, detail: resolved.detail, account };
  }

  // ---------------------------------------------------------------- World

  envPromptVars(): Record<string, string> {
    return { 'quota.summary': this.summary('zh') };
  }

  tools(): ToolDef[] {
    return [this.statusTool(), this.hermesTool()];
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    await this.refresh({ reason: 'start' });
    this.schedule();
  }

  async stop(): Promise<void> {
    this.host = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const t = quotaText(language);
    const pct = busiestPercent(this.quota);
    const worst = pct === null ? null : percent(pct);
    const source = this.currentSource();
    const lampState = !this.quota.ok
      ? (this.quota.reason === 'not read yet' ? ('loading' as const) : ('error' as const))
      : anyExhausted(this.quota)
        ? ('error' as const)
        : pct !== null && this.opts.cfg.alertPercent > 0 && pct >= this.opts.cfg.alertPercent
          ? ('loading' as const)
          : ('online' as const);

    return {
      label: t.label,
      lamps: [
        {
          label: source.label,
          state: lampState,
          hint: this.quota.ok
            ? anyExhausted(this.quota)
              ? t.lamps.quotaExhausted
              : t.lamps.quotaUsed(worst ?? '—')
            : source.implemented ? t.lamps.quotaUnknown : t.lamps.sourceMissing(source.label),
        },
        {
          label: t.lamps.hermes,
          state: this.hermes === null ? 'loading' : this.hermes.available ? 'online' : 'offline',
          hint: this.hermes?.available
            ? t.lamps.hermesOk(this.hermes.total?.calls ?? 0, compactCount(this.hermes.total?.totalTokens ?? 0))
            : t.lamps.hermesMissing,
        },
      ],
      badges: [
        { label: t.badges.plan, value: this.quota.planLabel ?? this.quota.planId ?? t.badges.unknown, tone: 'plain' },
        {
          label: t.badges.accounts,
          value: `${this.accounts.accounts.length}`,
          tone: this.accounts.accounts.length > 1 ? 'on' : 'plain',
        },
        {
          label: t.badges.fiveHour,
          value: this.quota.fiveHour ? percent(this.quota.fiveHour.usedPercent) : '—',
          tone: this.toneOf(this.quota.fiveHour?.usedPercent ?? null),
        },
        {
          label: t.badges.weekly,
          value: this.quota.weekly ? percent(this.quota.weekly.usedPercent) : '—',
          tone: this.toneOf(this.quota.weekly?.usedPercent ?? null),
        },
        {
          label: t.badges.monthly,
          value: money(this.quota.monthlyCredits),
          tone: this.quota.monthlyCredits !== null && this.quota.monthlyCredits <= 0.01 ? 'off' : 'plain',
        },
      ],
      panels: [
        { id: 'quota', title: t.label, description: t.panel.quotaDesc },
        // 自己画的「配置」页签：表单填完点保存才写回，不走框架配置页那种边打边存。
        { id: 'settings', title: t.panel.settingsTitle, description: t.panel.settingsDesc },
      ],
      invoke: (panel, method, args) => this.invoke(panel, method, args, language),
      promptDocs: [
        {
          key: 'worlds.quota.envPrompt',
          title: `${t.label} · 环境提示词`,
          description: '把这段交给 bot：提醒事件怎么处理、两个工具怎么用。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [{ name: 'quota.summary', description: '当前的额度与 Hermes 用量读数，此刻的值。', multiline: true }],
        },
      ],
    };
  }

  private toneOf(value: number | null): 'on' | 'off' | 'plain' {
    if (value === null) return 'plain';
    if (value >= 100) return 'off';
    if (this.opts.cfg.alertPercent > 0 && value >= this.opts.cfg.alertPercent) return 'plain';
    return 'on';
  }

  // ------------------------------------------------------------- 取数与提醒

  private schedule(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const minutes = Number(this.opts.cfg.pollMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    this.timer = setInterval(() => {
      void this.refresh({ reason: 'poll' });
    }, Math.min(1440, minutes) * 60_000);
    this.timer.unref?.();
  }

  /** 取一次额度与 Hermes 用量；顺带判定提醒、补模型清单。并发调用合并成一次。 */
  async refresh(opts: {
    reason: 'start' | 'poll' | 'panel' | 'tool' | 'account';
    force?: boolean;
    days?: number;
  }): Promise<void> {
    if (this.inflight) {
      await this.inflight;
      if (!opts.force) return;
    }
    const run = (async () => {
      const source = this.currentSource();
      // 先看一遍桌宠里的端点：账号表与密钥都跟着它走（桌宠里换了端点，这里立刻反映）。
      this.syncNativeAccounts();
      const fresh = opts.force === true
        || Date.now() - this.quota.fetchedAt > CACHE_MS
        || this.quota.reason === 'not read yet'
        || opts.reason === 'account';
      if (fresh) {
        const resolved = this.resolveKey();
        this.keyInfo = { source: resolved.source, detail: resolved.detail, accountLabel: resolved.account?.label ?? null };
        if (!source.implemented) {
          this.quota = emptyQuota(`source not implemented: ${source.id}`, { baseUrl: this.baseUrlFor(source), keySource: 'none' });
          // 这家没实现就把别家抓来的东西也清掉：留着上一家的价目/模型会让人以为那是这家的数。
          this.pricing = null;
          this.models = [];
        } else if (!resolved.key) {
          this.quota = emptyQuota(`no key for ${source.id}`, { baseUrl: this.baseUrlFor(source), keySource: 'none' });
        } else {
          this.quota = await source.fetchQuota!({
            baseUrl: this.baseUrlFor(source),
            key: resolved.key,
            keySource: resolved.source,
            monthlyAllowanceUsd: Number(this.opts.cfg.monthlyAllowanceUsd) || 0,
          });
        }
        this.rememberAccountResult(resolved.account);
        // 模型清单与价目都自带缓存，慢也只慢第一次：面板来的那一次等它们（首屏就有），别的路径不挡取数。
        if (source.implemented) {
          const wait = opts.reason === 'panel' || opts.reason === 'start';
          if (this.models.length === 0) {
            if (wait) await this.loadModels(false);
            else void this.loadModels(false);
          }
          if (wait) await this.loadPricing(false);
          else void this.loadPricing(false);
        }
      }
      this.hermes = await readHermesUsage({ home: this.hermesHome(), days: opts.days ?? this.opts.cfg.hermesDays ?? 7 });

      if (this.opts.cfg.alerts && this.opts.cfg.alertPercent > 0) {
        const alerts = evaluateAlerts(this.quota, {
          thresholdPercent: Number(this.opts.cfg.alertPercent),
          fired: this.fired(),
          periodKey: this.quota.periodEnd,
        });
        for (const alert of alerts) await this.pushAlert(alert);
      }
    })();
    this.inflight = run;
    try {
      await run;
    } finally {
      this.inflight = null;
    }
  }

  /** 把这一轮的成败写回账号记录，界面据此显示「最近检查」。 */
  private rememberAccountResult(account: QuotaAccount | null): void {
    if (!account) return;
    const stored = this.accounts.accounts.find((a) => a.id === account.id);
    if (!stored) return;
    if (this.quota.ok) {
      stored.lastCheckedAt = Date.now();
      stored.lastError = null;
      stored.email = this.quota.account ?? stored.email;
      stored.planId = this.quota.planId ?? stored.planId;
      stored.planLabel = this.quota.planLabel ?? stored.planLabel;
      // 原生端点账号的名字跟着登录邮箱走：界面上看到的就是「哪个号」。
      if (stored.origin === 'native' && stored.email) stored.label = stored.email;
    } else {
      stored.lastError = this.quota.reason;
    }
    this.persistAccounts();
  }

  private async pushAlert(alert: QuotaAlert): Promise<void> {
    const host = this.host;
    if (!host) return;
    const text = this.alertText(alert, 'zh');
    try {
      await host.pushEvent({
        type: 'quota.window',
        ts: nowIso(this.opts.timezone),
        source: this.id,
        origin: 'internal',
        senderKey: this.id,
        text,
        meta: {
          window: alert.window,
          kind: alert.kind,
          usedPercent: alert.usedPercent,
          resetAt: alert.resetAt,
          account: this.keyInfo.accountLabel,
        },
      });
    } catch {
      /* 投递失败不该让取数循环掉线；下一轮还会按游标判断 */
    }
  }

  // ---------------------------------------------------------------- 账号

  private accountWire(account: QuotaAccount): AccountWire {
    return {
      id: account.id,
      label: account.label,
      source: account.source,
      origin: account.origin,
      keyHint: account.keyHint,
      email: account.email,
      planId: account.planId,
      planLabel: account.planLabel,
      active: account.id === this.accounts.activeId,
      /** 桌宠现在拿它说话的那个端点（`activeProvider`）。 */
      inUse: account.origin === 'native' && Boolean(this.activeProvider)
        && this.native.some((e) => e.dir === account.providerDir && e.name === this.activeProvider),
      addedAt: account.addedAt,
      lastCheckedAt: account.lastCheckedAt,
      lastError: account.lastError,
    };
  }

  /**
   * 加一个账号：先拿这把 Key 真取一次数（顺带问出邮箱与套餐），成功才落表。
   * 密钥经框架的秘密存储写进部署 `.env`，账号表里只有变量名与尾四位。
   */
  private async addAccount(input: { label?: unknown; key?: unknown; source?: unknown }): Promise<AccountsFile> {
    const key = String(input.key ?? '').trim();
    if (!key) throw new Error('empty key');
    const sourceId = String(input.source ?? this.opts.cfg.source ?? 'commandcode');
    const source = sourceById(sourceId);
    if (!source) throw new Error(`unknown source: ${sourceId}`);
    if (!source.implemented) throw new Error(`source not implemented: ${sourceId}`);

    const probe = await source.fetchQuota!({
      baseUrl: this.baseUrlFor(source),
      key,
      keySource: 'account',
      monthlyAllowanceUsd: Number(this.opts.cfg.monthlyAllowanceUsd) || 0,
    });
    if (!probe.ok) throw new Error(probe.reason ?? 'key rejected');

    const account = buildAccount(
      {
        label: String(input.label ?? ''),
        source: sourceId,
        key,
        email: probe.account,
        planId: probe.planId,
        planLabel: probe.planLabel,
      },
      this.accounts.accounts,
    );
    this.accounts = addAccountToFile(this.accounts, account, key, this.opts.secrets);
    this.persistAccounts();
    await this.refresh({ reason: 'account', force: true });
    return this.accounts;
  }

  private activate(id: string): AccountsFile {
    this.accounts = activateAccount(this.accounts, id);
    this.persistAccounts();
    return this.accounts;
  }

  private removeAccount(id: string): AccountsFile {
    this.accounts = removeAccountFromFile(this.accounts, id);
    this.persistAccounts();
    return this.accounts;
  }

  // ---------------------------------------------------------------- 计划价目

  /**
   * 从官网计划页抓「这个套餐能用哪些模型、单价多少、每个模型给多少额度」。
   * 换账号/换套餐（planId 变了）或强制刷新时重抓，否则吃模块自己的 12 小时缓存。
   */
  private async loadPricing(force: boolean): Promise<PlanPricingWire | null> {
    const source = this.currentSource();
    if (!source.implemented) {
      this.pricing = null;
      return null;
    }
    const planId = this.quota.ok ? this.quota.planId : this.pricing?.planId ?? null;
    if (!force && this.pricing && this.pricing.planId === planId) return this.pricing;
    const file = join(this.opts.dataDir, 'quota', `plan-${planSlugFor(planId) ?? 'pricing-limits'}.json`);
    try {
      mkdirSync(dirname(file), { recursive: true });
    } catch {
      /* 建不出目录只是缓存落不下来，抓取本身照旧 */
    }
    try {
      this.pricing = await fetchPlanPricing({ planId, cacheFile: file, maxAgeMs: force ? 0 : undefined });
    } catch (err) {
      this.pricing = null;
      throw err;
    }
    return this.pricing;
  }

  // ---------------------------------------------------------------- 模型清单

  private async loadModels(force: boolean): Promise<ModelInfo[]> {
    const source = this.currentSource();
    if (!source.implemented || !source.fetchModels) {
      this.models = [];
      return this.models;
    }
    if (!force && this.models.length > 0) return this.models;
    const resolved = this.resolveKey();
    try {
      this.models = await source.fetchModels({ baseUrl: this.baseUrlFor(source), key: resolved.key ?? '' });
    } catch {
      this.models = [];
    }
    return this.models;
  }

  // ---------------------------------------------------------------- 文案

  private windowName(window: QuotaAlert['window'], t: QuotaText): string {
    if (window === 'fiveHour') return t.panel.windowHours;
    if (window === 'weekly') return t.panel.windowWeek;
    return t.panel.windowMonth;
  }

  private alertText(alert: QuotaAlert, language: Language): string {
    const t = quotaText(language);
    const source = this.currentSource();
    const name = this.windowName(alert.window, t);
    const zh = String(language).toLowerCase().startsWith('zh');
    const used = alert.used === null || alert.cap === null
      ? percent(alert.usedPercent, 1)
      : `${money(alert.used)}/${money(alert.cap)}`;
    const detail = alert.kind === 'exhausted'
      ? zh
        ? `已经用完（${used}）`
        : `is used up (${used})`
      : zh
        ? `已用 ${used}`
        : `at ${used}`;
    const reset = alert.resetAt === null
      ? ''
      : zh
        ? `，${clockText(alert.resetAt)} 重置（还有 ${durationText(alert.resetAt - Date.now(), 'zh')}）`
        : `, resets ${clockText(alert.resetAt)} (in ${durationText(alert.resetAt - Date.now(), 'en')})`;
    const rest = this.quota.monthlyCredits === null
      ? ''
      : zh
        ? `。本月还余 ${money(this.quota.monthlyCredits)}`
        : `. ${money(this.quota.monthlyCredits)} left this month`;
    const who = this.keyInfo.accountLabel ? (zh ? `${this.keyInfo.accountLabel} 的 ` : `${this.keyInfo.accountLabel} `) : '';
    // 正文只陈述事实：要不要说、怎么说，在 ENV_PROMPT.md 里，不往事件里塞指令。
    return zh
      ? `${t.events.prefix} ${who}${source.label} ${name}${detail}${reset}${rest}。`
      : `${t.events.prefix} ${who}${source.label} ${name} ${detail}${reset}${rest}.`;
  }

  private summary(language: Language): string {
    const t = quotaText(language);
    const zh = String(language).toLowerCase().startsWith('zh');
    const source = this.currentSource();
    const lines: string[] = [];
    if (!source.implemented) {
      lines.push(zh
        ? `${t.tools.statusHeading}：这家供应商（${source.label}）还没有实现取数，将来走：${source.plan}`
        : `${t.tools.statusHeading}: ${source.label} is not wired up yet; planned source: ${source.plan}`);
      return lines.join('\n');
    }
    if (!this.quota.ok) {
      lines.push(zh
        ? `${t.tools.statusHeading}：取不到（${this.quota.reason ?? '未知原因'}）。`
        : `${t.tools.statusHeading}: unavailable (${this.quota.reason ?? 'unknown'}).`);
    } else {
      lines.push(`${t.tools.statusHeading}：${this.quota.planLabel ?? this.quota.planId ?? '—'}`
        + (this.keyInfo.accountLabel ? (zh ? `（账号 ${this.keyInfo.accountLabel}）` : ` (account ${this.keyInfo.accountLabel})`) : '')
        + (this.quota.periodEnd ? zh ? `，本周期到 ${clockText(Date.parse(this.quota.periodEnd))}` : `, period ends ${clockText(Date.parse(this.quota.periodEnd))}` : ''));
      if (this.quota.monthlyCredits !== null) {
        lines.push(zh
          ? `本月余额 ${money(this.quota.monthlyCredits)}${this.quota.monthlyAllowance ? `（额度 ${money(this.quota.monthlyAllowance)}，已用 ${percent(this.quota.monthlyUsedPercent, 1)}）` : ''}`
          : `${money(this.quota.monthlyCredits)} left this month${this.quota.monthlyAllowance ? ` (allowance ${money(this.quota.monthlyAllowance)}, ${percent(this.quota.monthlyUsedPercent, 1)} used)` : ''}`);
      }
      for (const [name, w] of [[t.panel.windowHours, this.quota.fiveHour], [t.panel.windowWeek, this.quota.weekly]] as const) {
        if (!w) continue;
        const reset = w.resetAt === null ? '' : zh
          ? `，${clockText(w.resetAt)} 重置（还有 ${durationText(w.resetAt - Date.now(), 'zh')}）`
          : `, resets ${clockText(w.resetAt)} (in ${durationText(w.resetAt - Date.now(), 'en')})`;
        lines.push(`${name} ${money(w.used)}/${money(w.cap)}（${percent(w.usedPercent, 1)}）${reset}`);
      }
      if (this.accounts.accounts.length > 1) {
        lines.push(zh ? `账号 ${this.accounts.accounts.length} 个，当前用「${this.keyInfo.accountLabel ?? '默认' }」` : `${this.accounts.accounts.length} accounts, using ${this.keyInfo.accountLabel ?? 'default'}`);
      }
    }
    if (this.hermes?.available && this.hermes.total) {
      const h = this.hermes.total;
      lines.push(zh
        ? `Hermes 最近 ${this.hermes.days} 天：${h.calls} 次调用，输入 ${compactCount(h.inputTokens)}、输出 ${compactCount(h.outputTokens)}、缓存读 ${compactCount(h.cacheReadTokens)}、推理 ${compactCount(h.reasoningTokens)} token`
        : `Hermes, last ${this.hermes.days} days: ${h.calls} calls, input ${compactCount(h.inputTokens)}, output ${compactCount(h.outputTokens)}, cache read ${compactCount(h.cacheReadTokens)}, reasoning ${compactCount(h.reasoningTokens)}`);
    }
    return lines.join('\n');
  }

  private hermesText(days: number, language: Language): string {
    const t = quotaText(language);
    const zh = String(language).toLowerCase().startsWith('zh');
    const usage = this.hermes;
    if (!usage || !usage.available) return `${t.tools.hermesHeading(days)}：${t.tools.hermesUnavailable}${usage?.reason ? `（${usage.reason}）` : ''}`;
    if (!usage.total || usage.models.length === 0) return `${t.tools.hermesHeading(days)}：${t.tools.hermesNone}`;
    const lines = [t.tools.hermesHeading(days)];
    for (const row of usage.models.slice(0, 8)) {
      lines.push(zh
        ? `- ${row.model || '—'}：${row.calls} 次，输入 ${compactCount(row.inputTokens)}、输出 ${compactCount(row.outputTokens)}、缓存读 ${compactCount(row.cacheReadTokens)}、推理 ${compactCount(row.reasoningTokens)} token`
        : `- ${row.model || '—'}: ${row.calls} calls, input ${compactCount(row.inputTokens)}, output ${compactCount(row.outputTokens)}, cache read ${compactCount(row.cacheReadTokens)}, reasoning ${compactCount(row.reasoningTokens)} tokens`);
    }
    const h = usage.total;
    lines.push(zh
      ? `${t.tools.totals}：${h.calls} 次调用，${compactCount(h.totalTokens)} token`
      : `${t.tools.totals}: ${h.calls} calls, ${compactCount(h.totalTokens)} tokens`);
    return lines.join('\n');
  }

  // ---------------------------------------------------------------- 工具

  private statusTool(): ToolDef {
    return {
      name: 'quota_status',
      description: quotaText('en').tools.statusDesc,
      tags: [...QUOTA_TOOL_TAGS],
      parameters: QUOTA_STATUS_PARAMETERS,
      handler: async () => {
        await this.refresh({ reason: 'tool', days: this.opts.cfg.hermesDays });
        const t = quotaText('zh');
        return this.quota.ok ? `${t.tools.statusHeading}\n${this.summary('zh')}` : `${t.tools.statusHeading}：${this.summary('zh')}`;
      },
    };
  }

  private hermesTool(): ToolDef {
    return {
      name: 'quota_hermes',
      description: quotaText('en').tools.hermesDesc,
      tags: [...QUOTA_TOOL_TAGS],
      parameters: QUOTA_HERMES_PARAMETERS,
      handler: async (args) => {
        const raw = Number(args.days);
        const days = Number.isFinite(raw) && raw >= 1 ? Math.min(90, Math.round(raw)) : Number(this.opts.cfg.hermesDays) || 7;
        this.hermes = await readHermesUsage({ home: this.hermesHome(), days });
        return this.hermesText(days, 'zh');
      },
    };
  }

  // ---------------------------------------------------------------- 面板数据面

  /**
   * 面板「配置」页签上的保存：字段在这里校验/夹紧，一次写回自己的配置段。
   * 不走框架配置页那条路（那边是 400ms 防抖即时保存，敲一半的数字会被存下来）。
   */
  private saveSettings(input: Record<string, unknown>): void {
    const num = (raw: unknown, min: number, max: number, fallback: number): number => {
      const n = Number(raw);
      return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
    };
    const text = (raw: unknown): string => String(raw ?? '').trim();
    const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(input, key);

    const beforeThreshold = this.opts.cfg.alertPercent;
    const patch: Partial<QuotaConfigSection> = {};

    // 行为类
    if (has('alerts')) patch.alerts = Boolean(input.alerts);
    if (has('alertPercent')) patch.alertPercent = num(input.alertPercent, 0, 100, this.opts.cfg.alertPercent ?? 80);
    if (has('pollMinutes')) patch.pollMinutes = num(input.pollMinutes, 0, 1440, this.opts.cfg.pollMinutes ?? 10);
    if (has('hermesDays')) patch.hermesDays = num(input.hermesDays, 1, 90, this.opts.cfg.hermesDays ?? 7);

    // 连接类
    if (has('source')) {
      const id = text(input.source);
      if (sourceById(id)) patch.source = id;
    }
    if (has('commandcodeBaseUrl')) patch.commandcodeBaseUrl = text(input.commandcodeBaseUrl);
    if (has('monthlyAllowanceUsd')) patch.monthlyAllowanceUsd = Math.max(0, Number(input.monthlyAllowanceUsd) || 0);
    if (has('hermesHome')) patch.hermesHome = text(input.hermesHome);
    if (has('envFile')) patch.envFile = text(input.envFile);
    if (has('authFile')) patch.authFile = text(input.authFile);
    // 密钥：留空表示「不动它」，免得面板每次保存都把已有密钥抹掉。
    if (has('commandcodeKey')) {
      const key = text(input.commandcodeKey);
      if (key) patch.commandcodeKey = key;
    }
    if (has('clearCommandcodeKey') && input.clearCommandcodeKey === true) patch.commandcodeKey = '';

    if (Object.keys(patch).length === 0) return;
    this.opts.persist(patch);
    // 阈值变过就清一次提醒游标：降阈值后该提醒的窗口不必等到下次重置。
    if (patch.alertPercent !== undefined && patch.alertPercent !== beforeThreshold) this.firedByAccount.clear();
    this.schedule();
  }

  private async invoke(panel: string, method: string, args: unknown[], language: Language): Promise<unknown> {
    if (panel !== 'quota' && panel !== 'settings') throw new Error(`unknown panel: ${panel}`);
    const first = (args?.[0] ?? {}) as {
      days?: unknown;
      refresh?: unknown;
      label?: unknown;
      key?: unknown;
      id?: unknown;
      source?: unknown;
      alerts?: unknown;
      alertPercent?: unknown;
      pollMinutes?: unknown;
      hermesDays?: unknown;
    };
    const days = Number.isFinite(Number(first.days)) ? Math.min(90, Math.max(1, Math.round(Number(first.days)))) : this.opts.cfg.hermesDays || 7;

    switch (method) {
      case 'state':
        // 进界面先看手上这份（不拉网络，立刻显示）；要新的网络读数走 refresh 或各卡的按钮。
        // Hermes 那几张表读的是本机 sqlite，换统计范围就地重读，不算「网络刷新」。
        if (this.hermes === null || this.hermes.days !== days) {
          this.hermes = await readHermesUsage({ home: this.hermesHome(), days });
        }
        return this.view(language);
      case 'refresh': {
        await this.refresh({ reason: 'panel', force: method === 'refresh', days });
        return this.view(language);
      }
      case 'addAccount': {
        await this.addAccount(first);
        return this.view(language);
      }
      case 'activateAccount': {
        const id = String(first.id ?? '');
        if (!id) throw new Error('missing account id');
        this.activate(id);
        await this.refresh({ reason: 'account', force: true, days });
        return this.view(language);
      }
      case 'removeAccount': {
        const id = String(first.id ?? '');
        if (!id) throw new Error('missing account id');
        this.removeAccount(id);
        await this.refresh({ reason: 'account', force: true, days });
        return this.view(language);
      }
      case 'models': {
        await this.loadModels(first.refresh === true);
        return this.view(language);
      }
      case 'pricing': {
        await this.loadPricing(first.refresh === true);
        return this.view(language);
      }
      case 'saveSettings': {
        this.saveSettings(first as Record<string, unknown>);
        return this.view(language);
      }
      default:
        throw new Error(`unknown method: ${method}`);
    }
  }

  view(language: Language): QuotaView {
    const source = this.currentSource();
    const sources: SourceWire[] = SOURCES.map((s) => ({
      id: s.id,
      label: s.label,
      implemented: s.implemented,
      needs: s.needs,
      plan: s.plan,
      current: s.id === source.id,
    }));
    const models: ModelInfoWire[] = this.models.map((m) => ({
      id: m.id,
      name: m.name,
      contextLength: m.contextLength,
      endpoints: m.endpoints,
    }));
    return {
      quota: this.quota,
      hermes: this.hermes ?? {
        available: false,
        reason: 'not read yet',
        dbPath: this.hermesHome(),
        via: 'none',
        days: this.opts.cfg.hermesDays ?? 7,
        models: [],
        daily: [],
        total: null,
        sessions: 0,
        firstSeen: null,
        lastSeen: null,
      },
      key: this.keyInfo,
      config: {
        source: source.id,
        alerts: Boolean(this.opts.cfg.alerts),
        alertPercent: Number(this.opts.cfg.alertPercent) || 0,
        pollMinutes: Number(this.opts.cfg.pollMinutes) || 0,
        hermesDays: Number(this.opts.cfg.hermesDays) || 7,
        hermesHome: this.hermesHome(),
        envFile: this.envFile(),
        authFile: (this.opts.cfg.authFile ?? '').trim(),
        baseUrl: this.baseUrlFor(source),
        keyHint: (this.opts.cfg.commandcodeKey ?? '').trim() ? maskKey(this.opts.cfg.commandcodeKey ?? '') : '',
        monthlyAllowanceUsd: Number(this.opts.cfg.monthlyAllowanceUsd) || 0,
      },
      language,
      alerted: [...this.fired()],
      accounts: { activeId: this.accounts.activeId, list: this.accounts.accounts.map((a) => this.accountWire(a)) },
      sources,
      models,
      pricing: this.pricing,
    };
  }
}
