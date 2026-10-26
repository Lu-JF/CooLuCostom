import type { WorldDefinition } from 'cortico/world.ts';
import { QUOTA_DEFAULTS, type QuotaConfigSection } from './config.ts';
import { quotaText } from './i18n.ts';
import { QUOTA_HERMES_PARAMETERS, QUOTA_STATUS_PARAMETERS, QUOTA_TOOL_TAGS } from './tool-spec.ts';
import { QuotaWorld } from './world.ts';

export const QUOTA: WorldDefinition<QuotaConfigSection> = {
  id: 'quota',
  label: '用量额度',
  defaults: () => ({ ...QUOTA_DEFAULTS }),
  describe: {
    tools: [
      {
        name: 'quota_status',
        description: quotaText('en').tools.statusDesc,
        parameters: QUOTA_STATUS_PARAMETERS,
        tags: [...QUOTA_TOOL_TAGS],
        summary: { zh: '列出各端点与账号的额度、剩余与重置时间', en: 'Quota, remaining and reset time per endpoint and account' },
      },
      {
        name: 'quota_hermes',
        description: quotaText('en').tools.hermesDesc,
        parameters: QUOTA_HERMES_PARAMETERS,
        tags: [...QUOTA_TOOL_TAGS],
        summary: { zh: '按天数汇总 Hermes 的会话用量', en: 'Hermes session usage totalled over N days' },
      },
    ],
    events: [
      {
        type: 'quota.window',
        description: { zh: '额度将尽或已重置时提醒', en: 'A quota is nearly used up or just reset' },
      },
    ],
  },
  // 构造不做任何 IO：装配层会为未启用的 World 也建一个实例。
  create: (ctx) => new QuotaWorld({
    cfg: ctx.cfg,
    timezone: ctx.timezone,
    dataDir: ctx.dataDir,
    // bot 目录：桌宠的 providers/（每个端点一份 .env）与 config.json 在它旁边/里面。
    botDir: ctx.botDir,
    // 手动加的账号才用得到秘密存储：写进部署 .env，读回同一个变量名。
    secrets: {
      read: (name) => ctx.secret(name),
      write: (name, value) => ctx.storeSecret(name, value),
    },
    // 面板「提醒」卡的保存走这条：一次写回自己的配置段。
    persist: (patch) => ctx.persist(patch),
  }),
};
