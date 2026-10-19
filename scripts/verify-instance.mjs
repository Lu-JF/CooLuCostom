/**
 * 对着一个跑着的 Coopanion/Cortico 控制台核对这个扩展：装没装上、页与产物在不在、World 挂没挂、
 * 面板数据面能不能取到真数。用法：
 *
 *   node scripts/verify-instance.mjs [端口] [--alerts]
 *
 * 端口是控制台的 `web.port`（core.log 里有 `127.0.0.1:<端口>`）。默认只做只读检查，外加一次
 * 「启用 World」（写 config.json 的 `worlds.quota.enabled`）。加 `--alerts` 会额外把提醒阈值临时
 * 调到 1%、触发一次提醒、在事件库里找出那条事件，然后把阈值改回原值——会动配置，只在想验证提醒链路时加。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const port = args.find((a) => /^\d+$/.test(a)) ?? '17788';
const withAlerts = args.includes('--alerts');
const base = `http://127.0.0.1:${port}`;
const money = (n) => (typeof n === 'number' ? `$${n.toFixed(2)}` : '—');
let failed = 0;
let total = 0;

function check(name, ok, detail = '') {
  total += 1;
  if (!ok) failed += 1;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

const get = (p) => call('GET', p);
const post = (p, body) => call('POST', p, body ?? {});

console.log(`控制台 ${base}\n`);

const status = await get('/api/status');
check('控制台在跑', status.status === 200, `HTTP ${status.status}`);

const extensions = await get('/api/extensions');
const installed = (extensions.json?.extensions ?? []).find((p) => String(p.name ?? '').includes('cortico-world-quota'));
check(
  '扩展已装并被加载',
  Boolean(installed) && installed.loaded !== false,
  installed ? `${installed.name}@${installed.version} loaded=${installed.loaded}` : '列表里没有它',
);

// v0.2.0 起框架把控制台清单从 /api/console/manifest 挪到 /api/webui/manifest，面板方法也从
// /api/console/providers/… 挪到 /api/webui/providers/…。两条都试，好让这份自检在老实例和新安装版上都能跑。
const webui = await get('/api/webui/manifest');
const manifest = webui.status === 200 ? webui : await get('/api/console/manifest');
const panelBase = webui.status === 200 ? '/api/webui/providers' : '/api/console/providers';
const page = (manifest.json?.providers ?? []).find((p) => p.id === 'world:quota');
check(
  '控制台页 world:quota 在 manifest 里',
  Boolean(page),
  page
    ? `${manifest.status} ${webui.status === 200 ? '/api/webui/manifest' : '/api/console/manifest'} · ${page.label} panels=${(page.panels ?? []).map((p) => p.id).join(',')}`
    : 'manifest 里没有',
);

if (page?.client?.js) {
  const js = await get(page.client.js);
  const css = page.client.css ? await get(page.client.css) : { status: 0, text: '' };
  const hasCode = js.text.includes('quota-shell') && js.text.includes('world:quota');
  check(
    '面板产物可取且是这个包',
    js.status === 200 && hasCode,
    `${page.client.js} → HTTP ${js.status}, ${(js.text.length / 1024).toFixed(1)} KB；样式 HTTP ${css.status}`,
  );
} else {
  check('面板产物可取且是这个包', false, 'manifest 里没写 client.js');
}

const activation = await post('/api/worlds/activation', { id: 'quota', enabled: true });
check('启用 World quota', activation.status === 200, activation.json?.result ?? `HTTP ${activation.status}`);
const worlds = await get('/api/worlds');
const world = (worlds.json?.worlds ?? []).find((w) => w.id === 'quota');
check(
  'World 已挂载且带着两个工具',
  world?.status === 'active' && (world.tools ?? []).includes('quota_status') && (world.tools ?? []).includes('quota_hermes'),
  world ? `status=${world.status} tools=${(world.tools ?? []).join(',')} lamps=${(world.lamps ?? []).length}` : '没有 quota',
);

const panel = await post(`${panelBase}/world%3Aquota/panels/quota/state`, { args: [{ days: 7 }] });
const view = panel.json;
check('面板数据面 state', panel.status === 200 && Boolean(view?.quota), `HTTP ${panel.status}`);
if (view?.quota) {
  const q = view.quota;
  check(
    '读到了套餐额度',
    q.ok === true,
    q.ok
      ? `套餐 ${q.planLabel ?? q.planId} · 本月余 ${money(q.monthlyCredits)} · 5 小时 ${money(q.fiveHour?.used)}/${money(q.fiveHour?.cap)} · 本周 ${money(q.weekly?.used)}/${money(q.weekly?.cap)}`
      : `取不到：${q.reason}`,
  );
  const h = view.hermes;
  check(
    '读到了 Hermes 用量',
    h?.available === true,
    h?.available ? `${h.days} 天 ${h.total?.calls ?? 0} 次调用 · ${h.models?.length ?? 0} 个模型 · ${h.daily?.length ?? 0} 天` : `读不到：${h?.reason}`,
  );
  check('密钥来源已识别', Boolean(view.key?.source && view.key.source !== 'none'), `${view.key?.source} · ${view.key?.detail ?? ''}`);
  check(
    '两个页签声明在（用量额度 + 自己画的配置）',
    (page?.panels ?? []).some((p) => p.id === 'quota') && (page?.panels ?? []).some((p) => p.id === 'settings'),
    (page?.panels ?? []).map((p) => p.id).join(','),
  );
  check('配置不再交给框架的配置页（那边是即时保存）', (page?.configGroups ?? []).length === 0, `configGroups=${(page?.configGroups ?? []).length}`);
}

if (withAlerts && view?.quota?.ok) {
  const before = view.config?.alertPercent ?? 80;
  const startedAt = Date.now() - 5_000;
  await post('/api/config', { group: 'world:quota', values: { 'worlds.quota.alertPercent': 1 } });
  await post(`${panelBase}/world%3Aquota/panels/quota/refresh`, { args: [{ days: 7 }] });
  // 事件落库与 HTTP 返回之间有几拍：等一会儿再读，别把刚发的当没发。
  let fired = [];
  for (let i = 0; i < 8 && fired.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    const events = await get('/api/events');
    // 只看这次触发的：事件库里有更早的 run 留下的同类型事件。
    fired = (events.json?.events ?? []).filter(
      (e) => e.type === 'quota.window' && Date.parse(String(e.ts)) >= startedAt,
    );
  }
  check('提醒事件进了事件库', fired.length > 0, fired[0] ? fired[0].text : '这次没有新事件（可能该窗口已提醒过）');
  check('事件正文只陈述事实', fired.every((e) => !e.text.includes('转告')), fired[0]?.text ?? '');
  await post('/api/config', { group: 'world:quota', values: { 'worlds.quota.alertPercent': before <= 5 ? 80 : before } });
  check('提醒阈值已改回', true, `${before <= 5 ? 80 : before}%`);
}

// ---------------------------------------------------------------- 兴趣推送

const ipPage = (manifest.json?.providers ?? []).find((p) => p.id === 'world:interest-push');
check(
  '控制台页 world:interest-push 在 manifest 里',
  Boolean(ipPage),
  ipPage ? `${ipPage.label} panels=${(ipPage.panels ?? []).map((p) => p.id).join(',')}` : 'manifest 里没有',
);
check(
  '声明了列表 / 详情 / 配置三个页签',
  ['list', 'detail', 'settings'].every((id) => (ipPage?.panels ?? []).some((p) => p.id === id)),
  (ipPage?.panels ?? []).map((p) => p.id).join(','),
);
check('配置不再交给框架的配置页', (ipPage?.configGroups ?? []).length === 0, `configGroups=${(ipPage?.configGroups ?? []).length}`);

const ipClientUrl = ipPage?.client?.js;
if (ipClientUrl) {
  const js = await get(ipClientUrl);
  check(
    '面板产物可取且是这个包',
    js.status === 200 && js.text.includes('ip-list') && js.text.includes('ip-jrow'),
    `HTTP ${js.status} · ${ipClientUrl}`,
  );
} else {
  check('面板产物可取且是这个包', false, 'manifest 里没写 client.js');
}

const ipActivation = await post('/api/worlds/activation', { id: 'interest-push', enabled: true });
check('启用 World interest-push', ipActivation.status === 200, ipActivation.json?.result ?? `HTTP ${ipActivation.status}`);
const ipWorlds = await get('/api/worlds');
const ipWorld = (ipWorlds.json?.worlds ?? []).find((w) => w.id === 'interest-push');
check(
  'World 已激活并带三条读数',
  ipWorld?.status === 'active' && (ipWorld.lamps ?? []).length === 3,
  ipWorld ? `status=${ipWorld.status} lamps=${(ipWorld.lamps ?? []).length} badges=${(ipWorld.badges ?? []).length}` : '没有 interest-push',
);
const ipBadges = (ipWorld?.badges ?? []).map((b) => String(b.label ?? ''));
check('选项卡上方不再有「未读」标签', !ipBadges.includes('未读'), ipBadges.join(' / ') || '（无标签）');

const ipPanel = await post(`${panelBase}/world%3Ainterest-push/panels/list/state`, { args: [] });
const ipView = ipPanel.json?.view ?? ipPanel.json;
check('列表页数据面可用', ipPanel.status === 200 && Array.isArray(ipView?.items), `HTTP ${ipPanel.status} · 条目 ${ipView?.items?.length ?? 0}`);
const ipFirst = (ipView?.items ?? [])[0];
check(
  '抓到条目且带期刊、分区与来源',
  Boolean(ipFirst?.title && ipFirst?.journal && ipFirst?.source),
  ipFirst ? `${ipFirst.source} · ${ipFirst.journal} · ${ipFirst.issued}` : '一条都没有',
);
check(
  '调度读数在（上次检查 / 今日次数 / 下次窗口）',
  typeof ipView?.schedule?.lastCheckAt === 'number' && typeof ipView?.schedule?.pushedToday === 'number',
  ipView?.schedule ? `上次检查 ${new Date(ipView.schedule.lastCheckAt).toLocaleString('zh-CN')} · 今日 ${ipView.schedule.pushedToday}/${ipView.config?.dailyCap}` : '没有 schedule',
);
check(
  '关键设置项齐全（关键词 / 期刊 / 术语表 / 推送时刻）',
  (ipView?.config?.keywords ?? []).length >= 3
    && (ipView?.config?.journals ?? []).length >= 20
    && (ipView?.config?.glossary ?? []).length >= 30
    && (ipView?.config?.pushTimes ?? []).length >= 1,
  `关键词 ${(ipView?.config?.keywords ?? []).length} · 期刊 ${(ipView?.config?.journals ?? []).length} · 术语 ${(ipView?.config?.glossary ?? []).length} · 时刻 ${(ipView?.config?.pushTimes ?? []).join('/')}`,
);
check(
  '期刊集合覆盖中科院一区与 JCR Q1',
  (ipView?.config?.journals ?? []).filter((j) => /中科院一区|Q1/.test(j.tier ?? '')).length >= 20,
  `带分区标签 ${(ipView?.config?.journals ?? []).filter((j) => /中科院一区|Q1/.test(j.tier ?? '')).length} 家`,
);

// 「立刻推一条」：推完「推送」页签要跟到刚推的那篇；连点两次不会连着推同一篇。
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const readPushed = async (since) => {
  for (let i = 0; i < 12; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    const events = await get('/api/events');
    const hit = (events.json?.events ?? [])
      .filter((e) => e.type === 'news.item' && Date.parse(String(e.ts)) >= since)
      .reverse()[0];
    if (hit) return hit;
  }
  return null;
};
const titleOf = (event) => norm(String((event?.text ?? '').split('\n').find((l) => l.startsWith('标题：')) ?? '').replace(/^标题：/, ''));
const activeTitle = async () => {
  const d = await post(`${panelBase}/world%3Ainterest-push/panels/detail/state`, { args: [] });
  return { title: norm(d.json?.view?.active?.title ?? ''), id: d.json?.view?.active?.id ?? null };
};

if (withAlerts) {
  const before = await activeTitle();
  if (!before.id) {
    check('「立刻推一条」与推送页签同步', false, '推送页没有当前论文');
  } else {
    await post(`${panelBase}/world%3Ainterest-push/panels/settings/pushNow`, { args: [] });
    const first = await readPushed(Date.now() - 5_000);
    const afterFirst = await activeTitle();
    check(
      '推完「推送」页跟到刚推那篇',
      titleOf(first) !== '' && afterFirst.id !== null && afterFirst.title === titleOf(first),
      first ? `${afterFirst.title.slice(0, 34)} ⇄ ${titleOf(first).slice(0, 34)}` : '没有收到 news.item 事件',
    );
    const secondLine = (first?.text ?? '').split('\n')[1] ?? '';
    check('推送正文第二行是速评与分数', /^速评（大肥鱼，[\d.]+\/10）：/.test(secondLine) || secondLine.startsWith('速评：'), secondLine.slice(0, 40));

    // 再点一次：刚推那篇已经推过，应该换一篇，而不是连着推同一篇。
    const firstTitle = titleOf(first);
    await post(`${panelBase}/world%3Ainterest-push/panels/settings/pushNow`, { args: [] });
    const second = await readPushed(Date.now() - 5_000);
    const secondTitle = titleOf(second);
    check(
      '连点两次不会连着推同一篇',
      secondTitle !== '' && secondTitle !== firstTitle,
      secondTitle === '' ? '第二次没收到事件' : `${firstTitle.slice(0, 26)} → ${secondTitle.slice(0, 26)}`,
    );
    const afterSecond = await activeTitle();
    check('第二次推完页签也跟到新的那篇', secondTitle !== '' && afterSecond.title === secondTitle, afterSecond.title.slice(0, 34));
  }
}

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项没过`}（共 ${total} 项）`);
process.exit(failed === 0 ? 0 : 1);
