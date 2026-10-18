# 笔记：接口、形状与坑

## Command Code 的套餐额度接口

三个都是 CLI 自己用的内部接口（没有公开文档，社区项目 TokenTracker 也在用同一套），所以解析一律容错：

```
GET https://api.commandcode.ai/alpha/billing/credits
    → { credits: { monthlyCredits, purchasedCredits, freeCredits, creditThreshold, belowThreshold },
        windowLimits: { limited, exceeded, fiveHour: { used, cap, exceeded, resetAt }, weekly: {...} },
        sandboxAccess, sandboxMinutes }
       resetAt 是 epoch 毫秒
GET https://api.commandcode.ai/alpha/billing/subscriptions
    → { success, data: { id, status, planId, currentPeriodStart, currentPeriodEnd, cancelAtPeriodEnd, ... } }
       planId 例如 individual-goat、individual-pro-v1、individual-provider
GET https://api.commandcode.ai/alpha/whoami
    → { success, user: { id, name, userName, email }, org }
```

认证是 `Authorization: Bearer <apiKey>`。别的路径（`/alpha/usage`、`/provider/v1/usage`、`/api/user/self` …）
都是 404：额度只在 billing 这两个接口里。**模型清单在 `/provider/v1/models`（带不带 Key 都通**，当前 89 个模型，
字段 `id` / `name` / `context_length` / `supported_endpoints`）；**价目与计划可用模型没有接口**，只能抓官网计划页
（见下面「计划页与价目页」）。

实测（2026-10-13，GOAT 套餐）：`monthlyCredits 54.66`（月度额度按公开的 $70 算，已用 21.9%）、
`fiveHour 1.10/14`（21:44 重置）、`weekly 5.78/35`（10-16 15:30 重置）、订阅周期到 10-16 15:45。

**月度额度的美元数不在响应里**，只有「还剩多少」。所以百分比按公开的套餐表算
（Go 10 / GOAT 70 / Pro 80 / Max 10× 150 / Max 20× 300 / Team Pro 40，见 commandcode.ai 的
「Usage Limits」与套餐页），认不出的套餐只报剩余、不猜百分比。表变了或者你换套餐，直接把
`worlds.quota.monthlyAllowanceUsd` 填成数字覆盖。

## 密钥来源

与 CLI 一致，顺序是：扩展配置 → 环境变量（`COMMAND_CODE_API_KEY`、`COMMANDCODE_API_KEY`、`COMMAND_CODE_KEY`）
→ `~/.commandcode/auth.json` 的 `apiKey` → 指定的 `.env` 文件。Hermes 用户的 key 在
`%LOCALAPPDATA%\hermes\.env` 里叫 `COMMANDCODE_API_KEY`，所以默认的 `envFile` 就指那儿。

## Hermes 的用量

`%LOCALAPPDATA%\hermes\state.db` 的 `session_model_usage` 表，一行是
(会话, 模型, 计费端点, 任务) 的累计：`api_call_count`、`input_tokens`、`output_tokens`、
`cache_read_tokens`、`cache_write_tokens`、`reasoning_tokens`、`estimated_cost_usd`、`actual_cost_usd`、`first_seen`、`last_seen`。

- 只读打开（`node:sqlite` 的 `readOnly`）。Hermes 正在写、WAL 读不动时，把 `state.db` 与
  `-wal`、`-shm` 复制到临时目录再读那一份。
- `cost_*` 对 commandcode 全是 0/`unknown`：中转站不报价，所以 hermes 自己算不出花了多少钱——
  这也正是把两边的数放在同一页看的意义。
- 统计口径：`days` 窗口按 `last_seen` 筛，模型表按 (模型, 计费端点) 分组；`sessions` 是整库的会话数。
- 宿主 Node 里没有 `node:sqlite` 时（很旧的 Electron），退回读 `<Hermes 数据目录>/quota-usage.json`
  —— 形状见 `src/hermes.ts` 的 `readExport`，字段名驼峰下划线都认。

## 多账号与密钥落点

账号表在 **`<ctx.dataDir>/quota/accounts.json`**（`ctx.dataDir` 是桌宠的数据目录，dev 实例里就是
`build\data\home\companion\data`），记名字、供应商、来源、变量名、密钥尾四位、邮箱、套餐、最近检查/失败。
两种来源（`origin`）：

