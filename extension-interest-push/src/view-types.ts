/** 面板与工具共用的纯类型；这个文件不 import 任何带 Node 依赖的模块，浏览器侧 tsconfig 也编得了它。 */

export type NewsSource = 'crossref' | 'arxiv' | 'hf';

/** 一条论文记录。`id` 由 DOI（或标题+日期）哈希前 8 位得来，稳定且便于在事件里引用。 */
export interface NewsItem {
  id: string;
  doi: string | null;
  title: string;
  authors: string[];
  team: string | null;
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
}

/** 译文状态。 */
export interface TranslationState {
  ok: boolean;
  text: string | null;
  cached: boolean;
  /** 数字/单位/缩写可能缺失处的数量，仅作提示。 */
  missing: number;
  reason: string | null;
}

export interface InterestPushView {
  config: {
    checkMinutes: number;
    pushTimes: string[];
    dailyCap: number;
    quiet: string[];
    pushDays: number[];
    maxRounds: number;
    pausedUntil: number;
    keywords: string[];
    journals: Array<{ label: string; issn: string; tier: string; tierBasis: string; group: string }>;
    glossary: string[];
    arxivCats: string[];
    windowDays: number;
    rowsPerJournal: number;
    mailto: string;
    downloadDir: string;
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
  active: NewsItem | null;
  translation: TranslationState | null;
  /** 最近一次检查的错误原因，null 表示正常。 */
  lastError: string | null;
}
