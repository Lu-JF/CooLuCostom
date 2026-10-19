/** 面板与事件文案：中英两版（仓内其余扩展也只做这两版）。 */
import type { Language } from 'cortico/core/language.ts';

export interface InterestText {
  label: string;
  panel: { listTitle: string; listDesc: string; detailTitle: string; detailDesc: string; settingsTitle: string; settingsDesc: string };
  lamps: {
    check: string;
    checkNone: string;
    checkAt: (at: string) => string;
    checkFailed: (reason: string) => string;
    today: string;
    todayValue: (n: number, cap: number) => string;
    next: string;
    nextAt: (at: string) => string;
    nextPaused: string;
  };
  badges: { unread: string; journals: string; keywords: string; paused: string };
  list: {
    refresh: string;
    checking: string;
    empty: string;
    read: string;
    noAbstract: string;
    dismissed: string;
    error: (reason: string) => string;
    hint: string;
  };
  detail: {
    pick: string;
    paperTitle: string;
    refresh: string;
    next: string;
    authors: string;
    team: string;
    journal: string;
    issued: string;
    doi: string;
    source: string;
    abstract: string;
    translation: string;
    translate: string;
    retranslate: string;
    translating: string;
    cached: string;
    faithful: (n: number) => string;
    openOriginal: string;
    download: string;
    downloadOnlyOA: string;
    downloading: string;
    downloaded: (path: string) => string;
    failed: (reason: string) => string;
    none: string;
    dismissedNote: string;
  };
  settings: {
    save: string;
    saved: string;
    checkNow: string;
    pushNow: string;
    checking: string;
    groupPush: string;
    groupSources: string;
    groupTranslate: string;
    checkMinutes: string;
    pushTimes: string;
    dailyCap: string;
    quiet: string;
    pushDays: string;
    maxRounds: string;
    pausedUntil: string;
    resumNow: string;
    keywords: string;
    journals: string;
    arxivCats: string;
    windowDays: string;
    rowsPerJournal: string;
    mailto: string;
    downloadDir: string;
    glossary: string;
    addJournal: string;
    remove: string;
    groupTags: string;
    addTime: string;
    addKeyword: string;
    keywordPlaceholder: string;
    quietStart: string;
    quietEnd: string;
    saveSection: string;
    savedSection: (name: string) => string;
    savedSectionAdjusted: (name: string) => string;
    saveSectionFailed: (name: string) => string;
    journalNote: string;
    colLabel: string;
    colIssn: string;
    colTier: string;
    colGroup: string;
    colEnglish: string;
    colChinese: string;
    addTerm: string;
    journalLabel: string;
    journalIssn: string;
    journalTier: string;
    journalBasis: string;
    journalGroup: string;
    perLine: string;
    invalid: string;
    clearPause: string;
  };
  errors: { unknownMethod: (m: string) => string; noActive: string; noEndpoint: string };
}

