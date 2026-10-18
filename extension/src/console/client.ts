/**
 * 控制台面板：一页里几张卡——套餐额度、账号、供应商、可用模型、计划价目与额度、
 * Hermes 用量、提醒设置。
 *
 * 数据全走 `ctx.invoke`（`state` / `refresh` / `addAccount` / `activateAccount` /
 * `removeAccount` / `models` / `pricing`），设置走 `ctx.setConfig('world:quota', …)`；
 * 面板不直连 HTTP、不碰 document.body。密钥只在添加账号那一次经 invoke 递过去，面板不落存储。
 * 语言取 `ctx.language`，文案在 ../i18n.ts。
 */
import type { ConsoleCell, ConsoleClientBundle, ConsolePanelContext, ConsoleProgress } from 'cortico/web/shared/client-panel.ts';
import { agoText, clockText, compactCount, durationText, money, percent } from '../format.ts';
import { quotaText } from '../i18n.ts';
import type { AccountWire, ModelWire, QuotaView, QuotaWire, WindowWire } from '../view-types.ts';
import './style.css';

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function windowTone(w: WindowWire | null, threshold: number): 'plain' | 'warn' | 'accent' {
  if (!w || w.usedPercent === null) return 'plain';
  if (w.usedPercent >= 100) return 'warn';
  return threshold > 0 && w.usedPercent >= threshold ? 'accent' : 'plain';
}

