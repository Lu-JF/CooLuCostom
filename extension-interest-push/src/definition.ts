import type { WorldDefinition } from 'cortico/world.ts';
import { INTEREST_PUSH_DEFAULTS, type InterestPushConfigSection } from './config.ts';
import { DEFAULT_GLOSSARY } from './glossary.ts';
import { DEFAULT_JOURNALS } from './journals.ts';
import { PAPER_READ_DESCRIPTION, PAPER_READ_PARAMETERS, PAPER_READ_TAGS } from './paper-tool.ts';
import { InterestPushWorld } from './world.ts';

export const INTEREST_PUSH: WorldDefinition<InterestPushConfigSection> = {
  id: 'interest-push',
  label: '论文推送',
  defaults: () => ({
    ...INTEREST_PUSH_DEFAULTS,
    journals: DEFAULT_JOURNALS.map((j) => ({ ...j })),
    glossary: DEFAULT_GLOSSARY.map(([en, zh]) => `${en} | ${zh}`),
  }),
  describe: {
    tools: [
      {
        name: 'paper_read',
        description: PAPER_READ_DESCRIPTION,
        parameters: PAPER_READ_PARAMETERS,
        tags: [...PAPER_READ_TAGS],
        summary: { zh: '按编号读出推送过的论文题录与摘要', en: 'Read a pushed paper by its id' },
      },
    ],
    events: [
      {
        type: 'news.item',
        description: { zh: '推送一条论文：只带编号与处理要求', en: 'A paper push: id and instruction only' },
        trigger: 'flush',
      },
    ],
  },
  // 构造不做任何 IO：装配层会为未启用的 World 也建一个实例。
  create: (ctx) => new InterestPushWorld({
    cfg: ctx.cfg,
    timezone: ctx.timezone,
    dataDir: ctx.dataDir,
    botDir: ctx.botDir,
    persist: (patch) => ctx.persist(patch),
    secret: (name) => ctx.secret(name),
    storeSecret: (name, value) => ctx.storeSecret(name, value),
  }),
};
