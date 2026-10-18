/**
 * 把扩展装进官方安装版：构建面板产物 → 拷进 <应用目录>/data/extensions/node_modules/cortico-world-quota。
 *
 * 用法：node scripts/sync-extension-to-app.mjs [应用目录]      （默认 D:\Sorftware\Coopanion）
 *
 * 为什么是「拷贝」而不是软链：官方版是独立安装的产品，仓库可以随便搬/删；链接一旦指错，
 * 桌宠下次启动就没有这一页了。代价是改完扩展要再跑一次这个脚本（几秒）。
 * 框架的发现规则：读 <data>/extensions/package.json 的 dependencies，再去
 * <data>/extensions/node_modules/<包名> 找包（见 cortico 的 src/extensions.ts readInstalled）。
 */
import { cp, rm, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const app = process.argv[2] ?? 'D:\\Sorftware\\Coopanion';
const pkgName = 'cortico-world-quota';
const extRoot = join(app, 'data', 'extensions');
const pkgDir = join(extRoot, 'node_modules', pkgName);
const items = ['src', 'dist', 'scripts', 'tests', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.web.json', 'vitest.config.ts'];

try {
  await access(join(app, 'Coopanion.exe'));
} catch {
  console.error(`没找到官方版主程序：${join(app, 'Coopanion.exe')}`);
  console.error('用法：node scripts/sync-extension-to-app.mjs <应用目录>');
  process.exit(1);
}

// 1) 面板产物：控制台那页是 dist/console.js + dist/console.css
execFileSync(process.execPath, [join(repo, 'extension', 'scripts', 'build-console.mjs')], {
  cwd: join(repo, 'extension'),
  stdio: 'inherit',
});

// 2) 拷过去（不拷 node_modules：运行时只依赖框架给的那套 API）
await rm(pkgDir, { recursive: true, force: true });
await mkdir(pkgDir, { recursive: true });
for (const item of items) {
  await cp(join(repo, 'extension', item), join(pkgDir, item), { recursive: true }).catch(() => {});
}

// 3) 登记依赖（框架按这份 dependencies 找包名，再落到 node_modules/<包名>）
const pkgFile = join(extRoot, 'package.json');
const manifest = await readFile(pkgFile, 'utf8')
  .then((t) => JSON.parse(t))
  .catch(() => ({ name: 'cortico-extensions', private: true, dependencies: {} }));
manifest.name ??= 'cortico-extensions';
manifest.private ??= true;
manifest.dependencies = { ...(manifest.dependencies ?? {}), [pkgName]: `file:./node_modules/${pkgName}` };
await writeFile(pkgFile, `${JSON.stringify(manifest, null, 2)}\n`);

const version = JSON.parse(await readFile(join(repo, 'extension', 'package.json'), 'utf8')).version;
console.log(`\n已同步 ${pkgName}@${version} → ${pkgDir}`);
console.log('面板产物地址里带版本号，浏览器缓存是 immutable：改完扩展先升 extension/package.json 的 version，再跑本脚本，');
console.log('然后托盘点「重启」让桌宠重新加载扩展。');
