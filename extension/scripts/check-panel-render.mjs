/**
 * 在真控制台里看一眼这个面板画出来没有：起一个最小的 Electron 窗口打开控制台的这一页，
 * 经 CDP 读它的 DOM。用的是 Coopanion 自带的那份 Electron（不下载浏览器）。
 *
 *   node scripts/check-panel-render.mjs <控制台端口> [electron.exe 路径]
 *
 * 例：node scripts/check-panel-render.mjs 17788
 *     （不给路径时自己在仓库里找：node_modules/electron/dist，找不到再翻 .pnpm/electron@<版本>）
 *
 * 读的是页面文本与几个结构性节点（进度条、表格行、卡片标题），确认面板挂上了、拿到数据、
 * 没有把宿主原语用错——这些在 jsdom 的替身里过得了、在真宿主里未必。
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 找一只 Electron 运行时当浏览器用。给的路径可能失效：pnpm 的软链写的是**绝对路径**，
 * 仓库改过目录名之后 `node_modules/electron` 就成了断链，而真身在 `.pnpm/electron@<版本>/…/dist`。
 * 于是：给的路径不存在时，自己在仓库里找一遍。
 */
function resolveElectron(given) {
  if (given && existsSync(given)) return given;
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const roots = [
    join(repo, 'upstream', 'coopanion', 'node_modules'),
    join(repo, 'upstream', 'cortico', 'node_modules'),
  ];
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
  if (given) console.error(`给的 electron 路径不存在：${given}`);
  console.error('用法: node scripts/check-panel-render.mjs <端口> [electron.exe 路径]');
  process.exit(2);
}
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';

const port = process.argv[2] ?? '17788';
const electronPath = resolveElectron(process.argv[3]);
const DEBUG_PORT = '9223';
if (!electronPath) {
  console.error('用法: node scripts/check-panel-render.mjs <端口> <electron.exe>');
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), 'quota-render-'));
const userData = join(dir, 'userdata');
const mainJs = join(dir, 'main.cjs');
writeFileSync(
  mainJs,
  `const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('remote-debugging-port', ${JSON.stringify(DEBUG_PORT)});
app.commandLine.appendSwitch('remote-allow-origins', '*');
// 每次用自己的 userData 并关掉 HTTP 缓存：否则会命中上一次跑留下的旧面板产物，
// 看到的是「改了代码但页面还是老样子」的假象（同版本号的产物 URL 不变）。
app.commandLine.appendSwitch('disable-http-cache');
app.setPath('userData', ${JSON.stringify(userData)});
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1400, height: 1000, show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  win.loadURL(process.env.CONSOLE_URL);
});
`,
);

const url = `http://127.0.0.1:${port}/#/provider/world%3Aquota`;
const child = spawn(electronPath, [mainJs], { env: { ...process.env, CONSOLE_URL: url }, stdio: 'ignore' });

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

