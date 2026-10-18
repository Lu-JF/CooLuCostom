import type { WorldDefinition } from 'cortico/world.ts';
import { QUOTA_DEFAULTS, type QuotaConfigSection } from './config.ts';
import { QuotaWorld } from './world.ts';

export const QUOTA: WorldDefinition<QuotaConfigSection> = {
  id: 'quota',
  label: '用量额度',
  defaults: () => ({ ...QUOTA_DEFAULTS }),
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
