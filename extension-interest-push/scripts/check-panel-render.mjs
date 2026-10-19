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

  // ---- 详情页签（现在排第一）
  const detailOk = await openPanel('detail', '.ip-ov-title');
  check('推送页签排第一且挂上了', detailOk);
  await page.waitForFunction(() => (document.querySelector('.ip-detail')?.querySelectorAll('tr').length ?? 0) >= 5, null, { timeout: 40_000 }).catch(() => {});
  const detail = await page.evaluate(() => ({
    text: document.body.textContent ?? '',
    title: document.querySelector('.ip-ov-title')?.textContent ?? '',
    kv: [...document.querySelectorAll('.ip-detail tr')].map((tr) => tr.textContent ?? ''),
    abstract: document.querySelector('.ip-ov-abstract')?.textContent ?? '',
    kvFirstColWidth: document.querySelector('.ip-detail .kvtable td:first-child')?.getBoundingClientRect().width ?? 0,
    translateBelowAbstract: (() => {
      const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('翻译'));
      const abs = document.querySelector('.ip-ov-abstract');
      if (!btn || !abs) return false;
      return btn.getBoundingClientRect().top >= abs.getBoundingClientRect().bottom - 2;
    })(),
    kvTableWidth: document.querySelector('.ip-detail .kvtable')?.getBoundingClientRect().width ?? 0,
    buttons: [...document.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim()),
    selects: document.querySelectorAll('select').length,
    order: [...document.querySelectorAll('.sheet h3')].map((h) => (h.childNodes[0]?.textContent ?? '').trim()),
  }));
  check('详情给出期刊/上线/作者/团队/DOI/爬取源', ['期刊', '上线', '作者', '团队', 'DOI', '爬取源'].every((k) => detail.kv.some((row) => row.startsWith(k))), detail.kv.map((r) => r.slice(0, 4)).join(','));
  check('从上到下是论文速览、中文译文、详情卡', JSON.stringify(detail.order.slice(0, 3)) === JSON.stringify(['论文速览', '中文译文', '详情']), detail.order.slice(0, 3).join(' → '));
  check('速览里标题与摘要都有内容', detail.title.length > 10 && detail.abstract.length >= 10, `${detail.title.slice(0, 34)} … / ${detail.abstract.slice(0, 34)}`);
  check('详情卡键列不再占固定宽度', detail.kvTableWidth === 0 || detail.kvFirstColWidth / detail.kvTableWidth < 0.3, `键列 ${Math.round(detail.kvFirstColWidth)}px / 表宽 ${Math.round(detail.kvTableWidth)}px`);
  check('翻译按钮在速览卡里，且位于摘要下方', detail.translateBelowAbstract, detail.buttons.filter((b) => b.includes('翻译')).join('/'));
  check('顶部只留「换一篇」（刷新与它重复，已删）', detail.buttons.includes('换一篇') && !detail.buttons.includes('刷新'), detail.buttons.slice(0, 4).join(' / '));
  check('已取消下拉列表切换', detail.selects === 0, `${detail.selects} 个下拉`);
  check('详情卡里有打开原文与下载', detail.buttons.includes('打开原文') && detail.buttons.includes('下载原文'), '');
  check('详情卡里有「收进兴趣记录」', detail.buttons.includes('收进兴趣记录') || detail.buttons.includes('已在兴趣记录里'), '');

  // 真点一次「换一篇」：这是使用者报过的问题，必须在这里被抓住。
  const clickedNext = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === '换一篇');
    if (!btn) return false;
    btn.click();
    return true;
  });
  await page
    .waitForFunction((before) => (document.querySelector('.ip-ov-title')?.textContent ?? '') !== before, detail.title, { timeout: 20_000 })
    .catch(() => {});
  const switched = await page.evaluate(() => document.querySelector('.ip-ov-title')?.textContent ?? '');
  check(
    '点「换一篇」真的切到下一篇',
    clickedNext && switched !== detail.title && switched.length > 10,
    `${detail.title.slice(0, 24)} → ${switched.slice(0, 24)}`,
  );

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
      text: box?.textContent ?? '',
      note: document.querySelector('.ip-note')?.textContent ?? '',
      refresh: [...document.querySelectorAll('button')].some((b) => (b.textContent ?? '').includes('立即检查一次')),
    };
  });
  check('列表里有条目', list.rows > 0, `${list.rows} 条`);
  check('条目带标题与期刊行', list.titles[0]?.length > 10 && list.first.includes('·'), list.titles[0]?.slice(0, 50) ?? '');
  check('不再标「未读」，改为标「已读」', !list.text.includes('未读'), list.text.includes('已读') ? '有已读标记' : '当前都是未读（无标记）');
  check('顶部有检查状态与按钮', list.note.includes('上次检查') && list.refresh, list.note.slice(0, 60));

  // ---- 配置页签
  const settingsOk = await openPanel('settings', '.ip-gridhead');
  check('配置页签挂上了', settingsOk);
  await page.waitForFunction(() => (document.querySelectorAll('.ip-jrow').length ?? 0) > 0, null, { timeout: 30_000 }).catch(() => {});
  const cfg = await page.evaluate(() => {
    const text = document.body.textContent ?? '';
    const inputs = [...document.querySelectorAll('input')];
    const rows = [...document.querySelectorAll('.ip-gridbody .ip-jrow')];
    const journalRows = rows.filter((r) => r.querySelectorAll('input').length === 4);
    const termRows = rows.filter((r) => r.querySelectorAll('input').length === 2);
    const weekButtons = [...document.querySelectorAll('.ip-week .btn')];
    return {
      text,
      inputs: inputs.length,
      selects: document.querySelectorAll('select').length,
      journalRows: journalRows.length,
      journalCols: journalRows[0]?.querySelectorAll('input').length ?? 0,
      termRows: termRows.length,
      termCols: termRows[0]?.querySelectorAll('input').length ?? 0,
      tags: [...document.querySelectorAll('.ip-tag .ip-tagtext')].map((el) => el.textContent ?? ''),
      weekCount: weekButtons.length,
      weekOn: weekButtons.filter((b) => b.classList.contains('on')).length,
      saveButtons: [...document.querySelectorAll('button')].filter((b) => (b.textContent ?? '').trim() === '保存本组').length,
      pushNow: [...document.querySelectorAll('button')].some((b) => (b.textContent ?? '').includes('立刻推一条')),
      hasStepHint: /改完即生效/.test(text),
      pickPath: (text.match(/选择…/g) ?? []).length,
      journalHead: document.querySelector('.ip-gridhead')?.textContent ?? '',
      hasTierBasisColumn: /分区依据/.test(text),
      hasPerLineHint: /每行/.test(text),
      timeHasQuarter: [...document.querySelectorAll('select')].some((sel) => [...sel.options].some((o) => o.value === '15')),
      timeSelects: [...document.querySelectorAll('select')].length,
      weekInOwnRow: document.querySelector('.ip-week')?.parentElement?.classList.contains('ip-row-block') ?? false,
      gridClipped: [...document.querySelectorAll('.ip-gridbody')].some((el) => el.scrollHeight > el.clientHeight + 2 || getComputedStyle(el).overflow === 'auto'),
      bodyUnread: /未读/.test(document.body.textContent ?? ''),
    };
  });
  check('四组卡片都在（节奏/数据源/期刊/翻译）', ['推送节奏', '数据源', '期刊集合', '翻译'].every((k) => cfg.text.includes(k)), '');
  check('节奏字段齐（间隔/上限/轮次/时刻/静默/星期/暂停到）', ['检查间隔', '每天最多几条', '对话轮次上限', '推送时刻', '静默时段', '允许推送的星期', '暂停到'].every((k) => cfg.text.includes(k)), `${cfg.inputs} 个输入框`);
  check('推送时刻与关键词是标签', cfg.tags.length >= 8 && cfg.tags.includes('10:30') && cfg.tags.some((x) => x.includes('bearing')), cfg.tags.slice(0, 6).join(' / '));
  check('时刻是「时 + 分」两个下拉，分钟能选到 15（不用打字）', cfg.timeHasQuarter && cfg.timeSelects >= 4, `${cfg.timeSelects} 个下拉，含 15 分：${cfg.timeHasQuarter}`);
  check('星期是 1-7 的按钮、默认全亮、单独一行', cfg.weekCount === 7 && cfg.weekOn === 7 && cfg.weekInOwnRow, `${cfg.weekCount} 个按钮，亮 ${cfg.weekOn} 个，独占一行：${cfg.weekInOwnRow}`);
  check('期刊表有表头且第四列已取消', /刊名/.test(cfg.journalHead) && /ISSN/.test(cfg.journalHead) && /分区标签/.test(cfg.journalHead) && /分组/.test(cfg.journalHead) && !cfg.hasTierBasisColumn, cfg.journalHead.trim().slice(0, 40));
  check('期刊逐行可编辑（4 格）', cfg.journalRows >= 20 && cfg.journalCols === 4, `${cfg.journalRows} 行 × ${cfg.journalCols} 格`);
  check('术语表按行增删（英文 / 中文两格），且标签里没有「每行」说明', cfg.termRows >= 30 && cfg.termCols === 2 && !cfg.hasPerLineHint, `${cfg.termRows} 行 × ${cfg.termCols} 格`);
  check('有「只推送有摘要的条目」开关', cfg.text.includes('只推送有摘要的条目'), '');
  check('每组各有「保存本组」', cfg.saveButtons >= 4 && !cfg.hasStepHint, `${cfg.saveButtons} 个`);
  check('有「立即检查一次」与「立刻推一条」', cfg.text.includes('立即检查一次') && cfg.pushNow, '');
  check('两个编辑表格完全展开、没有滑动条', !cfg.gridClipped, cfg.gridClipped ? '仍有裁剪或滚动' : '');
  check('下载目录带本机选择器', cfg.pickPath >= 1, `${cfg.pickPath} 个`);
  check('页面里已无「未读」字样', !cfg.bodyUnread, cfg.bodyUnread ? '还看得到' : '');

  // 真点一次「保存本组」：验证写回与回读校验这条链路在真宿主里也通。
  const clickedSave = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === '保存本组');
    if (!btn) return false;
    btn.click();
    return true;
  });
  await page.waitForFunction(() => /已保存/.test(document.body.textContent ?? ''), null, { timeout: 20_000 }).catch(() => {});
  const saved = await page.evaluate(() => ({
    toast: /已保存/.test(document.body.textContent ?? ''),
    failed: /未生效/.test(document.body.textContent ?? ''),
  }));
  check('点「保存本组」会提示保存成功', clickedSave && saved.toast && !saved.failed, saved.failed ? '提示未生效' : '');

  // ---- 兴趣记录页签：先从「推送」页收一条进来，再看它有没有进列表
  await openPanel('detail', '.ip-ov-title');
  await page.waitForFunction(() => !document.querySelector('.busy, .busy-overlay, [class*="busy"]'), null, { timeout: 20_000 }).catch(() => {});
  const clickedKeep = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => ['收进兴趣记录', '已在兴趣记录里'].includes((b.textContent ?? '').trim()) && !b.disabled);
    if (!btn) return 'none';
    btn.click();
    return 'clicked';
  });
  await page.waitForTimeout(1500);
  const recordsOk = await openPanel('records', '.ip-rec, .placeholder');
  const records = await page.evaluate(() => ({
    rows: document.querySelectorAll('.ip-rec').length,
    text: document.body.textContent ?? '',
    titles: [...document.querySelectorAll('.ip-rec .ip-title')].map((el) => el.textContent ?? ''),
    hasRemove: [...document.querySelectorAll('.ip-rec button')].some((b) => (b.textContent ?? '').trim() === '删除'),
    card: [...document.querySelectorAll('.sheet h3')].map((h) => (h.childNodes[0]?.textContent ?? '').trim()).includes('兴趣记录'),
  }));
  check('兴趣记录页签挂上了', recordsOk && records.card, '');
  check('「收进兴趣记录」把条目真的存进了记录', clickedKeep !== 'none' && records.rows >= 1, `点了 ${clickedKeep}，列表 ${records.rows} 行：${records.titles[0]?.slice(0, 30) ?? ''}`);
  check('记录行能打开原文、能移除', records.hasRemove && (records.text.includes('打开原文')), '');

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
    await shoot('detail', '.ip-ov-title', `${prefix}-detail.png`, 1600);
    await shoot('list', '.ip-list', `${prefix}-list.png`, 1100);
    await shoot('settings', '.ip-gridhead', `${prefix}-settings.png`, 2400);
    await shoot('records', '.ip-rec, .placeholder', `${prefix}-records.png`, 900);
  }
} catch (err) {
  check('面板渲染检查', false, err instanceof Error ? err.message : String(err));
} finally {
  child.kill();
}

console.log(failed === 0 ? '\n渲染检查通过' : `\n${failed} 项没过`);
process.exit(failed === 0 ? 0 : 1);
