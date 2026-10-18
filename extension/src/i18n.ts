/**
 * 这个 World 的全部文案，中英两版。两份都用 `quotaText(language)` 取：
 * 服务端（事件正文、工具回执、环境提示词变量、报错）与浏览器侧的面板。
 *
 * 文件是纯数据，不 import node 或框架运行时，所以浏览器 bundle 能直接打包它。
 * 界面语言不是 zh 时读 en：本扩展只做两种语言的文案，缺的不是错。
 */
import type { Language } from 'cortico/core/language.ts';

export interface QuotaWindowText {
  fiveHour: string;
  weekly: string;
  monthly: string;
}

export interface QuotaText {
  /** World 在控制台里的名字。 */
  label: string;
  lamps: {
    quota: string;
    hermes: string;
    /** 悬停说明 */
    quotaUsed: (percent: string) => string;
    quotaUnknown: string;
    quotaExhausted: string;
    /** 当前这家供应商还没接：说明它叫什么。 */
    sourceMissing: (label: string) => string;
    hermesOk: (calls: number, tokens: string) => string;
    hermesMissing: string;
  };
  badges: QuotaWindowText & { plan: string; accounts: string; unknown: string };
  panel: {
    quotaTitle: string;
    quotaDesc: string;
    hermesTitle: string;
    hermesDesc: string;
    settingsTitle: string;
    settingsDesc: string;
    groupBehavior: string;
    groupConnection: string;
    groupPaths: string;
    sourceLabel: string;
    baseUrlLabel: string;
    keyLabel: string;
    keyHint: string;
    keyKeep: string;
    allowanceLabel: string;
    allowanceHint: string;
    hermesHomeLabel: string;
    hermesHomeHint: string;
    envFileLabel: string;
    envFileHint: string;
    authFileLabel: string;
    authFileHint: string;
    pickPath: string;
    refresh: string;
    account: string;
    plan: string;
    period: string;
    currentPeriod: string;
    keySource: string;
    keySources: {
      config: string;
      env: string;
      authFile: string;
      envFile: string;
      none: string;
    };
    remaining: string;
    used: string;
    resetsIn: string;
    resetsAt: string;
    resets: string;
    exceeded: string;
    fetchedAt: string;
    windowHours: string;
    windowWeek: string;
    windowMonth: string;
    noMonthAllowance: string;
    hermesMissing: string;
    hermesHint: string;
    calls: string;
    input: string;
    output: string;
    cacheRead: string;
    cacheWrite: string;
    reasoning: string;
    model: string;
    tokens: string;
    cost: string;
    day: string;
    days: string;
    sessions: string;
    window: string;
    lastSeen: string;
    threshold: string;
    thresholdHint: string;
    alerts: string;
    alertsHint: string;
    pollMinutes: string;
    pollHint: string;
    save: string;
    saved: string;
    daysSegmented: string;
    loading: string;
    failed: string;
    empty: string;
    close: string;
    accountsTitle: string;
    accountsDesc: string;
    accountAdd: string;
    accountFormLabel: string;
    accountFormKey: string;
    accountFormHint: string;
    accountUse: string;
    accountRemove: string;
    accountActive: string;
    accountNative: string;
    accountManual: string;
    accountInUse: string;
    sourcesNotes: string;
    accountNone: string;
    accountAdded: string;
    accountLastChecked: string;
    accountBad: string;
    sourcesTitle: string;
    sourcesDesc: string;
    sourceUse: string;
    sourceCurrent: string;
    sourceNotImplemented: string;
    sourceNeeds: string;
    sourcePlanned: string;
    modelsTitle: string;
    modelsDesc: string;
    modelsEmpty: string;
    pricingTitle: string;
    pricingDesc: string;
    pricingEmpty: string;
    pricingFetch: string;
    pricingFetched: (when: string, via: string) => string;
    colModel: string;
    colContext: string;
    colInput: string;
    colOutput: string;
    colCacheRead: string;
    colCacheWrite: string;
    colQuota5h: string;
    colQuotaWeek: string;
    colQuotaMonth: string;
    colMonthlyCredits: string;
    freeLabel: string;
    hermesDaysLabel: string;
    hermesDaysHint: string;
    settingsHint: string;
  };
  events: {
    /** 预警事件的正文前缀，后面跟窗口读数。 */
    prefix: string;
    window: string;
    heading: string;
  };
  tools: {
    statusName: string;
    statusDesc: string;
    statusHeading: string;
    statusNoKey: string;
    hermesName: string;
    hermesDesc: string;
    hermesHeading: (days: number) => string;
    hermesUnavailable: string;
    hermesNone: string;
    totals: string;
    calls: string;
  };
}

