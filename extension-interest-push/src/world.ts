/**
 * 这个 World：按设置里的节奏去学术数据源（期刊 Crossref、arXiv、Hugging Face 日榜）抓你研究方向的论文，
 * 命中的条目**以气泡多轮对话**介绍给你；详情（标题/作者/期刊/摘要/爬取源/DOI/译文/下载）在这一页自己看。
 *
 * 两个定时器，各管一件事：
 * - 检查：每 `checkMinutes` 分钟抓一轮，只更新列表；抓取用条件请求会另算（见 fetch.ts）。
 * - 打扰：算出下一个推送时刻，到点才发事件；`schedule.decide` 再挡一层（静默时段、每日上限、当天次数、暂停）。
 *
 * 说话的是 bot（桌宠的模型与人设），World 只发事实、读回执。翻译走桌宠配置的模型端点，见 translate.ts。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Language } from 'cortico/core/language.ts';
import type { World, WorldConsoleDecl, WorldHost } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import type { InterestPushConfigSection, JournalEntry } from './config.ts';
import { fetchHfDaily, fetchJournal, fetchOpenAlexAbstractByTitle, fetchOpenAlexAbstracts, fetchSemanticScholarAbstracts } from './fetch.ts';
import { fetchArxivSearch } from './arxiv.ts';
import { relevant } from './relevance.ts';
import { interestText } from './i18n.ts';
import { resolvePetModel } from './pet-model.ts';
import { decide, type ScheduleConfig } from './schedule.ts';
import { SeenStore } from './seen.ts';
import { translate } from './translate.ts';
import type { InterestPushView, InterestRecord, NewsItem, TranslationState } from './view-types.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
/** 列表最多留多少条。 */
const MAX_ITEMS = 60;
/** 已推送编号留多久（按条数）。 */
const MAX_PUSHED = 300;
/** 抓取并发上限：一次要问几十家期刊，别把源惹毛。 */
const FETCH_CONCURRENCY = 5;
/** 每轮最多按标题去补几条摘要（一次一条请求，别贪）。 */
const TITLE_BACKFILL_PER_RUN = 8;
/** 同一条多久后再试一次按标题补摘要。 */
const TITLE_BACKFILL_RETRY_MS = 24 * 60 * 60_000;

export interface InterestPushWorldOptions {
  cfg: InterestPushConfigSection;
  timezone: string;
  /** 部署数据目录：`news/` 放条目、已读与译文缓存。 */
  dataDir: string;
  /** bot 安装目录：`config.json` 与 `providers/` 在旁边，翻译要用。 */
  botDir: string;
  /** 写回自己的配置段（面板上的「保存」走它，一次写回）。 */
  persist: (patch: Partial<InterestPushConfigSection>) => void;
  /** 测试注入：网络与时钟。 */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface PersistedState {
  dismissed: string[];
  read: string[];
  pushedIds: string[];
  pushedDay: string;
  pushedToday: number;
  lastWindowKey: string | null;
  lastPushAt: number | null;
  lastCheckAt: number | null;
  answerCursor: number;
  conditional: Record<string, { etag?: string; lastModified?: string }>;
  /** 条目编号 → 上次按标题补摘要的时刻；避免对同一篇反复去问。 */
  abstractTried: Record<string, number>;
}

const EMPTY_STATE: PersistedState = {
  dismissed: [],
  read: [],
  pushedIds: [],
  pushedDay: '',
  pushedToday: 0,
  lastWindowKey: null,
  lastPushAt: null,
  lastCheckAt: null,
  answerCursor: 0,
  conditional: {},
  abstractTried: {},
};

/** 不认识的回执里出现这些词，就算「不感兴趣」。 */
const DISMISS_WORDS = /不感兴趣|不用|不了|不用了|不需要|结束|算了|先不看|不看了|不看|跳过|略过|够了|存过了|no thanks|not interested|skip|stop/i;

export class InterestPushWorld implements World {
  readonly id = 'interest-push';

  private host: WorldHost | null = null;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  /** 回执扫描：只读事件库，不发网络请求，所以可以跑得比检查密得多。 */
  private answerTimer: ReturnType<typeof setInterval> | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly seen: SeenStore;
  private state: PersistedState;
  private items: NewsItem[] = [];
  /** 兴趣记录：编号 → 条目快照。落 `news/records.json`。 */
  private records = new Map<string, InterestRecord>();
  private activeId: string | null = null;
  private translations = new Map<string, TranslationState>();
  private inflight: Promise<void> | null = null;
  private lastError: string | null = null;

  constructor(private readonly opts: InterestPushWorldOptions) {
    this.seen = new SeenStore(opts.dataDir);
    this.state = this.loadState();
    this.items = this.loadItems();
    this.records = this.loadRecords();
  }

  // ---------------------------------------------------------------- World

