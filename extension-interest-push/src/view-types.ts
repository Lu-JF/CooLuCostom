/** 面板与工具共用的纯类型；这个文件不 import 任何带 Node 依赖的模块，浏览器侧 tsconfig 也编得了它。 */

export type NewsSource = 'crossref' | 'arxiv' | 'hf';

/** 一条论文记录。`id` 由 DOI（或标题+日期）哈希前 8 位得来，稳定且便于在事件里引用。 */
export interface NewsItem {
  id: string;
  doi: string | null;
  title: string;
  authors: string[];
  /** 作者机构（OpenAlex 的 authorships，最多三个）。 */
  affiliation: string | null;
  /** 正式发表处：期刊名或会议名；预印本为 null。 */
  venue: string | null;
  /** 机构查过但查不到（OpenAlex 有记录、没有机构）：这类不进候选池。 */
  affiliationChecked?: boolean;
  journal: string;
  journalIssn: string | null;
  tier: string | null;
  issued: string;
  abstract: string;
  url: string;
  pdfUrl: string | null;
  source: NewsSource;
  sourceDetail: string;
  foundAt: number;
}

/** 列表页一行。 */
export interface NewsRow {
  id: string;
  title: string;
  journal: string;
  tier: string | null;
  issued: string;
  source: NewsSource;
  unread: boolean;
  /** 源是否给了摘要；没给的条目在列表里标出来，免得点进去才发现。 */
  hasAbstract: boolean;
  /** 正式发表处；null 表示预印本。 */
  venue: string | null;
  /** 大肥鱼速评摘要（列表里只放评语与总分，没有就是 null）。 */
  review: { total: number; text: string } | null;
}

/** 译文状态。 */
export interface TranslationState {
  ok: boolean;
  /** 标题译文；模型没按格式给标题时为空串。 */
  title: string | null;
  text: string | null;
  cached: boolean;
  /** 数字/单位/缩写可能缺失处的数量，仅作提示。 */
  missing: number;
  reason: string | null;
}

/** 大肥鱼速评的状态：没评过 = ok:false + reason:'none'；评过就从缓存回。 */
export interface ReviewState {
  ok: boolean;
  text: string;
  /** 总分 0–10（满分 10 星），一位小数；没分数时 null。 */
  total: number | null;
  cached: boolean;
  reason: string | null;
  at: number;
}

/** 兴趣记录的一条：抓到的条目 + 收进来的时间。 */
export interface InterestRecord {
  id: string;
  title: string;
  journal: string;
  tier: string | null;
  issued: string;
  doi: string | null;
  url: string;
  pdfUrl: string | null;
  source: NewsSource;
  sourceDetail: string;
  savedAt: number;
}

export interface InterestPushView {
  /** 推送或抓取合并后自增，面板轮询时据此判断要不要重画。 */
  revision: number;
  config: {
    checkMinutes: number;
    pushTimes: string[];
    dailyCap: number;
    quiet: string[];
    pushDays: number[];
    maxRounds: number;
    pausedUntil: number;
    keywords: string[];
    journals: Array<{ label: string; issn: string; tier: string; tierBasis: string }>;
    glossary: string[];
    arxivCats: string[];
    windowDays: number;
    rowsPerJournal: number;
    journalDelayDays: number;
    mailto: string;
    downloadDir: string;
    requireAbstract: boolean;
    allowNoAbstractPush: boolean;
    /** 是否已经配了 OpenAlex 密钥（值不回显）。 */
    openAlexKeySet: boolean;
    /** 落在静默时段里的推送时刻（配置页据此提示）。 */
    quietConflicts: string[];
  };
  /** 上一次「检测全部期刊」的结果。 */
  journalTest: {
    at: number | null;
    ok: number;
    total: number;
    results: Array<{ issn: string; label: string; ok: boolean; reason: string }>;
  };
  /** 调度状态摘要，配置页显示。 */
  schedule: {
    lastCheckAt: number | null;
    lastPushAt: number | null;
    pushedToday: number;
    paused: boolean;
    nextCheckAt: number | null;
  };
  items: NewsRow[];
  /** 收进兴趣记录的条目，按收藏时间倒序。 */
  records: InterestRecord[];
  active: NewsItem | null;
  translation: TranslationState | null;
  /** 当前这篇的速评；没评过时 ok:false、reason:'none'。 */
  review: ReviewState | null;
  /** 最近一次检查的错误原因，null 表示正常。 */
  lastError: string | null;
}
