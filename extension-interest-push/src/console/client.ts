/**
 * 控制台面板：三个页签。
 * - `list`：抓到的条目列表，点一条标记已读并尽力切到详情页签（切不过去就留在本页，详情页签自己也能选条目）。
 * - `detail`：标题、作者与团队、期刊与分区、上线日期、DOI、**爬取源**、原文摘要、译文、打开原文与下载。
 * - `settings`：推送节奏、数据源、期刊集合、翻译术语表；**填完点保存**才写回（不走框架配置页的边打边存）。
 *
 * 数据全走 `ctx.invoke`；面板不直连 HTTP、不碰 document.body。语言取 `ctx.language`，文案在 ../i18n.ts。
 */
import type { ConsoleClientBundle, ConsolePanelContext } from 'cortico/web/shared/client-panel.ts';
import { interestText, type InterestText } from '../i18n.ts';
import type { InterestPushView, NewsItem, NewsRow, TranslationState } from '../view-types.ts';
import './style.css';

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

interface InvokeResult {
  ok: boolean;
  reason: string | null;
  view: InterestPushView;
}

const fmtTime = (ms: number | null): string =>
  ms === null ? '—' : new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));

/** 页签之间的跳转：控制台是 hash 路由，切失败就留在原地（本页仍能用）。 */
function switchPanel(ctx: ConsolePanelContext, panelId: string): void {
  try {
    const hash = `#/provider/${encodeURIComponent(ctx.pageId)}/${panelId}`;
    if (location.hash !== hash) location.hash = hash;
  } catch {
    /* 路由变了也没关系：详情页签自己能选条目 */
  }
}

function metaLine(t: InterestText, row: NewsRow): string {
  return [row.journal, row.tier ?? '', row.issued, row.source].filter((s) => s !== '').join(' · ');
}

// --------------------------------------------------------------------- 列表

function mountList(ctx: ConsolePanelContext): void {
  const t = interestText(ctx.language);
  const ui = ctx.ui;
  let view: InterestPushView | null = null;
  let busy: { dispose(): void } | null = null;

  const setBusy = (on: boolean): void => {
    if (on) {
      busy ??= ui.busy(t.panel.listTitle, t.list.checking);
      return;
    }
    busy?.dispose();
    busy = null;
  };

  const sheet = ui.sheet({ title: t.panel.listTitle, desc: t.list.hint });
  const bar = ui.rowbar();
  const note = ui.h('span', 'ip-note');
  const refresh = ui.button(t.list.refresh, {
    size: 'sm',
    onClick: () => {
      void (async () => {
        setBusy(true);
        try {
          const out = await ctx.invoke<InvokeResult>('list', ['checkNow']);
          view = out.view;
          ui.toast(t.settings.saved, 'ok');
        } catch (err) {
          ui.toast(errText(err), 'bad');
        } finally {
          setBusy(false);
          render();
        }
      })();
    },
  });
  bar.append(refresh, note);
  const body = ui.h('div', 'ip-list');
  sheet.body.append(bar, body);
  ctx.root.appendChild(sheet.el);

  function render(): void {
    const v = view;
    note.textContent = v
      ? `${t.lamps.check} ${fmtTime(v.schedule.lastCheckAt)} · ${t.lamps.today} ${t.lamps.todayValue(v.schedule.pushedToday, v.config.dailyCap)}${v.schedule.paused ? ` · ${t.badges.paused}` : ''}`
      : '';
    body.replaceChildren();
    if (!v) return;
    if (v.lastError) body.appendChild(ui.msgline(t.list.error(v.lastError), true));
    if (v.items.length === 0) {
      body.appendChild(ui.placeholder(t.list.empty));
      return;
    }
    for (const row of v.items) {
      const line = ui.h('div', 'ip-row');
      const head = ui.h('div', 'ip-rowhead');
      head.append(ui.h('span', 'ip-title', row.title));
      head.append(ui.pill(row.unread ? t.list.unread : t.list.read, row.unread ? 'on' : 'plain'));
      line.append(head, ui.h('div', 'ip-meta', metaLine(t, row)));
      line.addEventListener('click', () => {
        void (async () => {
          try {
            const out = await ctx.invoke<InvokeResult>('list', ['open', row.id]);
            view = out.view;
            render();
            switchPanel(ctx, 'detail');
          } catch (err) {
            ui.toast(errText(err), 'bad');
          }
        })();
      });
      body.appendChild(line);
    }
  }

  void (async () => {
    setBusy(true);
    try {
      view = (await ctx.invoke<InvokeResult>('list', ['state'])).view;
      render();
    } catch (err) {
      body.replaceChildren(ui.msgline(`${t.list.error(errText(err))}`, true));
    } finally {
      setBusy(false);
    }
  })();
}

