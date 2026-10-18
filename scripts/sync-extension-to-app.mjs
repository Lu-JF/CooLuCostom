/**
 * 把仓库里的扩展装进官方安装版：逐个包「构建面板产物 → 拷贝 → 登记依赖」。
 *
 * 用法：node scripts/sync-extension-to-app.mjs [应用目录]      （默认 D:\Sorftware\Coopanion）
 *
 * 为什么是「拷贝」而不是软链：官方版是独立安装的产品，仓库可以随便搬/删；链接一旦指错，
 * 桌宠下次启动就没有那一页了。代价是改完扩展要再跑一次这个脚本（几秒）。
 * 框架的发现规则：读 <data>/extensions/package.json 的 dependencies，再去
 * <data>/extensions/node_modules/<包名> 找包（见 cortico 的 src/extensions.ts readInstalled）。
 */
import { cp, rm, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库里要同步的包：目录名（相对仓库根）与包名（与 package.json 的 name 一致）。 */
const PACKAGES = [
  { dir: 'extension', name: 'cortico-world-quota' },
  { dir: 'extension-interest-push', name: 'cortico-world-interest-push' },
];

/** 拷贝白名单：运行时只要这些；node_modules 由框架侧提供，不拷。 */
const ITEMS = ['src', 'dist', 'scripts', 'tests', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.web.json', 'vitest.config.ts'];

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const app = process.argv[2] ?? 'D:\\Sorftware\\Coopanion';
const extRoot = join(app, 'data', 'extensions');

try {
  await access(join(app, 'Coopanion.exe'));
} catch {
  console.error(`没找到官方版主程序：${join(app, 'Coopanion.exe')}`);
  console.error('用法：node scripts/sync-extension-to-app.mjs <应用目录>');
  process.exit(1);
}

const manifestFile = join(extRoot, 'package.json');
const manifest = await readFile(manifestFile, 'utf8')
  .then((t) => JSON.parse(t))
  .catch(() => ({ name: 'cortico-extensions', private: true, dependencies: {} }));
manifest.name ??= 'cortico-extensions';
manifest.private ??= true;
manifest.dependencies ??= {};

let synced = 0;
for (const { dir, name } of PACKAGES) {
  const from = join(repo, dir);
  const pkgJson = join(from, 'package.json');
  try {
    await access(pkgJson);
  } catch {
    console.log(`跳过 ${dir}：没有 package.json`);
    continue;
  }
  const pkg = JSON.parse(await readFile(pkgJson, 'utf8'));
  if (pkg.name !== name) {
    console.log(`跳过 ${dir}：package.json 里的 name 是 ${pkg.name}，与预期 ${name} 不一致`);
    continue;
  }

  // 1) 面板产物：控制台那一页是 dist/console.js + dist/console.css
  execFileSync(process.execPath, [join(from, 'scripts', 'build-console.mjs')], { cwd: from, stdio: 'inherit' });

  // 2) 拷贝
  const to = join(extRoot, 'node_modules', name);
  await rm(to, { recursive: true, force: true });
  await mkdir(to, { recursive: true });
  for (const item of ITEMS) {
    await cp(join(from, item), join(to, item), { recursive: true }).catch(() => {});
  }

  // 3) 登记依赖
  manifest.dependencies[name] = `file:./node_modules/${name}`;
  console.log(`已同步 ${name}@${pkg.version} → ${to}`);
  synced += 1;
}

await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`\n共同步 ${synced} 个包。面板产物地址里带版本号、浏览器缓存是 immutable：改完面板先升该包 package.json 的 version，`);
console.log('再跑本脚本，然后托盘点「重启」让桌宠重新加载扩展。');