const zh: InterestText = {
  label: '兴趣推送',
  panel: {
    listTitle: '列表',
    listDesc: '最近抓到的论文；点一条看详情。',
    detailTitle: '详情',
    detailDesc: '标题、作者、期刊、摘要、爬取源与译文。',
    settingsTitle: '配置',
    settingsDesc: '推送节奏、关键词、期刊集合与翻译术语表；填完点保存。',
  },
  lamps: {
    check: '上次检查',
    checkNone: '尚未检查',
    checkAt: (at) => at,
    checkFailed: (reason) => `失败：${reason}`,
    today: '今日推送',
    todayValue: (n, cap) => `${n}/${cap}`,
    next: '下次窗口',
    nextAt: (at) => at,
    nextPaused: '已暂停',
  },
  badges: { unread: '未读', journals: '期刊', keywords: '关键词', paused: '已暂停' },
  list: {
    refresh: '立即检查一次',
    checking: '正在检查…',
    empty: '还没有抓到条目。检查一次，或把关键词和期刊放宽些。',
    read: '已读',
    noAbstract: '无摘要',
    dismissed: '不再推送',
    error: (reason) => `上次检查出错：${reason}`,
    hint: '订阅的论文会以气泡对话介绍；详情在这里看。',
  },
  detail: {
    pick: '还没有条目。先去「配置」页签点一次检查。',
    paperTitle: '论文标题',
    refresh: '刷新',
    next: '换一篇',
    authors: '作者',
    team: '团队',
    journal: '期刊',
    issued: '上线',
    doi: 'DOI',
    source: '爬取源',
    abstract: '原文摘要',
    translation: '中文译文',
    translate: '翻译摘要',
    retranslate: '重新翻译',
    translating: '翻译中…',
    cached: '已用缓存译文',
    faithful: (n) => `译文可能遗漏 ${n} 处数字或缩写，建议对照原文`,
    openOriginal: '打开原文',
    download: '下载原文',
    downloadOnlyOA: '该刊不开放原文，可点「打开原文」到出版社页面',
    downloading: '下载中…',
    downloaded: (path) => `已保存到 ${path}`,
    failed: (reason) => `失败：${reason}`,
    none: '—',
    dismissedNote: '你标记过不再推送这一条，它只是留在列表里。',
  },
  settings: {
    save: '保存',
    saved: '已保存',
    checkNow: '立即检查一次',
    pushNow: '立刻推一条（试）',
    checking: '正在检查…',
    groupPush: '推送节奏',
    groupSources: '数据源',
    groupTranslate: '翻译',
    checkMinutes: '检查间隔（分钟）',
    pushTimes: '推送时刻',
    dailyCap: '每天最多几条',
    quiet: '静默时段',
    pushDays: '允许推送的星期（1=周一…7=周日）',
    maxRounds: '气泡对话轮次上限',
    pausedUntil: '暂停到（时间戳毫秒，0 为不暂停）',
    resumNow: '取消暂停',
    clearPause: '清空',
    keywords: '研究领域关键词',
    journals: '期刊集合',
    arxivCats: 'arXiv 分类',
    windowDays: '只看最近多少天',
    rowsPerJournal: '每刊每次取多少条',
    mailto: 'Crossref 邮箱（polite pool）',
    downloadDir: '下载目录（空 = 数据目录下 news/papers）',
    glossary: '翻译术语表（每行「英文 | 中文」）',
    addJournal: '增加一行',
    remove: '删除',
    groupTags: '点右侧「✕」删掉，用下面的菜单或输入框增加',
    addTime: '增加时刻',
    addKeyword: '增加关键词',
    keywordPlaceholder: '输入关键词后回车',
    quietStart: '静默起',
    quietEnd: '静默止',
    saveSection: '保存本组',
    savedSection: (name) => `${name}已保存`,
    savedSectionAdjusted: (name) => `${name}已保存，个别数值按合法范围调整`,
    saveSectionFailed: (name) => `${name}未生效，请重试`,
    journalNote: '分区标签参照 2025 中科院分区表与 JCR 2024（逐年变化，标签可直接改）；依据不在表格里编辑。',
    colLabel: '刊名',
    colIssn: 'ISSN',
    colTier: '分区标签',
    colGroup: '分组',
    colEnglish: '英文',
    colChinese: '中文',
    addTerm: '增加词条',
    journalLabel: '刊名',
    journalIssn: 'ISSN',
    journalTier: '分区标签',
    journalBasis: '分区依据',
    journalGroup: '分组',
    perLine: '每行一条',
    invalid: '有字段不合法，已按合法范围夹紧后再保存。',
  },
  errors: { unknownMethod: (m) => `未实现的方法 ${m}`, noActive: '没有选中的条目', noEndpoint: '找不到可用的模型端点' },
};