// --------------------------------------------------------------------- 详情

function mountDetail(ctx: ConsolePanelContext): void {
  const t = interestText(ctx.language);
  const ui = ctx.ui;
  let view: InterestPushView | null = null;
  let busy: { dispose(): void } | null = null;
  let pickedId = '';

  const setBusy = (on: boolean, text: string = t.detail.translating): void => {
    if (on) {
      busy ??= ui.busy(t.panel.detailTitle, text);
      return;
    }
    busy?.dispose();
    busy = null;
  };

  const picker = ui.select({ options: [], onInput: (value) => { void load(value); } });
  const pickRow = ui.rowbar();
  pickRow.append(ui.field(t.panel.listTitle, picker));
  const head = ui.sheet({ title: t.panel.detailTitle, desc: t.panel.detailDesc });
  head.body.appendChild(pickRow);

  const metaBody = ui.h('div', 'ip-detail');
  const abstractBody = ui.h('div', 'ip-abstract');
  const translationBody = ui.h('div', 'ip-translation');
  const actionBar = ui.rowbar();
  const note = ui.h('span', 'ip-note');
  head.body.append(metaBody, actionBar, note);
  ctx.root.appendChild(head.el);

  const abstractCard = ui.sheet({ title: t.detail.abstract });
  abstractCard.body.appendChild(abstractBody);
  const translationCard = ui.sheet({ title: t.detail.translation });
  translationCard.body.appendChild(translationBody);
  ctx.root.append(abstractCard.el, translationCard.el);

  function render(): void {
    const v = view;
    const item: NewsItem | null = v?.active ?? null;
    const options = (v?.items ?? []).map((row) => ({ value: row.id, label: `${row.unread ? '● ' : ''}${row.title.slice(0, 70)}` }));
    picker.replaceChildren(...options.map((o) => {
      const el = document.createElement('option');
      el.value = o.value;
      el.textContent = o.label;
      return el;
    }));
    if (item) {
      pickedId = item.id;
      picker.value = item.id;
    } else if (options.length > 0) {
      picker.value = options[0]?.value ?? '';
    }

    metaBody.replaceChildren();
    actionBar.replaceChildren();
    abstractBody.textContent = '';
    translationBody.replaceChildren();
    note.textContent = '';
    if (!item) {
      metaBody.appendChild(ui.placeholder(t.detail.pick));
      return;
    }
    metaBody.appendChild(
      ui.kv([
        { k: t.detail.journal, v: `${item.journal}${item.tier ? `（${item.tier}）` : ''}` },
        { k: t.detail.issued, v: item.issued },
        { k: t.detail.authors, v: item.authors.length > 0 ? item.authors.join('、') : t.detail.none },
        { k: t.detail.team, v: item.team ?? t.detail.none },
        { k: t.detail.doi, v: item.doi ?? t.detail.none },
        { k: t.detail.source, v: item.sourceDetail },
      ]),
    );
    const openBtn = ui.button(t.detail.openOriginal, { size: 'sm', onClick: () => window.open(item.url, '_blank', 'noopener') });
    const dlBtn = ui.button(t.detail.download, {
      size: 'sm',
      onClick: () => {
        void (async () => {
          setBusy(true, t.detail.downloading);
          try {
            const out = await ctx.invoke<InvokeResult>('detail', ['download']);
            view = out.view;
            ui.toast(out.ok ? String(out.reason ?? '') : t.detail.failed(String(out.reason ?? '')), out.ok ? 'ok' : 'bad');
          } catch (err) {
            ui.toast(errText(err), 'bad');
          } finally {
            setBusy(false);
          }
        })();
      },
    });
    dlBtn.disabled = item.pdfUrl === null;
    if (item.pdfUrl === null) dlBtn.title = t.detail.downloadOnlyOA;
    const tr = view?.translation ?? null;
    const trBtn = ui.button(tr?.text ? t.detail.retranslate : t.detail.translate, {
      size: 'sm',
      onClick: () => {
        void (async () => {
          setBusy(true);
          try {
            const out = await ctx.invoke<InvokeResult>('detail', ['translate']);
            view = out.view;
            if (!out.ok) ui.toast(t.detail.failed(String(out.reason ?? '')), 'bad');
          } catch (err) {
            ui.toast(errText(err), 'bad');
          } finally {
            setBusy(false);
            render();
          }
        })();
      },
    });
    actionBar.append(openBtn, dlBtn, trBtn);

    abstractBody.textContent = item.abstract || t.detail.none;
    if (tr) {
      if (tr.ok && tr.text) {
        translationBody.appendChild(ui.h('pre', 'ip-tr', tr.text));
        const bits: string[] = [];
        if (tr.cached) bits.push(t.detail.cached);
        if (tr.missing > 0) bits.push(t.detail.faithful(tr.missing));
        if (bits.length > 0) translationBody.appendChild(ui.msgline(bits.join(' · '), tr.missing > 0));
      } else {
        translationBody.appendChild(ui.msgline(t.detail.failed(String(tr.reason ?? '')), true));
      }
    } else {
      translationBody.appendChild(ui.placeholder(t.detail.translate));
    }
  }

  async function load(id?: string): Promise<void> {
    setBusy(true, t.list.checking);
    try {
      const out = await ctx.invoke<InvokeResult>('detail', ['state', id ?? pickedId]);
      view = out.view;
      render();
    } catch (err) {
      ui.toast(errText(err), 'bad');
    } finally {
      setBusy(false);
    }
  }

  void load();
}

