/**
 * 相关性过滤：Hugging Face 日榜是整条 AI 领域的榜单，只留与研究领域有关的条目。
 *
 * 判定顺序：命中任一关键词短语 → 收；命中两个以上**领域词** → 收。
 * 不再用关键词里的泛词做二次判定（edge、computing、learning 这类会把「目标导航」
 * 一类的通用 AI 论文也放进来，实测放过一篇）。
 */
const STOP = new Set([
  'with', 'from', 'using', 'based', 'under', 'into', 'that', 'this', 'these', 'those',
  'study', 'data', 'model', 'models', 'learning', 'deep', 'method', 'methods', 'approach',
  'approaches', 'analysis', 'research', 'paper', 'their', 'and', 'the', 'for', 'are', 'its',
]);

/** 领域兜底词：旋转机械、故障诊断、健康管理与边缘智能。 */
const DOMAIN_TOKENS = [
  'fault diagnos', 'fault detect', 'bearing', 'gearbox', 'rotating machin', 'motor',
  'prognos', 'phm', 'condition monitor', 'remaining useful life', 'vibration',
  'architecture search', 'distillation', 'quantization', 'edge comput', 'industrial internet',
];

/** 关键词 → 词根集合（短语本身也算一个）；面板与调试用。 */
export function relevanceTokens(keywords: string[]): string[] {
  const out = new Set<string>();
  for (const keyword of keywords) {
    const phrase = keyword.trim().toLowerCase();
    if (phrase !== '') out.add(phrase);
    for (const word of phrase.split(/[^a-z0-9]+/)) {
      if (word.length >= 4 && !STOP.has(word)) out.add(word);
    }
  }
  return [...out];
}

/** 一段文本（标题 + 摘要）是否与关键词相关。 */
export function relevant(text: string, keywords: string[]): boolean {
  const hay = String(text ?? '').toLowerCase();
  if (hay.trim() === '') return false;
  for (const keyword of keywords) {
    const phrase = keyword.trim().toLowerCase();
    if (phrase !== '' && hay.includes(phrase)) return true;
  }
  let domain = 0;
  for (const token of DOMAIN_TOKENS) {
    if (hay.includes(token)) domain += 1;
    if (domain >= 2) return true;
  }
  return false;
}
