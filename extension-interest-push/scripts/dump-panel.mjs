/**
 * 打印「推送」页签此刻渲染出来的条目，用于核对面板与推送是否同一条。
 * 用法：node scripts/dump-panel.mjs <控制台端口>
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const port = process.argv[2] ?? '17788';
const DEBUG_PORT = 9334;
const PAGE = 'world%3Ainterest-push';

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
  throw new Error('没有找到 electron.exe');
}

const base = `http://127.0.0.1:${port}`;
const dir = mkdtempSync(join(tmpdir(), 'ip-dump-'));
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

const child = spawn(resolveElectron(process.argv[3]), [mainJs], {
  env: { ...process.env, CONSOLE_URL: `${base}/` },
  stdio: 'pipe',
});
child.stderr.on('data', (b) => process.stderr.write(b));

let browser = null;
try {
  for (let i = 0; i < 60 && !browser; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`).catch(() => null);
  }
  if (!browser) throw new Error('连不上 Electron 的调试端口');
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.waitForEvent('page'));
  await page.addInitScript(() => {
    try { localStorage.setItem('companion.mode', 'advanced'); } catch { /* 忽略 */ }
  });
  await page.goto(`${base}/#/provider/${PAGE}/detail`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ip-ov-title', { timeout: 30_000 });
  await page.waitForTimeout(1200);
  const seen = await page.evaluate(() => ({
    title: document.querySelector('.ip-ov-title')?.textContent?.trim() ?? '',
    score: document.querySelector('.ip-score')?.textContent?.trim() ?? '',
    doi: [...document.querySelectorAll('.ip-detail tr')].map((tr) => tr.textContent ?? '').find((x) => x.includes('DOI')) ?? '',
    kv: [...document.querySelectorAll('.ip-detail tr')].map((tr) => (tr.textContent ?? '').replace(/\s+/g, ' ').trim()),
  }));
  const state = await page.evaluate(async (pageId) => {
    const res = await fetch(`/api/webui/providers/${pageId}/panels/detail/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: [] }),
    });
    const body = await res.json();
    return { active: body?.view?.active ?? null };
  }, PAGE);
  console.log('页面标题：', seen.title);
  console.log('页面分数：', seen.score);
  console.log('详情行：', seen.doi);
  console.log('详情字段：', seen.kv.join(' | '));
  console.log('接口 active：', state.active?.id, '|', state.active?.title);

  // --watch：先推一条，等面板自己轮询过来，看页面标题是否跟着换。
  if (process.argv.includes('--watch')) {
    const pushed = await page.evaluate(async (pageId) => {
      const res = await fetch(`/api/webui/providers/${pageId}/panels/detail/pushNow`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: [] }),
      });
      const body = await res.json();
      return { id: body?.view?.active?.id ?? null, title: body?.view?.active?.title ?? '' };
    }, PAGE);
    console.log('推送后接口：', pushed.id, '|', pushed.title);
    const before = seen.title;
    const deadline = Date.now() + 30_000;
    let now = before;
    while (Date.now() < deadline) {
      await page.waitForTimeout(1000);
      now = await page.evaluate(() => document.querySelector('.ip-ov-title')?.textContent?.trim() ?? '');
      if (now !== before && now !== '') break;
    }
    console.log('轮询后页面标题：', now);
    console.log(now === pushed.title ? '✓ 面板跟上了这次推送' : '✗ 面板没有跟上');
  }
} finally {
  await browser?.close().catch(() => {});
  child.kill();
}