try {
  // 等 Electron 的调试端口起来
  let browser = null;
  for (let i = 0; i < 40 && !browser; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
    } catch {
      browser = null;
    }
  }
  if (!browser) throw new Error('连不上 Electron 的调试端口');

  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.waitForEvent('page'));
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));
  const failedUrls = [];
  page.on('response', (res) => {
    if (res.status() >= 400) failedUrls.push(`${res.status()} ${res.url()}`);
  });
  const bundleHits = [];
  page.on('response', (res) => {
    if (res.url().includes('cortico-world-quota')) bundleHits.push(`${res.status()} ${res.url()}`);
  });

  await page.addInitScript(() => {
    // Coopanion 的普通模式左栏只列桌宠那几页，贡献方的页（含这一页）只在高级模式里出现。
    try {
      localStorage.setItem('companion.mode', 'advanced');
    } catch {
      /* 无痕模式下写不进，那就按普通模式渲染，下面的检查会说明原因 */
    }
  });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  // 先让控制台自己起来（首屏落在「开始」），再进这一页；直接带 hash 首开会停在别处。
  await page.waitForSelector('#kernel-root', { timeout: 30_000 });
  // 进这一页有两种方式：新版靠侧栏点「用量额度」（高级模式的 WORLD 组），老版可以直接带 hash。
  const clickByText = async (want, tags = 'a, button, li, [role="tab"], .navitem, .tab') =>
    page.evaluate(
      ({ text, sel }) => {
        const hit = [...document.querySelectorAll(sel)].find((el) => (el.textContent ?? '').trim() === text);
        if (!hit) return false;
        hit.click();
        return true;
      },
      { text: want, sel: tags },
    );
  const clicked = await clickByText('用量额度');
  let mounted = false;
  if (clicked) {
    mounted = await page
      .waitForSelector('.quota-shell', { timeout: 20_000, state: 'attached' })
      .then(() => true)
      .catch(() => false);
  }
  if (!mounted) {
    // 点不到（老版本侧栏结构不同、或语言不是中文）：退回带 hash 直进
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.quota-shell', { timeout: 30_000, state: 'attached' });
  }
  await page.waitForFunction(
    () => (document.querySelector('.quota-shell')?.textContent ?? '').includes('GOAT'),
    null,
    { timeout: 30_000 },
  );

  const data = await page.evaluate(() => {
    const shell = document.querySelector('.quota-shell');
    const text = shell?.textContent ?? '';
    const rows = [...document.querySelectorAll('.quota-shell table')].map((t) => t.querySelectorAll('tbody tr').length);
    return {
      text,
      cards: shell?.querySelectorAll(':scope > .sheet').length ?? 0,
      titles: [...(shell?.querySelectorAll(':scope > .sheet > h3') ?? [])].map((h) => h.childNodes[0]?.textContent ?? ''),
      progress: shell?.querySelectorAll('.progress').length ?? 0,
      selects: shell?.querySelectorAll('select').length ?? 0,
      tableRows: rows,
      progressReads: [...document.querySelectorAll('.quota-shell .progress')].map((p) => p.textContent ?? ''),
      scripts: [...document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src') ?? '').filter((s) => s.includes('extensions')),
      cardsHtml: [...(shell?.querySelectorAll(':scope > .sheet') ?? [])].map((s) => `${s.className}::${(s.querySelector('h3')?.childNodes[0]?.textContent ?? '').slice(0, 24)}`),
      bodyHasAccounts: (document.body.textContent ?? '').includes('添加账号'),
      shells: document.querySelectorAll('.quota-shell').length,
    };
  });

  check('面板挂到了这一页', data.cards >= 3, `${data.cards} 张卡：${data.titles.join(' / ')}`);
  check('额度进度条画出来了', data.progress >= 2, `${data.progress} 条：${data.progressReads.slice(0, 2).join(' | ')}`);
  check('Hermes 表格有行', data.tableRows.some((n) => n > 0), `各表行数 ${JSON.stringify(data.tableRows)}`);
  check('读到了套餐与余额', data.text.includes('GOAT') && /\$\d/.test(data.text), data.text.match(/套餐[^·]{0,20}/)?.[0] ?? '');
  check(
    '价目表只留单价与「月额度 $」',
    data.text.includes('月额度 $') && !/5 小时额度/.test(data.text) && !/周额度/.test(data.text),
    data.text.match(/模型\s*上下文[^\n]{0,60}/)?.[0] ?? '',
  );
  check('账号 / 供应商 / 模型 / 价目四张新卡都在', ['账号', '供应商', '可用模型', '计划价目与额度'].every((s) => data.text.includes(s)), ['账号', '供应商', '可用模型', '计划价目与额度'].filter((s) => data.text.includes(s)).join(' / '));
  check(
    '价目表带单价与按模型的额度',
    /\$\d+(?:\.\d+)?/.test(data.text) && /(5 小时额度|周额度|月额度)/.test(data.text),
    data.text.match(/输入\/M[^\n]{0,40}/)?.[0] ?? '',
  );
  check('供应商下拉有选项', data.selects >= 1, `${data.selects} 个下拉`);

  // 「配置」页签：框架那张自动保存的配置页已经不声明了，这一页是我们自己画的，保存按钮得在。
  const switched = await page.evaluate(() => {
    const tags = [...document.querySelectorAll('a, button, [role="tab"], .tab, .navitem, li')];
    const hit = tags.find((el) => (el.textContent ?? '').trim() === '配置');
    if (!hit) return false;
    hit.click();
    return true;
  });
  if (!switched) {
    check('找到「配置」页签', false, '页面上没找到可点的「配置」');
  } else {
    await page.waitForFunction(() => (document.body.textContent ?? '').includes('选择…'), null, { timeout: 15_000 }).catch(() => {});
    const settings = await page.evaluate(() => ({
      text: document.body.textContent ?? '',
      saveButtons: [...document.querySelectorAll('button')].filter((b) => b.textContent === '保存').length,
    }));
    check(
      '「配置」页签是扩展自己画的（提醒阈值/路径都在）',
      settings.text.includes('提醒阈值') && settings.text.includes('Hermes 数据目录') && settings.text.includes('Command Code 密钥'),
      '',
    );
    check('「配置」页签有「保存」按钮', settings.saveButtons >= 1, `${settings.saveButtons} 个保存按钮`);
    check('路径项带本机选择器', (settings.text.match(/选择…/g) ?? []).length >= 3, `${(settings.text.match(/选择…/g) ?? []).length} 个选择器`);
    check('「配置」页签上不再有「即时保存」的味道', !/改完即生效/.test(settings.text), '');
  }
  // Coopanion 自己在页面上顺手查更新（GitHub releases 限流 403、/api/framework/release 500），
  // 跟这个面板无关，不算它的账。
  const ownFailed = failedUrls.filter((u) => !/api\.github\.com|api\/framework\/release/.test(u));
  check('面板相关资源没有失败', ownFailed.length === 0, ownFailed.slice(0, 2).join(' / '));
  if (failedUrls.length) console.log(`    资源失败：${failedUrls.slice(0, 5).join(' | ')}`);
  console.log(`    面板脚本：${data.scripts.join(' | ') || '（没看到扩展脚本标签）'}`);
  console.log(`    面板产物请求：${bundleHits.join(' | ') || '（页面没请求扩展产物）'}`);
  console.log(`    卡节点：${JSON.stringify(data.cardsHtml)}`);
  console.log(`    页面里有「添加账号」：${data.bodyHasAccounts}；.quota-shell 个数：${data.shells}`);
  const bundleUrl = (await fetch(`http://127.0.0.1:${port}/api/webui/manifest`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null))?.providers?.find?.((p) => p.id === 'world:quota')?.client?.js
    ?? '/assets/extensions/cortico-world-quota/0.1.5/console.js';
  const inPage = await page.evaluate(async (url) => {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      const text = await res.text();
      return { status: res.status, bytes: text.length, hasAccounts: text.includes('addAccount'), hasSources: text.includes('quota-form') };
    } catch (err) {
      return { error: String(err) };
    }
  }, bundleUrl);
  console.log(`    页面内取产物（${bundleUrl}）：${JSON.stringify(inPage)}`);

  const shotAt = process.argv.indexOf('--shot');
  if (shotAt !== -1 && process.argv[shotAt + 1]) {
    const target = process.argv[shotAt + 1];
    // 整页截图与滚动后再截都会被卡住（内容比视口高、卡片是 sticky 表头），所以：
    // 直接把视口开高，拍视口截图；失败就跳过，不因此判整体不通过。
    const shoot = async (path, width, height, label, scrollTo = 'top') => {
      try {
        await page.setViewportSize({ width, height });
        // 进页面会拉一次数（busy 遮罩）：等它落地再拍，别把「正在取数」拍进文档图。
        await page.waitForFunction(
          () => !document.querySelector('.busy, .busy-overlay, [class*="busy"]'),
          null,
          { timeout: 20_000 },
        ).catch(() => {});
        await page.waitForTimeout(1_000);
        await page.evaluate((where) => {
          if (where === 'price') {
            const sheets = [...document.querySelectorAll('.quota-shell > .sheet')];
            sheets[4]?.scrollIntoView({ block: 'start' });
          } else {
            document.querySelector('.quota-shell')?.scrollIntoView({ block: 'start' });
          }
        }, scrollTo);
        await page.screenshot({ path, timeout: 25_000, animations: 'disabled' });
        console.log(`  截图（${label}） → ${path}`);
        return true;
      } catch (err) {
        console.log(`  截图（${label}）没拍成：${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    };
    // 两个页签各拍一张：先把「用量额度」切回来，再切「配置」。
    const clickTab = async (title) => {
      await page.evaluate((want) => {
        const tags = [...document.querySelectorAll('a, button, [role="tab"], .tab, .navitem, li')];
        const hit = tags.find((el) => (el.textContent ?? '').trim() === want);
        if (hit) hit.click();
      }, title);
      await page.waitForTimeout(800);
    };
    await clickTab('用量额度');
    await shoot(target, 1400, 1200, '顶部');
    await shoot(target.replace(/\.png$/, '-tall.png'), 1400, 2600, '整面板（高视口）');
    await shoot(target.replace(/\.png$/, '-pricing.png'), 1400, 1200, '价目卡', 'price');
    await clickTab('配置');
    await shoot(target.replace(/\.png$/, '-settings.png'), 1400, 1600, '配置页签');
  }
} catch (err) {
  check('面板渲染检查', false, err instanceof Error ? err.message : String(err));
} finally {
  child.kill();
}

console.log(failed === 0 ? '\n渲染检查通过' : `\n${failed} 项没过`);
process.exit(failed === 0 ? 0 : 1);
