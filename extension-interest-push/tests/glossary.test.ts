import { describe, expect, it } from 'vitest';
import { DEFAULT_GLOSSARY, glossaryHash, parseGlossary } from '../src/glossary.ts';

describe('默认术语表', () => {
  it('条目数不少于 40', () => {
    expect(DEFAULT_GLOSSARY.length).toBeGreaterThanOrEqual(40);
  });

  it('包含必备词条 rolling element bearing|滚动轴承', () => {
    expect(DEFAULT_GLOSSARY).toContainEqual(['rolling element bearing', '滚动轴承']);
  });

  it('每一条都是非空的中英对照', () => {
    for (const [en, zh] of DEFAULT_GLOSSARY) {
      expect(en.trim()).not.toBe('');
      expect(zh.trim()).not.toBe('');
    }
  });
});

describe('parseGlossary', () => {
  it('解析半角竖线分隔的行', () => {
    expect(parseGlossary(['gearbox | 齿轮箱'])).toEqual([['gearbox', '齿轮箱']]);
  });

  it('接受全角竖线与多余空白', () => {
    expect(parseGlossary(['  unbalance｜  不平衡 '])).toEqual([['unbalance', '不平衡']]);
  });

  it('跳过空行、无分隔符行与缺一侧的行，且不抛错', () => {
    const lines = ['', '   ', 'no separator here', 'only-en |', '| 只有中文', 'cage | 保持架'];
    expect(parseGlossary(lines)).toEqual([['cage', '保持架']]);
  });

  it('输出条数等于输入里的有效行数', () => {
    const lines = ['a | 甲', '', 'b｜乙', 'bad', 'c | 丙'];
    expect(parseGlossary(lines)).toHaveLength(3);
  });
});

describe('glossaryHash', () => {
  it('返回 12 位十六进制', () => {
    expect(glossaryHash(['gearbox | 齿轮箱'])).toMatch(/^[0-9a-f]{12}$/);
  });

  it('相同内容（含空白与大小写差异）得到同一指纹', () => {
    const a = glossaryHash(['Gearbox | 齿轮箱', 'cage | 保持架']);
    const b = glossaryHash(['  gearbox  |  齿轮箱 ', 'cage｜保持架']);
    expect(a).toBe(b);
  });

  it('改动一行后指纹变化', () => {
    const before = glossaryHash(['gearbox | 齿轮箱', 'cage | 保持架']);
    const after = glossaryHash(['gearbox | 齿轮箱', 'cage | 轴承保持架']);
    expect(after).not.toBe(before);
  });
});