- **`native`：桌宠里配的模型端点**（推荐，也就是使用者说的「原生接入」）。布局实测：

  ```
  <home>/providers/<端点名>/config.json   { kind, baseUrl, secret: "<.env 里的变量名>", spec, … }
  <home>/providers/<端点名>/.env          <变量名>=<密钥>
  ```

  `src/native.ts` 只看 `baseUrl` 指向 `commandcode.ai` 的那些端点；每轮取数前重新扫一遍
  （桌宠里换端点/换 Key，这里立刻跟上），把端点 upsert 成账号：id 由端点名定死（`nativeAccountId`），
  有就更新、没有就加，第一条被发现的端点自动成为当前账号。密钥**每轮从端点 `.env` 现读**，
  不复制到别处。登录邮箱与套餐用同一把密钥问 `/alpha/whoami` 与 `/alpha/billing/subscriptions` 回填，
  回填后账号名就跟着邮箱走（界面上看到的是「哪个号」而不是「哪个端点」）。
  「桌宠在用」的标记来自 `<botDir>/config.json` 的 `activeProvider`。
- **`manual`：面板里手动加的**（给不在桌宠端点里的号）。密钥经 `ctx.storeSecret` 写进
  **部署 `.env`**（变量名如 `QUOTA_COMMANDCODE_1`），表里只有变量名与尾四位。只有这种账号能在面板里删。

取数用的 Key 顺序：**当前账号（native 读端点 `.env` / manual 读部署 `.env`）→ 配置里手填的 Key →
环境变量 → 登录文件 → 指定的 `.env`**。切账号会重置提醒游标（`firedByAccount` 按账号 id 分组）。
账号只服务这一页的额度/价目，Coo 用哪个端点说话由「模型供应商」页决定。

**Command Code 没有「账号密码」接口**：官方 CLI 的登录是浏览器 OAuth（临时本地回调 + `~/.commandcode/auth.json`），
所以「在面板里输账号密码」做不到；面板显示的邮箱是拿端点那把 Key 调 `whoami` 问出来的，不是读 cookie。
详见 `docs/VENDORS.md`。

## 面板上的按钮与「保存」（两条踩过的坑）

- **按钮为什么看着像纯文字**：控制台的**页面作用域**把 `.btn` 重定义成
  `background: transparent; border: 1px solid transparent`（原文在 `src/web/public/styles.css`
  的页面级 `.btn` 块，第 ~1460 行），只有 hover 才变色；`.btn.sm` 又小，在表格里就跟文字一样。
  扩展这边的修法是**在 `.quota-shell` 里把按钮的样子给回来**（浅填充 + 可见描边 + 一点阴影 + 按下位移），
  颜色全用 `color-mix` 从主题变量混出来，浅色/深色主题都不跑偏。不动框架样式，升级也不受影响。
- **框架「配置」页没有保存按钮，它是 400ms 防抖即时保存**：`src/web/client/features/config/view.ts`
  里写着 `const SAVE_DEBOUNCE_MS = 400`，连续输入去抖后直接 POST `/api/config`；框架只提供 `x-hot`
  （改完是否需重启），**没有「先编辑、后提交」这种模式**。也就是说「提醒阈值」这种数字敲到一半就会被存下来
  （想写 `80`，敲到 `8` 就已经存进去了）。
  **解法：不把配置段声明给框架**（`console().config` 不填），改成**自己再声明一个面板**——
  框架里「一个面板 = 一个页签」，所以第二个面板 `{ id: 'settings', title: '配置' }` 就是我们要的那一页。
  面板里画分组表单（提醒 / 连接 / 路径），底部一个**保存**按钮 → `invoke('saveSettings')` →
  World 端逐字段校验夹紧后 `ctx.persist(patch)` **一次写回**；路径类字段用 `ctx.pickPath()` 配「选择…」。
  密钥框留空表示「不动它」，免得每次保存都把已有密钥抹掉。
  实测：manifest 里 `panels=quota,settings`、`configGroups=0`；保存后 `config.json` 的 `worlds.quota` 同步落盘。
  （附带发现：`POST /api/config` 其实**接受未声明的键**，只是页面不渲染它们——所以别指望「不声明」能挡住写入。）

## 取数策略（不做自动轮询）

