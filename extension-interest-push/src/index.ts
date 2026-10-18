/** 包入口：默认导出 `WorldDefinition`，加载器按 `cortico.kind === 'world'` 认它。 */
import { INTEREST_PUSH } from './definition.ts';

export default INTEREST_PUSH;
export { INTEREST_PUSH };
export type { InterestPushConfigSection, JournalEntry } from './config.ts';
export type { NewsItem, NewsRow, TranslationState, InterestPushView, NewsSource } from './view-types.ts';
