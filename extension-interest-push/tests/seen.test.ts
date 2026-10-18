import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SeenStore } from '../src/seen.ts';

const dirs: string[] = [];

/** 建一个临时 dataDir，用完统一清理。 */
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'seen-test-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('SeenStore', () => {
  it('空目录：构造得到空表', () => {
    const store = new SeenStore(makeDir());
    expect(store.size()).toBe(0);
    expect(store.has('whatever')).toBe(false);
  });

  it('同一 DOI 第二次 add 返回 false', () => {
    const store = new SeenStore(makeDir());
    expect(store.add({ id: 'a1', doi: '10.1/x', foundAt: 1 })).toBe(true);
    expect(store.add({ id: 'a2', doi: '10.1/x', foundAt: 2 })).toBe(false);
    expect(store.size()).toBe(1);
  });

  it('无 DOI 时按 id 去重', () => {
    const store = new SeenStore(makeDir());
    expect(store.add({ id: 'id-1', doi: null, foundAt: 1 })).toBe(true);
    expect(store.add({ id: 'id-1', doi: null, foundAt: 2 })).toBe(false);
    expect(store.size()).toBe(1);
  });

  it('同时按 doi 与 id 两个键去重', () => {
    const store = new SeenStore(makeDir());
    expect(store.add({ id: 'id-9', doi: '10.9/y', foundAt: 1 })).toBe(true);
    // 换个 doi，但 id 撞上已见条目 → 仍算已见。
    expect(store.add({ id: 'id-9', doi: '10.9/z', foundAt: 2 })).toBe(false);
    expect(store.has('id-9')).toBe(true);
    expect(store.has('10.9/y')).toBe(true);
  });

  it('文件损坏：当作空表，size() 为 0', () => {
    const dir = makeDir();
    mkdirSync(join(dir, 'news'), { recursive: true });
    writeFileSync(join(dir, 'news', 'seen.json'), '{ this is not json', 'utf8');
    const store = new SeenStore(dir);
    expect(store.size()).toBe(0);
  });

  it('save() 后新实例能读回同样的条目', () => {
    const dir = makeDir();
    const store = new SeenStore(dir);
    store.add({ id: 'p1', doi: '10.2/a', foundAt: 111 });
    store.add({ id: 'p2', doi: null, foundAt: 222 });
    store.save();

    const reloaded = new SeenStore(dir);
    expect(reloaded.size()).toBe(2);
    expect(reloaded.has('10.2/a')).toBe(true);
    expect(reloaded.has('p2')).toBe(true);
    // 读回后继续按 DOI 去重。
    expect(reloaded.add({ id: 'p3', doi: '10.2/a', foundAt: 333 })).toBe(false);
  });
});