- 面板**进入这一页**：先 `state` 把手上那份画出来（不拉网络，实测 0.02s），再 `refresh` 拉一次（约 2.3s），
  之后**不再自动取数**；要新的就读各卡上的按钮（额度「刷新」、模型「刷新」、价目「抓取」）。
- `state` 只回内存里那份；唯一例外是 Hermes 的统计范围变了就地重读本机 sqlite（本地、便宜）。
- World 自己的后台轮询（`worlds.quota.pollMinutes`，默认 10 分钟）只为**越过阈值的提醒**服务；
  设 0 就完全只在面板/工具调用时取数。

## 计划页与价目页（爬取）

用户要的「计划可用模型 + 单价 + 计划额度」官网上有，接口里没有，所以抓网页（`src/pricing.ts`）：

- 计划页 `https://commandcode.ai/docs/plans/<go|goat|pro|max|ultra|provider|teams-pro>` 是 SSR 的真
  `<table>`，三张表按模型名对齐：① `Model | Context | Intelligence | Input | Output | Cache read | Cache write | Caps`
  ② `Model | Requests / 5 hours | Requests / week | Requests / month` ③ `Model | … | Monthly credits`。
  实测 GOAT 页 65 行，含每个模型的请求额度与月度 $ 额度。
- 全局价目页 `https://commandcode.ai/docs/resources/pricing-limits` 把 93 个模型塞在 Next.js 的 RSC
  JSON（`self.__next_f.push([1,"…"])` 拼起来后的 `"rows":[…]`）里，渲染出来的是 CSS grid 不是 `<table>`，
  所以先读 JSON、读不到再退回表格。
- 解析全容错：金额 `$0.10` → 0.1，`Free` → 0 + `free: true`，`—` → null，`+1` 之类脚注收进 `caps`；
  认不出来只是少一段数据，写进 `notes` 不抛错。
- 抓回来缓存到 **`<ctx.dataDir>/quota/plan-<slug>.json`**，默认 12 小时；抓不到就吃缓存（过期的也吃），
  带 `reason` 说明；面板的「抓取」按钮传 `maxAgeMs: 0` 强制重抓。
- planId → slug 的映射在 `planSlugFor`（`individual-goat` → `goat`；认不出就退回全局价目页）。
  换账号/换套餐（planId 变了）会自动重抓。

## 供应商接缝

`src/sources.ts` 里一张登记表：`commandcode` 有实现（`fetchQuota` / `fetchModels` / `planPageUrl`），
其余 8 家只有 `implemented: false` 与两句说明（`needs` 要什么、`plan` 将来从哪儿查：OpenAI 走
`/v1/organization/costs`（要 Admin Key）、Anthropic 走 `/v1/organizations/cost_report`、DeepSeek 走
`/user/balance`、OpenRouter 走 `/api/v1/credits` 与自带价格的 `/api/v1/models`、Kimi 走
`/v1/users/me/balance`、智谱与百炼没有公开余额接口、自定义中转看情况）。这些接口是**候选、待核实**，
写在那儿是为了让接新家时知道从哪起手——面板切过去只会显示「未实现」与这段说明，不发任何请求。
「当前供应商」存在配置 `worlds.quota.source`（x-hot），面板的下拉直接写它。

## 坑

1. **vite / vitest 解析不了 `node:sqlite`**：静态 `import` 或动态 import 都会被它当成一个叫 `sqlite` 的包。
   用 `createRequire(import.meta.url)('node:sqlite')` 绕开，这也是 `src/hermes.ts` 现在的写法。
2. **面板 bundle 只能 `import type` 框架**：任何运行时 import 都会让 esbuild 报
   "Could not resolve cortico/…"。所以共享的类型放在 `src/view-types.ts`，那里不 import 任何带 node 依赖的模块，
   浏览器侧 tsconfig 也编得了它。
3. **浏览器侧 tsconfig 要开 node 类型**：面板 import 的类型链（如 `cortico/core/language.ts`）会牵进带
   `node:built-in` 的框架源码，Coopanion 自己的 web tsconfig 也是这么写的（注释里就说了这一点）。
4. **普通模式看不到这页**：Coopanion 的普通模式左栏只列桌宠四页 + 系统提示词 + 用量与成本 + 对话，
   扩展页只在高级模式里出现。所以提醒走气泡，页面走高级模式。
