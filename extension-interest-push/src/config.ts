/**
 * `worlds.interest-push` 段的形状与默认值。默认禁用（契约要求 World 自己声明的 `enabled` 为 false）：
 * 部署在「World 总览」里启用，或在 bot 的 `declares` 里写上 `interest-push`。
 *
 * 这个段**不声明给框架的配置页**（那边是 400ms 防抖即时保存）：World 自己画「配置」页签，
 * 表单填完点保存、一次性 `ctx.persist()` 写回，见 world.ts 的 saveSettings。
 */
export interface JournalEntry {
  /** 刊名（原样显示）。 */
  label: string;
  /** 印刷版 ISSN，Crossref 查询用。 */
  issn: string;
  /** 分区标签，例如「中科院一区 · JCR Q1」。 */
  tier: string;
  /** 分区依据（哪一年的表），提醒读者标签会过时。 */
  tierBasis: string;
}

export interface InterestPushConfigSection {
  enabled: boolean;
  /** 检查间隔（分钟）。一次检查会逐个问期刊的 Crossref 接口，间隔不宜太短。 */
  checkMinutes: number;
  /** 允许打扰的时刻（本地时间 `HH:MM`）。每个时刻最多打扰一次。 */
  pushTimes: string[];
  /** 每天最多推送几条。 */
  dailyCap: number;
  /** 静默时段 `[起, 止]`（`HH:MM`）：期间只检查不打扰。 */
  quiet: string[];
  /** 允许打扰的星期（ISO 编号，1 = 周一）。 */
  pushDays: number[];
  /** 气泡对话轮次上限。 */
  maxRounds: number;
  /** 暂停到某个时刻（epoch ms，0 表示不暂停）。 */
  pausedUntil: number;
  /** 研究领域关键词，用于 Crossref 与 arXiv 查询。 */
  keywords: string[];
  /** 期刊集合。 */
  journals: JournalEntry[];
  /** 翻译术语表，每行 `英文 | 中文`。 */
  glossary: string[];
  /** arXiv 分类，例如 eess.SP。 */
  arxivCats: string[];
  /** 只看最近多少天内上线的条目。 */
  windowDays: number;
  /** 每次每刊取多少条。 */
  rowsPerJournal: number;
  /**
   * 期刊的「等摘要」延迟天数：跳过最近 N 天发表的文章。
   * IEEE/Elsevier 这些刊在 Crossref 里从不给摘要，摘要要等 OpenAlex 一类源去抓（几天到几周），
   * 因此晚几天再收，收到的就大多带摘要。arXiv 与每日论文榜不受影响（它们本就带摘要）。
   */
  journalDelayDays: number;
  /** CrossRef 的 polite pool 邮箱。 */
  mailto: string;
  /** 下载目录；空表示 `<dataDir>/news/papers`。 */
  downloadDir: string;
  /**
   * 只推送有摘要的条目。源没给摘要时补不到就等下一轮（摘要往往几天后才出现），
   * 免得把「只有标题」的条目推给使用者——那等于无效推送。
   */
  requireAbstract: boolean;
  /** 没有可推条目时，手动推送允许推缺摘要的条目（默认关闭，自动推送始终要求摘要）。 */
  allowNoAbstractPush: boolean;
}

export const INTEREST_PUSH_DEFAULTS: InterestPushConfigSection = {
  enabled: false,
  checkMinutes: 120,
  pushTimes: ['10:30', '13:00', '19:30'],
  dailyCap: 2,
  quiet: ['22:30', '08:30'],
  pushDays: [1, 2, 3, 4, 5, 6, 7],
  maxRounds: 3,
  pausedUntil: 0,
  keywords: [
    'bearing fault diagnosis',
    'rotating machinery',
    'prognostics and health management',
    'industrial fault diagnosis',
    'neural architecture search',
    'edge computing',
  ],
  journals: [],          // 默认集合在 journals.ts，装配时注入
  glossary: [],          // 默认术语表在 glossary.ts，装配时注入
  arxivCats: ['eess.SP', 'eess.AS'],
  windowDays: 30,
  rowsPerJournal: 50,
  journalDelayDays: 14,
  mailto: 'research@example.com',
  downloadDir: '',
  requireAbstract: true,
  allowNoAbstractPush: false,
};
