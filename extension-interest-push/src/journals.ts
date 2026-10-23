/**
 * 默认期刊集合。ISSN 已逐条用 Crossref 核实，不得改动。
 */
import type { JournalEntry } from './config.ts';

/** 分区依据。分区表每年更新，这里固定写在标签上提醒读者。 */
const TIER_BASIS = '2025 中科院分区表 · JCR 2024';

/** 一区标签。 */
const TIER_YI = '中科院一区 · JCR Q1';
/** 二区标签。 */
const TIER_ER = '中科院二区 · JCR Q1';
/** 只有 JCR 记录的标签。 */
const TIER_JCR = 'JCR Q1';

export const DEFAULT_JOURNALS: JournalEntry[] = [
  { label: 'Mechanical Systems and Signal Processing', issn: '0888-3270', tier: TIER_YI, tierBasis: TIER_BASIS },
  { label: 'Reliability Engineering & System Safety', issn: '0951-8320', tier: TIER_YI, tierBasis: TIER_BASIS },
  { label: 'Structural Health Monitoring', issn: '1475-9217', tier: TIER_YI, tierBasis: TIER_BASIS },
  { label: 'Journal of Sound and Vibration', issn: '0022-460X', tier: TIER_JCR, tierBasis: TIER_BASIS },
  { label: 'Tribology International', issn: '0301-679X', tier: TIER_JCR, tierBasis: TIER_BASIS },
  { label: 'IEEE Transactions on Reliability', issn: '0018-9529', tier: TIER_JCR, tierBasis: TIER_BASIS },

  { label: 'IEEE Transactions on Industrial Electronics', issn: '0278-0046', tier: TIER_YI, tierBasis: TIER_BASIS },
  { label: 'IEEE Transactions on Industrial Informatics', issn: '1551-3203', tier: TIER_YI, tierBasis: TIER_BASIS },
  { label: 'IEEE Transactions on Instrumentation and Measurement', issn: '0018-9456', tier: TIER_ER, tierBasis: TIER_BASIS },
  { label: 'IEEE/ASME Transactions on Mechatronics', issn: '1083-4435', tier: TIER_JCR, tierBasis: TIER_BASIS },
  { label: 'IEEE Transactions on Energy Conversion', issn: '0885-8969', tier: TIER_JCR, tierBasis: TIER_BASIS },
  { label: 'IEEE Sensors Journal', issn: '1530-437X', tier: TIER_ER, tierBasis: TIER_BASIS },
  { label: 'ISA Transactions', issn: '0019-0578', tier: TIER_YI, tierBasis: TIER_BASIS },
  { label: 'Measurement', issn: '0263-2241', tier: TIER_JCR, tierBasis: TIER_BASIS },

  { label: 'Journal of Manufacturing Systems', issn: '0278-6125', tier: TIER_YI, tierBasis: TIER_BASIS },
  { label: 'Computers in Industry', issn: '0166-3615', tier: TIER_YI, tierBasis: TIER_BASIS },
  { label: 'Robotics and Computer-Integrated Manufacturing', issn: '0736-5845', tier: TIER_YI, tierBasis: TIER_BASIS },
  { label: 'Journal of Intelligent Manufacturing', issn: '0956-5515', tier: TIER_JCR, tierBasis: TIER_BASIS },
  { label: 'IEEE Internet of Things Journal', issn: '2327-4662', tier: TIER_YI, tierBasis: TIER_BASIS },

  { label: 'Information Fusion', issn: '1566-2535', tier: TIER_YI, tierBasis: TIER_BASIS },
  { label: 'Knowledge-Based Systems', issn: '0950-7051', tier: TIER_YI, tierBasis: TIER_BASIS },
  { label: 'Expert Systems with Applications', issn: '0957-4174', tier: TIER_YI, tierBasis: TIER_BASIS },
  { label: 'Advanced Engineering Informatics', issn: '1474-0346', tier: TIER_YI, tierBasis: TIER_BASIS },
  { label: 'Engineering Applications of Artificial Intelligence', issn: '0952-1976', tier: TIER_YI, tierBasis: TIER_BASIS },
  { label: 'Applied Soft Computing', issn: '1568-4946', tier: TIER_YI, tierBasis: TIER_BASIS },
  { label: 'Neural Networks', issn: '0893-6080', tier: TIER_YI, tierBasis: TIER_BASIS },
  { label: 'Pattern Recognition', issn: '0031-3203', tier: TIER_YI, tierBasis: TIER_BASIS },
  { label: 'Neurocomputing', issn: '0925-2312', tier: TIER_ER, tierBasis: TIER_BASIS },
];