const zh: QuotaText = {
  label: '用量额度',
  lamps: {
    quota: 'Command Code 额度',
    hermes: 'Hermes 用量',
    quotaUsed: (percent) => `最紧的一个窗口已用 ${percent}`,
    quotaUnknown: '取不到套餐额度',
    quotaExhausted: '有窗口已用完',
    sourceMissing: (label) => `${label} 还没接：只有 Command Code 有实现`,
    hermesOk: (calls, tokens) => `${calls} 次调用，${tokens} tokens`,
    hermesMissing: '读不到 Hermes 的用量库',
  },
  badges: {
    plan: '套餐',
    accounts: '账号',
    fiveHour: '5 小时',
    weekly: '本周',
    monthly: '本月余额',
    unknown: '未知',
  },
  panel: {
    quotaTitle: 'Command Code 套餐额度',
    quotaDesc: '套餐的月度额度与 5 小时、每周两个滚动窗口。数字直接取自 commandcode.ai。',
    hermesTitle: 'Hermes 用量',
    hermesDesc: '本机 Hermes 的调用次数与 token 统计（读她的 state.db，只读）。',
    settingsTitle: '配置',
    settingsDesc: '这里改完点「保存」才写入；框架那套「边打边存」不在这里，所以数字填一半不会存下去。',
    groupBehavior: '提醒',
    groupConnection: '连接',
    groupPaths: '路径',
    sourceLabel: '供应商',
    baseUrlLabel: 'API 地址',
    keyLabel: 'Command Code 密钥',
    keyHint: '直接填的密钥只在这里用；桌宠端点里的账号优先于它。',
    keyKeep: '留空＝保持已存的密钥',
    allowanceLabel: '月度额度（美元）',
    allowanceHint: '这个套餐每月的额度；0 表示按套餐名取公开数字。',
    hermesHomeLabel: 'Hermes 数据目录',
    hermesHomeHint: 'state.db 所在目录。留空取 HERMES_HOME，再空取 %LOCALAPPDATA%\\hermes。',
    envFileLabel: '读密钥的 .env 文件',
    envFileHint: '留空取 <Hermes 数据目录>/.env。',
    authFileLabel: '命令行登录文件',
    authFileHint: '留空取 ~/.commandcode/auth.json。',
    pickPath: '选择…',
    refresh: '刷新',
    account: '账号',
    plan: '套餐',
    period: '订阅周期',
    currentPeriod: '当前周期',
    keySource: '密钥来源',
    keySources: { config: '扩展配置', env: '环境变量', authFile: '命令行登录文件', envFile: '.env 文件', none: '没有找到' },
    remaining: '剩余',
    used: '已用',
    resetsIn: '重置倒计时',
    resetsAt: '重置时刻',
    resets: '重置',
    exceeded: '已用完',
    fetchedAt: '取数时刻',
    windowHours: '5 小时窗口',
    windowWeek: '本周窗口',
    windowMonth: '本月额度',
    noMonthAllowance: '这个套餐的月度额度没有公开数字，只报剩余',
    hermesMissing: '读不到 Hermes 的用量库',
    hermesHint: '在「提醒」卡里改 Hermes 数据目录；默认取 %LOCALAPPDATA%\\hermes。',
    calls: '调用次数',
    input: '输入',
    output: '输出',
    cacheRead: '缓存读',
    cacheWrite: '缓存写',
    reasoning: '推理',
    model: '模型',
    tokens: 'token',
    cost: '费用',
    day: '日期',
    days: '天',
    sessions: '会话数',
    window: '统计窗口',
    lastSeen: '最近一次调用',
    threshold: '提醒阈值',
    thresholdHint: '任一窗口用量到这个百分比时提醒一次，0 表示关掉提醒。',
    alerts: '提醒',
    alertsHint: '开着的窗口越过阈值时由 Coo 说一声。',
    pollMinutes: '检查间隔（分钟）',
    pollHint: '每次检查取一次套餐额度；0 表示只在打开面板时取。',
    save: '保存',
    saved: '已保存',
    daysSegmented: '统计范围',
    loading: '正在取数…',
    failed: '取数失败',
    empty: '没有数据',
    close: '关闭',
    accountsTitle: '账号',
    accountsDesc: '账号自动来自你桌宠里配的模型端点（指向 Command Code 的那些）：面板直接用同一把密钥问出登录邮箱与套餐，你在这里不用再贴 Key。想换号就在桌宠的「模型供应商」页换端点，回来点「使用」。',
    accountAdd: '手动添加账号',
    accountFormLabel: '名称',
    accountFormKey: 'API Key',
    accountFormHint: '给桌宠端点之外的号用（填那个号的 API Key）：会先真取一次数，Key 不对就不会存下来。',
    accountUse: '使用',
    accountRemove: '删除',
    accountActive: '使用中',
    accountNative: '桌宠端点',
    accountManual: '手动添加',
    accountInUse: '桌宠在用',
    sourcesNotes: '只有 Command Code 有实现；其余家要什么、将来从哪儿查，写在项目里的 docs/VENDORS.md。',
    accountNone: '还没有账号：现在按默认来源取数（扩展配置 / 环境变量 / .env / 命令行登录文件）。',
    accountAdded: '已添加',
    accountLastChecked: '最近检查',
    accountBad: '上次没取到',
    sourcesTitle: '供应商',
    sourcesDesc: '只有 Command Code 有实现；其余几项是留给后续接入的接缝，切过去只会看到它将来该走哪儿取数。',
    sourceUse: '切到这家',
    sourceCurrent: '当前',
    sourceNotImplemented: '未实现',
    sourceNeeds: '需要',
    sourcePlanned: '将来从这儿查',
    modelsTitle: '可用模型',
    modelsDesc: '这家此刻给出的模型清单（取自它的模型接口）。',
    modelsEmpty: '清单为空：先加账号，或点刷新。',
    pricingTitle: '计划价目与额度',
    pricingDesc: '从官网计划页抓：这个计划能用哪些模型、每个模型的单价，以及它给的请求额度。',
    pricingEmpty: '还没抓过价目：点「抓取」拿一次，同一份缓存 12 小时。',
    pricingFetch: '抓取',
    pricingFetched: (when, via) => `抓取于 ${when}（${via === 'cache' ? '缓存' : '在线'}）`,
    colModel: '模型',
    colContext: '上下文',
    colInput: '输入/M',
    colOutput: '输出/M',
    colCacheRead: '缓存读/M',
    colCacheWrite: '缓存写/M',
    colQuota5h: '5 小时额度',
    colQuotaWeek: '周额度',
    colQuotaMonth: '月额度',
    colMonthlyCredits: '月额度 $',
    freeLabel: '免费',
    hermesDaysLabel: 'Hermes 统计天数',
    hermesDaysHint: '面板与 quota_hermes 默认看的天数（1～90）。',
    settingsHint: '这里改完点「保存」一次写入；框架「配置」页那边是即时保存，所以阈值、间隔、天数只在这里改。',
  },
  events: {
    prefix: '[用量]',
    window: '窗口',
    heading: 'Command Code 套餐额度',
  },
  tools: {
    statusName: 'quota_status',
    statusDesc: 'Read the Command Code plan quota: monthly credit balance, the rolling 5-hour and weekly windows with their reset times, and the plan and billing period. Use it when asked how much quota is left.',
    statusHeading: 'Command Code 套餐额度',
    statusNoKey: '没找到 Command Code 的密钥，取不到额度',
    hermesName: 'quota_hermes',
    hermesDesc: 'Read local Hermes token usage: call counts and token totals per model and per day, over the last N days (default 7). Use it when asked what Hermes has been spending.',
    hermesHeading: (days) => `Hermes 用量（最近 ${days} 天）`,
    hermesUnavailable: '读不到 Hermes 的用量库',
    hermesNone: '这个窗口里没有记录',
    totals: '合计',
    calls: '次调用',
  },
};