  envPromptVars(): Record<string, string> {
    // 占位符名不用连字符：模板渲染只认 [\w.] 一类的名字，带连字符的会被原样留下。
    return { 'interestpush.status': this.statusText() };
  }

  tools(): never[] {
    return [];
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    await this.run('start');
    this.scheduleCheck();
    this.schedulePush();
    // 问答回执一到就该认领（已读、不再推送），不能等下一次检查（默认隔两小时）。
    this.answerTimer = setInterval(() => {
      this.scanAnswers();
      this.saveState();
    }, 15_000);
    this.answerTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.host = null;
    if (this.checkTimer) clearInterval(this.checkTimer);
    if (this.pushTimer) clearTimeout(this.pushTimer);
    if (this.answerTimer) clearInterval(this.answerTimer);
    this.checkTimer = null;
    this.pushTimer = null;
    this.answerTimer = null;
  }

  console(language: Language = 'zh'): WorldConsoleDecl {
    const t = interestText(language);
    const paused = this.opts.cfg.pausedUntil > this.now();
    const nextWindow = this.nextWindowAt();
    return {
      label: t.label,
      lamps: [
        {
          label: t.lamps.check,
          state: this.lastError ? 'error' : this.state.lastCheckAt ? 'online' : 'loading',
          hint: this.lastError
            ? t.lamps.checkFailed(this.lastError)
            : this.state.lastCheckAt
              ? t.lamps.checkAt(this.localTime(this.state.lastCheckAt))
              : t.lamps.checkNone,
        },
        {
          label: t.lamps.today,
          state: this.state.pushedToday > 0 ? 'online' : 'offline',
          hint: t.lamps.todayValue(this.state.pushedToday, this.opts.cfg.dailyCap),
        },
        {
          label: t.lamps.next,
          state: paused ? 'offline' : 'loading',
          hint: paused ? t.lamps.nextPaused : nextWindow === null ? t.lamps.checkNone : t.lamps.nextAt(this.localTime(nextWindow)),
        },
      ],
      badges: [
        { label: t.badges.journals, value: this.opts.cfg.journals.length, tone: 'plain' },
        { label: t.badges.keywords, value: this.opts.cfg.keywords.length, tone: 'plain' },
        { label: t.badges.paused, value: paused ? 'on' : 'off', tone: paused ? 'off' : 'plain' },
      ],
      panels: [
        // 详情排第一：这里才是使用者真正要看的一页。
        { id: 'detail', title: t.panel.detailTitle, description: t.panel.detailDesc },
        { id: 'list', title: t.panel.listTitle, description: t.panel.listDesc },
        { id: 'records', title: t.panel.recordsTitle, description: t.panel.recordsDesc },
        { id: 'settings', title: t.panel.settingsTitle, description: t.panel.settingsDesc },
      ],
      invoke: (panel, method, args) => this.invoke(panel, method, args, language),
      promptDocs: [
        {
          key: 'worlds.interest-push.envPrompt',
          title: `${t.label} · 环境提示词`,
          description: '把这段交给 bot：news.item 事件怎么处理、气泡对话怎么走。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [{ name: 'interestpush.status', description: '当前的检查与推送读数，此刻的值。', multiline: false }],
        },
      ],
    };
  }

  // ------------------------------------------------------------ 抓取与调度

  private scheduleConfig(): ScheduleConfig {
    const cfg = this.opts.cfg;
    return {
      checkMinutes: cfg.checkMinutes,
      pushTimes: cfg.pushTimes,
      dailyCap: cfg.dailyCap,
      quiet: cfg.quiet,
      pushDays: cfg.pushDays,
      maxRounds: cfg.maxRounds,
      pausedUntil: cfg.pausedUntil,
    };
  }

  private scheduleCheck(): void {
    if (this.checkTimer) clearInterval(this.checkTimer);
    this.checkTimer = null;
    const minutes = Number(this.opts.cfg.checkMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    this.checkTimer = setInterval(() => {
      void this.run('timer');
    }, Math.min(1440, minutes) * 60_000);
    this.checkTimer.unref?.();
  }

  /** 下一个推送时刻（本地时间）的毫秒戳；没有可用的窗口时返回 null。 */
  nextWindowAt(): number | null {
    const now = new Date(this.now());
    const times = this.opts.cfg.pushTimes.map((s) => parseTime(s)).filter((v): v is { h: number; m: number } => v !== null);
    if (times.length === 0) return null;
    for (let dayOffset = 0; dayOffset <= 1; dayOffset += 1) {
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset);
      const iso = day.getDay() === 0 ? 7 : day.getDay();
      if (!this.opts.cfg.pushDays.includes(iso)) continue;
      for (const { h, m } of [...times].sort((a, b) => a.h * 60 + a.m - (b.h * 60 + b.m))) {
        const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0).getTime();
        if (at > now.getTime()) return at;
      }
    }
    return null;
  }

