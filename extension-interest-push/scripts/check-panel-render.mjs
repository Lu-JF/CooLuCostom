/**
 * 在真控制台里看三个页签画出来没有：用 Coopanion 自带的那份 Electron 当浏览器，
 * 经 CDP 读 DOM。jsdom 里过得了的，在真宿主里未必。
 *
 *   node scripts/check-panel-render.mjs <控制台端口> [electron.exe 路径] [--shot <png 前缀>]
 *
 * 例：node scripts/check-panel-render.mjs 17788
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

/** 找一只 Electron 运行时当浏览器用（pnpm 的软链可能是绝对路径断链，真身在 .pnpm 里）。 */
function resolveElectron(given) {
  if (given && existsSync(given)) return given;
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const roots = [join(repo, 'upstream', 'coopanion', 'node_modules'), join(repo, 'upstream', 'cortico', 'node_modules')];
  for (const root of roots) {
    const direct = join(root, 'electron', 'dist', 'electron.exe');
    if (existsSync(direct)) return direct;
    const pnpm = join(root, '.pnpm');
    if (!existsSync(pnpm)) continue;
    for (const entry of readdirSync(pnpm)) {
      if (!entry.startsWith('electron@')) continue;
      const hit = join(pnpm, entry, 'node_modules', 'electron', 'dist', 'electron.exe');
      if (existsSync(hit)) return hit;
    }
  }
  console.error('没找到 electron.exe；用法: node scripts/check-panel-render.mjs <端口> [electron.exe 路径]');
  process.exit(2);
}

const port = process.argv[2] ?? '17788';
const electronPath = resolveElectron(process.argv[3]);
const DEBUG_PORT = '9225';
const PAGE = 'world%3Ainterest-push';
const base = `http://127.0.0.1:${port}`;

const dir = mkdtempSync(join(tmpdir(), 'ip-render-'));
const mainJs = join(dir, 'main.cjs');
writeFileSync(
  mainJs,
  `const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('remote-debugging-port', ${JSON.stringify(DEBUG_PORT)});
app.commandLine.appendSwitch('remote-allow-origins', '*');
app.commandLine.appendSwitch('disable-http-cache');
app.setPath('userData', ${JSON.stringify(join(dir, 'userdata'))});
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1400, height: 1000, show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  win.loadURL(process.env.CONSOLE_URL);
});
`,
);

const child = spawn(electronPath, [mainJs], { env: { ...process.env, CONSOLE_URL: `${base}/` }, stdio: 'ignore' });

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