function mount(ctx: ConsolePanelContext): void {
  const L = ctx.language;
  const t = (): ReturnType<typeof quotaText> => quotaText(L);
  const ui = ctx.ui;

  const shell = ui.h('div', 'quota-shell');
  ctx.root.appendChild(shell);

  let view: QuotaView | null = null;
  let days = 7;
  let daysTouched = false;
  let busy: { dispose(): void } | null = null;

  const setBusy = (on: boolean): void => {
    if (on) {
      busy ??= ui.busy(t().panel.quotaTitle, t().panel.loading);
      return;
    }
    busy?.dispose();
    busy = null;
  };

  // ------------------------------------------------------------ 卡片一：套餐额度

  const quotaSheet = ui.sheet({ title: t().panel.quotaTitle, en: 'command code plan quota', desc: t().panel.quotaDesc });
  const quotaBar = ui.rowbar();
  const quotaNote = ui.h('span', 'quota-note');
  const refreshButton = ui.button(t().panel.refresh, { size: 'sm', onClick: () => void load(true) });
  quotaBar.append(refreshButton, quotaNote);
  const quotaBody = ui.h('div', 'quota-body');
  quotaSheet.body.append(quotaBar, quotaBody);
  shell.appendChild(quotaSheet.el);

  function keyLabel(source: string): string {
    const table = t().panel.keySources as Record<string, string>;
    return table[source] ?? source;
  }

  function renderQuota(): void {
    const q = view?.quota ?? null;
    quotaBody.replaceChildren();
    quotaNote.textContent = q ? `${t().panel.fetchedAt} ${clockText(q.fetchedAt)} · ${keyLabel(q.keySource)}` : '';
    if (!q) return;

    if (!q.ok) {
      quotaBody.appendChild(ui.msgline(`${t().panel.failed}：${q.reason ?? '—'}`, true));
    }

    quotaBody.appendChild(
      ui.kv([
        { k: t().panel.account, v: q.account ?? '—' },
        { k: t().panel.plan, v: `${q.planLabel ?? q.planId ?? '—'}${q.planStatus ? ` · ${q.planStatus}` : ''}` },
        {
          k: t().panel.period,
          v: q.periodEnd
            ? `${q.periodStart ? `${clockText(Date.parse(q.periodStart))} → ` : ''}${clockText(Date.parse(q.periodEnd))}`
            : '—',
        },
        { k: t().panel.keySource, v: keyLabel(q.keySource) },
      ]),
    );

    const threshold = view?.config.alertPercent ?? 0;
    const windows: Array<[string, WindowWire | null]> = [
      [t().panel.windowHours, q.fiveHour],
      [t().panel.windowWeek, q.weekly],
    ];
    for (const [name, w] of windows) {
      if (!w) continue;
      const bar: ConsoleProgress = ui.progress({
        label: name,
        max: w.cap,
        value: w.used,
        tone: windowTone(w, threshold),
        format: (value, max) => {
          const reset = w.resetAt === null
            ? ''
            : ` · ${t().panel.resetsIn} ${durationText(w.resetAt - Date.now(), L)}（${clockText(w.resetAt)}）`;
          const flag = w.exceeded ? ` · ${t().panel.exceeded}` : '';
          return `${money(value)} / ${money(max)}${reset}${flag}`;
        },
      });
      quotaBody.appendChild(bar.el);
    }

    if (q.monthlyCredits !== null) {
      if (q.monthlyAllowance !== null && q.monthlyUsedPercent !== null) {
        quotaBody.appendChild(
          ui.progress({
            label: t().panel.windowMonth,
            max: q.monthlyAllowance,
            value: Math.max(0, q.monthlyAllowance - q.monthlyCredits),
            tone: q.monthlyUsedPercent >= 100 ? 'warn' : threshold > 0 && q.monthlyUsedPercent >= threshold ? 'accent' : 'plain',
            format: (value, max) => `${money(value)} / ${money(max)} · ${t().panel.remaining} ${money(q.monthlyCredits)}`,
          }).el,
        );
      } else {
        quotaBody.appendChild(ui.msgline(`${t().panel.remaining} ${money(q.monthlyCredits)} · ${t().panel.noMonthAllowance}`));
      }
    }
  }

  // ------------------------------------------------------------ 卡片：账号
  //
  // 密钥只经 `invoke('addAccount')` 递给 World，面板不落任何存储；列表里只有尾四位。

  const accountsSheet = ui.sheet({ title: t().panel.accountsTitle, en: 'accounts', desc: t().panel.accountsDesc });
  const accountsBar = ui.rowbar();
  let showForm = false;
  const addToggle = ui.button(t().panel.accountAdd, {
    size: 'sm',
    onClick: () => {
      showForm = !showForm;
      renderAccounts();
    },
  });
  const accountsNote = ui.h('span', 'quota-note');
  accountsBar.append(addToggle, accountsNote);

  const accountForm = ui.h('div', 'quota-form');
  const labelInput = ui.input({ placeholder: t().panel.accountFormLabel, cls: 'mono' });
  const keyInput = ui.input({ type: 'password', placeholder: t().panel.accountFormKey, cls: 'mono' });
  const addButton = ui.button(t().panel.accountAdd, { variant: 'primary', size: 'sm', onClick: () => void addAccount() });
  const accountFormBar = ui.rowbar();
  accountFormBar.appendChild(addButton);
  accountForm.append(
    ui.field(t().panel.accountFormLabel, labelInput),
    ui.field(t().panel.accountFormKey, keyInput),
    ui.msgline(t().panel.accountFormHint),
    accountFormBar,
  );
  accountForm.style.display = 'none';

  const accountsList = ui.h('div', 'quota-body');
  accountsSheet.body.append(accountsBar, accountForm, accountsList);
  shell.appendChild(accountsSheet.el);

  async function addAccount(): Promise<void> {
    const key = keyInput.value.trim();
    if (!key) {
      ui.toast(t().panel.accountFormKey, 'bad');
      return;
    }
    setBusy(true);
    try {
      view = await ctx.invoke<QuotaView>('addAccount', [{ label: labelInput.value.trim(), key, source: view?.config.source }]);
      keyInput.value = '';
      labelInput.value = '';
      showForm = false;
      renderAll();
      ui.toast(t().panel.accountAdded, 'ok');
    } catch (err) {
      ui.toast(errText(err), 'bad');
    } finally {
      setBusy(false);
    }
  }

  async function accountAction(method: 'activateAccount' | 'removeAccount', id: string): Promise<void> {
    setBusy(true);
    try {
      view = await ctx.invoke<QuotaView>(method, [{ id }]);
      renderAll();
    } catch (err) {
      ui.toast(errText(err), 'bad');
    } finally {
      setBusy(false);
    }
  }

  async function removeWithConfirm(account: AccountWire): Promise<void> {
    const ok = await ui.confirm({ title: t().panel.accountRemove, body: account.label, danger: true });
    if (ok) await accountAction('removeAccount', account.id);
  }

  function renderAccounts(): void {
    accountForm.style.display = showForm ? '' : 'none';
    accountsList.replaceChildren();
    const data = view?.accounts ?? null;
    if (!data) return;
    accountsNote.textContent = data.list.length > 0 ? `${data.list.length}` : '';
    if (data.list.length === 0) {
      accountsList.appendChild(ui.msgline(t().panel.accountNone));
      return;
    }
    const table = ui.table({ head: [t().panel.accountFormLabel, t().panel.plan, t().panel.keySource, t().panel.accountLastChecked, ''] });
    for (const account of data.list) {
      // 名称那一格：账号名（域名账号就是登录邮箱）+ 来源标记 + 「桌宠在用」
      const nameCell = ui.h('div', 'quota-account');
      nameCell.appendChild(
        ui.h('span', 'mono', account.email && account.email !== account.label ? `${account.label} · ${account.email}` : account.label),
      );
      const badges = ui.h('div', 'quota-actions');
      badges.appendChild(ui.chip(account.origin === 'native' ? t().panel.accountNative : t().panel.accountManual, 'plain'));
      if (account.inUse) badges.appendChild(ui.chip(t().panel.accountInUse, 'accent'));
      nameCell.appendChild(badges);

      const actions = ui.h('div', 'quota-actions');
      if (account.active) {
        actions.appendChild(ui.chip(t().panel.accountActive, 'accent'));
      } else {
        actions.appendChild(ui.button(t().panel.accountUse, { size: 'sm', onClick: () => void accountAction('activateAccount', account.id) }));
      }
      // 桌宠端点账号不在面板里删：要删就去桌宠的「模型供应商」页删那个端点。
      if (account.origin === 'manual') {
        actions.appendChild(ui.button(t().panel.accountRemove, { variant: 'danger', size: 'sm', onClick: () => void removeWithConfirm(account) }));
      }

      table.addRow([
        { el: nameCell },
        account.planLabel ?? account.planId ?? '—',
        account.keyHint,
        account.lastError
          ? `${t().panel.accountBad}: ${account.lastError}`
          : account.lastCheckedAt === null ? '—' : agoText(account.lastCheckedAt, L),
        { el: actions },
      ]);
    }
    accountsList.appendChild(table.el);
  }

  // ------------------------------------------------------------ 卡片：供应商

  const sourcesSheet = ui.sheet({ title: t().panel.sourcesTitle, en: 'vendors', desc: t().panel.sourcesDesc });
  const sourceSelect = ui.select({ options: [], onChange: (value) => void switchSource(value) });
  const sourcesBody = ui.h('div', 'quota-body');
  sourcesSheet.body.append(ui.field(t().panel.sourcesTitle, sourceSelect), sourcesBody);
  shell.appendChild(sourcesSheet.el);

  async function switchSource(id: string): Promise<void> {
    setBusy(true);
    try {
      // 切供应商走配置面（`worlds.quota.source` 是 x-hot）：World 下一轮就按新家取数。
      await ctx.setConfig('world:quota', { 'worlds.quota.source': id });
      await load(true);
    } catch (err) {
      ui.toast(errText(err), 'bad');
    } finally {
      setBusy(false);
    }
  }

  function renderSources(): void {
    const list = view?.sources ?? [];
    const current = view?.config.source ?? '';
    sourceSelect.replaceChildren(
      ...list.map((source) => {
        const option = document.createElement('option');
        option.value = source.id;
        option.textContent = source.implemented
          ? source.label
          : `${source.label} · ${t().panel.sourceNotImplemented}`;
        return option;
      }),
    );
    sourceSelect.value = current;
    // 各家要什么、将来从哪儿查，不在这页堆表格：走项目里的备忘文档。
    sourcesBody.replaceChildren(ui.msgline(t().panel.sourcesNotes));
  }

  // ------------------------------------------------------------ 卡片：可用模型

  const modelsSheet = ui.sheet({ title: t().panel.modelsTitle, en: 'models', desc: t().panel.modelsDesc });
  const modelsBar = ui.rowbar();
  const modelsNote = ui.h('span', 'quota-note');
  modelsBar.append(ui.button(t().panel.refresh, { size: 'sm', onClick: () => void fetchModels() }), modelsNote);
  const modelsBody = ui.h('div', 'quota-body');
  modelsSheet.body.append(modelsBar, modelsBody);
  shell.appendChild(modelsSheet.el);

  async function fetchModels(): Promise<void> {
    setBusy(true);
    try {
      view = await ctx.invoke<QuotaView>('models', [{ refresh: true, days }]);
      renderAll();
    } catch (err) {
      ui.toast(errText(err), 'bad');
    } finally {
      setBusy(false);
    }
  }

  function renderModels(): void {
    const models = view?.models ?? [];
    const source = (view?.sources ?? []).find((s) => s.current);
    modelsNote.textContent = source ? `${source.label} · ${models.length}` : String(models.length);
    modelsBody.replaceChildren();
    if (models.length === 0) {
      modelsBody.appendChild(ui.msgline(t().panel.modelsEmpty));
      return;
    }
    const table = ui.table({ head: [t().panel.colModel, t().panel.colContext, 'endpoints'], maxHeight: '320px' });
    for (const model of models.slice(0, 200)) {
      table.addRow([
        { text: model.name || model.id, cls: 'mono' },
        model.contextLength === null ? '—' : compactCount(model.contextLength),
        model.endpoints.join(', '),
      ]);
    }
    modelsBody.appendChild(table.el);
  }

  // ------------------------------------------------------------ 卡片：计划价目与额度

  const pricingSheet = ui.sheet({ title: t().panel.pricingTitle, en: 'plan pricing', desc: t().panel.pricingDesc });
  const pricingBar = ui.rowbar();
  const pricingNote = ui.h('span', 'quota-note');
  pricingBar.append(ui.button(t().panel.pricingFetch, { size: 'sm', onClick: () => void fetchPricing() }), pricingNote);
  const pricingBody = ui.h('div', 'quota-body');
  pricingSheet.body.append(pricingBar, pricingBody);
  shell.appendChild(pricingSheet.el);

  async function fetchPricing(): Promise<void> {
    setBusy(true);
    try {
      view = await ctx.invoke<QuotaView>('pricing', [{ refresh: true, days }]);
      renderAll();
    } catch (err) {
      ui.toast(errText(err), 'bad');
    } finally {
      setBusy(false);
    }
  }

  const priceCell = (value: number | null, free: boolean): string =>
    value === null ? '—' : free ? t().panel.freeLabel : `$${value}`;

  function renderPricing(): void {
    const pricing = view?.pricing ?? null;
    pricingBody.replaceChildren();
    if (!pricing) {
      pricingNote.textContent = '';
      pricingBody.appendChild(ui.msgline(t().panel.pricingEmpty));
      return;
    }
    pricingNote.textContent = t().panel.pricingFetched(clockText(pricing.fetchedAt), pricing.via);
    pricingBody.appendChild(ui.msgline(`${pricing.planLabel ?? pricing.planId ?? '—'} · ${pricing.models.length} · ${pricing.url}`));
    if (pricing.reason) pricingBody.appendChild(ui.msgline(pricing.reason, true));
    const table = ui.table({
      head: [
        t().panel.colModel,
        t().panel.colContext,
        t().panel.colInput,
        t().panel.colOutput,
        t().panel.colCacheRead,
        t().panel.colCacheWrite,
        t().panel.colMonthlyCredits,
      ],
      maxHeight: '380px',
    });
    for (const row of pricing.models) {
      table.addRow([
        { text: row.name, cls: 'mono' },
        row.context ?? '—',
        priceCell(row.inputPerM, row.free),
        priceCell(row.outputPerM, row.free),
        priceCell(row.cacheReadPerM, row.free),
        priceCell(row.cacheWritePerM, row.free),
        row.monthlyCredits === null ? '—' : money(row.monthlyCredits),
      ]);
    }
    if (pricing.models.length === 0) table.clear(t().panel.empty);
    pricingBody.appendChild(table.el);
  }

  // ------------------------------------------------------------ 卡片二：Hermes 用量

  const hermesSheet = ui.sheet({ title: t().panel.hermesTitle, en: 'hermes token usage', desc: t().panel.hermesDesc });
  const hermesBar = ui.rowbar();
  const daysBar = ui.segmented(
    [
      { value: '1', label: `1 ${t().panel.days}` },
      { value: '7', label: `7 ${t().panel.days}` },
      { value: '30', label: `30 ${t().panel.days}` },
      { value: '90', label: `90 ${t().panel.days}` },
    ],
    {
      value: '7',
      size: 'sm',
      onSelect: (value) => {
        days = Number(value) || 7;
        daysTouched = true;
        void load(false);
      },
    },
  );
  const hermesNote = ui.h('span', 'quota-note');
  hermesBar.append(ui.h('span', 'quota-bar-label', t().panel.daysSegmented), daysBar.el, hermesNote);
  const hermesBody = ui.h('div', 'quota-body');
  hermesSheet.body.append(hermesBar, hermesBody);
  shell.appendChild(hermesSheet.el);

  function modelCells(row: ModelWire): ConsoleCell[] {
    return [
      { text: `${row.provider ? `${row.provider} · ` : ''}${row.model || '—'}`, cls: 'mono' },
      row.calls,
      compactCount(row.inputTokens),
      compactCount(row.outputTokens),
      compactCount(row.cacheReadTokens),
      compactCount(row.reasoningTokens),
      compactCount(row.totalTokens),
    ];
  }

  function renderHermes(): void {
    const h = view?.hermes ?? null;
    hermesBody.replaceChildren();
    if (!h) return;
    hermesNote.textContent = `${h.via === 'export' ? 'export' : h.dbPath} · ${h.days} ${t().panel.days} · ${h.sessions} ${t().panel.sessions}`;
    if (!h.available) {
      hermesBody.appendChild(ui.msgline(`${t().panel.hermesMissing}：${h.reason ?? '—'}`, true));
      hermesBody.appendChild(ui.msgline(t().panel.hermesHint));
      return;
    }
    if (h.total) {
      hermesBody.appendChild(
        ui.statgrid([
          { k: t().panel.calls, v: String(h.total.calls) },
          { k: t().panel.input, v: compactCount(h.total.inputTokens), unit: t().panel.tokens },
          { k: t().panel.output, v: compactCount(h.total.outputTokens), unit: t().panel.tokens },
          { k: t().panel.cacheRead, v: compactCount(h.total.cacheReadTokens), unit: t().panel.tokens },
          { k: t().panel.reasoning, v: compactCount(h.total.reasoningTokens), unit: t().panel.tokens },
          { k: t().panel.tokens, v: compactCount(h.total.totalTokens), accent: true },
        ]),
      );
    }

    const models = ui.table({
      head: [t().panel.model, t().panel.calls, t().panel.input, t().panel.output, t().panel.cacheRead, t().panel.reasoning, t().panel.tokens],
      maxHeight: '320px',
    });
    for (const row of h.models) models.addRow(modelCells(row));
    if (h.models.length === 0) models.clear(t().panel.empty);
    hermesBody.appendChild(models.el);

    const daily = ui.table({ head: [t().panel.day, t().panel.calls, t().panel.tokens], maxHeight: '260px' });
    for (const row of h.daily.slice(0, 31)) daily.addRow([{ text: row.day, cls: 'mono' }, row.calls, compactCount(row.totalTokens)]);
    if (h.daily.length === 0) daily.clear(t().panel.empty);
    hermesBody.appendChild(daily.el);

    if (h.lastSeen) hermesBody.appendChild(ui.msgline(`${t().panel.lastSeen} ${agoText(h.lastSeen * 1000, L)}`));
  }

  // ------------------------------------------------------------ 取数

  async function load(force: boolean): Promise<void> {
    setBusy(true);
    try {
      view = await ctx.invoke<QuotaView>(force ? 'refresh' : 'state', [{ days }]);
      renderAll();
    } catch (err) {
      quotaBody.replaceChildren(ui.msgline(`${t().panel.failed}：${errText(err)}`, true));
      hermesBody.replaceChildren(ui.msgline(`${t().panel.failed}：${errText(err)}`, true));
    } finally {
      setBusy(false);
    }
  }

  function renderAll(): void {
    // 统计范围没被手动换过时，跟着配置里的天数走（配置在「配置」页签里改）。
    const c = view?.config;
    if (c && !daysTouched) {
      days = c.hermesDays;
      daysBar.setValue(String(days));
    }
    renderQuota();
    renderAccounts();
    renderSources();
    renderModels();
    renderPricing();
    renderHermes();
  }

  void (async () => {
    // 进界面：先把手上这份画出来（立刻显示、不转圈），再拉一次新的。
    await load(false);
    await load(true);
  })();
  // 之后不再自动取数（使用者要的：进来拉一次 + 按钮手动刷），各卡上的按钮各自负责自己的那一份。
}

