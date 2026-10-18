/**
 * 术语表：默认中英对照、逐行解析与指纹计算。纯函数，不碰 IO。
 * 每行格式 `英文 | 中文`（分隔符也接受全角竖线）。配置页与装配层共用这里的逻辑。
 */

import { createHash } from 'node:crypto';

/** 默认术语表 `[英文, 中文]`。涵盖旋转机械、健康管理与智能算法三块常用词。 */
export const DEFAULT_GLOSSARY: Array<[string, string]> = [
  ['rolling element bearing', '滚动轴承'],
  ['inner race', '内圈'],
  ['outer race', '外圈'],
  ['rolling element', '滚动体'],
  ['cage', '保持架'],
  ['spalling', '剥落'],
  ['pitting', '点蚀'],
  ['gearbox', '齿轮箱'],
  ['planetary gearbox', '行星齿轮箱'],
  ['tooth root crack', '齿根裂纹'],
  ['misalignment', '不对中'],
  ['unbalance', '不平衡'],
  ['looseness', '松动'],
  ['stator winding', '定子绕组'],
  ['inter-turn short circuit', '匝间短路'],
  ['demagnetization', '退磁'],
  ['envelope spectrum', '包络谱'],
  ['spectral kurtosis', '谱峰度'],
  ['variational mode decomposition', '变分模态分解'],
  ['condition monitoring', '状态监测'],
  ['fault diagnosis', '故障诊断'],
  ['feature extraction', '特征提取'],
  ['prognostics and health management', '故障预测与健康管理'],
  ['remaining useful life', '剩余使用寿命'],
  ['health indicator', '健康指标'],
  ['degradation', '退化'],
  ['domain adaptation', '域自适应'],
  ['transfer learning', '迁移学习'],
  ['few-shot', '小样本'],
  ['neural architecture search', '神经架构搜索'],
  ['knowledge distillation', '知识蒸馏'],
  ['edge computing', '边缘计算'],
  ['predictive maintenance', '预测性维护'],
  ['compound fault', '复合故障'],
  ['run-to-failure', '全寿命试验'],
  ['signal-to-noise ratio', '信噪比'],
  ['interpretability', '可解释性'],
  ['attention mechanism', '注意力机制'],
  ['unseen working condition', '未见工况'],
  ['benchmark dataset', '基准数据集'],
  ['fault signature', '故障特征'],
  ['transferability', '可迁移性'],
  ['cross-domain', '跨域'],
  ['label noise', '标签噪声'],
  ['time-frequency analysis', '时频分析'],
  ['deep learning', '深度学习'],
];

/** 取行内第一个分隔符（半角竖线或全角竖线）的位置，找不到返回 -1。 */
function firstSeparator(line: string): number {
  const half = line.indexOf('|');
  const full = line.indexOf('｜');
  if (half < 0) return full;
  if (full < 0) return half;
  return Math.min(half, full);
}

/**
 * 逐行解析术语表。空行、无分隔符的行、任一侧为空的行一律跳过；两侧多余空白裁掉。
 */
export function parseGlossary(lines: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const raw of lines) {
    if (typeof raw !== 'string') continue;
    const line = raw.trim();
    if (line === '') continue;
    const at = firstSeparator(line);
    if (at < 0) continue;
    const en = line.slice(0, at).trim();
    const zh = line.slice(at + 1).trim();
    if (en === '' || zh === '') continue;
    out.push([en, zh]);
  }
  return out;
}

/** 规范化术语表：两侧去空白、英文转小写，再拼成稳定的多行文本。 */
function normalizeGlossary(lines: string[]): string {
  return parseGlossary(lines)
    .map(([en, zh]) => `${en.trim().toLowerCase()}|${zh.trim()}`)
    .join('\n');
}

/** 术语表指纹：sha1(规范化文本) 的前 12 位十六进制。用于判断配置是否变化。 */
export function glossaryHash(lines: string[]): string {
  return createHash('sha1').update(normalizeGlossary(lines), 'utf8').digest('hex').slice(0, 12);
}