  private schedulePush(): void {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = null;
    const at = this.nextWindowAt();
    if (at === null) return;
    const delay = Math.max(5_000, at - this.now());
    this.pushTimer = setTimeout(() => {
      void this.run('window').then(() => this.schedulePush());
    }, Math.min(delay, 6 * 60 * 60_000));
    this.pushTimer.unref?.();
  }

  private async run(reason: 'start' | 'timer' | 'window' | 'manual' | 'force'): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doRun(reason).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doRun(reason: 'start' | 'timer' | 'window' | 'manual' | 'force'): Promise<void> {
    this.rollDay();
    try {
      const found = await this.collect();
      this.lastError = null;
      this.merge(found);
    } catch (err) {
      this.lastError = String((err as Error)?.message ?? err);
      this.log(`抓取失败：${this.lastError}`);
    }
    this.state.lastCheckAt = this.now();
    this.scanAnswers();

    if (reason === 'window' || reason === 'force') {
      // `force` 是面板上「立刻推一条」：跳过时间与次数判断，只要求有一条没推过的条目。
      const decision: { push: boolean; windowKey: string | null; reason: string } =
        reason === 'force'
          ? { push: true, windowKey: this.state.lastWindowKey, reason: 'forced' }
          : decide(this.scheduleConfig(), new Date(this.now()), {
              pushedToday: this.state.pushedToday,
              lastWindowKey: this.state.lastWindowKey,
            });
      if (decision.push) {
        const item = this.pickPushItem();
        if (item) await this.pushItem(item, decision.windowKey);
        else this.log('窗口到点，但没有新条目可推');
      } else {
        this.log(`窗口不打扰：${decision.reason}`);
      }
    }
    this.saveState();
    this.saveItems();
  }

  private async collect(): Promise<NewsItem[]> {
    const cfg = this.opts.cfg;
    const deps = {
      fetchImpl: this.opts.fetchImpl ?? fetch,
      mailto: cfg.mailto,
      // 可选：这两个免费额度按 IP 共享，有 key 才稳。走环境变量，不落盘。
      openAlexKey: process.env.OPENALEX_API_KEY ?? '',
      semanticScholarKey: process.env.S2_API_KEY ?? '',
    };
    const tierOf = new Map<string, JournalEntry>(cfg.journals.map((j) => [j.issn, j]));
    const jobs: Array<() => Promise<NewsItem[]>> = [
      ...cfg.journals.map((j) => () =>
        fetchJournal({ issn: j.issn, days: cfg.windowDays, rows: cfg.rowsPerJournal, keywords: cfg.keywords }, deps).then((list) =>
          list.map((item) => ({ ...item, tier: item.tier ?? tierOf.get(j.issn)?.tier ?? null, journal: item.journal || j.label })),
        ),
      ),
      () => fetchArxivSearch({ keywords: cfg.keywords, categories: cfg.arxivCats, max: 40 }, deps),
      () => fetchHfDaily(deps),
    ];
    const out: NewsItem[] = [];
    for (let i = 0; i < jobs.length; i += FETCH_CONCURRENCY) {
      const batch = jobs.slice(i, i + FETCH_CONCURRENCY);
      const results = await Promise.all(batch.map((job) => job().catch(() => [] as NewsItem[])));
      for (const list of results) out.push(...list);
    }
    await this.backfillAbstracts(out, deps);
    // Hugging Face 日榜是整条 AI 领域的榜单：只留与研究领域相关的条目。
    return out.filter((item) => item.source !== 'hf' || relevant(`${item.title} ${item.abstract}`, cfg.keywords));
  }

  /**
   * 缺摘要的条目按 DOI 补：先 OpenAlex，剩下的再问 Semantic Scholar
   * （Elsevier 在 Crossref 里不存摘要，OpenAlex 对新文章也常没有）。
   * 补上了就在爬取源里注明来源，详情页那个「爬取源」字段会说清摘要从哪来。
   */
  private async backfillAbstracts(items: NewsItem[], deps: { fetchImpl?: typeof fetch; mailto: string }): Promise<void> {
    const pending = (): string[] => [
      ...new Set(items.filter((i) => i.abstract.trim() === '' && i.doi).map((i) => i.doi as string)),
    ];
    let filled = 0;
    try {
      const first = pending();
      if (first.length > 0) filled += this.applyAbstracts(items, await fetchOpenAlexAbstracts(first, deps), 'openalex');
      const rest = pending();
      if (rest.length > 0) filled += this.applyAbstracts(items, await fetchSemanticScholarAbstracts(rest, deps), 'semanticscholar');
      // 最后按标题去 OpenAlex 碰一次运气：新文章常是「记录有了、DOI 还没对上」。
      filled += await this.backfillByTitle(items, deps);
    } catch (err) {
      this.log(`补摘要失败：${String((err as Error)?.message ?? err)}`);
    }
    if (filled > 0) this.log(`补了 ${filled} 条摘要`);
  }