// -------------------------------------------------------------- 「配置」页签
//
// 框架的配置页是 400ms 防抖即时保存（敲一半就写进去），所以这里自己画一页：
// 表单填完点「保存」才一次性写回（World 端 saveSettings → ctx.persist）。

function mountSettings(ctx: ConsolePanelContext): void {
  const L = ctx.language;
  const t = (): ReturnType<typeof quotaText> => quotaText(L);
  const ui = ctx.ui;

  const shell = ui.h('div', 'quota-shell');
  ctx.root.appendChild(shell);

  let view: QuotaView | null = null;
  let busy: { dispose(): void } | null = null;

  const setBusy = (on: boolean): void => {
    if (on) {
      busy ??= ui.busy(t().panel.settingsTitle, t().panel.loading);
      return;
    }
    busy?.dispose();
    busy = null;
  };

  const sheet = ui.sheet({ title: t().panel.settingsTitle, en: 'settings', desc: t().panel.settingsDesc });
  const body = ui.h('div', 'quota-body');

  // 行为类
  const alertsBox = ui.checkbox(t().panel.alerts, { checked: true, title: t().panel.alertsHint });
  const thresholdInput = ui.input({ type: 'number', cls: 'mono' });
  const pollInput = ui.input({ type: 'number', cls: 'mono' });
  const hermesDaysInput = ui.input({ type: 'number', cls: 'mono' });

  // 连接类
  const sourceSelect = ui.select({ options: [] });
  const baseUrlInput = ui.input({ cls: 'mono' });
  const keyInput = ui.input({ type: 'password', cls: 'mono', placeholder: t().panel.keyKeep });
  const allowanceInput = ui.input({ type: 'number', cls: 'mono' });
  const hermesHomeInput = ui.input({ cls: 'mono' });
  const envFileInput = ui.input({ cls: 'mono' });
  const authFileInput = ui.input({ cls: 'mono' });

  /** 路径那几项配一个本机选择器；取消就保持原值。 */
  const pathField = (label: string, input: HTMLInputElement, kind: 'file' | 'directory'): HTMLElement => {
    const bar = ui.rowbar();
    bar.append(
      ui.button(t().panel.pickPath, {
        size: 'sm',
        onClick: () => {
          void (async () => {
            try {
              const picked = await ctx.pickPath({ kind });
              if (picked) input.value = picked;
            } catch (err) {
              ui.toast(errText(err), 'bad');
            }
          })();
        },
      }),
    );
    const row = ui.h('div', 'quota-field-row');
    row.append(input, bar);
    return ui.field(label, row);
  };

  body.append(
    ui.h('div', 'quota-group', t().panel.groupBehavior),
    alertsBox.el,
    ui.field(t().panel.threshold, thresholdInput),
    ui.msgline(t().panel.thresholdHint),
    ui.field(t().panel.pollMinutes, pollInput),
    ui.msgline(t().panel.pollHint),
    ui.field(t().panel.hermesDaysLabel, hermesDaysInput),
    ui.msgline(t().panel.hermesDaysHint),
    ui.h('div', 'quota-group', t().panel.groupConnection),
    ui.field(t().panel.sourceLabel, sourceSelect),
    ui.field(t().panel.baseUrlLabel, baseUrlInput),
    ui.field(t().panel.keyLabel, keyInput),
    ui.msgline(t().panel.keyHint),
    ui.field(t().panel.allowanceLabel, allowanceInput),
    ui.msgline(t().panel.allowanceHint),
    ui.h('div', 'quota-group', t().panel.groupPaths),
    pathField(t().panel.hermesHomeLabel, hermesHomeInput, 'directory'),
    ui.msgline(t().panel.hermesHomeHint),
    pathField(t().panel.envFileLabel, envFileInput, 'file'),
    ui.msgline(t().panel.envFileHint),
    pathField(t().panel.authFileLabel, authFileInput, 'file'),
    ui.msgline(t().panel.authFileHint),
  );

  const bar = ui.rowbar();
  bar.append(
    ui.msgline(t().panel.settingsHint),
    ui.button(t().panel.save, { variant: 'primary', size: 'sm', onClick: () => void save() }),
  );
  sheet.body.append(body, bar);
  shell.appendChild(sheet.el);

  function render(): void {
    const c = view?.config;
    if (!c) return;
    const sources = view?.sources ?? [];
    sourceSelect.replaceChildren(
      ...sources.map((source) => {
        const option = document.createElement('option');
        option.value = source.id;
        option.textContent = source.implemented ? source.label : `${source.label} · ${t().panel.sourceNotImplemented}`;
        return option;
      }),
    );
    sourceSelect.value = c.source;

    alertsBox.setChecked(c.alerts);
    const set = (input: HTMLInputElement, value: string): void => {
      if (document.activeElement !== input) input.value = value;
    };
    set(thresholdInput, String(c.alertPercent));
    set(pollInput, String(c.pollMinutes));
    set(hermesDaysInput, String(c.hermesDays));
    set(baseUrlInput, c.baseUrl);
    keyInput.value = '';
    keyInput.placeholder = c.keyHint ? `${t().panel.keyKeep}（${c.keyHint}）` : t().panel.keyKeep;
    set(allowanceInput, String(c.monthlyAllowanceUsd));
    set(hermesHomeInput, c.hermesHome);
    set(envFileInput, c.envFile);
    set(authFileInput, c.authFile);
  }

  async function save(): Promise<void> {
    setBusy(true);
    try {
      view = await ctx.invoke<QuotaView>('saveSettings', [
        {
          alerts: alertsBox.checked,
          alertPercent: thresholdInput.value,
          pollMinutes: pollInput.value,
          hermesDays: hermesDaysInput.value,
          source: sourceSelect.value,
          commandcodeBaseUrl: baseUrlInput.value,
          commandcodeKey: keyInput.value,
          monthlyAllowanceUsd: allowanceInput.value,
          hermesHome: hermesHomeInput.value,
          envFile: envFileInput.value,
          authFile: authFileInput.value,
        },
      ]);
      render();
      ui.toast(t().panel.saved, 'ok');
    } catch (err) {
      ui.toast(errText(err), 'bad');
    } finally {
      setBusy(false);
    }
  }

  void (async () => {
    setBusy(true);
    try {
      view = await ctx.invoke<QuotaView>('state', [{ days: 7 }]);
      render();
    } catch (err) {
      body.replaceChildren(ui.msgline(`${t().panel.failed}：${errText(err)}`, true));
    } finally {
      setBusy(false);
    }
  })();
}

const bundle: ConsoleClientBundle = { panels: { quota: { mount }, settings: { mount: mountSettings } } };

export default bundle;
