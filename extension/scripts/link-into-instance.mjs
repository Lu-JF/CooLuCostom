/**
 * 把一个扩展包以 link 方式放进一份 Cortico 部署的扩展目录，效果与在控制台「扩展」页填本机目录相同
 * （`pnpm add link:<dir>`），但不需要控制台已经跑起来——用在装完就先配好的场合。
 *
 *   node scripts/link-into-instance.mjs <数据目录 或 扩展目录>
 *
 * 传数据目录时，用的扩展目录是它下面的 `extensions/`（Coopanion 的 CORTICO_EXTENSIONS_DIR）。
 * 已经装过同名包时直接返回；链接方式是目录联接，Windows 上不需要管理员权限。
 */
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';

const PACKAGE_NAME = 'cortico-world-quota';
const here = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(here, '..');

const arg = process.argv[2];
if (!arg) {
  console.error('用法: node scripts/link-into-instance.mjs <数据目录 或 扩展目录>');
  process.exit(2);
}

const target = resolve(arg);
const extensionsDir = basename(target) === 'extensions' ? target : join(target, 'extensions');
mkdirSync(extensionsDir, { recursive: true });

const manifest = join(extensionsDir, 'package.json');
const pkg = existsSync(manifest)
  ? JSON.parse(readFileSync(manifest, 'utf8'))
  : { name: 'cortico-extensions', private: true, dependencies: {} };
pkg.private = true;
pkg.dependencies = { ...(pkg.dependencies ?? {}), [PACKAGE_NAME]: `link:${packageDir.replace(/\\/g, '/')}` };
writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`);

const linkPath = join(extensionsDir, 'node_modules', PACKAGE_NAME);
mkdirSync(join(extensionsDir, 'node_modules'), { recursive: true });
if (existsSync(linkPath)) {
  console.log(`已经装过：${linkPath}`);
} else {
  symlinkSync(packageDir, linkPath, 'junction');
  console.log(`已链接：${linkPath} → ${packageDir}`);
}

if (!existsSync(join(packageDir, 'dist', 'console.js'))) {
  console.log('提醒：面板产物 dist/console.js 不在，先在扩展目录里跑 `npm run build`。');
}
console.log(`下一步：重启 Coopanion，在「World 总览」启用 quota（或把 worlds.quota.enabled 写成 true）。`);