  /**
   * 按标题补摘要（一次一条请求）。同一条 24 小时内只试一次，一轮最多试 `TITLE_BACKFILL_PER_RUN` 条，
   * 免得刚抓回来还没上线摘要的文章被反复追问。
   */
  private async backfillByTitle(items: NewsItem[], deps: { fetchImpl?: typeof fetch; mailto: string }): Promise<number> {
    const now = this.now();
    const candidates = items
      .filter((i) => i.abstract.trim() === '' && i.title.trim() !== '')
      .filter((i) => now - (this.state.abstractTried[i.id] ?? 0) > TITLE_BACKFILL_RETRY_MS)
      .slice(0, TITLE_BACKFILL_PER_RUN);
    let filled = 0;
    if (candidates.length > 0) this.log(`按标题补摘要：试 ${candidates.length} 条`);
    for (const item of candidates) {
      this.state.abstractTried[item.id] = now;
      const text = await fetchOpenAlexAbstractByTitle(item.title, deps);
      if (text === null) continue;
      item.abstract = text;
      item.sourceDetail = `${item.sourceDetail} +openalex标题摘要`;
      filled += 1;
      this.log(`按标题补到摘要：${item.id} ${item.title.slice(0, 30)}`);
    }
    return filled;
  }

  /** 把 doi→摘要 填进缺摘要的条目；返回补上的条数。 */
  private applyAbstracts(items: NewsItem[], abstracts: Record<string, string>, tag: string): number {
    let filled = 0;
    for (const item of items) {
      if (item.abstract.trim() !== '' || !item.doi) continue;
      const text = abstracts[item.doi.toLowerCase()];
      if (!text) continue;
      item.abstract = text;
      item.sourceDetail = `${item.sourceDetail} +${tag}摘要`;
      filled += 1;
    }
    return filled;
  }

  private merge(found: NewsItem[]): void {
    const fresh: NewsItem[] = [];
    // 早先抓进来的 HF 条目按旧规则放行过：按现在的相关性规则重新过一遍，不相关的清掉。
    const byId = new Map(
      this.items
        .filter((i) => i.source !== 'hf' || relevant(`${i.title} ${i.abstract}`, this.opts.cfg.keywords))
        .map((i) => [i.id, i]),
    );
    let improved = 0;
    for (const item of found) {
      if (!item.id || !item.title) continue;
      const existing = byId.get(item.id);
      if (existing !== undefined) {
        // 已经在名单里：只在「这次补到了摘要、上次没有」时更新，别把列表刷新成一份新快照。
        if (existing.abstract.trim() === '' && item.abstract.trim() !== '') {
          existing.abstract = item.abstract;
          existing.sourceDetail = item.sourceDetail;
          improved += 1;
        }
        continue;
      }
      if (this.seen.has(item.id)) continue;
      this.seen.add({ id: item.id, doi: item.doi, foundAt: item.foundAt });
      fresh.push(item);
    }
    if (fresh.length > 0) this.seen.save();
    if (improved > 0) this.log(`更新了 ${improved} 条的摘要`);
    for (const item of fresh) byId.set(item.id, item);
    this.items = [...byId.values()]
      .sort((a, b) => (a.issued === b.issued ? b.foundAt - a.foundAt : b.issued.localeCompare(a.issued)))
      .slice(0, MAX_ITEMS);
    this.log(`本轮抓到 ${found.length} 条，其中新的 ${fresh.length} 条`);
  }

  /**
   * 挑一条推送。默认只推有摘要的：气泡要讲得出内容，只有标题的推送等于白推
   * （源没给就等下一轮，摘要往往过几天才补上）。把 requireAbstract 关掉才允许退而推最新的那条。
   */
  private pickPushItem(): NewsItem | null {
    const skip = new Set([...this.state.pushedIds, ...this.state.dismissed, ...this.state.read]);
    const pool = this.items.filter((i) => !skip.has(i.id));
    const withAbstract = pool.find((i) => i.abstract.trim() !== '');
    if (withAbstract !== undefined) return withAbstract;
    return this.opts.cfg.requireAbstract ? null : (pool[0] ?? null);
  }

  private async pushItem(item: NewsItem, windowKey: string | null): Promise<void> {
    const host = this.host;
    if (!host) return;
    await host.pushEvent(
      {
        type: 'news.item',
        ts: nowIso(this.opts.timezone),
        source: this.id,
        origin: 'internal',
        senderKey: item.id,
        text: this.itemEventText(item),
      },
      { trigger: 'flush' },
    );
    this.state.pushedIds = [...this.state.pushedIds, item.id].slice(-MAX_PUSHED);
    this.state.pushedToday += 1;
    this.state.lastPushAt = this.now();
    this.state.lastWindowKey = windowKey ?? this.state.lastWindowKey;
    this.log(`已推送 ${item.id}：${item.title.slice(0, 40)}`);
  }

