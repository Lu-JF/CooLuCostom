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
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Language } from 'cortico/core/language.ts';
import type { World, WorldConsoleDecl, WorldHost } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import type { InterestPushConfigSection, JournalEntry } from './config.ts';
import { lookupJournal, normalizeIssn, probeLatest, resolveTier } from './journal.ts';
import {
  fetchHfDaily,
  fetchJournal,
  fetchOpenAlexAbstractByTitle,
  fetchOpenAlexAbstracts,
  fetchOpenAlexInstitutions,
  fetchOpenAlexInstitutionsByTitle,
  fetchSemanticScholarAbstracts,
} from './fetch.ts';
import { fetchArxivSearch } from './arxiv.ts';
import { relevant } from './relevance.ts';
import { interestText } from './i18n.ts';
import { resolvePetModel } from './pet-model.ts';
import { keepsInPool, pickManualCandidate, pickPushCandidate, sortForList, type PickOptions } from './pick.ts';
import { readReview, reviewItem } from './review.ts';
import { decide, type ScheduleConfig } from './schedule.ts';
import { SeenStore } from './seen.ts';
import { translate } from './translate.ts';
import type { InterestPushView, InterestRecord, NewsItem, ReviewState, TranslationState } from './view-types.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
/** 列表最多留多少条。 */
const MAX_ITEMS = 60;
/** 已推送编号留多久（按条数）。 */
const MAX_PUSHED = 300;
/** 抓取并发上限：一次要问几十家期刊，别把源惹毛。 */
const FETCH_CONCURRENCY = 5;
/** 每轮最多按标题去补几条摘要（一次一条请求，别贪）。 */
const TITLE_BACKFILL_PER_RUN = 24;
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
  /** 读框架的秘密存储（部署 .env）。 */
  secret?: (name: string) => string;
  /** 写部署 .env（密钥只走这里，不进配置文件）。 */
  storeSecret?: (name: string, value: string) => void;
  /** 测试注入：网络与时钟。 */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface PersistedState {
  dismissed: string[];
  /** 面板当前看的条目：重启后仍停在刚推送的那篇，而不是最新抓到的一篇。 */
  activeId?: string | null;
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
  /** 条目编号 → 上次按标题问机构的时刻。 */
  affiliationTried?: Record<string, number>;
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
  affiliationTried: {},
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
  /** 每次推送或抓取合并后自增，面板据此判断是否需要重画。 */
  private revision = 0;
  /** 上一次「检测全部期刊」的结果，只放内存。 */
  private journalTest: InterestPushView['journalTest'] = { at: null, ok: 0, total: 0, results: [] };
  private translations = new Map<string, TranslationState>();
  private inflight: Promise<void> | null = null;
  private lastError: string | null = null;

  constructor(private readonly opts: InterestPushWorldOptions) {
    this.seen = new SeenStore(opts.dataDir);
    this.state = this.loadState();
    this.activeId = this.state.activeId ?? null;
    this.items = this.loadItems();
    this.migrateItems();
    this.fixJournalIssns();
    this.records = this.loadRecords();
  }

  // ---------------------------------------------------------------- World

  envPromptVars(): Record<string, string> {
    // 占位符名不用连字符：模板渲染只认 [\w.] 一类的名字，带连字符的会被原样留下。
    return {
      'interestpush.status': this.statusText(),
      'interestpush.rounds': String(Math.max(1, Math.floor(this.opts.cfg.maxRounds))),
    };
  }

  tools(): never[] {
    return [];
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.restoreConfigSnapshot();
    await this.run('start');
    this.pruneCaches();
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
        // 没暂停就不挂这个标签：「已暂停 off」等于双重否定，看不明白。暂停时直接写出到哪一刻。
        ...(paused
          ? [{ label: t.badges.paused, value: this.localTime(this.opts.cfg.pausedUntil), tone: 'off' as const }]
          : []),
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
          vars: [
          { name: 'interestpush.status', description: '当前的检查与推送读数，此刻的值。', multiline: false },
          { name: 'interestpush.rounds', description: '气泡对话轮数上限，取自配置。', multiline: false },
        ],
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

  private async run(reason: 'start' | 'timer' | 'window' | 'manual'): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doRun(reason).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doRun(reason: 'start' | 'timer' | 'window' | 'manual'): Promise<void> {
    this.rollDay();
    try {
      const found = await this.collect();
      this.lastError = null;
      this.merge(found);
      // 机构要补在合并之后：collect 阶段 this.items 还是上一轮的名单。
      await this.enrichAffiliations(this.fetchDeps());
    } catch (err) {
      this.lastError = String((err as Error)?.message ?? err);
      this.log(`抓取失败：${this.lastError}`);
    }
    this.state.lastCheckAt = this.now();
    this.scanAnswers();

    if (reason === 'window') {
      const decision = decide(this.scheduleConfig(), new Date(this.now()), {
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
    this.revision += 1;
    this.saveItems();
    this.pruneCaches();
    this.writeConfigSnapshot();
  }

  private fetchDeps(): { fetchImpl: typeof fetch; mailto: string; openAlexKey: string; semanticScholarKey: string } {
    return {
      fetchImpl: this.opts.fetchImpl ?? fetch,
      mailto: this.opts.cfg.mailto,
      // 可选：这两个免费额度按 IP 共享，有 key 才稳。走环境变量，不落盘。
      openAlexKey: (this.opts.secret?.('OPENALEX_API_KEY') ?? '') || (process.env.OPENALEX_API_KEY ?? ''),
      semanticScholarKey: (this.opts.secret?.('S2_API_KEY') ?? '') || (process.env.S2_API_KEY ?? ''),
    };
  }

  private async collect(): Promise<NewsItem[]> {
    const cfg = this.opts.cfg;
    const deps = this.fetchDeps();
    const tierOf = new Map<string, JournalEntry>(cfg.journals.map((j) => [j.issn, j]));
    const jobs: Array<() => Promise<NewsItem[]>> = [
      ...cfg.journals.map((j) => () =>
        fetchJournal(
          {
            issn: j.issn,
            days: cfg.windowDays,
            delayDays: cfg.journalDelayDays,
            rows: cfg.rowsPerJournal,
            keywords: cfg.keywords,
          },
          deps,
        ).then((list) =>
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
   * 补作者机构。期刊条目按 DOI 批量问 OpenAlex，预印本没有 DOI 时按标题问，
   * 同一条 24 小时内只问一次，结果写回条目。
   */
  private async enrichAffiliations(deps: { fetchImpl?: typeof fetch; mailto: string }): Promise<void> {
    const now = this.now();
    const missing = this.items.filter((i) => (i.affiliation ?? '').trim() === '');
    if (missing.length === 0) return;
    const withDoi = missing.filter((i) => (i.doi ?? '').trim() !== '');
    if (withDoi.length > 0) {
      const byDoi = await fetchOpenAlexInstitutions(withDoi.map((i) => i.doi as string), deps);
      let filled = 0;
      for (const item of withDoi) {
        const hit = byDoi[(item.doi as string).toLowerCase()];
        if (hit !== undefined) {
          item.affiliationChecked = true;
          if (hit !== '') {
            item.affiliation = hit;
            item.sourceDetail = `${item.sourceDetail} +openalex机构`;
            filled += 1;
          }
        }
      }
      if (filled > 0) this.log(`补了 ${filled} 条机构`);
    }
    this.state.affiliationTried ??= {};
    const tried = this.state.affiliationTried;
    const byTitle = missing
      .filter((i) => (i.affiliation ?? '').trim() === '' && i.title.trim() !== '')
      .filter((i) => now - (tried[i.id] ?? 0) > 24 * 60 * 60_000)
      .slice(0, 12);
    for (const item of byTitle) {
      tried[item.id] = now;
      const names = await fetchOpenAlexInstitutionsByTitle(item.title, deps);
      if (names !== null) {
        item.affiliationChecked = true;
        if (names !== '') {
          item.affiliation = names;
          item.sourceDetail = `${item.sourceDetail} +openalex标题机构`;
        }
      }
    }
    const before = this.items.length;
    this.items = this.items.filter((i) => keepsInPool(i, this.state.pushedIds));
    if (this.items.length < before) this.log(`机构未知，去掉 ${before - this.items.length} 条`);
    this.saveItems();
    this.saveState();
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
      // 还没推过的先补：它们缺摘要就真的推不出去。
      .sort((a, b) => Number(this.state.pushedIds.includes(a.id)) - Number(this.state.pushedIds.includes(b.id)))
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
    // 名单先过两道筛：与研究方向无关的 HF 条目清掉；期刊里「还没到延迟窗口又没摘要」的也清掉
    // （设置里既然说了等摘要，就不该把刚发表、摘要还没长出来的摆在列表里）。
    const delay = Math.max(0, Math.floor(this.opts.cfg.journalDelayDays));
    const today = this.now();
    const stillWaiting = (i: NewsItem): boolean => {
      if (i.source !== 'crossref' || i.abstract.trim() !== '' || delay <= 0) return false;
      const issued = Date.parse(`${i.issued}T00:00:00Z`);
      if (!Number.isFinite(issued)) return false;
      return (today - issued) / 86_400_000 < delay;
    };
    const byId = new Map(
      this.items
        .filter((i) => i.source !== 'hf' || relevant(`${i.title} ${i.abstract}`, this.opts.cfg.keywords))
        .filter((i) => !stillWaiting(i))
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
    this.items = sortForList([...byId.values()]).slice(0, MAX_ITEMS);
    this.log(`本轮抓到 ${found.length} 条，其中新的 ${fresh.length} 条`);
  }

  /**
   * 挑一条推送。默认只推有摘要的：气泡要讲得出内容，只有标题的推送等于白推
   * （源没给就等下一轮，摘要往往过几天才补上）。把 requireAbstract 关掉才允许退而推最新的那条。
   */
  private pickOptions(): PickOptions {
    return {
      read: this.state.read,
      pushedIds: this.state.pushedIds,
      dismissed: this.state.dismissed,
      requireAbstract: this.opts.cfg.requireAbstract,
    };
  }

  private pickPushItem(): NewsItem | null {
    return pickPushCandidate(this.items, this.pickOptions());
  }

  /** 列表里用的速评缩略：总分 + 评语（没有就是 null）。 */
  private reviewThumb(id: string): { total: number; text: string } | null {
    const r = readReview(this.opts.dataDir, id);
    return r === null ? null : { total: r.total, text: r.text };
  }

  /** 当前这篇的速评状态；没评过回 ok:false、reason:'none'。 */
  private reviewStateOf(id: string): ReviewState {
    const r = readReview(this.opts.dataDir, id);
    if (r === null) return { ok: false, text: '', total: null, cached: false, reason: 'none', at: 0 };
    return { ok: true, text: r.text, total: r.total, cached: true, reason: null, at: r.at };
  }

  /**
   * 确保这篇有速评：有缓存直接用，没有就评一次并落盘。
   * 失败不抛错——推送照发，只是气泡里没有速评那一段。
   */
  private async ensureReview(item: NewsItem): Promise<ReviewState | null> {
    const cached = readReview(this.opts.dataDir, item.id);
    if (cached) return { ok: true, text: cached.text, total: cached.total, cached: true, reason: null, at: cached.at };
    const model = resolvePetModel(this.opts.botDir);
    if (!model) {
      this.log('速评跳过：找不到桌宠端点');
      return null;
    }
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const state = await reviewItem(item, {
          dataDir: this.opts.dataDir,
          keywords: this.opts.cfg.keywords,
          baseUrl: model.baseUrl,
          apiKey: model.apiKey,
          model: model.model,
          fetchImpl: this.opts.fetchImpl,
        });
        if (state.ok) {
          this.log(`大肥鱼速评 ${state.total}/10：${item.title.slice(0, 30)}`);
          return state;
        }
        this.log(`速评失败（第 ${attempt} 次）：${state.reason}`);
        if (attempt === 2) return null;
      } catch (err) {
        this.log(`速评出错（第 ${attempt} 次）：${String((err as Error)?.message ?? err)}`);
        if (attempt === 2) return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
    return null;
  }

  private async pushItem(item: NewsItem, windowKey: string | null, countToday = true): Promise<void> {
    const host = this.host;
    if (!host) return;
    // 先把速评评好：气泡的第一段就是速评与打分，缺了它推送就只剩摘要。
    const review = await this.ensureReview(item);
    await host.pushEvent(
      {
        type: 'news.item',
        ts: nowIso(this.opts.timezone),
        source: this.id,
        origin: 'internal',
        senderKey: item.id,
        text: this.itemEventText(item, review),
      },
      { trigger: 'flush' },
    );
    this.state.pushedIds = [...this.state.pushedIds, item.id].slice(-MAX_PUSHED);
    // 手动试推不计入「今日推送」，否则上限 2 条时会显示成 21/2 这种自相矛盾的读数。
    if (countToday) this.state.pushedToday += 1;
    this.state.lastPushAt = this.now();
    this.state.lastWindowKey = windowKey ?? this.state.lastWindowKey;
    // 页签跟到刚推的这篇：「推送」页看到的就是气泡刚讲的那一篇，两处永远一致。
    this.activeId = item.id;
    this.revision += 1;
    this.log(`已推送 ${item.id}：${item.title.slice(0, 40)}`);
  }

  /**
   * 事件正文。开头先写一句「该做什么」：这段正文就在模型眼前，比只放在系统前缀里的提示词更靠得住
   * （人设允许沉默时，只放在系统前缀里的提示不足以让它开口）。
   */
  private itemEventText(item: NewsItem, review: ReviewState | null): string {
    const authors = item.authors.slice(0, 3).join('、') + (item.authors.length > 3 ? ' 等' : '');
    return [
      '[研究] 订阅推送一条。请按「论文推送」的环境提示词开口：先用 pet_say 报「大肥鱼速评」的评价与星级，再讲论文，' +
        '最后用 pet_ask 给按钮；不要沉默。',
      review === null
        ? '速评：（这次没评出来，直接讲论文，不要编分数）'
        : `速评（大肥鱼，${review.total ?? '—'}/10）：${review.text}`,
      `标题：${item.title}`,
      `期刊：${item.journal}${item.tier ? `（${item.tier}）` : ''} · 上线 ${item.issued}`,
      `作者：${authors || '—'}${item.affiliation ? ` · ${item.affiliation}` : ''}`,
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
      if (method === 'setOpenAlexKey') {
        // 密钥只写部署 .env，不进配置文件，也不回显。
        const value = String(args[0] ?? '').trim();
        // 留空表示不改动：框架的秘密存储不接受空值。
        if (value === '') return { ok: true, reason: null, view: this.view(language) };
        if (this.opts.storeSecret === undefined) {
          return { ok: false, reason: t.errors.noSecretStore, view: this.view(language) };
        }
        if (!/^[A-Za-z0-9_-]{8,64}$/.test(value)) {
          return { ok: false, reason: t.settings.openAlexBad, view: this.view(language) };
        }
        this.opts.storeSecret('OPENALEX_API_KEY', value);
        this.log('已保存 OpenAlex 密钥');
        return { ok: true, reason: null, view: this.view(language) };
      }
      if (method === 'addJournal') {
        const issn = normalizeIssn(String(args[0] ?? ''));
        if (issn === null) return { ok: false, reason: t.settings.issnBad, view: this.view(language) };
        if (this.opts.cfg.journals.some((j) => j.issn === issn)) {
          return { ok: false, reason: t.settings.journalExists(issn), view: this.view(language) };
        }
        const deps = this.fetchDeps();
        const meta = await lookupJournal(issn, deps);
        if (meta === null) return { ok: false, reason: t.settings.journalMissing(issn), view: this.view(language) };
        // 保存即试抓一篇：抓不到就不入库，免得列表里躺着一家永远没有结果的刊。
        const sample = await probeLatest(issn, deps);
        if (sample === null) {
          return { ok: false, reason: t.settings.journalNoPapers(meta.title), view: this.view(language) };
        }
        const tier = await resolveTier(issn, deps);
        const entry = { label: meta.title, issn, tier: tier.tier, tierBasis: tier.tierBasis };
        const journals = [...this.opts.cfg.journals, entry];
        this.opts.persist({ journals });
        this.opts.cfg.journals = journals;
        this.writeConfigSnapshot();
        this.log(`新增期刊 ${meta.title}（${issn}），试抓成功：${sample.title.slice(0, 40)}`);
        return { ok: true, reason: t.settings.journalAdded(meta.title, sample.title), view: this.view(language) };
      }
      if (method === 'removeJournal') {
        const issn = normalizeIssn(String(args[0] ?? '')) ?? String(args[0] ?? '').trim();
        const journals = this.opts.cfg.journals.filter((j) => j.issn !== issn);
        if (journals.length === this.opts.cfg.journals.length) {
          return { ok: false, reason: t.settings.journalUnknown(issn), view: this.view(language) };
        }
        this.opts.persist({ journals });
        this.opts.cfg.journals = journals;
        this.journalTest = {
          ...this.journalTest,
          results: this.journalTest.results.filter((r) => r.issn !== issn),
          total: journals.length,
          ok: this.journalTest.results.filter((r) => r.issn !== issn && r.ok).length,
        };
        this.writeConfigSnapshot();
        return { ok: true, reason: null, view: this.view(language) };
      }
      if (method === 'testJournals') {
        const deps = this.fetchDeps();
        const journals = [...this.opts.cfg.journals];
        const results: Array<{ issn: string; label: string; ok: boolean; reason: string }> = [];
        await new Promise((resolve) => setTimeout(resolve, 400));
        // 顺序发、每条之间留一点间隔：Crossref 对突发请求限流，并发的「抓不到」是假失败。
        for (const j of journals) {
          const sample = await probeLatest(j.issn, deps);
          results.push({
            issn: j.issn,
            label: j.label,
            ok: sample !== null,
            reason: sample === null ? t.settings.journalNoPapers(j.label) : sample.title,
          });
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        this.journalTest = { at: Date.now(), ok: results.filter((r) => r.ok).length, total: results.length, results };
        this.log(`期刊检测：${this.journalTest.ok}/${this.journalTest.total} 可抓取`);
        return { ok: true, reason: t.settings.journalTestDone(this.journalTest.ok, this.journalTest.total), view: this.view(language) };
      }
      if (method === 'addTerm') {
        const line = String(args[0] ?? '').replace(/\s*\|\s*/g, ' | ').trim();
        const [en, zh] = line.split(' | ');
        if (!en || !zh) return { ok: false, reason: t.settings.termBad, view: this.view(language) };
        if (this.opts.cfg.glossary.includes(line)) {
          return { ok: false, reason: t.settings.termExists, view: this.view(language) };
        }
        const glossary = [...this.opts.cfg.glossary, line];
        this.opts.persist({ glossary });
        this.opts.cfg.glossary = glossary;
        this.writeConfigSnapshot();
        return { ok: true, reason: null, view: this.view(language) };
      }
      if (method === 'removeTerm') {
        const line = String(args[0] ?? '').trim();
        const glossary = this.opts.cfg.glossary.filter((x) => x !== line);
        if (glossary.length === this.opts.cfg.glossary.length) {
          return { ok: false, reason: t.settings.termUnknown, view: this.view(language) };
        }
        this.opts.persist({ glossary });
        this.opts.cfg.glossary = glossary;
        this.writeConfigSnapshot();
        return { ok: true, reason: null, view: this.view(language) };
      }
      if (method === 'review') {
        // 三个面板都能叫：列表里点「速评」时把那条传进来，推送页不传就是当前这篇。
        const id = String(args[0] ?? '').trim();
        if (id !== '') this.activeId = id;
        const item = this.activeItem();
        if (!item) return { ok: false, reason: t.errors.noActive, view: this.view(language) };
        const state = await this.ensureReview(item);
        if (state === null || !state.ok) {
          return { ok: false, reason: state?.reason ?? t.errors.noEndpoint, view: this.view(language) };
        }
        return { ok: true, reason: state.cached ? 'cached' : null, view: this.view(language) };
      }
      if (method === 'pushNow') {
        // 页面上哪篇能推就推哪篇；它推不了（已推过 / 没摘要 / 判过不感兴趣）就换下一篇能推的。
        // 推完 activeId 跟到那篇（见 pushItem），于是「推送」页签永远显示刚刚气泡讲的那一篇。
        // 手动是人明确要求的：只剩无摘要的条目时照样推，气泡里会注明源未提供摘要。
        const active = this.activeItem();
        const strict = pickManualCandidate(this.items, active, this.pickOptions());
        const loose = strict === null && this.opts.cfg.allowNoAbstractPush
          ? pickManualCandidate(this.items, active, { ...this.pickOptions(), requireAbstract: false })
          : null;
        const target = strict ?? loose;
        if (target === null) {
          return { ok: false, reason: this.emptyPoolText(language), view: this.view(language) };
        }
        await this.pushItem(target, null, false);
        this.saveState();
        return { ok: true, reason: loose === null ? null : t.detail.noAbstractFromSource, view: this.view(language) };
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
          this.writeConfigSnapshot();
          // 改了推送时刻 / 星期 / 检查间隔，必须重排定时器，否则新加的窗口要等到下一天才生效。
          this.scheduleCheck();
          this.schedulePush();
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

  view(_language?: Language): InterestPushView {
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
        journalDelayDays: cfg.journalDelayDays,
        mailto: cfg.mailto,
        downloadDir: cfg.downloadDir,
        requireAbstract: cfg.requireAbstract,
        allowNoAbstractPush: cfg.allowNoAbstractPush,
        openAlexKeySet: (this.opts.secret?.('OPENALEX_API_KEY') ?? '') !== '',
        quietConflicts: this.quietConflicts(),
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
        venue: item.venue,
        review: this.reviewThumb(item.id),
      })),
      active,
      revision: this.revision,
      journalTest: this.journalTest,
      translation: active ? (this.translations.get(active.id) ?? null) : null,
      review: active ? this.reviewStateOf(active.id) : null,
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

  /** 池底空了的说明：已推多少、无摘要多少，比一句「没有可推的条目」有用。 */
  private emptyPoolText(language: Language): string {
    const t = interestText(language);
    const pushed = new Set(this.state.pushedIds);
    const dismissed = new Set(this.state.dismissed);
    const pushedCount = this.items.filter((i) => pushed.has(i.id)).length;
    const rest = this.items.length - pushedCount;
    return t.errors.poolEmpty(this.items.length, pushedCount, dismissed.size, Math.max(0, rest - dismissed.size)) + (this.opts.cfg.allowNoAbstractPush ? '' : t.errors.poolEmptyHint);
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
    /** 静默起止：只校验合法性，不排序——跨夜时段（22:30 → 08:30）排一下就反了。 */
    const quietPair = (value: unknown, fallback: string[]): string[] => {
      const list = (Array.isArray(value) ? value : String(value ?? '').split(','))
        .map((v) => String(v).trim())
        .filter((v) => parseTime(v) !== null);
      const first = list[0] ?? fallback[0] ?? '22:30';
      const second = list[1] ?? fallback[1] ?? '08:30';
      return [first, second];
    };
    const times = (value: unknown, fallback: string[]): string[] => {
      if (value === undefined) return fallback;
      const list = (Array.isArray(value) ? value : String(value).split(','))
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

    // 空数组是合法的（使用者就是要清空）；只有「键都没给」才保持原样。
    const days = (Array.isArray(raw.pushDays) ? raw.pushDays : [])
      .map((v) => Math.round(Number(v)))
      .filter((v) => Number.isFinite(v) && v >= 1 && v <= 7);

    const patch: Partial<InterestPushConfigSection> = {
      checkMinutes: num(raw.checkMinutes, 5, 1440, cfg.checkMinutes),
      pushTimes: times(raw.pushTimes, cfg.pushTimes),
      dailyCap: num(raw.dailyCap, 1, 10, cfg.dailyCap),
      // 静默时段是两个时刻的「起 → 止」，顺序有意义（22:30→08:30 是跨夜），不能像时刻表那样排序。
      quiet: quietPair(raw.quiet, cfg.quiet),
      pushDays: raw.pushDays === undefined ? cfg.pushDays : days.length > 0 ? [...new Set(days)].sort((a, b) => a - b) : (clamped = true, cfg.pushDays),
      maxRounds: num(raw.maxRounds, 1, 5, cfg.maxRounds),
      pausedUntil: Math.max(0, Math.round(Number(raw.pausedUntil ?? 0)) || 0),
      keywords: raw.keywords === undefined ? cfg.keywords : lines(raw.keywords, 30),
      // 期刊与术语表都只由 add/remove 方法改，面板的保存不再覆盖它们。
      arxivCats: raw.arxivCats === undefined ? cfg.arxivCats : (Array.isArray(raw.arxivCats) ? raw.arxivCats : String(raw.arxivCats).split(','))
        .map((v) => String(v).trim())
        .filter((v) => v !== '')
        .slice(0, 20),
      windowDays: num(raw.windowDays, 1, 365, cfg.windowDays),
      rowsPerJournal: num(raw.rowsPerJournal, 5, 200, cfg.rowsPerJournal),
      journalDelayDays: num(raw.journalDelayDays, 0, 120, cfg.journalDelayDays),
      mailto: String(raw.mailto ?? cfg.mailto).trim() || cfg.mailto,
      downloadDir: String(raw.downloadDir ?? cfg.downloadDir).trim(),
      requireAbstract: typeof raw.requireAbstract === 'boolean' ? raw.requireAbstract : cfg.requireAbstract,
      allowNoAbstractPush:
        typeof raw.allowNoAbstractPush === 'boolean' ? raw.allowNoAbstractPush : cfg.allowNoAbstractPush,
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

  /** 配置快照文件：升级安装版可能把 worlds.<id> 重置为默认值，启动时靠它补回。 */
  private snapshotFile(): string {
    return this.dataFile('config-snapshot.json');
  }

  /** 把当前生效配置写入快照（保存配置、启动完成、推送后都会刷新）。 */
  private writeConfigSnapshot(): void {
    const cfg = this.opts.cfg;
    const snap = {
      checkMinutes: cfg.checkMinutes,
      pushTimes: [...cfg.pushTimes],
      dailyCap: cfg.dailyCap,
      quiet: [...cfg.quiet],
      pushDays: [...cfg.pushDays],
      maxRounds: cfg.maxRounds,
      keywords: [...cfg.keywords],
      arxivCats: [...cfg.arxivCats],
      windowDays: cfg.windowDays,
      rowsPerJournal: cfg.rowsPerJournal,
      journalDelayDays: cfg.journalDelayDays,
      mailto: cfg.mailto,
      downloadDir: cfg.downloadDir,
      requireAbstract: cfg.requireAbstract,
      allowNoAbstractPush: cfg.allowNoAbstractPush,
      journals: cfg.journals.map((j) => ({ ...j })),
      glossary: [...cfg.glossary],
      at: Date.now(),
    };
    try {
      mkdirSync(dirname(this.snapshotFile()), { recursive: true });
      writeFileSync(this.snapshotFile(), `${JSON.stringify(snap, null, 2)}\n`, 'utf8');
    } catch {
      /* 快照失败不影响运行 */
    }
  }

  /**
   * 配置被重置时从快照恢复。判定标准只有两条：期刊从多家变成不足 5 家，或推送时刻被清空。
   * 使用者主动清空名单时快照会跟着变空，因此不会反复互相覆盖。
   */
  private restoreConfigSnapshot(): void {
    let snap: Partial<InterestPushConfigSection> | null = null;
    try {
      snap = JSON.parse(readFileSync(this.snapshotFile(), 'utf8')) as Partial<InterestPushConfigSection>;
    } catch {
      return;
    }
    if (!snap) return;
    const cfg = this.opts.cfg;
    const snapJournals = Array.isArray(snap.journals) ? snap.journals : [];
    const journalsReset = snapJournals.length >= 5 && cfg.journals.length < 5;
    const timesReset = (snap.pushTimes ?? []).length > 0 && cfg.pushTimes.length === 0;
    if (!journalsReset && !timesReset) return;
    const { pausedUntil: _paused, ...patch } = snap as InterestPushConfigSection;
    this.opts.persist(patch);
    Object.assign(cfg, patch);
    this.log('配置看起来被重置了，已从快照恢复');
  }

  /** 缓存只保留当前列表里的条目：列表每天覆盖，缓存跟着收敛，不会无限增长。 */
  private pruneCaches(): void {
    const keep = new Set(this.items.map((i) => i.id));
    for (const dir of ['reviews', 'translated']) {
      const full = join(this.opts.dataDir, 'news', dir);
      let names: string[];
      try {
        names = readdirSync(full);
      } catch {
        continue;
      }
      let removed = 0;
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        if (keep.has(name.slice(0, -5))) continue;
        try {
          unlinkSync(join(full, name));
          removed += 1;
        } catch {
          /* 单个删不掉不影响其余 */
        }
      }
      if (removed > 0) this.log(`清理 ${dir} 缓存 ${removed} 条（不在当前列表）`);
    }
  }

  /** 落在静默时段里的推送时刻：配置页据此提示，避免设了却不生效。 */
  private quietConflicts(): string[] {
    const start = parseTime(this.opts.cfg.quiet[0] ?? '');
    const end = parseTime(this.opts.cfg.quiet[1] ?? '');
    if (!start || !end) return [];
    const a = start.h * 60 + start.m;
    const b = end.h * 60 + end.m;
    const inside = (m: number): boolean => (a <= b ? m >= a && m < b : m >= a || m < b);
    return this.opts.cfg.pushTimes.filter((text) => {
      const p = parseTime(text);
      return p !== null && inside(p.h * 60 + p.m);
    });
  }

  /** 早期默认表把 Structural Health Monitoring 的 ISSN 写成了 1477-9217，读到就改回来。 */
  private fixJournalIssns(): void {
    const fixes: Record<string, string> = { '1477-9217': '1475-9217' };
    let changed = false;
    for (const j of this.opts.cfg.journals) {
      const right = fixes[j.issn];
      if (right !== undefined) {
        j.issn = right;
        changed = true;
      }
    }
    if (changed) {
      this.opts.persist({ journals: this.opts.cfg.journals });
      this.log('已修正 Structural Health Monitoring 的 ISSN');
    }
  }

  /** 旧条目没有 venue：期刊来源的补上刊名，其余按预印本处理。只写一次。 */
  private migrateItems(): void {
    let changed = false;
    for (const item of this.items) {
      if (item.venue === undefined) {
        item.venue = item.source === 'crossref' && item.journal !== '' ? item.journal : null;
        changed = true;
      }
    }
    if (changed) this.saveItems();
  }

  private loadState(): PersistedState {
    // 数组与对象必须给出新的，不能只做浅拷贝：`{...EMPTY_STATE}` 会让同一进程里的两个实例
    // 共用一个 dismissed / pushedIds 数组（一处 push，另一处也变），测试里串得一眼可见。
    const blank = (): PersistedState => ({
      ...EMPTY_STATE,
      dismissed: [],
      read: [],
      pushedIds: [],
      conditional: {},
      abstractTried: {},
    });
    try {
      const raw = JSON.parse(readFileSync(this.dataFile('state.json'), 'utf8')) as Partial<PersistedState>;
      return { ...blank(), ...raw };
    } catch {
      return blank();
    }
  }

  private saveState(): void {
    try {
      mkdirSync(dirname(this.dataFile('state.json')), { recursive: true });
      this.state.activeId = this.activeId;
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
