import type { WorldDefinition } from 'cortico/world.ts';
import { INTEREST_PUSH_DEFAULTS, type InterestPushConfigSection } from './config.ts';
import { DEFAULT_GLOSSARY } from './glossary.ts';
import { DEFAULT_JOURNALS } from './journals.ts';
import { InterestPushWorld } from './world.ts';

export const INTEREST_PUSH: WorldDefinition<InterestPushConfigSection> = {
  id: 'interest-push',
  label: '兴趣推送',
  defaults: () => ({
    ...INTEREST_PUSH_DEFAULTS,
    journals: DEFAULT_JOURNALS.map((j) => ({ ...j })),
    glossary: DEFAULT_GLOSSARY.map(([en, zh]) => `${en} | ${zh}`),
  }),
  // 构造不做任何 IO：装配层会为未启用的 World 也建一个实例。
  create: (ctx) => new InterestPushWorld({
    cfg: ctx.cfg,
    timezone: ctx.timezone,
    dataDir: ctx.dataDir,
    botDir: ctx.botDir,
    persist: (patch) => ctx.persist(patch),
    secret: (name) => ctx.secret(name),
  }),
};