// --------------------------------------------------------------------- 配置

function mountSettings(ctx: ConsolePanelContext): void {
  const t = interestText(ctx.language);
  const ui = ctx.ui;
  let view: InterestPushView | null = null;
  let busy: { dispose(): void } | null = null;

  const setBusy = (on: boolean): void => {
    if (on) {
      busy ??= ui.busy(t.panel.settingsTitle, t.settings.checking);
      return;
    }
    busy?.dispose();
    busy = null;
  };

  const field = (label: string, control: HTMLElement): HTMLLabelElement => ui.field(label, control);
  const text = (label: string, placeholder = ''): HTMLInputElement => ui.input({ placeholder });
  const area = (label: string, rows = 6): HTMLTextAreaElement => ui.textarea({ rows });

  // ---- 推送节奏
  const cadence = ui.sheet({ title: t.settings.groupPush, desc: t.panel.settingsDesc });
  const checkInput = text(t.settings.checkMinutes);
  const pushTimesInput = text(t.settings.pushTimes);
  const capInput = text(t.settings.dailyCap);
  const quietInput = text(t.settings.quiet);
  const daysInput = text(t.settings.pushDays);
  const roundsInput = text(t.settings.maxRounds);
  const pauseDate = ui.input({ type: 'date' });
  const resumeBtn = ui.button(t.settings.resumNow, { size: 'sm', onClick: () => { pauseDate.value = ''; } });
  const pauseBar = ui.rowbar();
  pauseBar.append(pauseDate, resumeBtn);
  cadence.body.append(
    field(t.settings.checkMinutes, checkInput),
    field(t.settings.pushTimes, pushTimesInput),
    field(t.settings.dailyCap, capInput),
    field(t.settings.quiet, quietInput),
    field(t.settings.pushDays, daysInput),
    field(t.settings.maxRounds, roundsInput),
    field(t.settings.pausedUntil, pauseBar),
  );

  // ---- 数据源
  const sources = ui.sheet({ title: t.settings.groupSources });
  const keywordsArea = area(t.settings.keywords, 7);
  const catsInput = text(t.settings.arxivCats);
  const windowInput = text(t.settings.windowDays);
  const rowsInput = text(t.settings.rowsPerJournal);
  const mailtoInput = text(t.settings.mailto);
  const dirInput = text(t.settings.downloadDir);
  const dirBar = ui.rowbar();
  dirBar.append(
    dirInput,
    ui.button('选择…', {
      size: 'sm',
      onClick: () => {
        void (async () => {
          try {
            const picked = await ctx.pickPath({ kind: 'directory', currentPath: dirInput.value });
            if (picked) dirInput.value = picked;
          } catch (err) {
            ui.toast(errText(err), 'bad');
          }
        })();
      },
    }),
  );
  sources.body.append(
    field(t.settings.keywords, keywordsArea),
    field(t.settings.arxivCats, catsInput),
    field(t.settings.windowDays, windowInput),
    field(t.settings.rowsPerJournal, rowsInput),
    field(t.settings.mailto, mailtoInput),
    field(t.settings.downloadDir, dirBar),
  );

  // ---- 期刊集合：一行五格 + 删除；「增加一行」追加
  const journalsTitle = ui.sheet({ title: t.settings.journals });
  const rowsHost = ui.h('div', 'ip-jrows');
  const journalRows: Array<{ label: HTMLInputElement; issn: HTMLInputElement; tier: HTMLInputElement; basis: HTMLInputElement; group: HTMLInputElement; el: HTMLElement }> = [];

  function addJournalRow(init?: { label?: string; issn?: string; tier?: string; tierBasis?: string; group?: string }): void {
    const el = ui.h('div', 'ip-jrow');
    const label = text(t.settings.journalLabel);
    const issn = text(t.settings.journalIssn);
    const tier = text(t.settings.journalTier);
    const basis = text(t.settings.journalBasis);
    const group = text(t.settings.journalGroup);
    label.value = init?.label ?? '';
    issn.value = init?.issn ?? '';
    tier.value = init?.tier ?? '';
    basis.value = init?.tierBasis ?? '';
    group.value = init?.group ?? '';
    const del = ui.button(t.settings.remove, {
      size: 'sm',
      variant: 'danger',
      onClick: () => {
        el.remove();
        const at = journalRows.findIndex((r) => r.el === el);
        if (at >= 0) journalRows.splice(at, 1);
      },
    });
    el.append(label, issn, tier, basis, group, del);
    rowsHost.appendChild(el);
    journalRows.push({ label, issn, tier, basis, group, el });
  }
  const addRow = ui.rowbar();
  addRow.append(ui.button(t.settings.addJournal, { size: 'sm', onClick: () => addJournalRow() }));
  journalsTitle.body.append(rowsHost, addRow);

  // ---- 翻译
  const translateSheet = ui.sheet({ title: t.settings.groupTranslate });
  const glossaryArea = area(t.settings.glossary, 14);
  translateSheet.body.append(field(t.settings.glossary, glossaryArea));

  // ---- 动作
  const actions = ui.rowbar();
  const saveBtn = ui.button(t.settings.save, { variant: 'primary', onClick: () => void save() });
  const checkBtn = ui.button(t.settings.checkNow, {
    size: 'sm',
    onClick: () => {
      void (async () => {
        setBusy(true);
        try {
          const out = await ctx.invoke<InvokeResult>('settings', ['checkNow']);
          view = out.view;
          render();
          ui.toast(t.settings.saved, 'ok');
        } catch (err) {
          ui.toast(errText(err), 'bad');
        } finally {
          setBusy(false);
        }
      })();
    },
  });
  const pushBtn = ui.button(t.settings.pushNow, {
    size: 'sm',
    onClick: () => {
      void (async () => {
        setBusy(true);
        try {
          const out = await ctx.invoke<InvokeResult>('settings', ['pushNow']);
          view = out.view;
          render();
        } catch (err) {
          ui.toast(errText(err), 'bad');
        } finally {
          setBusy(false);
        }
      })();
    },
  });
  const mute = ui.h('span', 'ip-note');
  actions.append(saveBtn, checkBtn, pushBtn, mute);

  ctx.root.append(cadence.el, sources.el, journalsTitle.el, translateSheet.el, actions);

  function render(): void {
    const v = view;
    if (!v) return;
    const c = v.config;
    const set = (input: HTMLInputElement, value: string): void => {
      if (document.activeElement !== input) input.value = value;
    };
    set(checkInput, String(c.checkMinutes));
    set(pushTimesInput, c.pushTimes.join(', '));
    set(capInput, String(c.dailyCap));
    set(quietInput, c.quiet.join(', '));
    set(daysInput, c.pushDays.join(', '));
    set(roundsInput, String(c.maxRounds));
    set(catsInput, c.arxivCats.join(', '));
    set(windowInput, String(c.windowDays));
    set(rowsInput, String(c.rowsPerJournal));
    set(mailtoInput, c.mailto);
    set(dirInput, c.downloadDir);
    if (document.activeElement !== glossaryArea) glossaryArea.value = c.glossary.join('\n');
    if (document.activeElement !== keywordsArea) keywordsArea.value = c.keywords.join('\n');
    if (c.pausedUntil > 0 && document.activeElement !== pauseDate) {
      const d = new Date(c.pausedUntil);
      pauseDate.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    } else if (c.pausedUntil === 0) {
      pauseDate.value = '';
    }
    mute.textContent = v.schedule.paused
      ? `${t.badges.paused} · ${t.lamps.today} ${t.lamps.todayValue(v.schedule.pushedToday, c.dailyCap)}`
      : `${t.lamps.check} ${fmtTime(v.schedule.lastCheckAt)} · ${t.badges.unread} ${v.items.filter((i) => i.unread).length}`;

    rowsHost.replaceChildren();
    journalRows.length = 0;
    for (const j of c.journals) addJournalRow(j);
  }

  async function save(): Promise<void> {
    setBusy(true);
    try {
      const paused = pauseDate.value.trim();
      const out = await ctx.invoke<InvokeResult>('settings', [
        'saveSettings',
        {
          checkMinutes: checkInput.value,
          pushTimes: pushTimesInput.value,
          dailyCap: capInput.value,
          quiet: quietInput.value,
          pushDays: daysInput.value.split(/[,\s]+/).filter((s) => s !== ''),
          maxRounds: roundsInput.value,
          pausedUntil: paused === '' ? 0 : new Date(`${paused}T23:59:59`).getTime(),
          keywords: keywordsArea.value.split('\n'),
          journals: journalRows.map((r) => ({ label: r.label.value, issn: r.issn.value, tier: r.tier.value, tierBasis: r.basis.value, group: r.group.value })),
          glossary: glossaryArea.value.split('\n'),
          arxivCats: catsInput.value.split(',').map((s) => s.trim()).filter((s) => s !== ''),
          windowDays: windowInput.value,
          rowsPerJournal: rowsInput.value,
          mailto: mailtoInput.value,
          downloadDir: dirInput.value,
        },
      ]);
      view = out.view;
      render();
      ui.toast(out.reason === 'clamped' ? t.settings.invalid : t.settings.saved, out.reason === 'clamped' ? 'bad' : 'ok');
    } catch (err) {
      ui.toast(errText(err), 'bad');
    } finally {
      setBusy(false);
    }
  }

  void (async () => {
    setBusy(true);
    try {
      view = (await ctx.invoke<InvokeResult>('settings', ['state'])).view;
      render();
    } catch (err) {
      ctx.root.appendChild(ui.msgline(errText(err), true));
    } finally {
      setBusy(false);
    }
  })();
}

const bundle: ConsoleClientBundle = {
  panels: {
    list: { mount: mountList },
    detail: { mount: mountDetail },
    settings: { mount: mountSettings },
  },
};

export default bundle;