  /**
   * 事件正文。开头先写一句「该做什么」：这段正文就在模型眼前，比只放在系统前缀里的提示词更靠得住
   * （人设允许沉默，实测它会直接 end_turn 不出声）。
   */
  private itemEventText(item: NewsItem): string {
    const authors = item.authors.slice(0, 3).join('、') + (item.authors.length > 3 ? ' 等' : '');
    return [
      '[研究] 订阅推送一条。请按「兴趣推送」的环境提示词开口：先用 pet_say 说一两句，再用 pet_ask 给按钮；不要沉默。',
      `标题：${item.title}`,
      `期刊：${item.journal}${item.tier ? `（${item.tier}）` : ''} · 上线 ${item.issued}`,
      `作者：${authors || '—'}${item.team ? ` · ${item.team}` : ''}`,
      `DOI：${item.doi ?? '—'}`,
      `爬取源：${item.sourceDetail}（抓取于 ${this.localTime(item.foundAt)}）`,
      `摘要：${item.abstract || '（源未给摘要）'}`,
      `编号 ${item.id}`,
    ].join('\n');
  }

  /** 读桌宠的问答回执：把最近一条推送标记为已读，判定「不感兴趣」就不再推它。 */
  private scanAnswers(): void {
    const host = this.host;
    if (!host) return;
    const events = host.store.range({ fromCursor: this.state.answerCursor + 1, limit: 200 });
    for (const ev of events) {
      this.state.answerCursor = Math.max(this.state.answerCursor, ev.cursor);
      if (ev.type !== 'desktop-pet.answer') continue;
      const target = this.lastPushedBefore(ev.cursor);
      if (!target) continue;
      if (!this.state.read.includes(target)) this.state.read.push(target);
      if (DISMISS_WORDS.test(ev.text)) {
        if (!this.state.dismissed.includes(target)) this.state.dismissed.push(target);
        this.log(`收到「不感兴趣」回执，不再推送 ${target}`);
      }
    }
  }