const en: InterestText = {
  label: 'Research Picks',
  panel: {
    listTitle: 'List',
    listDesc: 'Recently crawled papers; open one for details.',
    detailTitle: 'Detail',
    detailDesc: 'Title, authors, venue, abstract, crawl source and translation.',
    settingsTitle: 'Settings',
    settingsDesc: 'Cadence, keywords, journal set and translation glossary; press Save when done.',
  },
  lamps: {
    check: 'Last check',
    checkNone: 'never',
    checkAt: (at) => at,
    checkFailed: (reason) => `failed: ${reason}`,
    today: 'Pushed today',
    todayValue: (n, cap) => `${n}/${cap}`,
    next: 'Next window',
    nextAt: (at) => at,
    nextPaused: 'paused',
  },
  badges: { unread: 'unread', journals: 'journals', keywords: 'keywords', paused: 'paused' },
  list: {
    refresh: 'Check now',
    checking: 'Checking…',
    empty: 'Nothing crawled yet. Run a check, or widen the keywords and journals.',
    read: 'read',
    noAbstract: 'no abstract',
    dismissed: 'not pushed again',
    error: (reason) => `Last check failed: ${reason}`,
    hint: 'Subscribed papers are introduced in a bubble chat; details live here.',
  },
  detail: {
    pick: 'Nothing yet. Run a check on the Settings tab.',
    paperTitle: 'Title',
    refresh: 'Refresh',
    next: 'Next paper',
    authors: 'Authors',
    team: 'Team',
    journal: 'Venue',
    issued: 'Published',
    doi: 'DOI',
    source: 'Crawl source',
    abstract: 'Original abstract',
    translation: 'Chinese translation',
    translate: 'Translate',
    retranslate: 'Translate again',
    translating: 'Translating…',
    cached: 'from cache',
    faithful: (n) => `translation may miss ${n} numbers or acronyms; compare with the original`,
    openOriginal: 'Open original',
    download: 'Download',
    downloadOnlyOA: 'Not open access; use Open original instead',
    downloading: 'Downloading…',
    downloaded: (path) => `saved to ${path}`,
    failed: (reason) => `failed: ${reason}`,
    none: '—',
    dismissedNote: 'You marked this one as not interested; it stays in the list.',
  },
  settings: {
    save: 'Save',
    saved: 'Saved',
    checkNow: 'Check now',
    pushNow: 'Push one now (test)',
    checking: 'Checking…',
    groupPush: 'Cadence',
    groupSources: 'Sources',
    groupTranslate: 'Translation',
    checkMinutes: 'Check interval (minutes)',
    pushTimes: 'Push times',
    dailyCap: 'Max pushes per day',
    quiet: 'Quiet hours',
    pushDays: 'Allowed weekdays (1=Mon…7=Sun)',
    maxRounds: 'Max bubble rounds',
    pausedUntil: 'Paused until (epoch ms, 0 = off)',
    resumNow: 'Resume now',
    clearPause: 'Clear',
    keywords: 'Research keywords',
    journals: 'Journal set',
    arxivCats: 'arXiv categories',
    windowDays: 'Only last N days',
    rowsPerJournal: 'Rows per journal',
    mailto: 'Crossref mailto (polite pool)',
    downloadDir: 'Download dir (empty = <dataDir>/news/papers)',
    glossary: 'Translation glossary (one "en | zh" per line)',
    addJournal: 'Add row',
    remove: 'Remove',
    groupTags: 'Click ✕ to remove; add with the menu or box below',
    addTime: 'Add time',
    addKeyword: 'Add keyword',
    keywordPlaceholder: 'Type a keyword and press Enter',
    quietStart: 'Quiet from',
    quietEnd: 'Quiet to',
    saveSection: 'Save',
    savedSection: (name) => `${name} saved`,
    savedSectionAdjusted: (name) => `${name} saved with some values clamped`,
    saveSectionFailed: (name) => `${name} did not take effect, retry`,
    journalNote: 'Tier labels follow the 2025 CAS list and JCR 2024; edit the label directly. The basis is not edited here.',
    colLabel: 'Journal',
    colIssn: 'ISSN',
    colTier: 'Tier',
    colGroup: 'Group',
    colEnglish: 'English',
    colChinese: 'Chinese',
    addTerm: 'Add term',
    journalLabel: 'Journal',
    journalIssn: 'ISSN',
    journalTier: 'Tier',
    journalBasis: 'Tier basis',
    journalGroup: 'Group',
    perLine: 'one per line',
    invalid: 'Some fields were out of range and got clamped before saving.',
  },
  errors: { unknownMethod: (m) => `method ${m} is not implemented`, noActive: 'no active item', noEndpoint: 'no usable model endpoint' },
};

export function interestText(language: Language): InterestText {
  return language === 'en' ? en : zh;
}