5. **提醒去重靠游标**：`窗口:重置时刻:档位`。窗口重置后 `resetAt` 变了，同一档才会再报一次；
   服务器不给 `resetAt` 时退化成订阅周期做锚点，避免每轮都报。
6. **Cortico 与自己那份 `cortico` 包**：开发期 `cortico/*` 由 npm 上的 `cortico` 包解析（当前 0.1.13），
   装进宿主后由框架的模块钩子解析到它自己运行的那份源码。两边的 `WorldDefinition` 形状一致（world api 5）。
7. **sparse-checkout 会静默毁掉形象包**：只检出部分目录时，`packages/cortico-world-desktop-pet/web/whale/`
   不在工作树里，切到 whale 会「没能显示出来」并回退 Coo，而且**回退会写回配置**（`skin.figure` 变成 coo）。
   要动这个仓库就用完整检出（`git sparse-checkout disable`）。
8. **pnpm 在搬动过的目录上要一次重建**：非交互环境跑 `pnpm run dev` 会先自检依赖，发现 node_modules 与
   项目位置/状态对不上就想重建，TTY 缺失时报 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`；给 `CI=true`
   跑一次 `pnpm install` 即可。另外 **`electron` 的 postinstall 常被跳过**，二进制要手动补：
   `cd node_modules/electron && ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node install.js`。
   国内网络下 registry 也换 npmmirror，否则 110 MB 的 Electron 包基本下不下来。
9. **真宿主的面板原语与替身有差异**：`ctx.ui.sheet()` 画出来的是 `div.sheet.tabbed > h3 + .sheetbody`，
   不是 `section.sheet`；DOM 断言按真结构写。
10. **路由里的页 id 是编码过的**：导航 href 形如 `#/provider/world%3Aquota`（`buildHash` 对每段
    `encodeURIComponent`）。另外 Coopanion **普通模式**会把非桌宠页重定向回「开始」，要看这一页得先切
    **高级模式**（`localStorage['companion.mode']='advanced'`）。
11. **`node:sqlite` 在 vitest 里**：静态 import 与动态 import 都会被 vite 当成一个叫 `sqlite` 的包，
    用 `createRequire(import.meta.url)('node:sqlite')`。
12. **改完面板代码却看到老页面 = HTTP 缓存假象，且「重启」不一定救得了**：面板产物的响应头是
    `Cache-Control: public, max-age=31536000, immutable`，而 URL 只带包版本（`…/0.1.0/console.js`）。
    开发期版本号不变 → 之前抓过旧产物的客户端（控制台窗口、渲染检查用的 Electron）在整个有效期内
    **不再回源**，于是「我这边是新页面、使用者那边还是 3 张卡」。
    **可靠修法：升 `package.json` 里的 version**（URL 随之改变，缓存必然失效），再重启应用/进程；
    使用者那边只需重新打开那一页（已加载在内存里的旧 JS 不会自己换）。
    渲染检查为了可重复，另给每次运行独立的 `app.setPath('userData', …)` 并加 `disable-http-cache`。
13. **长面板整页截图会挂**：内容比视口高、卡片头是 sticky 时，`page.screenshot({fullPage:true})` 会
    卡在「waiting for fonts」直到超时。改成**把视口开高**（1400×2600）拍视口截图，并让截图失败不影响
    整体判定。
14. **World 的目录与秘密存储**：`ctx.dataDir` 是**桌宠实例的数据目录**（dev 里
    `build\data\home\companion\data`），不是 `build\data`；`ctx.storeSecret(name, value)` 写的是
    `<botDir>/.env`（`build\data\home\companion\.env`）并同步 `process.env`，而 `ctx.secret(name)` 读的是
    「进程环境优先，其次那份 `.env`」。写缓存文件前要自己 `mkdirSync(recursive)`，框架不管这个。
15. **面板的 `invoke` 方法要跟 World 的 switch 对齐**：面板调的每一个方法名（`state`/`refresh`/
    `addAccount`/`activateAccount`/`removeAccount`/`models`/`pricing`）都要在 `world.ts` 的 `invoke` 里
    有分支，否则是 500；jsdom 替身测不到这条，真控制台才露出来。渲染检查里的「添加账号」按钮能做真
    检查，别只断言文案。