  private lastPushedBefore(cursor: number): string | null {
    const events = this.host?.store.range({ toCursor: cursor - 1, limit: 30 }) ?? [];
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i];
      if (ev.type === 'news.item' && ev.senderKey) return ev.senderKey;
    }
    return null;
  }

  // -------------------------------------------------------------- 面板方法

  async invoke(panel: string, method: string, args: unknown[], language: Language): Promise<unknown> {
    const t = interestText(language);
    try {
      // 三个面板都放行这两个动作：面板只能调自己那页的方法，不该为了「检查一次」跨页调用。
      if (method === 'checkNow') {
        await this.run('manual');
        return { ok: true, reason: null, view: this.view(language) };
      }
      if (method === 'pushNow') {
        await this.run('force');
        return { ok: true, reason: null, view: this.view(language) };
      }
      if (panel === 'list') {
        if (method === 'state') return { ok: true, reason: null, view: this.view(language) };
        if (method === 'markRead') {
          const id = String(args[0] ?? '');
          if (id) {
            this.activeId = id;
            if (!this.state.read.includes(id)) this.state.read.push(id);
            this.saveState();
          }
          return { ok: true, reason: null, view: this.view(language) };
        }
        if (method === 'open') {
          const id = String(args[0] ?? '');
          if (id) {
            this.activeId = id;
            if (!this.state.read.includes(id)) this.state.read.push(id);
            this.saveState();
          }
          return { ok: true, reason: null, view: this.view(language) };
        }
      }
      if (panel === 'detail') {
        if (method === 'state') {
          const id = String(args[0] ?? '');
          if (id) this.activeId = id;
          return { ok: true, reason: null, view: this.view(language) };
        }
        if (method === 'refresh') {
          await this.run('manual');
          return { ok: true, reason: null, view: this.view(language) };
        }
        if (method === 'translate') return await this.translateActive(language);
        if (method === 'download') return await this.downloadActive(language);
        if (method === 'next') {
          // 「不感兴趣，换一篇」：按列表顺序挪到下一条（已读的照样可以再看），末尾回到第一条。
          // 以「此刻实际在看的那条」为基准：没显式选过时它是最新一条，而不是 -1。
          const current = this.activeItem();
          const at = current === null ? -1 : this.items.findIndex((i) => i.id === current.id);
          const next = this.items.length === 0 ? undefined : this.items[(at + 1 + this.items.length) % this.items.length];
          if (next) {
            this.activeId = next.id;
            if (!this.state.read.includes(next.id)) this.state.read.push(next.id);
            this.saveState();
          }
          return { ok: Boolean(next), reason: next ? null : interestText(language).errors.noActive, view: this.view(language) };
        }
        if (method === 'record') {
          const item = this.activeItem();
          const saved = item === null ? false : this.saveRecord(item);
          return { ok: saved, reason: saved ? null : t.errors.noActive, view: this.view(language) };
        }
        if (method === 'dismiss') {
          const item = this.activeItem();
          if (item && !this.state.dismissed.includes(item.id)) this.state.dismissed.push(item.id);
          this.saveState();
          return { ok: true, reason: null, view: this.view(language) };
        }
      }
      if (panel === 'records') {
        if (method === 'state') return { ok: true, reason: null, view: this.view(language) };
        if (method === 'remove') {
          const id = String(args[0] ?? '');
          if (id !== '') this.records.delete(id);
          this.saveRecords();
          return { ok: true, reason: null, view: this.view(language) };
        }
      }
      if (panel === 'settings') {
        if (method === 'state') return { ok: true, reason: null, view: this.view(language) };
        if (method === 'saveSettings') {
          const clamped = this.saveSettings(args[0]);
          return { ok: true, reason: clamped ? 'clamped' : null, view: this.view(language) };
        }
      }
      return { ok: false, reason: interestText(language).errors.unknownMethod(`${panel}.${method}`), view: this.view(language) };
    } catch (err) {
      const reason = String((err as Error)?.message ?? err);
      this.log(`方法 ${panel}.${method} 出错：${reason}`);
      return { ok: false, reason, view: this.view(language) };
    }
  }

  view(language: Language): InterestPushView {
    const cfg = this.opts.cfg;
    const active = this.activeItem();
    return {
      config: {
        checkMinutes: cfg.checkMinutes,
        pushTimes: [...cfg.pushTimes],
        dailyCap: cfg.dailyCap,
        quiet: [...cfg.quiet],
        pushDays: [...cfg.pushDays],
        maxRounds: cfg.maxRounds,
        pausedUntil: cfg.pausedUntil,
        keywords: [...cfg.keywords],
        journals: cfg.journals.map((j) => ({ ...j })),
        glossary: [...cfg.glossary],
        arxivCats: [...cfg.arxivCats],
        windowDays: cfg.windowDays,
        rowsPerJournal: cfg.rowsPerJournal,
        mailto: cfg.mailto,
        downloadDir: cfg.downloadDir,
        requireAbstract: cfg.requireAbstract,
      },
      schedule: {
        lastCheckAt: this.state.lastCheckAt,
        lastPushAt: this.state.lastPushAt,
        pushedToday: this.state.pushedToday,
        paused: cfg.pausedUntil > this.now(),
        nextCheckAt: this.state.lastCheckAt === null ? null : this.state.lastCheckAt + Math.max(1, cfg.checkMinutes) * 60_000,
      },
      records: [...this.records.values()].sort((a, b) => b.savedAt - a.savedAt),
      items: this.items.map((item) => ({
        id: item.id,
        title: item.title,
        journal: item.journal,
        tier: item.tier,
        issued: item.issued,
        source: item.source,
        unread: !this.state.read.includes(item.id),
        hasAbstract: item.abstract.trim() !== '',
      })),
      active,
      translation: active ? (this.translations.get(active.id) ?? null) : null,
      lastError: this.lastError,
    };
  }

  /**
   * 当前要看的条目。详情页现在排第一个，打开时就该有内容可看，
   * 因此没选过或选中的那条已经被挤出列表时，默认落在最新的一条上。
   */
  private activeItem(): NewsItem | null {
    if (this.items.length === 0) return null;
    const hit = this.activeId === null ? undefined : this.items.find((i) => i.id === this.activeId);
    return hit ?? this.items[0] ?? null;
  }

  private async translateActive(language: Language): Promise<unknown> {
    const item = this.activeItem();
    const t = interestText(language);
    if (!item) return { ok: false, reason: t.errors.noActive, view: this.view(language) };
    const model = resolvePetModel(this.opts.botDir);
    if (!model) {
      const state: TranslationState = { ok: false, title: null, text: null, cached: false, missing: 0, reason: t.errors.noEndpoint };
      this.translations.set(item.id, state);
      return { ok: false, reason: t.errors.noEndpoint, view: this.view(language) };
    }
    const state = await translate(item, {
      dataDir: this.opts.dataDir,
      baseUrl: model.baseUrl,
      apiKey: model.apiKey,
      model: model.model,
      glossaryLines: this.opts.cfg.glossary,
      fetchImpl: this.opts.fetchImpl,
    });
    this.translations.set(item.id, state);
    return { ok: state.ok, reason: state.reason, view: this.view(language) };
  }

  private async downloadActive(language: Language): Promise<unknown> {
    const item = this.activeItem();
    const t = interestText(language);
    if (!item) return { ok: false, reason: t.errors.noActive, view: this.view(language) };
    if (!item.pdfUrl) return { ok: false, reason: t.detail.downloadOnlyOA, view: this.view(language) };
    const dir = this.opts.cfg.downloadDir.trim() || join(this.opts.dataDir, 'news', 'papers');
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      return { ok: false, reason: t.detail.failed(`无法创建目录 ${dir}`), view: this.view(language) };
    }
    const safe = item.title.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80);
    const path = join(dir, `${item.id}-${safe}.pdf`);
    if (existsSync(path)) return { ok: true, reason: t.detail.downloaded(path), view: this.view(language) };
    const doFetch = this.opts.fetchImpl ?? fetch;
    try {
      // 带一个说明用途的 UA：出版社与 arXiv 对无 UA 的自动请求更容易拦。
      const res = await doFetch(item.pdfUrl, { headers: { 'user-agent': 'interest-push/0.1 (+local research reader)' } });
      if (!res.ok) return { ok: false, reason: t.detail.failed(`http ${res.status}`), view: this.view(language) };
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(path, buf);
      this.log(`已下载原文到 ${path}`);
      return { ok: true, reason: t.detail.downloaded(path), view: this.view(language) };
    } catch (err) {
      const e = err as Error & { cause?: unknown };
      const cause = e?.cause === undefined ? '' : ` · ${String((e.cause as Error)?.message ?? e.cause)}`;
      this.log(`下载失败：${String(e?.message ?? err)}${cause}`);
      return { ok: false, reason: t.detail.failed(`${String(e?.message ?? err)}${cause}`), view: this.view(language) };
    }
  }

  /** 逐字段夹紧后一次写回；返回是否发生过夹紧。 */
  private saveSettings(input: unknown): boolean {
    const raw = (input ?? {}) as Record<string, unknown>;
    const cfg = this.opts.cfg;
    let clamped = false;
    const num = (value: unknown, lo: number, hi: number, fallback: number): number => {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        clamped = true;
        return fallback;
      }
      const v = Math.round(n);
      if (v < lo || v > hi) {
        clamped = true;
        return Math.min(hi, Math.max(lo, v));
      }
      return v;
    };
    const times = (value: unknown, fallback: string[]): string[] => {
      const list = (Array.isArray(value) ? value : String(value ?? '').split(','))
        .map((v) => String(v).trim())
        .filter((v) => parseTime(v) !== null);
      const uniq = [...new Set(list)].sort((a, b) => {
        const pa = parseTime(a);
        const pb = parseTime(b);
        return (pa ? pa.h * 60 + pa.m : 0) - (pb ? pb.h * 60 + pb.m : 0);
      });
      if (uniq.length === 0) {
        clamped = true;
        return fallback;
      }
      return uniq;
    };
    const lines = (value: unknown, max: number): string[] =>
      (Array.isArray(value) ? value : String(value ?? '').split('\n'))
        .map((v) => String(v).trim())
        .filter((v) => v !== '')
        .slice(0, max);
    const journals: JournalEntry[] = (Array.isArray(raw.journals) ? raw.journals : [])
      .map((j) => (j ?? {}) as Record<string, unknown>)
      .map((j) => ({
        label: String(j.label ?? '').trim(),
        issn: String(j.issn ?? '').trim(),
        tier: String(j.tier ?? '').trim(),
        tierBasis: String(j.tierBasis ?? '').trim(),
        group: String(j.group ?? '').trim() || 'X',
      }))
      .filter((j) => j.label !== '' && j.issn !== '')
      .slice(0, 200);
    const days = (Array.isArray(raw.pushDays) ? raw.pushDays : [])
      .map((v) => Math.round(Number(v)))
      .filter((v) => Number.isFinite(v) && v >= 1 && v <= 7);

    const patch: Partial<InterestPushConfigSection> = {
      checkMinutes: num(raw.checkMinutes, 5, 1440, cfg.checkMinutes),
      pushTimes: times(raw.pushTimes, cfg.pushTimes),
      dailyCap: num(raw.dailyCap, 1, 10, cfg.dailyCap),
      quiet: times(raw.quiet, cfg.quiet).slice(0, 2),
      pushDays: days.length > 0 ? [...new Set(days)].sort((a, b) => a - b) : (clamped = true, cfg.pushDays),
      maxRounds: num(raw.maxRounds, 1, 5, cfg.maxRounds),
      pausedUntil: Math.max(0, Math.round(Number(raw.pausedUntil ?? 0)) || 0),
      keywords: lines(raw.keywords, 30),
      journals,
      glossary: lines(raw.glossary, 400),
      arxivCats: (Array.isArray(raw.arxivCats) ? raw.arxivCats : String(raw.arxivCats ?? '').split(','))
        .map((v) => String(v).trim())
        .filter((v) => v !== '')
        .slice(0, 20),
      windowDays: num(raw.windowDays, 1, 365, cfg.windowDays),
      rowsPerJournal: num(raw.rowsPerJournal, 5, 200, cfg.rowsPerJournal),
      mailto: String(raw.mailto ?? cfg.mailto).trim() || cfg.mailto,
      downloadDir: String(raw.downloadDir ?? cfg.downloadDir).trim(),
      requireAbstract: typeof raw.requireAbstract === 'boolean' ? raw.requireAbstract : cfg.requireAbstract,
    };
    this.opts.persist(patch);
    this.scheduleCheck();
    this.schedulePush();
    return clamped;
  }

  // ---------------------------------------------------------------- 落盘

  private dataFile(name: string): string {
    return join(this.opts.dataDir, 'news', name);
  }

  private loadState(): PersistedState {
    try {
      const raw = JSON.parse(readFileSync(this.dataFile('state.json'), 'utf8')) as Partial<PersistedState>;
      return { ...EMPTY_STATE, ...raw };
    } catch {
      return { ...EMPTY_STATE };
    }
  }

  private saveState(): void {
    try {
      mkdirSync(dirname(this.dataFile('state.json')), { recursive: true });
      writeFileSync(this.dataFile('state.json'), `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    } catch {
      /* 落盘失败不影响本次动作 */
    }
  }

  private saveRecord(item: NewsItem): boolean {
    if (this.records.has(item.id)) return false;
    this.records.set(item.id, {
      id: item.id,
      title: item.title,
      journal: item.journal,
      tier: item.tier,
      issued: item.issued,
      doi: item.doi,
      url: item.url,
      pdfUrl: item.pdfUrl,
      source: item.source,
      sourceDetail: item.sourceDetail,
      savedAt: this.now(),
    });
    this.saveRecords();
    this.log(`收进兴趣记录：${item.title.slice(0, 40)}`);
    return true;
  }

  private loadRecords(): Map<string, InterestRecord> {
    try {
      const raw = JSON.parse(readFileSync(this.dataFile('records.json'), 'utf8')) as Record<string, InterestRecord>;
      return new Map(Object.entries(raw ?? {}));
    } catch {
      return new Map();
    }
  }

  private saveRecords(): void {
    try {
      mkdirSync(dirname(this.dataFile('records.json')), { recursive: true });
      writeFileSync(
        this.dataFile('records.json'),
        `${JSON.stringify(Object.fromEntries(this.records), null, 2)}\n`,
        'utf8',
      );
    } catch {
      /* 落盘失败不影响本次动作 */
    }
  }

  private loadItems(): NewsItem[] {
    try {
      const raw = JSON.parse(readFileSync(this.dataFile('items.json'), 'utf8')) as NewsItem[];
      return Array.isArray(raw) ? raw.slice(0, MAX_ITEMS) : [];
    } catch {
      return [];
    }
  }

  private saveItems(): void {
    try {
      mkdirSync(dirname(this.dataFile('items.json')), { recursive: true });
      writeFileSync(this.dataFile('items.json'), `${JSON.stringify(this.items, null, 2)}\n`, 'utf8');
    } catch {
      /* 同上 */
    }
  }

  // ---------------------------------------------------------------- 小工具

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private rollDay(): void {
    const key = this.localDateKey(this.now());
    if (this.state.pushedDay !== key) {
      this.state.pushedDay = key;
      this.state.pushedToday = 0;
      this.state.lastWindowKey = null;
    }
  }

  private localDateKey(ms: number): string {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: this.opts.timezone || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
    return parts;
  }

  private localTime(ms: number): string {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: this.opts.timezone || undefined,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(ms));
  }

  private statusText(): string {
    const cfg = this.opts.cfg;
    const t = interestText('zh');
    const next = this.nextWindowAt();
    const unread = this.items.filter((i) => !this.state.read.includes(i.id)).length;
    return [
      `${t.lamps.check}：${this.state.lastCheckAt ? this.localTime(this.state.lastCheckAt) : t.lamps.checkNone}${this.lastError ? `（${this.lastError}）` : ''}`,
      `${t.lamps.today}：${this.state.pushedToday}/${cfg.dailyCap}`,
      `${t.lamps.next}：${cfg.pausedUntil > this.now() ? t.lamps.nextPaused : next === null ? t.lamps.checkNone : this.localTime(next)}`,
      `未读：${unread}`,
    ].join(' · ');
  }

  private log(message: string): void {
    this.host?.log?.info?.(`[interest-push] ${message}`);
  }
}

/** `HH:MM` → 时/分；非法返回 null。 */
function parseTime(value: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mi) || h > 23 || mi > 59) return null;
  return { h, m: mi };
}
