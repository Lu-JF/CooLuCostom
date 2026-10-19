/**
 * 控制台面板：三个页签，详情排第一。
 *
 * - `detail`：论文标题 → 原文摘要（带翻译按钮）→ 中文译文（连标题一起翻）→ 详情（期刊、作者、DOI、爬取源、
 *   打开原文与下载）。顶部两个按钮：刷新、换一篇。
 * - `list`：抓到的条目，点一条切到详情并标记已读。
 * - `settings`：推送节奏、数据源、期刊集合、翻译术语表四组，每组各有「保存本组」；短字符项（推送时刻、
 *   研究领域关键词）是标签，时间用下拉菜单选，星期是七个可切换的按钮。
 *
 * 数据全走 `ctx.invoke`；面板不直连 HTTP、不碰 document.body。语言取 `ctx.language`，文案在 ../i18n.ts。
 */
import type { ConsoleClientBundle, ConsolePanelContext } from 'cortico/web/shared/client-panel.ts';
import { interestText, type InterestText } from '../i18n.ts';
import type { InterestPushView, NewsRow } from '../view-types.ts';
import './style.css';

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

interface InvokeResult {
  ok: boolean;
  reason: string | null;
  view: InterestPushView;
}

type Cfg = InterestPushView['config'];

const fmtTime = (ms: number | null): string =>
  ms === null ? '—' : new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));

const uniqSorted = (list: string[]): string[] => [...new Set(list.map((v) => v.trim()).filter((v) => v !== ''))].sort();

const localDateValue = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** 00:00 到 23:45，一刻钟一档（能设 10:15 这类时刻）。 */
const TIME_OPTIONS: string[] = Array.from({ length: 96 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`);

/** 页签之间的跳转：控制台是 hash 路由，切失败就留在原地（本页仍能用）。 */
function switchPanel(ctx: ConsolePanelContext, panelId: string): void {
  try {
    const hash = `#/provider/${encodeURIComponent(ctx.pageId)}/${panelId}`;
    if (location.hash !== hash) location.hash = hash;
  } catch {
    /* 路由变了也没关系 */
  }
}

function metaLine(t: InterestText, row: NewsRow): string {
  return [row.journal, row.tier ?? '', row.issued, row.source].filter((s) => s !== '').join(' · ');
}

type U = ConsolePanelContext['ui'];

/** 标签与控件同行的紧凑字段（框架的 field 会把控件顶到下一行，这里自己排）。 */
function fieldRow(ui: U, label: string, control: HTMLElement): HTMLLabelElement {
  const row = ui.h('label', 'ip-fieldrow');
  row.append(ui.h('span', 'ip-fieldlabel', label), control);
  return row;
}

function numberInput(ui: U, value: string, width = '5.5em'): HTMLInputElement {
  const input = ui.input({ type: 'number' });
  input.value = value;
  input.style.width = width;
  return input;
}

/** 时间下拉菜单：避免手打时间出错。 */
function timeSelect(ui: U, value: string, onChange: (v: string) => void): HTMLSelectElement {
  return ui.select({ options: TIME_OPTIONS, value, onInput: onChange });
}

interface TagEditor {
  el: HTMLDivElement;
  values(): string[];
  setValues(values: string[]): void;
}

/** 标签式编辑器：短字符串横着排，点 ✕ 删掉。 */
function tagEditor(
  ui: U,
  t: InterestText,
  opts: { add: () => HTMLSelectElement | HTMLInputElement; signal?: AbortSignal },
): TagEditor {
  const el = ui.h('div', 'ip-tags');
  const chips = ui.h('div', 'ip-taglist');
  const addRow = ui.rowbar();
  const addBtn = ui.button('增加', { size: 'sm', onClick: () => add() });
  let current: string[] = [];
  const redraw = (): void => {
    chips.replaceChildren();
    if (current.length === 0) chips.appendChild(ui.h('span', 'ip-tagempty', '—'));
    for (const value of current) {
      const chip = ui.h('span', 'ip-tag');
      chip.append(ui.h('span', 'ip-tagtext', value));
      const x = ui.button('✕', {
        size: 'sm',
        onClick: () => {
          current = current.filter((v) => v !== value);
          redraw();
        },
      });
      x.classList.add('ip-tagx');
      chip.appendChild(x);
      chips.appendChild(chip);
    }
  };
  const control = opts.add();
  // 输入框上按回车也能加；监听随面板信号一起撤销。
  if (control instanceof HTMLInputElement) {
    control.addEventListener(
      'keydown',
      (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          add();
        }
      },
      opts.signal ? { signal: opts.signal } : undefined,
    );
  }
  const add = (): void => {
    const raw = control instanceof HTMLSelectElement ? control.value : (control as HTMLInputElement).value;
    const value = String(raw ?? '').trim();
    if (value === '' || current.includes(value)) return;
    current.push(value);
    if (!(control instanceof HTMLSelectElement)) (control as HTMLInputElement).value = '';
    redraw();
  };
  addRow.append(control, addBtn);
  el.append(chips, ui.h('div', 'ip-taghint', t.settings.groupTags), addRow);
  redraw();
  return {
    el,
    values: () => [...current],
    setValues: (values) => {
      current = [...values];
      redraw();
    },
  };
}