let browser = null;
try {
  for (let i = 0; i < 60 && !browser; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`).catch(() => null);
  }
  if (!browser) throw new Error('连不上 Electron 的调试端口');

  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.waitForEvent('page'));
  const errors = [];
  const failedUrls = [];
  const bundleHits = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('response', (res) => {
    if (res.status() >= 400) failedUrls.push(`${res.status()} ${res.url()}`);
    if (res.url().includes('cortico-world-interest-push')) bundleHits.push(`${res.status()} ${res.url()}`);
  });
  await page.addInitScript(() => {
    try { localStorage.setItem('companion.mode', 'advanced'); } catch { /* 无痕模式写不进就按普通模式渲染 */ }
  });

  const clickText = (want) =>
    page.evaluate((text) => {
      const tags = [...document.querySelectorAll('a, button, [role="tab"], .tab, .navitem, li')];
      const hit = tags.find((el) => (el.textContent ?? '').trim() === text);
      if (!hit) return false;
      hit.click();
      return true;
    }, want);

  const openPanel = async (panel, selector) => {
    await page.goto(`${base}/#/provider/${PAGE}/${panel}`, { waitUntil: 'domcontentloaded' });
    return page.waitForSelector(selector, { timeout: 30_000, state: 'attached' }).then(() => true).catch(() => false);
  };

  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#kernel-root', { timeout: 30_000 });

  // ---- 列表页签
  const listOk = await openPanel('list', '.ip-list');
  check('列表页签挂上了', listOk);
  await page.waitForFunction(() => (document.querySelector('.ip-list')?.querySelectorAll('.ip-row').length ?? 0) > 0, null, { timeout: 40_000 }).catch(() => {});
  const list = await page.evaluate(() => {
    const box = document.querySelector('.ip-list');
    const rows = [...(box?.querySelectorAll('.ip-row') ?? [])];
    return {
      rows: rows.length,
      first: rows[0]?.textContent ?? '',
      titles: rows.slice(0, 3).map((r) => r.querySelector('.ip-title')?.textContent ?? ''),
      pills: (box?.textContent ?? ''),
      note: document.querySelector('.ip-note')?.textContent ?? '',
      refresh: [...document.querySelectorAll('button')].some((b) => (b.textContent ?? '').includes('立即检查一次')),
    };
  });
  check('列表里有条目', list.rows > 0, `${list.rows} 条`);
  check('条目带标题与期刊行', list.titles[0]?.length > 10 && list.first.includes('·'), list.titles[0]?.slice(0, 54) ?? '');
  check('有读/未读标记', /未读|已读/.test(list.pills), '');
  check('顶部有检查状态与按钮', list.note.includes('上次检查') && list.refresh, list.note.slice(0, 60));

  // ---- 详情页签
  const detailOk = await openPanel('detail', '.ip-detail');
  check('详情页签挂上了', detailOk);
  await page.waitForFunction(() => (document.querySelector('.ip-detail')?.querySelectorAll('tr').length ?? 0) >= 5, null, { timeout: 40_000 }).catch(() => {});
  const detail = await page.evaluate(() => ({
    text: document.body.textContent ?? '',
    kv: [...document.querySelectorAll('.ip-detail tr')].map((tr) => tr.textContent ?? ''),
    hasAbstract: (document.querySelector('.ip-abstract')?.textContent ?? '').length > 40,
    buttons: [...document.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim()),
    selector: document.querySelectorAll('select').length,
  }));
  check('详情给出期刊/上线/作者/团队/DOI/爬取源', ['期刊', '上线', '作者', '团队', 'DOI', '爬取源'].every((k) => detail.kv.some((row) => row.startsWith(k))), detail.kv.map((r) => r.slice(0, 6)).join(','));
  check('细节带条目标题（可切换）', detail.selector >= 1, `${detail.selector} 个下拉`);
  check('有原文摘要卡', detail.text.includes('原文摘要'), detail.hasAbstract ? '摘要非空' : '本条无摘要（源未给）');
  check('有打开原文与下载按钮', detail.buttons.includes('打开原文') && detail.buttons.includes('下载原文'), detail.buttons.slice(0, 6).join(' / '));
  check('有翻译按钮（不自动翻译）', detail.buttons.some((b) => b === '翻译摘要' || b === '重新翻译'), detail.buttons.filter((b) => b.includes('翻译')).join(' / '));

  // ---- 配置页签
  const settingsOk = await openPanel('settings', '.ip-jrows');
  check('配置页签挂上了', settingsOk);
  await page.waitForFunction(() => (document.querySelectorAll('.ip-jrow').length ?? 0) > 0, null, { timeout: 30_000 }).catch(() => {});
  const cfg = await page.evaluate(() => {
    const text = document.body.textContent ?? '';
    const inputs = [...document.querySelectorAll('input')];
    const areas = [...document.querySelectorAll('textarea')];
    const rows = [...document.querySelectorAll('.ip-jrow')];
    return {
      text,
      inputs: inputs.length,
      areas: areas.length,
      journalRows: rows.length,
      journalCols: rows[0]?.querySelectorAll('input').length ?? 0,
      save: [...document.querySelectorAll('button')].filter((b) => (b.textContent ?? '').trim() === '保存').length,
      pushNow: [...document.querySelectorAll('button')].some((b) => (b.textContent ?? '').includes('立刻推一条')),
      keywords: areas.some((a) => (a.value ?? '').includes('bearing fault diagnosis')),
      glossary: areas.some((a) => (a.value ?? '').includes('|')),
      tierShown: rows[0]?.querySelectorAll('input')[2]?.value ?? '',
      hasStepHint: /改完即生效/.test(text),
      pickPath: (text.match(/选择…/g) ?? []).length,
    };
  });
  check('三组卡片都在（节奏/数据源/期刊/翻译）', ['推送节奏', '数据源', '期刊集合', '翻译'].every((k) => cfg.text.includes(k)), '');
  check('节奏字段齐（间隔/时刻/上限/静默/星期/轮次/暂停到）', ['检查间隔', '推送时刻', '每天最多几条', '静默时段', '允许推送的星期', '对话轮次上限', '暂停到'].every((k) => cfg.text.includes(k)), `${cfg.inputs} 个输入框`);
  check('关键词与术语表是可编辑文本域', cfg.keywords && cfg.glossary, `${cfg.areas} 个文本域`);
  check('期刊集合逐行可编辑（刊名/ISSN/分区/依据/分组）', cfg.journalRows >= 20 && cfg.journalCols === 5, `${cfg.journalRows} 行 × ${cfg.journalCols} 格`);
  check('期刊行带分区标签', cfg.tierShown.includes('区') || cfg.tierShown.includes('Q1'), cfg.tierShown.slice(0, 24));
  check('有「保存」按钮（不边打边存）', cfg.save >= 1 && !cfg.hasStepHint, `${cfg.save} 个保存按钮`);
  check('有「立即检查一次」与「立刻推一条」', cfg.text.includes('立即检查一次') && cfg.pushNow, '');
  check('下载目录带本机选择器', cfg.pickPath >= 1, `${cfg.pickPath} 个`);

  const ownFailed = failedUrls.filter((u) => !/api\.github\.com|api\/framework\/release/.test(u));
  check('面板相关资源没有失败', ownFailed.length === 0, ownFailed.slice(0, 2).join(' / '));
  if (failedUrls.length) console.log(`    资源失败：${failedUrls.slice(0, 4).join(' | ')}`);
  console.log(`    面板产物请求：${bundleHits.join(' | ') || '（页面没请求扩展产物）'}`);
  if (errors.length) console.log(`    控制台报错：${errors.slice(0, 3).join(' | ')}`);

  const shotAt = process.argv.indexOf('--shot');
  if (shotAt !== -1 && process.argv[shotAt + 1]) {
    const prefix = process.argv[shotAt + 1];
    const shoot = async (panel, selector, file, height) => {
      await openPanel(panel, selector);
      await page.waitForFunction(() => !document.querySelector('.busy, .busy-overlay, [class*="busy"]'), null, { timeout: 20_000 }).catch(() => {});
      await page.waitForTimeout(1200);
      try {
        await page.setViewportSize({ width: 1400, height });
        await page.screenshot({ path: file, timeout: 25_000, animations: 'disabled' });
        console.log(`  截图（${panel}） → ${file}`);
      } catch (err) {
        console.log(`  截图（${panel}）没拍成：${err instanceof Error ? err.message : String(err)}`);
      }
    };
    await shoot('list', '.ip-list', `${prefix}-list.png`, 1100);
    await shoot('detail', '.ip-detail', `${prefix}-detail.png`, 1500);
    await shoot('settings', '.ip-jrows', `${prefix}-settings.png`, 2400);
  }
} catch (err) {
  check('面板渲染检查', false, err instanceof Error ? err.message : String(err));
} finally {
  child.kill();
}

console.log(failed === 0 ? '\n渲染检查通过' : `\n${failed} 项没过`);
process.exit(failed === 0 ? 0 : 1);
