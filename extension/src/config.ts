/**
 * `worlds.quota` 段的形状与默认值。默认禁用（契约要求 World 自己声明的 `enabled` 为 false）：
 * 部署在「World 总览」里启用，或在 bot 的 `declares` 里写上 `quota`。
 *
 * 这个段**不声明给框架的配置页**（那样是 400ms 防抖即时保存）：世界自己画「配置」页签，
 * 表单填完点保存一次性 `ctx.persist()` 写回，见 world.ts 的 saveSettings。
 */
export interface QuotaConfigSection {
  enabled: boolean;
  /** 当前供应商（见 sources.ts）：账号、额度、价目都按它取。 */
  source: string;
  /** Hermes 数据目录（`state.db` 所在）。空着取 `HERMES_HOME`，再空取 `%LOCALAPPDATA%\hermes`。 */
  hermesHome: string;
  /** 读 Command Code 密钥的 .env 文件。空着取 `<hermesHome>/.env`。 */
  envFile: string;
  /** 命令行登录文件。空着取 `~/.commandcode/auth.json`。 */
  authFile: string;
  /** 直接填的密钥，只在这一项非空时使用。写在这里是明文（config.json 在本机数据目录里）。 */
  commandcodeKey: string;
  /** Command Code API 根地址。改它是为了将来域名变了或走镜像。 */
  commandcodeBaseUrl: string;
  /** 检查间隔（分钟）；0 表示只在打开面板或问 bot 时取。在面板「提醒」卡里改（有保存按钮）。 */
  pollMinutes: number;
  /** 是否发提醒事件。在面板「提醒」卡里改。 */
  alerts: boolean;
  /** 提醒阈值（百分比）；0 表示关掉。任一窗口到达它就提醒一次。在面板「提醒」卡里改。 */
  alertPercent: number;
  /** 面板与工具默认看多少天的 Hermes 用量。在面板「提醒」卡里改。 */
  hermesDays: number;
  /** 月度额度的美元数；0 表示按套餐名自动取公开数字。 */
  monthlyAllowanceUsd: number;
}

export const QUOTA_DEFAULTS: QuotaConfigSection = {
  enabled: false,
  source: 'commandcode',
  hermesHome: '',
  envFile: '',
  authFile: '',
  commandcodeKey: '',
  commandcodeBaseUrl: 'https://api.commandcode.ai',
  pollMinutes: 10,
  alerts: true,
  alertPercent: 80,
  hermesDays: 7,
  monthlyAllowanceUsd: 0,
};