/** 星期按钮：点一下亮，再点一下灭。 */
function weekdayButtons(ui: U, onChange?: () => void): { el: HTMLDivElement; values(): number[]; setValues(days: number[]): void } {
  const labels = ['一', '二', '三', '四', '五', '六', '日'];
  const el = ui.h('div', 'ip-week');
  let on = new Set<number>();
  const buttons = labels.map((label, at) => {
    const day = at + 1;
    const btn = ui.button(label, {
      size: 'sm',
      onClick: () => {
        if (on.has(day)) on.delete(day);
        else on.add(day);
        sync();
        onChange?.();
      },
    });
    el.appendChild(btn);
    return { day, btn };
  });
  const sync = (): void => {
    for (const { day, btn } of buttons) btn.classList.toggle('on', on.has(day));
  };
  return {
    el,
    values: () => [...on].sort((a, b) => a - b),
    setValues: (days) => {
      on = new Set(days);
      sync();
    },
  };
}

// --------------------------------------------------------------------- 详情

function mountDetail(ctx: ConsolePanelContext): void {
  const t = interestText(ctx.language);
  const ui = ctx.ui;
  let view: InterestPushView | null = null;
  let busy: { dispose(): void } | null = null;

  const setBusy = (on: boolean, text: string = t.detail.translating): void => {
    if (on) {
      busy ??= ui.busy(t.panel.detailTitle, text);
      return;
    }
    busy?.dispose();
    busy = null;
  };

  const top = ui.rowbar();
  const note = ui.h('span', 'ip-note');
  const refreshBtn = ui.button(t.detail.refresh, {
    size: 'sm',
    onClick: () => {
      void (async () => {
        setBusy(true, t.list.checking);
        try {
          view = (await ctx.invoke<InvokeResult>('detail', ['refresh'])).view;
          render();
        } catch (err) {
          ui.toast(errText(err), 'bad');
        } finally {
          setBusy(false);
        }
      })();
    },
  });
  const nextBtn = ui.button(t.detail.next, {
    size: 'sm',
    onClick: () => {
      void (async () => {
        try {
          view = (await ctx.invoke<InvokeResult>('detail', ['next'])).view;
          render();
        } catch (err) {
          ui.toast(errText(err), 'bad');
        }
      })();
    },
  });
  top.append(refreshBtn, nextBtn, note);
  ctx.root.appendChild(top);

  // 标题与摘要合成一张「论文速览」：标题一行醒目，摘要一段浅色，中间留一口气。
  const overviewCard = ui.sheet({ title: t.detail.overviewTitle });
  const overviewBar = ui.rowbar();
  const titleBody = ui.h('div', 'ip-ov-title');
  const abstractBody = ui.h('div', 'ip-ov-abstract');
  const translateBtn = ui.button(t.detail.translate, {
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
  overviewBar.append(translateBtn);
  // 标题 → 摘要 → 翻译按钮：按钮就落在原文与译文之间，符合阅读顺序。
  overviewCard.body.append(titleBody, abstractBody, overviewBar);

  // 译文与原文同构：标题一行、摘要一段。
  const translationCard = ui.sheet({ title: t.detail.translation });
  const translatedTitle = ui.h('div', 'ip-ov-title');
  const translationBody = ui.h('div', 'ip-ov-abstract ip-tr');
  translationCard.body.append(translatedTitle, translationBody);

  const detailCard = ui.sheet({ title: t.panel.detailCardTitle });
  const detailBody = ui.h('div', 'ip-detail');
  const actionBar = ui.rowbar();
  detailCard.body.append(detailBody, actionBar);

  ctx.root.append(overviewCard.el, translationCard.el, detailCard.el);

  function render(): void {
    const v = view;
    const item = v?.active ?? null;
    note.textContent = v ? `${t.lamps.check} ${fmtTime(v.schedule.lastCheckAt)} · ${t.lamps.today} ${t.lamps.todayValue(v.schedule.pushedToday, v.config.dailyCap)}` : '';
    titleBody.textContent = item?.title ?? '';
    const hasAbstract = (item?.abstract ?? '').trim() !== '';
    abstractBody.textContent = item ? (hasAbstract ? item.abstract : t.detail.noAbstractFromSource) : '';
    abstractBody.classList.toggle('ip-muted', item !== null && !hasAbstract);
    detailBody.replaceChildren();
    actionBar.replaceChildren();
    translatedTitle.replaceChildren();
    translationBody.replaceChildren();
    translateBtn.textContent = v?.translation?.text ? t.detail.retranslate : t.detail.translate;
    translateBtn.disabled = item === null;
    nextBtn.disabled = (v?.items.length ?? 0) <= 1;
    if (!item) {
      titleBody.textContent = t.detail.pick;
      overviewCard.el.hidden = false;
      abstractBody.textContent = '';
      translationCard.el.hidden = true;
      detailCard.el.hidden = true;
      return;
    }
    overviewCard.el.hidden = false;
    translationCard.el.hidden = false;
    detailCard.el.hidden = false;

    const tr = v?.translation ?? null;
    if (tr?.ok && (tr.title || tr.text)) {
      translatedTitle.textContent = tr.title ?? '';
      translatedTitle.hidden = (tr.title ?? '') === '';
      translationBody.textContent = tr.text ?? '';
      translationBody.hidden = (tr.text ?? '') === '';
      if (tr.title && !hasAbstract) translationBody.appendChild(ui.msgline(t.detail.titleOnlyTranslation));
      const bits: string[] = [];
      if (tr.cached) bits.push(t.detail.cached);
      if (tr.missing > 0) bits.push(t.detail.faithful(tr.missing));
      if (bits.length > 0) translationCard.el.appendChild(ui.msgline(bits.join(' · '), tr.missing > 0));
    } else if (tr && !tr.ok) {
      translationBody.hidden = false;
      translationBody.textContent = '';
      translationBody.appendChild(ui.msgline(t.detail.failed(String(tr.reason ?? '')), true));
    } else {
      translationBody.hidden = false;
      translationBody.textContent = '';
      translationBody.appendChild(ui.placeholder(t.detail.notTranslated));
    }

    detailBody.appendChild(
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
    actionBar.append(openBtn, dlBtn);
  }

  void (async () => {
    setBusy(true, t.list.checking);
    try {
      view = (await ctx.invoke<InvokeResult>('detail', ['state'])).view;
      render();
    } catch (err) {
      titleBody.textContent = errText(err);
    } finally {
      setBusy(false);
    }
  })();
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
          view = (await ctx.invoke<InvokeResult>('list', ['checkNow'])).view;
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
      // 只标「已读」，未读靠没有标记来区分。
      if (!row.unread) head.append(ui.pill(t.list.read, 'plain'));
      if (!row.hasAbstract) head.append(ui.pill(t.list.noAbstract, 'plain'));
      line.append(head, ui.h('div', 'ip-meta', metaLine(t, row)));
      line.addEventListener('click', () => {
        void (async () => {
          try {
            view = (await ctx.invoke<InvokeResult>('list', ['open', row.id])).view;
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
      body.replaceChildren(ui.msgline(t.list.error(errText(err)), true));
    } finally {
      setBusy(false);
    }
  })();
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

  // ---- 顶部动作
  const top = ui.rowbar();
  const note = ui.h('span', 'ip-note');
  const checkBtn = ui.button(t.settings.checkNow, {
    size: 'sm',
    onClick: () => {
      void (async () => {
        setBusy(true);
        try {
          view = (await ctx.invoke<InvokeResult>('settings', ['checkNow'])).view;
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
          view = (await ctx.invoke<InvokeResult>('settings', ['pushNow'])).view;
          render();
        } catch (err) {
          ui.toast(errText(err), 'bad');
        } finally {
          setBusy(false);
        }
      })();
    },
  });
  top.append(checkBtn, pushBtn, note);

  // ---- 推送节奏
  const cadence = ui.sheet({ title: t.settings.groupPush });
  const checkInput = numberInput(ui, '120');
  const capInput = numberInput(ui, '2');
  const roundsInput = numberInput(ui, '3');
  const numbersRow = ui.h('div', 'ip-fields');
  numbersRow.append(
    fieldRow(ui, t.settings.checkMinutes, checkInput),
    fieldRow(ui, t.settings.dailyCap, capInput),
    fieldRow(ui, t.settings.maxRounds, roundsInput),
  );
  const pushTimesEditor = tagEditor(ui, t, { add: () => timeSelect(ui, '10:30', () => {}) });
  const quietRow = ui.h('div', 'ip-fields');
  const quietStart = timeSelect(ui, '22:30', () => {});
  const quietEnd = timeSelect(ui, '08:30', () => {});
  quietRow.append(fieldRow(ui, t.settings.quietStart, quietStart), fieldRow(ui, t.settings.quietEnd, quietEnd));
  const week = weekdayButtons(ui);
  // 星期单独占一行：七个按钮横排，不与其它字段挤在一起。
  const weekRow = ui.h('div', 'ip-row-block');
  weekRow.append(ui.h('span', 'ip-fieldlabel', t.settings.pushDays), week.el);
  const pauseRow = ui.h('div', 'ip-fields');
  const pauseDate = ui.input({ type: 'date' });
  const resumeBtn = ui.button(t.settings.resumNow, { size: 'sm', onClick: () => { pauseDate.value = ''; } });
  pauseRow.append(fieldRow(ui, t.settings.pausedUntil, pauseDate), resumeBtn);
  const cadenceSave = ui.button(t.settings.saveSection, { variant: 'primary', size: 'sm', onClick: () => void saveCard('cadence') });
  const cadenceFoot = ui.rowbar();
  cadenceFoot.append(cadenceSave);
  cadence.body.append(
    numbersRow,
    fieldRow(ui, t.settings.pushTimes, ui.h('div')),
    pushTimesEditor.el,
    fieldRow(ui, t.settings.quiet, quietRow),
    weekRow,
    pauseRow,
    cadenceFoot,
  );

  // ---- 数据源
  const sources = ui.sheet({ title: t.settings.groupSources });
  const keywordsEditor = tagEditor(ui, t, {
    add: () => ui.input({ placeholder: t.settings.keywordPlaceholder }),
    signal: ctx.signal,
  });
  const catsEditor = tagEditor(ui, t, { add: () => ui.input({ placeholder: 'eess.SP' }), signal: ctx.signal });
  const windowInput = numberInput(ui, '30');
  const rowsInput = numberInput(ui, '50');
  const mailtoInput = ui.input({ placeholder: 'name@example.org' });
  const dirInput = ui.input({ placeholder: '' });
  const dirBar = ui.h('div', 'ip-inline');
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
  const sourceNumbers = ui.h('div', 'ip-fields');
  sourceNumbers.append(fieldRow(ui, t.settings.windowDays, windowInput), fieldRow(ui, t.settings.rowsPerJournal, rowsInput));
  const sourcesSave = ui.button(t.settings.saveSection, { variant: 'primary', size: 'sm', onClick: () => void saveCard('sources') });
  const sourcesFoot = ui.rowbar();
  sourcesFoot.append(sourcesSave);
  sources.body.append(
    fieldRow(ui, t.settings.keywords, ui.h('div')),
    keywordsEditor.el,
    fieldRow(ui, t.settings.arxivCats, ui.h('div')),
    catsEditor.el,
    sourceNumbers,
    fieldRow(ui, t.settings.mailto, mailtoInput),
    fieldRow(ui, t.settings.downloadDir, dirBar),
    sourcesFoot,
  );

  // ---- 期刊集合：四列 + 表头 + 说明
  const journals = ui.sheet({ title: t.settings.journals });
  const journalGrid = ui.h('div', 'ip-grid');
  const journalHead = ui.h('div', 'ip-jrow ip-gridhead');
  for (const label of [t.settings.colLabel, t.settings.colIssn, t.settings.colTier, t.settings.colGroup, '']) {
    journalHead.appendChild(ui.h('span', 'ip-gridcell', label));
  }
  const journalRowsHost = ui.h('div', 'ip-gridbody');
  journalGrid.append(journalHead, journalRowsHost);
  const journalRows: Array<{ label: HTMLInputElement; issn: HTMLInputElement; tier: HTMLInputElement; group: HTMLInputElement; el: HTMLElement }> = [];
  const addJournalRow = (init?: { label?: string; issn?: string; tier?: string; group?: string }): void => {
    const el = ui.h('div', 'ip-jrow');
    const label = ui.input({ placeholder: t.settings.colLabel });
    const issn = ui.input({ placeholder: '0888-3270' });
    const tier = ui.input({ placeholder: '中科院一区 · JCR Q1' });
    const group = ui.input({ placeholder: 'A' });
    label.value = init?.label ?? '';
    issn.value = init?.issn ?? '';
    tier.value = init?.tier ?? '';
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
    el.append(label, issn, tier, group, del);
    journalRowsHost.appendChild(el);
    journalRows.push({ label, issn, tier, group, el });
  };
  const journalFoot = ui.rowbar();
  const journalsSave = ui.button(t.settings.saveSection, { variant: 'primary', size: 'sm', onClick: () => void saveCard('journals') });
  journalFoot.append(ui.button(t.settings.addJournal, { size: 'sm', onClick: () => addJournalRow() }), journalsSave);
  journals.body.append(journalGrid, ui.msgline(t.settings.journalNote), journalFoot);

  // ---- 翻译术语表：两列 + 表头
  const glossary = ui.sheet({ title: t.settings.glossary });
  const termGrid = ui.h('div', 'ip-grid');
  const termHead = ui.h('div', 'ip-jrow ip-gridhead ip-grow');
  for (const label of [t.settings.colEnglish, t.settings.colChinese, '']) {
    termHead.appendChild(ui.h('span', 'ip-gridcell', label));
  }
  const termRowsHost = ui.h('div', 'ip-gridbody');
  termGrid.append(termHead, termRowsHost);
  const termRows: Array<{ en: HTMLInputElement; zh: HTMLInputElement; el: HTMLElement }> = [];
  const addTermRow = (init?: { en?: string; zh?: string }): void => {
    const el = ui.h('div', 'ip-jrow ip-grow');
    const en = ui.input({ placeholder: 'bearing' });
    const zh = ui.input({ placeholder: '轴承' });
    en.value = init?.en ?? '';
    zh.value = init?.zh ?? '';
    const del = ui.button(t.settings.remove, {
      size: 'sm',
      variant: 'danger',
      onClick: () => {
        el.remove();
        const at = termRows.findIndex((r) => r.el === el);
        if (at >= 0) termRows.splice(at, 1);
      },
    });
    el.append(en, zh, del);
    termRowsHost.appendChild(el);
    termRows.push({ en, zh, el });
  };
  const termFoot = ui.rowbar();
  const glossarySave = ui.button(t.settings.saveSection, { variant: 'primary', size: 'sm', onClick: () => void saveCard('glossary') });
  termFoot.append(ui.button(t.settings.addTerm, { size: 'sm', onClick: () => addTermRow() }), glossarySave);
  glossary.body.append(termGrid, termFoot);

  ctx.root.append(top, cadence.el, sources.el, journals.el, glossary.el);

  // ---- 取值与保存
  const pausedUntilFromForm = (): number => {
    const value = pauseDate.value.trim();
    return value === '' ? 0 : new Date(`${value}T23:59:59`).getTime();
  };
  const form = () => ({
    checkMinutes: Number(checkInput.value),
    dailyCap: Number(capInput.value),
    maxRounds: Number(roundsInput.value),
    pushTimes: uniqSorted(pushTimesEditor.values()),
    quiet: [quietStart.value, quietEnd.value],
    pushDays: week.values(),
    pausedUntil: pausedUntilFromForm(),
    keywords: uniqSorted(keywordsEditor.values()),
    arxivCats: uniqSorted(catsEditor.values()),
    windowDays: Number(windowInput.value),
    rowsPerJournal: Number(rowsInput.value),
    mailto: mailtoInput.value.trim(),
    downloadDir: dirInput.value.trim(),
    journals: journalRows
      .map((r) => ({ label: r.label.value.trim(), issn: r.issn.value.trim(), tier: r.tier.value.trim(), group: r.group.value.trim() }))
      .filter((j) => j.label !== '' && j.issn !== ''),
    glossary: uniqSorted(termRows.map((r) => `${r.en.value.trim()} | ${r.zh.value.trim()}`)).filter((line) => !/^\|\s*$/.test(line)),
  });

  const snapshotOf = (cfg: Cfg, card: 'cadence' | 'sources' | 'journals' | 'glossary'): unknown => {
    if (card === 'cadence') {
      return { checkMinutes: cfg.checkMinutes, dailyCap: cfg.dailyCap, maxRounds: cfg.maxRounds, pushTimes: cfg.pushTimes, quiet: cfg.quiet, pushDays: cfg.pushDays, pausedUntil: cfg.pausedUntil };
    }
    if (card === 'sources') {
      return { keywords: cfg.keywords, arxivCats: cfg.arxivCats, windowDays: cfg.windowDays, rowsPerJournal: cfg.rowsPerJournal, mailto: cfg.mailto, downloadDir: cfg.downloadDir };
    }
    if (card === 'journals') {
      return cfg.journals.map((j) => ({ label: j.label, issn: j.issn, tier: j.tier, group: j.group }));
    }
    return cfg.glossary;
  };

  async function saveCard(card: 'cadence' | 'sources' | 'journals' | 'glossary'): Promise<void> {
    const names: Record<string, string> = {
      cadence: t.settings.groupPush,
      sources: t.settings.groupSources,
      journals: t.settings.journals,
      glossary: t.settings.glossary,
    };
    const name = names[card] ?? card;
    setBusy(true);
    try {
      const before = view?.config ?? null;
      const payload = form();
      const out = await ctx.invoke<InvokeResult>('settings', ['saveSettings', payload]);
      view = out.view;
      // 保存后回读一遍：值确实变了 = 写回成功；与提交值一致 = 原样落地，否则说明被夹到合法范围。
      const after = snapshotOf(view.config, card);
      const wanted = snapshotOf(payload as unknown as Cfg, card);
      const changed = before === null ? true : JSON.stringify(snapshotOf(before, card)) !== JSON.stringify(after);
      if (!out.ok || (!changed && JSON.stringify(wanted) !== JSON.stringify(snapshotOf(before as Cfg, card)))) {
        ui.toast(t.settings.saveSectionFailed(name), 'bad');
      } else {
        ui.toast(JSON.stringify(wanted) === JSON.stringify(after) ? t.settings.savedSection(name) : t.settings.savedSectionAdjusted(name), 'ok');
      }
      render();
    } catch (err) {
      ui.toast(t.settings.saveSectionFailed(name), 'bad');
      console.warn('[interest-push] 保存失败', errText(err));
    } finally {
      setBusy(false);
    }
  }

  function render(): void {
    const v = view;
    if (!v) return;
    const c = v.config;
    const setNum = (input: HTMLInputElement, value: number): void => {
      if (document.activeElement !== input) input.value = String(value);
    };
    setNum(checkInput, c.checkMinutes);
    setNum(capInput, c.dailyCap);
    setNum(roundsInput, c.maxRounds);
    setNum(windowInput, c.windowDays);
    setNum(rowsInput, c.rowsPerJournal);
    if (document.activeElement !== mailtoInput) mailtoInput.value = c.mailto;
    if (document.activeElement !== dirInput) dirInput.value = c.downloadDir;
    pushTimesEditor.setValues(c.pushTimes);
    keywordsEditor.setValues(c.keywords);
    catsEditor.setValues(c.arxivCats);
    if (![...quietStart.options].some((o) => o.value === c.quiet[0])) quietStart.appendChild(new Option(c.quiet[0] ?? '', c.quiet[0] ?? ''));
    if (![...quietEnd.options].some((o) => o.value === c.quiet[1])) quietEnd.appendChild(new Option(c.quiet[1] ?? '', c.quiet[1] ?? ''));
    quietStart.value = c.quiet[0] ?? '';
    quietEnd.value = c.quiet[1] ?? '';
    week.setValues(c.pushDays);
    if (c.pausedUntil > 0) {
      if (document.activeElement !== pauseDate) pauseDate.value = localDateValue(c.pausedUntil);
    } else if (document.activeElement !== pauseDate) {
      pauseDate.value = '';
    }

    journalRowsHost.replaceChildren();
    journalRows.length = 0;
    for (const j of c.journals) addJournalRow(j);
    termRowsHost.replaceChildren();
    termRows.length = 0;
    for (const line of c.glossary) {
      const [en, zh] = line.split('|').map((s) => s.trim());
      addTermRow({ en: en ?? '', zh: zh ?? '' });
    }

    note.textContent = [
      `${t.lamps.check} ${fmtTime(v.schedule.lastCheckAt)}`,
      `${t.lamps.today} ${t.lamps.todayValue(v.schedule.pushedToday, c.dailyCap)}`,
      `${t.lamps.next} ${v.schedule.paused ? t.lamps.nextPaused : fmtTime(v.schedule.nextCheckAt)}`,
    ].join(' · ');
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
    detail: { mount: mountDetail },
    list: { mount: mountList },
    settings: { mount: mountSettings },
  },
};

export default bundle;
