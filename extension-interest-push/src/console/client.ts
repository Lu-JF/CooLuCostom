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

/** 时、分两栏下拉：小时 00–23，分钟 5 分钟一档。全程点选，不用打字，也不会有非法输入。 */
const HOUR_OPTIONS: string[] = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
const MINUTE_OPTIONS: string[] = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, '0'));

/** 页签之间的跳转：控制台是 hash 路由，切失败就留在原地（本页仍能用）。 */
function switchPanel(ctx: ConsolePanelContext, panelId: string): void {
  try {
    const hash = `#/provider/${encodeURIComponent(ctx.pageId)}/${panelId}`;
    if (location.hash !== hash) location.hash = hash;
  } catch {
    /* 路由变了也没关系 */
  }
}

function metaLine(row: NewsRow): string {
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

interface TimeField {
  el: HTMLDivElement;
  value(): string;
  set(value: string): void;
}

/** 「时 : 分」两个下拉。存量值不在 5 分钟档上时，补一个选项进去，原值照旧显示。 */
function timeField(ui: U, initial: string): TimeField {
  const hour = ui.select({ options: HOUR_OPTIONS, value: initial.slice(0, 2) });
  const minute = ui.select({ options: MINUTE_OPTIONS, value: initial.slice(3, 5) });
  const el = ui.h('div', 'ip-inline');
  el.append(hour, ui.h('span', 'ip-timecolon', ':'), minute);
  return {
    el,
    value: () => `${hour.value}:${minute.value}`,
    set: (value) => {
      const h = value.slice(0, 2);
      const m = value.slice(3, 5);
      if (!HOUR_OPTIONS.includes(h) && h !== '') hour.appendChild(new Option(h, h));
      if (!MINUTE_OPTIONS.includes(m) && m !== '') minute.appendChild(new Option(m, m));
      hour.value = h;
      minute.value = m;
    },
  };
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
  opts: { add: () => { el: HTMLElement; value(): string; clear?(): void }; signal?: AbortSignal },
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
  if (control.el instanceof HTMLInputElement) {
    control.el.addEventListener(
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
    const value = String(control.value() ?? '').trim();
    if (value === '' || current.includes(value)) return;
    current.push(value);
    control.clear?.();
    redraw();
  };
  addRow.append(control.el, addBtn);
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

/** 行内状态：一个小圆圈 + 一句话，替代会挡住整页的 busy 遮罩（翻译、速评、检查都长，遮罩体验太差）。 */
function makeStatus(ui: ConsolePanelContext['ui']): { el: HTMLElement; set: (text: string, tone?: 'busy' | 'ok' | 'bad' | '') => void } {
  const el = ui.h('span', 'ip-status');
  return {
    el,
    set: (text, tone = '') => {
      el.textContent = text;
      el.className = `ip-status${tone === '' ? '' : ` ip-status-${tone}`}`;
      el.hidden = text === '';
    },
  };
}

/** 10 颗星：够分点亮，不够空心。总分可能是 7.5 这样的小数，按四舍五入点亮。 */
function renderStars(el: HTMLElement, total: number | null): void {
  el.replaceChildren();
  if (total === null) return;
  const filled = Math.max(0, Math.min(10, Math.round(total)));
  for (let i = 1; i <= 10; i += 1) {
    const star = document.createElement('span');
    star.className = i <= filled ? 'ip-star ip-star-on' : 'ip-star';
    star.textContent = i <= filled ? '★' : '☆';
    el.appendChild(star);
  }
}

/** 一张卡里的小节：小标题 + 内容，给配置页做出段落层次（卡片 → 小节 → 字段）。 */
function block(ui: ConsolePanelContext['ui'], title: string, ...children: HTMLElement[]): HTMLElement {
  const wrap = ui.h('div', 'ip-block');
  const body = ui.h('div', 'ip-blockbody');
  body.append(...children);
  wrap.append(ui.h('div', 'ip-blockhead', title), body);
  return wrap;
}

function mountDetail(ctx: ConsolePanelContext): void {
  const t = interestText(ctx.language);
  const ui = ctx.ui;
  ctx.root.classList.add('ip-shell');
  let view: InterestPushView | null = null;
  let busy: { dispose(): void } | null = null;
  /** 正在叫模型评速评：期间不重复发请求，也不显示「还没评过」。 */
  let reviewing = false;

  const setBusy = (on: boolean, text: string = t.detail.translating): void => {
    if (on) {
      busy ??= ui.busy(t.panel.detailTitle, text);
      return;
    }
    busy?.dispose();
    busy = null;
  };

  // 只留「换一篇」：抓新数据这件事在列表页与配置页都有「重新爬取一次」，这里再来一个就是重复。
  const top = ui.rowbar();
  const note = ui.h('span', 'ip-note');
  const nextBtn = ui.button(t.detail.next, {
    size: 'sm',
    variant: 'primary',
    onClick: () => {
      void (async () => {
        try {
          view = (await ctx.invoke<InvokeResult>('next')).view;
          translateStatus.set('', '');
          reviewStatus.set('', '');
          render();
        } catch (err) {
          ui.toast(errText(err), 'bad');
        }
      })();
    },
  });
  top.append(nextBtn, note);
  ctx.root.appendChild(top);
  ctx.root.appendChild(ui.h('div', 'ip-note ip-tokenhint', t.detail.tokenHint));

  // 大肥鱼速评：卡片排最上面——气泡推送也是先念这一段，页面顺序与对话顺序保持一致。
  const reviewCard = ui.sheet({ title: t.detail.reviewTitle });
  const reviewHead = ui.rowbar();
  const starsEl = ui.h('span', 'ip-stars');
  const scoreEl = ui.h('span', 'ip-score');
  const reviewStatus = makeStatus(ui);
  const reviewBody = ui.h('div', 'ip-review');
  const reviewBtn = ui.button(t.detail.reviewAsk, {
    size: 'sm',
    onClick: () => {
      void (async () => {
        reviewing = true;
        reviewBtn.disabled = true;
        reviewStatus.set(t.detail.reviewing, 'busy');
        try {
          const out = await ctx.invoke<InvokeResult>('review');
          view = out.view;
          reviewStatus.set(out.ok ? '' : t.detail.reviewFailed(String(out.reason ?? '')), out.ok ? '' : 'bad');
        } catch (err) {
          reviewStatus.set(t.detail.reviewFailed(errText(err)), 'bad');
        } finally {
          reviewing = false;
          reviewBtn.disabled = false;
          render();
        }
      })();
    },
  });
  reviewHead.append(starsEl, scoreEl, reviewStatus.el, reviewBtn);
  reviewCard.body.append(reviewHead, reviewBody);

  // 标题与摘要合成一张「论文速览」：标题一行醒目，摘要一段浅色，中间留一口气。
  const overviewCard = ui.sheet({ title: t.detail.overviewTitle });
  const overviewBar = ui.rowbar();
  const titleBody = ui.h('div', 'ip-ov-title');
  const abstractBody = ui.h('div', 'ip-ov-abstract');
  const translateStatus = makeStatus(ui);
  const translateBtn = ui.button(t.detail.translate, {
    size: 'sm',
    variant: 'primary',
    onClick: () => {
      void (async () => {
        // 翻译要十几秒：不占整页，只在按钮旁边转圈，翻完在这里写结果。
        translateBtn.disabled = true;
        translateStatus.set(t.detail.translating, 'busy');
        try {
          const out = await ctx.invoke<InvokeResult>('translate');
          view = out.view;
          translateStatus.set(out.ok ? t.detail.translateOk : t.detail.failed(String(out.reason ?? '')), out.ok ? 'ok' : 'bad');
        } catch (err) {
          translateStatus.set(t.detail.failed(errText(err)), 'bad');
        } finally {
          translateBtn.disabled = false;
          render();
        }
      })();
    },
  });
  overviewBar.append(translateBtn, translateStatus.el);
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

  ctx.root.append(reviewCard.el, overviewCard.el, translationCard.el, detailCard.el);

  function render(): void {
    const v = view;
    const item = v?.active ?? null;
    note.textContent = v ? `${t.lamps.check} ${fmtTime(v.schedule.lastCheckAt)} · ${t.lamps.today} ${t.lamps.todayValue(v.schedule.pushedToday, v.config.dailyCap)}` : '';
    titleBody.textContent = item?.title ?? '';
    const hasAbstract = (item?.abstract ?? '').trim() !== '';
    const alreadyRecorded = item !== null && (v?.records ?? []).some((r) => r.id === item.id);
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
      reviewCard.el.hidden = true;
      abstractBody.textContent = '';
      translationCard.el.hidden = true;
      detailCard.el.hidden = true;
      return;
    }
    reviewCard.el.hidden = false;

    // 速评：有就显示星星与评语，没有就给按钮；评的时候按钮转圈，别整页卡住。
    const rv = v?.review ?? null;
    renderStars(starsEl, rv?.total ?? null);
    scoreEl.textContent = typeof rv?.total === 'number' ? t.detail.stars(rv.total) : '';
    reviewBody.replaceChildren();
    if (rv?.text) reviewBody.appendChild(ui.h('div', 'ip-review-text', rv.text));
    if (!rv?.ok && !reviewing) {
      const reason = String(rv?.reason ?? 'none');
      reviewBody.appendChild(ui.msgline(reason === 'none' ? t.detail.reviewNone : t.detail.reviewFailed(reason), reason !== 'none'));
    }
    reviewBtn.hidden = Boolean(rv?.ok) || reviewing;
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
        { k: t.detail.affiliation, v: item.affiliation ?? t.detail.none },
        // 期刊论文的「发表」就是上面那本刊，重复一遍没信息量；这里只在预印本见刊时写刊名。
        { k: t.detail.venue, v: item.venue === null ? t.detail.preprint : item.venue === item.journal ? t.detail.published : item.venue },
        { k: t.detail.doi, v: item.doi ?? t.detail.none },
        { k: t.detail.source, v: item.sourceDetail },
      ]),
    );
    const recordBtn = ui.button(alreadyRecorded ? t.detail.recorded : t.detail.record, {
      size: 'sm',
      onClick: () => {
        void (async () => {
          try {
            const out = await ctx.invoke<InvokeResult>('record');
            view = out.view;
            ui.toast(out.ok ? t.detail.recorded : String(out.reason ?? ''), out.ok ? 'ok' : 'bad');
            render();
          } catch (err) {
            ui.toast(errText(err), 'bad');
          }
        })();
      },
    });
    recordBtn.disabled = alreadyRecorded;
    const openBtn = ui.button(t.detail.openOriginal, { size: 'sm', onClick: () => window.open(item.url, '_blank', 'noopener') });
    const dlBtn = ui.button(t.detail.download, {
      size: 'sm',
      onClick: () => {
        void (async () => {
          setBusy(true, t.detail.downloading);
          try {
            const out = await ctx.invoke<InvokeResult>('download');
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
    actionBar.append(recordBtn, openBtn, dlBtn);
  }

  void (async () => {
    setBusy(true, t.list.checking);
    try {
      view = (await ctx.invoke<InvokeResult>('state')).view;
      render();
    } catch (err) {
      titleBody.textContent = errText(err);
    } finally {
      setBusy(false);
    }
  })();

  // 推送是在后台发生的：页面自己对照一次「现在讲的是哪一篇」，否则停在这里看到的是打开时那一篇。
  ctx.interval(() => {
    if (busy !== null || reviewing) return;
    void (async () => {
      try {
        const next = (await ctx.invoke<InvokeResult>('state')).view;
        const changed = view === null || next.revision !== view.revision || (next.active?.id ?? null) !== (view.active?.id ?? null);
        view = next;
        if (changed) render();
      } catch {
        /* 下次轮询再试 */
      }
    })();
  }, 20_000);
}

// --------------------------------------------------------------------- 列表

function mountList(ctx: ConsolePanelContext): void {
  const t = interestText(ctx.language);
  const ui = ctx.ui;
  ctx.root.classList.add('ip-shell');
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
    variant: 'primary',
    onClick: () => {
      void (async () => {
        setBusy(true);
        try {
          view = (await ctx.invoke<InvokeResult>('checkNow')).view;
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
    const pendingAbstract = v ? v.items.filter((i) => !i.hasAbstract).length : 0;
    note.textContent = v
      ? [
          `${t.lamps.check} ${fmtTime(v.schedule.lastCheckAt)}`,
          `${t.lamps.today} ${t.lamps.todayValue(v.schedule.pushedToday, v.config.dailyCap)}`,
          v.schedule.paused ? t.badges.paused : '',
          pendingAbstract > 0 ? t.list.abstractPending(pendingAbstract) : '',
        ]
          .filter((x) => x !== '')
          .join(' · ')
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
      head.append(ui.pill(row.venue ?? t.list.preprint, row.venue === null ? 'plain' : 'on'));
      // 速评一行：评过的显示星星与评语，没评过的给个按钮现评——评一次就落盘，两个页签共用同一份。
      const revRow = ui.h('div', 'ip-review-row');
      const rev = row.review;
      if (rev !== null) {
        const starBar = ui.h('span', 'ip-stars ip-stars-sm');
        renderStars(starBar, rev.total);
        revRow.append(starBar, ui.h('span', 'ip-score', t.detail.stars(rev.total)), ui.h('span', 'ip-review-snip', rev.text));
      } else {
        const rb = ui.button(t.list.review, {
          size: 'sm',
          onClick: (ev) => {
            ev.stopPropagation();
            rb.disabled = true;
            rb.textContent = t.detail.reviewing;
            void (async () => {
              try {
                view = (await ctx.invoke<InvokeResult>('review', [row.id])).view;
              } catch (err) {
                ui.toast(errText(err), 'bad');
              } finally {
                rb.disabled = false;
                rb.textContent = t.list.review;
                render();
              }
            })();
          },
        });
        revRow.append(rb);
      }
      line.append(head, ui.h('div', 'ip-meta', metaLine(row)), revRow);
      line.addEventListener('click', () => {
        void (async () => {
          try {
            view = (await ctx.invoke<InvokeResult>('open', [row.id])).view;
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
      view = (await ctx.invoke<InvokeResult>('state')).view;
      render();
    } catch (err) {
      body.replaceChildren(ui.msgline(t.list.error(errText(err)), true));
    } finally {
      setBusy(false);
    }
  })();

  // 与推送页保持同一份读数：推送、已读、速评都会让 revision 变。
  ctx.interval(() => {
    if (busy !== null) return;
    void (async () => {
      try {
        const next = (await ctx.invoke<InvokeResult>('state')).view;
        const changed = view === null || next.revision !== view.revision || next.items.length !== view.items.length;
        view = next;
        if (changed) render();
      } catch {
        /* 下次轮询再试 */
      }
    })();
  }, 20_000);
}

// --------------------------------------------------------------------- 配置

function mountSettings(ctx: ConsolePanelContext): void {
  const t = interestText(ctx.language);
  const ui = ctx.ui;
  ctx.root.classList.add('ip-shell');
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
  const checkStatus = makeStatus(ui);
  const checkBtn = ui.button(t.settings.checkNow, {
    size: 'sm',
    variant: 'primary',
    onClick: () => {
      void (async () => {
        // 抓取与摘要回填耗时较长，进度写在按钮旁，不用整页遮罩。
        checkBtn.disabled = true;
        checkStatus.set(t.settings.checking, 'busy');
        try {
          view = (await ctx.invoke<InvokeResult>('checkNow')).view;
          checkStatus.set(t.settings.saved, 'ok');
          render();
        } catch (err) {
          checkStatus.set(errText(err), 'bad');
        } finally {
          checkBtn.disabled = false;
        }
      })();
    },
  });
  const pushStatus = makeStatus(ui);
  const pushBtn = ui.button(t.settings.pushNow, {
    size: 'sm',
    onClick: () => {
      void (async () => {
        // 推的是「推送」页签正在显示的那一篇，两个页签保持一致。
        pushBtn.disabled = true;
        pushStatus.set(t.settings.checking, 'busy');
        try {
          const out = await ctx.invoke<InvokeResult>('pushNow');
          view = out.view;
          pushStatus.set(out.ok ? String(out.reason ?? t.settings.saved) : String(out.reason ?? ''), out.ok ? 'ok' : 'bad');
          render();
        } catch (err) {
          pushStatus.set(errText(err), 'bad');
        } finally {
          pushBtn.disabled = false;
        }
      })();
    },
  });
  top.append(checkBtn, pushBtn, checkStatus.el, pushStatus.el, note);

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
  const pushTimesEditor = tagEditor(ui, t, {
    add: () => {
      const f = timeField(ui, '10:30');
      return { el: f.el, value: () => f.value() };
    },
  });
  const quietRow = ui.h('div', 'ip-fields');
  const quietStart = timeField(ui, '22:30');
  const quietEnd = timeField(ui, '08:30');
  quietRow.append(fieldRow(ui, t.settings.quietStart, quietStart.el), fieldRow(ui, t.settings.quietEnd, quietEnd.el));
  const abstractBox = ui.checkbox(t.settings.requireAbstract, { checked: true });
  const bareBox = ui.checkbox(t.settings.allowNoAbstract, { checked: false });
  // OpenAlex 密钥：只写部署 .env，页面上不回显，只显示「已配置 / 未配置」。
  const keyInput = ui.input({ type: 'password' });
  keyInput.placeholder = t.settings.openAlexPlaceholder;
  keyInput.autocomplete = 'off';
  const keyState = ui.h('span', 'ip-note');
  const keySaveBtn = ui.button(t.settings.openAlexSave, {
    size: 'sm',
    onClick: () => {
      void (async () => {
        const value = keyInput.value.trim();
        keySaveBtn.disabled = true;
        try {
          const out = await ctx.invoke<InvokeResult>('setOpenAlexKey', [value]);
          view = out.view;
          if (out.ok) {
            keyInput.value = '';
            ui.toast(value === '' ? t.settings.openAlexSave : t.settings.openAlexSave, 'ok');
          } else {
            ui.toast(String(out.reason ?? ''), 'bad');
          }
          render();
        } catch (err) {
          ui.toast(errText(err), 'bad');
        } finally {
          keySaveBtn.disabled = false;
        }
      })();
    },
  });
  const keyRow = ui.h('div', 'ip-fieldrow ip-keyrow');
  keyRow.append(ui.h('span', 'ip-fieldlabel', t.settings.openAlexKey), keyInput, keySaveBtn);

  const week = weekdayButtons(ui);
  // 星期单独占一行：七个按钮横排，不与其它字段挤在一起。
  const weekRow = ui.h('div', 'ip-row-block');
  weekRow.append(ui.h('span', 'ip-fieldlabel', t.settings.pushDays), week.el);
  const pauseRow = ui.h('div', 'ip-fields');
  const pauseDate = ui.input({ type: 'date' });
  const resumeBtn = ui.button(t.settings.resumNow, { size: 'sm', onClick: () => { pauseDate.value = ''; } });
  pauseRow.append(fieldRow(ui, t.settings.pausedUntil, pauseDate), resumeBtn);
  const quietWarn = ui.h('div', 'ip-warn');
  const cadenceSave = ui.button(t.settings.saveSectionOf(t.settings.groupPush), { variant: 'primary', size: 'sm', onClick: () => void saveCard('cadence') });
  const cadenceFoot = ui.rowbar();
  cadenceFoot.append(cadenceSave);
  cadence.body.append(
    block(ui, t.settings.blockFrequency, numbersRow),
    block(
      ui,
      t.settings.blockWindows,
      fieldRow(ui, t.settings.pushTimes, ui.h('div')),
      pushTimesEditor.el,
      fieldRow(ui, t.settings.quiet, quietRow),
      quietWarn,
    ),
    block(ui, t.settings.blockDays, weekRow, pauseRow),
    cadenceFoot,
  );

  // ---- 数据源
  const sources = ui.sheet({ title: t.settings.groupSources });
  const keywordsEditor = tagEditor(ui, t, {
    add: () => {
      const input = ui.input({ placeholder: t.settings.keywordPlaceholder });
      return { el: input, value: () => input.value, clear: () => { input.value = ''; } };
    },
    signal: ctx.signal,
  });
  const catsView = ui.h('div', 'ip-tags');
  const fillCats = (cats: string[]): void => {
    catsView.replaceChildren();
    for (const cat of cats) catsView.appendChild(ui.chip(cat, 'plain'));
  };
  const windowInput = numberInput(ui, '30');
  const rowsInput = numberInput(ui, '50');
  const delayInput = numberInput(ui, '14', '4.5em');
  const mailtoInput = ui.input({ placeholder: 'name@example.org' });
  // 旁边的「!」：点开说明这个地址会被发给谁、有什么用。
  const mailtoHelpBody = ui.h('div', 'ip-help');
  for (const para of t.settings.mailtoHelp.split('\n\n')) mailtoHelpBody.appendChild(ui.h('p', '', para));
  const mailtoHelpBtn = ui.button('!', {
    size: 'sm',
    variant: 'plain',
    onClick: () => {
      mailtoHelpBtn.classList.add('ip-helpbtn-on');
      const drawer = ui.drawer(t.settings.mailtoHelpTitle, mailtoHelpBody);
      void drawer;
    },
  });
  mailtoHelpBtn.classList.add('ip-helpbtn');
  mailtoHelpBtn.title = t.settings.mailtoHelpTitle;
  const mailtoWrap = ui.h('div', 'ip-withhelp');
  mailtoWrap.append(mailtoInput, mailtoHelpBtn);
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
  sourceNumbers.append(
    fieldRow(ui, t.settings.windowDays, windowInput),
    fieldRow(ui, t.settings.rowsPerJournal, rowsInput),
    fieldRow(ui, t.settings.journalDelayDays, delayInput),
  );
  const sourcesSave = ui.button(t.settings.saveSectionOf(t.settings.groupSources), { variant: 'primary', size: 'sm', onClick: () => void saveCard('sources') });
  const sourcesFoot = ui.rowbar();
  sourcesFoot.append(sourcesSave);
  sources.body.append(
    block(
      ui,
      t.settings.blockInterest,
      fieldRow(ui, t.settings.keywords, ui.h('div')),
      keywordsEditor.el,
      fieldRow(ui, t.settings.arxivCats, ui.h('div')),
      catsView,
      ui.msgline(t.settings.arxivReadonly),
    ),
    block(ui, t.settings.blockWindow, sourceNumbers, fieldRow(ui, t.settings.mailto, mailtoWrap)),
    block(ui, t.settings.blockAbstract, abstractBox.el, bareBox.el, ui.msgline(t.settings.abstractHint)),
    block(ui, t.settings.blockDownload, fieldRow(ui, t.settings.downloadDir, dirBar)),
    block(ui, t.settings.blockOpenAlex, keyRow, keyState, ui.msgline(t.settings.openAlexHint)),
    sourcesFoot,
  );

  // ---- 期刊集合：只展示，新增靠 ISSN，删除靠 ×，检测靠按钮
  const journals = ui.sheet({ title: t.settings.journals });
  const journalGrid = ui.h('div', 'ip-grid');
  const journalHead = ui.h('div', 'ip-jrow ip-gridhead');
  for (const label of [t.settings.colLabel, t.settings.colIssn, t.settings.colTier, '']) {
    journalHead.appendChild(ui.h('span', 'ip-gridcell', label));
  }
  const journalRowsHost = ui.h('div', 'ip-gridbody');
  journalGrid.append(journalHead, journalRowsHost);

  const journalStatus = makeStatus(ui);
  const issnInput = ui.input({ placeholder: '0888-3270' });
  issnInput.classList.add('ip-issninput');
  const addJournalBtn = ui.button(t.settings.addJournal, {
    size: 'sm',
    variant: 'primary',
    onClick: () => {
      void (async () => {
        const value = issnInput.value.trim();
        if (value === '') return;
        addJournalBtn.disabled = true;
        journalStatus.set(t.settings.checking, 'busy');
        try {
          const out = await ctx.invoke<InvokeResult>('addJournal', [value]);
          view = out.view;
          if (out.ok) {
            issnInput.value = '';
            journalStatus.set(String(out.reason ?? ''), 'ok');
          } else {
            journalStatus.set(String(out.reason ?? ''), 'bad');
          }
          render();
        } catch (err) {
          journalStatus.set(errText(err), 'bad');
        } finally {
          addJournalBtn.disabled = false;
        }
      })();
    },
  });
  const testJournalsBtn = ui.button(t.settings.testJournals, {
    size: 'sm',
    onClick: () => {
      void (async () => {
        testJournalsBtn.disabled = true;
        journalStatus.set(t.settings.checking, 'busy');
        try {
          const out = await ctx.invoke<InvokeResult>('testJournals');
          view = out.view;
          journalStatus.set(String(out.reason ?? ''), out.ok ? 'ok' : 'bad');
          render();
        } catch (err) {
          journalStatus.set(errText(err), 'bad');
        } finally {
          testJournalsBtn.disabled = false;
        }
      })();
    },
  });
  const journalFoot = ui.rowbar();
  journalFoot.append(issnInput, addJournalBtn, testJournalsBtn, journalStatus.el);
  journals.body.append(journalGrid, ui.msgline(t.settings.journalNote), ui.msgline(t.settings.addJournalHint), journalFoot);

  // ---- 翻译术语表：只展示 + 增加词条 + ×
  const glossary = ui.sheet({ title: t.settings.glossary });
  const termGrid = ui.h('div', 'ip-grid');
  const termHead = ui.h('div', 'ip-jrow ip-gridhead ip-grow');
  for (const label of [t.settings.colEnglish, t.settings.colChinese, '']) {
    termHead.appendChild(ui.h('span', 'ip-gridcell', label));
  }
  const termRowsHost = ui.h('div', 'ip-gridbody');
  termGrid.append(termHead, termRowsHost);

  const termStatus = makeStatus(ui);
  const termEn = ui.input({ placeholder: 'bearing' });
  const termZh = ui.input({ placeholder: '轴承' });
  const addTermBtn = ui.button(t.settings.addTerm, {
    size: 'sm',
    onClick: () => {
      void (async () => {
        const en = termEn.value.trim();
        const zh = termZh.value.trim();
        if (en === '' || zh === '') return;
        addTermBtn.disabled = true;
        try {
          const out = await ctx.invoke<InvokeResult>('addTerm', [`${en} | ${zh}`]);
          view = out.view;
          if (out.ok) {
            termEn.value = '';
            termZh.value = '';
            termStatus.set('', '');
          } else {
            termStatus.set(String(out.reason ?? ''), 'bad');
          }
          render();
        } catch (err) {
          termStatus.set(errText(err), 'bad');
        } finally {
          addTermBtn.disabled = false;
        }
      })();
    },
  });
  const termFoot = ui.rowbar();
  termFoot.append(termEn, termZh, addTermBtn, termStatus.el);
  glossary.body.append(termGrid, termFoot);

  ctx.root.append(top, ui.msgline(t.settings.checkNowHint), cadence.el, sources.el, journals.el, glossary.el);

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
    quiet: [quietStart.value(), quietEnd.value()],
    pushDays: week.values(),
    pausedUntil: pausedUntilFromForm(),
    keywords: uniqSorted(keywordsEditor.values()),

    windowDays: Number(windowInput.value),
    rowsPerJournal: Number(rowsInput.value),
    journalDelayDays: Number(delayInput.value),
    mailto: mailtoInput.value.trim(),
    downloadDir: dirInput.value.trim(),
    requireAbstract: abstractBox.checked,
    allowNoAbstractPush: bareBox.checked,
  });

  const snapshotOf = (cfg: Cfg, card: 'cadence' | 'sources'): unknown => {
    if (card === 'cadence') {
      return { checkMinutes: cfg.checkMinutes, dailyCap: cfg.dailyCap, maxRounds: cfg.maxRounds, pushTimes: cfg.pushTimes, quiet: cfg.quiet, pushDays: cfg.pushDays, pausedUntil: cfg.pausedUntil };
    }
    if (card === 'sources') {
      return { keywords: cfg.keywords, arxivCats: cfg.arxivCats, windowDays: cfg.windowDays, rowsPerJournal: cfg.rowsPerJournal, mailto: cfg.mailto, downloadDir: cfg.downloadDir };
    }
  };

  async function saveCard(card: 'cadence' | 'sources'): Promise<void> {
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
      const out = await ctx.invoke<InvokeResult>('saveSettings', [payload]);
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
    setNum(delayInput, c.journalDelayDays);
    abstractBox.setChecked(c.requireAbstract);
    bareBox.setChecked(c.allowNoAbstractPush);
    keyState.textContent = c.openAlexKeySet ? t.settings.openAlexSet : t.settings.openAlexUnset;
    keyState.className = `ip-note${c.openAlexKeySet ? ' ip-note-ok' : ''}`;
    const conflicts = c.quietConflicts ?? [];
    quietWarn.textContent = conflicts.length > 0 ? t.settings.quietConflict(conflicts.join('、')) : '';
    quietWarn.hidden = conflicts.length === 0;
    if (document.activeElement !== mailtoInput) mailtoInput.value = c.mailto;
    if (document.activeElement !== dirInput) dirInput.value = c.downloadDir;
    pushTimesEditor.setValues(c.pushTimes);
    keywordsEditor.setValues(c.keywords);
    fillCats(c.arxivCats);
    quietStart.set(c.quiet[0] ?? '22:30');
    quietEnd.set(c.quiet[1] ?? '08:30');
    week.setValues(c.pushDays);
    if (c.pausedUntil > 0) {
      if (document.activeElement !== pauseDate) pauseDate.value = localDateValue(c.pausedUntil);
    } else if (document.activeElement !== pauseDate) {
      pauseDate.value = '';
    }

    journalRowsHost.replaceChildren();
    const results = new Map(v.journalTest.results.map((r) => [r.issn, r]));
    for (const j of c.journals) {
      const row = ui.h('div', 'ip-jrow');
      row.append(ui.h('span', 'ip-gridcell', j.label), ui.h('span', 'ip-gridcell', j.issn), ui.h('span', 'ip-gridcell', j.tier));
      const probe = results.get(j.issn);
      const cell = ui.h('span', 'ip-gridcell');
      if (probe !== undefined) cell.appendChild(ui.pill(probe.ok ? '✓' : '✗', probe.ok ? 'on' : 'plain'));
      const del = ui.button('×', {
        size: 'sm',
        onClick: () => {
          void (async () => {
            try {
              const out = await ctx.invoke<InvokeResult>('removeJournal', [j.issn]);
              view = out.view;
              render();
              if (!out.ok) ui.toast(String(out.reason ?? ''), 'bad');
            } catch (err) {
              ui.toast(errText(err), 'bad');
            }
          })();
        },
      });
      del.classList.add('ip-del');
      del.title = t.settings.remove;
      cell.appendChild(del);
      row.appendChild(cell);
      journalRowsHost.appendChild(row);
    }
    termRowsHost.replaceChildren();
    for (const line of c.glossary) {
      const [en = '', zh = ''] = line.split(' | ');
      const row = ui.h('div', 'ip-jrow ip-grow');
      row.append(ui.h('span', 'ip-gridcell', en), ui.h('span', 'ip-gridcell', zh));
      const del = ui.button('×', {
        size: 'sm',
        onClick: () => {
          void (async () => {
            try {
              const out = await ctx.invoke<InvokeResult>('removeTerm', [line]);
              view = out.view;
              render();
              if (!out.ok) ui.toast(String(out.reason ?? ''), 'bad');
            } catch (err) {
              ui.toast(errText(err), 'bad');
            }
          })();
        },
      });
      del.classList.add('ip-del');
      del.title = t.settings.remove;
      const cell = ui.h('span', 'ip-gridcell');
      cell.appendChild(del);
      row.appendChild(cell);
      termRowsHost.appendChild(row);
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
      view = (await ctx.invoke<InvokeResult>('state')).view;
      render();
    } catch (err) {
      ctx.root.appendChild(ui.msgline(errText(err), true));
    } finally {
      setBusy(false);
    }
  })();
}

// ----------------------------------------------------------------- 兴趣记录

function mountRecords(ctx: ConsolePanelContext): void {
  const t = interestText(ctx.language);
  const ui = ctx.ui;
  ctx.root.classList.add('ip-shell');
  let view: InterestPushView | null = null;
  let busy: { dispose(): void } | null = null;

  const setBusy = (on: boolean): void => {
    if (on) {
      busy ??= ui.busy(t.panel.recordsTitle, t.settings.checking);
      return;
    }
    busy?.dispose();
    busy = null;
  };

  const sheet = ui.sheet({ title: t.panel.recordsTitle, desc: t.panel.recordsDesc });
  const body = ui.h('div', 'ip-list');
  sheet.body.append(body);
  ctx.root.appendChild(sheet.el);

  function render(): void {
    const recs = view?.records ?? [];
    body.replaceChildren();
    if (recs.length === 0) {
      body.appendChild(ui.placeholder(t.records.empty));
      return;
    }
    for (const rec of recs) {
      const row = ui.h('div', 'ip-rec');
      const head = ui.h('div', 'ip-rowhead');
      head.append(ui.h('span', 'ip-title', rec.title));
      row.append(head, ui.h('div', 'ip-meta', [rec.journal, rec.tier ?? '', rec.issued, rec.source].filter((x) => x !== '').join(' · ')));
      if (rec.doi !== null) row.append(ui.h('div', 'ip-meta', `DOI ${rec.doi}`));
      const actions = ui.rowbar();
      actions.append(
        ui.button(t.detail.openOriginal, { size: 'sm', onClick: () => window.open(rec.url, '_blank', 'noopener') }),
        ui.button(t.settings.remove, {
          size: 'sm',
          variant: 'danger',
          onClick: () => {
            void (async () => {
              try {
                view = (await ctx.invoke<InvokeResult>('remove', [rec.id])).view;
                render();
              } catch (err) {
                ui.toast(errText(err), 'bad');
              }
            })();
          },
        }),
      );
      const dl = ui.button(t.detail.download, {
        size: 'sm',
        onClick: () => {
          window.open(rec.pdfUrl ?? rec.url, '_blank', 'noopener');
        },
      });
      dl.disabled = rec.pdfUrl === null;
      actions.appendChild(dl);
      row.appendChild(actions);
      body.appendChild(row);
    }
  }

  void (async () => {
    setBusy(true);
    try {
      view = (await ctx.invoke<InvokeResult>('state')).view;
      render();
    } catch (err) {
      body.replaceChildren(ui.msgline(errText(err), true));
    } finally {
      setBusy(false);
    }
  })();
}

const bundle: ConsoleClientBundle = {
  panels: {
    detail: { mount: mountDetail },
    list: { mount: mountList },
    records: { mount: mountRecords },
    settings: { mount: mountSettings },
  },
};

export default bundle;