const en: QuotaText = {
  label: 'Usage quota',
  lamps: {
    quota: 'Command Code quota',
    hermes: 'Hermes usage',
    quotaUsed: (percent) => `Busiest window at ${percent}`,
    quotaUnknown: 'Quota unavailable',
    quotaExhausted: 'A window is used up',
    sourceMissing: (label) => `${label} is not wired up yet; only Command Code is`,
    hermesOk: (calls, tokens) => `${calls} calls, ${tokens} tokens`,
    hermesMissing: "Hermes' usage database is unreadable",
  },
  badges: {
    plan: 'Plan',
    accounts: 'Accounts',
    fiveHour: '5 hours',
    weekly: 'This week',
    monthly: 'Monthly left',
    unknown: 'unknown',
  },
  panel: {
    quotaTitle: 'Command Code plan quota',
    quotaDesc: 'The plan monthly allowance and the rolling 5-hour and weekly windows, read from commandcode.ai.',
    hermesTitle: 'Hermes usage',
    hermesDesc: "This machine's Hermes call counts and token totals, read read-only from her state.db.",
    settingsTitle: 'Settings',
    settingsDesc: 'Nothing is written until you press Save, so half-typed numbers never get stored.',
    groupBehavior: 'Alerts',
    groupConnection: 'Connection',
    groupPaths: 'Paths',
    sourceLabel: 'Vendor',
    baseUrlLabel: 'API base URL',
    keyLabel: 'Command Code key',
    keyHint: 'A key typed here is a fallback; the account from the pet endpoint wins over it.',
    keyKeep: 'Leave empty to keep the stored key',
    allowanceLabel: 'Monthly allowance (USD)',
    allowanceHint: 'The plan monthly allowance; 0 means take the published number for the plan.',
    hermesHomeLabel: 'Hermes data directory',
    hermesHomeHint: 'Where state.db lives. Empty: HERMES_HOME, then %LOCALAPPDATA%\\hermes.',
    envFileLabel: 'Key .env file',
    envFileHint: 'Empty: <Hermes data directory>/.env.',
    authFileLabel: 'CLI login file',
    authFileHint: 'Empty: ~/.commandcode/auth.json.',
    pickPath: 'Choose…',
    refresh: 'Refresh',
    account: 'Account',
    plan: 'Plan',
    period: 'Billing period',
    currentPeriod: 'Current period',
    keySource: 'Key source',
    keySources: { config: 'extension config', env: 'environment', authFile: 'CLI login file', envFile: '.env file', none: 'not found' },
    remaining: 'Left',
    used: 'Used',
    resetsIn: 'Resets in',
    resetsAt: 'Resets at',
    resets: 'Resets',
    exceeded: 'Used up',
    fetchedAt: 'Read at',
    windowHours: '5-hour window',
    windowWeek: 'Weekly window',
    windowMonth: 'Monthly allowance',
    noMonthAllowance: 'This plan publishes no monthly allowance, only the balance',
    hermesMissing: "Hermes' usage database is unreadable",
    hermesHint: 'Set the Hermes home in the Alerts card; %LOCALAPPDATA%\\hermes by default.',
    calls: 'Calls',
    input: 'Input',
    output: 'Output',
    cacheRead: 'Cache read',
    cacheWrite: 'Cache write',
    reasoning: 'Reasoning',
    model: 'Model',
    tokens: 'tokens',
    cost: 'Cost',
    day: 'Day',
    days: 'days',
    sessions: 'Sessions',
    window: 'Range',
    lastSeen: 'Last call',
    threshold: 'Alert threshold',
    thresholdHint: 'Alert once per window when usage reaches this percentage. 0 turns alerts off.',
    alerts: 'Alerts',
    alertsHint: 'Let Coo say a line when a window passes the threshold.',
    pollMinutes: 'Check every (minutes)',
    pollHint: 'How often the quota is read. 0 reads it only while the panel is open.',
    save: 'Save',
    saved: 'Saved',
    daysSegmented: 'Range',
    loading: 'Loading…',
    failed: 'Could not read',
    empty: 'No data',
    close: 'Close',
    accountsTitle: 'Accounts',
    accountsDesc: 'Accounts come from the model endpoints you configured in the pet (the ones pointing at Command Code): the panel asks with the same key, so it can show the signed-in email and plan without you pasting anything. To use another account, switch the endpoint in the pet and press Use here.',
    accountAdd: 'Add account manually',
    accountFormLabel: 'Name',
    accountFormKey: 'API Key',
    accountFormHint: 'For accounts outside the pet endpoints (paste that account API key): the key is really used once first, so a wrong one is never stored.',
    accountUse: 'Use',
    accountRemove: 'Remove',
    accountActive: 'Active',
    accountNative: 'From the pet',
    accountManual: 'Added here',
    accountInUse: 'Pet is using it',
    sourcesNotes: 'Only Command Code is implemented; what each other vendor needs and where its numbers would come from is written down in docs/VENDORS.md in the project.',
    accountNone: 'No accounts yet: quota comes from the default sources (extension config / environment / .env / CLI login file).',
    accountAdded: 'Added',
    accountLastChecked: 'Last checked',
    accountBad: 'Last read failed',
    sourcesTitle: 'Vendors',
    sourcesDesc: 'Only Command Code is implemented; the rest are seams for later, and switching to one only shows where its numbers would come from.',
    sourceUse: 'Switch to this',
    sourceCurrent: 'Current',
    sourceNotImplemented: 'Not implemented',
    sourceNeeds: 'Needs',
    sourcePlanned: 'Planned source',
    modelsTitle: 'Available models',
    modelsDesc: "The model list this vendor serves right now, from its models endpoint.",
    modelsEmpty: 'Empty: add an account, or refresh.',
    pricingTitle: 'Plan pricing and allowances',
    pricingDesc: "Scraped from the vendor's plan page: which models the plan includes, their unit prices, and the request allowances it grants.",
    pricingEmpty: 'No pricing fetched yet: press Fetch; the same answer is cached for 12 hours.',
    pricingFetch: 'Fetch',
    pricingFetched: (when, via) => `Fetched ${when} (${via === 'cache' ? 'cache' : 'live'})`,
    colModel: 'Model',
    colContext: 'Context',
    colInput: 'Input/M',
    colOutput: 'Output/M',
    colCacheRead: 'Cache read/M',
    colCacheWrite: 'Cache write/M',
    colQuota5h: '5-hour quota',
    colQuotaWeek: 'Weekly quota',
    colQuotaMonth: 'Monthly quota',
    colMonthlyCredits: 'Monthly $',
    freeLabel: 'free',
    hermesDaysLabel: 'Hermes days',
    hermesDaysHint: 'Default range for the panel and for quota_hermes (1-90).',
    settingsHint: 'Press Save here to write all of it at once; the framework Config tab saves as you type, so threshold, interval and days are edited only here.',
  },
  events: {
    prefix: '[usage]',
    window: 'window',
    heading: 'Command Code plan quota',
  },
  tools: {
    statusName: 'quota_status',
    statusDesc: 'Read the Command Code plan quota: monthly credit balance, the rolling 5-hour and weekly windows with their reset times, and the plan and billing period. Use it when asked how much quota is left.',
    statusHeading: 'Command Code plan quota',
    statusNoKey: 'No Command Code key found, quota unavailable',
    hermesName: 'quota_hermes',
    hermesDesc: 'Read local Hermes token usage: call counts and token totals per model and per day, over the last N days (default 7). Use it when asked what Hermes has been spending.',
    hermesHeading: (days) => `Hermes usage (last ${days} days)`,
    hermesUnavailable: "Hermes' usage database is unreadable",
    hermesNone: 'Nothing recorded in that range',
    totals: 'Total',
    calls: 'calls',
  },
};

export function quotaText(language?: Language): QuotaText {
  return String(language ?? 'zh').toLowerCase().startsWith('zh') ? zh : en;
}