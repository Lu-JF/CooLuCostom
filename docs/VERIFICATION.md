# 验证记录

跑过什么、结果是什么。日期 2026-10-13，本机 Windows 11。

## 1. 单元测试与类型检查

```bash
cd extension
npm run typecheck     # Node 侧 + 浏览器侧两份 tsconfig
npm test
npm run build
```

结果：

- `tsc --noEmit` 与 `tsc -p tsconfig.web.json` 都 0 错。
- 37 个测试全过（5 个文件）：
  - `commandcode.test.ts` 14 个：三个接口的解析（含字段缺失、值类型怪）、套餐名与月度额度、重置时刻三种写法、
    密钥来源四层顺序、401 与断网。
  - `hermes.test.ts` 4 个：真 sqlite 聚合（按模型/端点分组、窗口过滤、日粒度、会话数）、库不在、导出文件兜底。
  - `alerts.test.ts` 7 个：阈值与用尽的区分、同窗口同档只报一次、窗口重置后可再报、月度额度百分比。
  - `world.test.ts` 6 个：挂载即取数并只发一条提醒、关掉提醒/阈值 0 不发、没密钥不抛错、环境提示词与工具与
    控制台声明、面板数据面。
  - `console-panel.test.ts` 6 个（jsdom）：面板挂载后把额度/Hermes/提醒三张卡画出来、刷新按钮走 refresh、
    换统计范围重新取数、密钥取不到与 Hermes 读不到时的提示、保存只写该写的三项。
- `dist/console.js` 14.2 KB + `dist/console.css` 0.3 KB。

## 2. 框架自己的契约校验

```bash
cd <Cortico 检出>       # Pal-AI-Lab/Cortico @ e21a524
pnpm install --ignore-scripts
pnpm check:extension D:/Work_AI/Git_Lu/CooLuCostom/extension
```

结果：

```
框架契约: world v5 / provider v5 / bot v6
  ✓ manifest: kind=world,api=5
  ✓ 默认导出符合 world 的形状;id = quota
  ✓ 浏览器端产物: dist/console.js   （页 id world:quota）
  ✓ 浏览器端样式: dist/console.css
  ✓ defaults() / create() / tools(): quota_status, quota_hermes / envPromptVars() / console()
扩展检查通过。
```

## 3. 真机（源码 dev 实例）

实例：Coopanion `0.1.24`（子模块 Cortico `e21a524`）`pnpm run dev`，Electron 44.4.4 / Node 24.21.0。
扩展以目录联接装进 `build/data/extensions`，控制台在 `127.0.0.1:17788`。

```bash
node scripts/verify-instance.mjs 17788 --alerts
```

```
✓ 控制台在跑
✓ 扩展已装并被加载 — cortico-world-quota@0.1.0 loaded=true
✓ 控制台页 world:quota 在 manifest 里 — 用量额度 panels=quota config=world:quota
✓ 面板产物可取且是这个包 — /assets/extensions/cortico-world-quota/0.1.0/console.js → HTTP 200, 14.2 KB
✓ 启用 World quota / ✓ World 已挂载且带着两个工具 — status=active tools=quota_status,quota_hermes lamps=2
✓ 面板数据面 state — HTTP 200
✓ 读到了套餐额度 — 套餐 GOAT · 本月余 $54.01 · 5 小时 $1.75/$14.00 · 本周 $6.43/$35.00
✓ 读到了 Hermes 用量 — 7 天 2061 次调用 · 4 个模型 · 4 天
✓ 密钥来源已识别 — envFile · C:\Users\user\AppData\Local\hermes\.env :: COMMANDCODE_API_KEY
✓ 提醒事件进了事件库 — [用量] Command Code 5 小时窗口已用 $1.75/$14.00，10-13 21:44 重置（还有 1 小时 4 分钟）。本月还余 $54.01。
✓ 事件正文只陈述事实
全部通过（共 14 项）
```

事件库里那条 `quota.window` 是 World 自己发出来的，`origin: internal`、`contextDelivery: deliver`，
也就是会进 bot 上下文、由 Coo 决定说出来的那条。

真控制台里的渲染（起一个最小 Electron 窗口开这一页，经 CDP 读 DOM）：

```bash
node extension/scripts/check-panel-render.mjs 17788 <electron.exe>
```

```
✓ 面板挂到了这一页 — 3 张卡：Command Code 套餐额度 / Hermes 用量 / 提醒
✓ 额度进度条画出来了 — 3 条：5 小时窗口$1.83 / $14.00 · 重置倒计时 53 分钟（10-13 21:44） | 本周窗口$6.51 / $35.00 · 重置倒计时 2 天 18 小时（10-16 15:30）
✓ Hermes 表格有行 — 各表行数 [0,4,4]
✓ 读到了套餐与余额 / ✓ 提醒设置卡在 / ✓ 页面没有报错
渲染检查通过
```

注意：这一页在**高级模式**才出现在左栏（Coopanion 普通模式只列桌宠那几页），检查脚本会先把
`localStorage` 里的 `companion.mode` 设成 `advanced`。

## 4. 搬家后的复验（2026-10-13 21:0x）

整个项目搬到 `D:\Work_AI\Git_Lu\CooLuCostom\`（上游检出在 `upstream\coopanion`、`upstream\cortico`），
实例从新路径 `pnpm run dev` 起来后重跑了两项：

- `node scripts/verify-instance.mjs 17788 --alerts` → 14 项全过，读数照旧（套餐 GOAT · 本月余 $53.84 ·
  5 小时 $1.92/$14.00 · 本周 $6.60/$35.00；Hermes 7 天 2191 次调用），提醒事件照常进库。
- `node extension/scripts/check-panel-render.mjs …` → 渲染检查通过（3 张卡、3 条进度条带真读数、无报错）。

搬家路上修掉一个真问题：**sparse-checkout 让大肥鱼形象加载失败**。当初 clone 时我排除了
`packages/*/web/whale/`，贴图不在，切到 whale 后 World 回退成 Coo 并在事件里写明：

```
20:42 [形象] whale没能显示出来(没有装这个形象),你现在是Coo,一个小桌宠…
```

`git sparse-checkout disable` 补齐工作树后再切，事件变成：

```
21:03 [形象] 你现在的样子:DeepSeek 大肥鱼,一个 Q 版鲸鱼娘,二头身,侧身朝右站;蓝色长发、头顶一根呆毛…
```

`/api/figures` 也从只有 `['coo']` 变成 `['coo','whale']`，`skin.figure=whale` 持久化后不再回退。

## 6. 多账号 / 供应商接缝 / 模型与价目（2026-10-14）

这一轮加了：账号（添加 / 切换 / 删除）、供应商切换（只有 Command Code 有实现）、可用模型清单、
计划价目与按模型的额度。复验如下。

单元测试与类型检查：

- `vitest run` → **73 个测试全过（8 个文件）**。新增：`accounts.test.ts` 8 个（尾四位掩码、变量名避让、
  落盘与坏文件、加/删/切与「账号密钥优先」）、`sources.test.ts` 3 个（登记表形状、未实现的家都写了
  `needs`/`plan`、Command Code 三个方法的归一化）、`pricing.test.ts` 16 个（计划页三张表对齐、全局价目页
  RSC JSON、容错、缓存与回退）、`world.test.ts` 11 个（含加号先验 Key、Key 不对不落表不写秘密存储、
  切号删号与「提醒游标按账号分开」、账号表落盘后重建实例仍生效）、`console-panel.test.ts` 10 个
  （账号卡、供应商下拉写配置、价目表渲染、价目还没抓过时的空态）。
- `tsc -p tsconfig.json` 与 `tsc -p tsconfig.web.json` 都 0 错；`dist/console.js` 24.3 KB。
- 官方契约校验 `pnpm check:extension` 仍通过（world api 5 没变，这次只加内部方法）。

真机（同一份 dev 实例，重启进程后经面板的 `invoke` 数据面核对）：

```
state    → accounts {activeId: null, list: []}；sources 9 项（commandcode + 8 个未实现）；
           models 89 个；pricing GOAT · 65 行 · via=live
pricing  → 强制重抓：65 行，例 Claude Haiku 5.5 $0.10/$0.50 per 1M、5h 5970 / 周 14900 / 月 29900 次请求、月额度 $20；
                           DeepSeek V4.1 Flash Fast $0.16/$0.58、5h 11500 / 周 28700 / 月 57500、月额度 $60；
                           免费模型（Glyph Cluster、Ling 3.1 Flash…）单价记 0 且标 free
models   → 89 个模型（来自 /provider/v1/models）
addAccount（假 Key）→ HTTP 500「command code rejected the key」，账号表仍为空、部署 .env 里没有 QUOTA_*
价目缓存 → <dataDir>/quota/plan-goat.json（dataDir = build\data\home\companion\data）
```

真控制台渲染（CDP 读 DOM，顺带拍图）：

```
✓ 账号 / 供应商 / 模型 / 价目四张新卡都在 — 共 7 张卡：额度 / 账号 / 供应商 / 可用模型 / 计划价目与额度 / Hermes / 提醒
✓ 价目表带单价与按模型的额度 — 表头 输入/M 输出/M 缓存读/M 缓存写/M 5 小时额度 周额度 月额度 月额度$
✓ 供应商下拉有选项 — 1 个下拉
✓ 面板相关资源没有失败
渲染检查通过（截图 docs/panel.png、docs/panel-pricing.png）
```

这一轮抓到并修掉一个真问题：**渲染检查看到的是旧面板产物**。面板产物的 URL 只带包版本（`0.1.0`），
Electron 的 userData HTTP 缓存把上一次跑的旧 `console.js` 喂给了页面，于是「代码改了、页面还是 3 张卡」。
改成每次运行用独立的 `app.setPath('userData', …)` + `disable-http-cache` 后，7 张卡与价目表才如实出现
（同一现象对使用者也是真的：改完面板要重启进程，必要时硬刷）。

## 8. 账号改成「桌宠端点自动记录」+ 刷新策略（2026-10-14 下午）

按要求做了三处改动：账号栏直接记录桌宠端点里的那个号（不用手输 Key）、进页面拉一次 + 按钮手动刷、
供应商卡只留下拉（备忘挪到 `docs/VENDORS.md`）。扩展版本 **0.1.2**。

```
vitest run           → 85 个测试全过（9 个文件；新增 native.test.ts 5 个、accounts +3、world +4、面板 +1）
tsc 双 tsconfig      → 0 错
pnpm check:extension → 通过（world api 5）
```

真机读数（`build\data\home\providers\CommandCode\{config.json,.env}` 是这份实例的原生凭证）：

```
state    → 0.02s 返回（手上那份，不拉网络）
refresh  → 2.30s（进来那一次 / 点「刷新」）
账号栏   → [ { id: acc_native_commandcode, label: test@gmail.com, email: test@gmail.com,
              planLabel: GOAT, keyHint: ••••xYkS, origin: native, active: true, inUse: true } ]
           —— id 由端点名定死、每轮 upsert；邮箱与套餐是用端点那把 Key 问 whoami/subscriptions 回填的
sources  → 9 项（commandcode 当前 + 8 个未实现），面板上只有下拉与一句 docs/VENDORS.md，没有表格
models   → 89 个；pricing → 65 行（GOAT 计划页）
渲染检查 → 7 张卡全在；账号表 1 行、供应商表 0 行；截图 docs/panel.png、docs/panel-pricing.png
```

面板产物 URL 也顺势升到 `…/0.1.2/console.js`（`0.1.1` 那次是修缓存假象、`0.1.2` 是这次改动的产物）。
渲染检查脚本顺手改成「等取数落地再截图」，免得把「正在取数」的遮罩拍进文档图。

## 10. 按钮观感与「保存」这两处修正（2026-10-16）

使用者反馈：面板里的按钮跟文字分不开；框架「配置」页缺保存按钮、即时保存会存下敲一半的参数
（详见 `docs/NOTES.md` 的「面板上的按钮与『保存』」）。改动与复验：

```
vitest run           → 87 个测试全过（新增 2 个：saveSettings 夹紧写回、配置页不再声明那四项）
tsc 双 tsconfig      → 0 错
pnpm check:extension → 通过
扩展版本 0.1.3 → 0.1.4（面板产物 URL 随之改变，见第 6 节缓存那条）
```

真机：

```
GET /api/config              → world:quota 只声明 7 个字段（source / monthlyAllowanceUsd / commandcodeKey /
                               commandcodeBaseUrl / hermesHome / envFile / authFile）；
                               阈值、间隔、天数**已不在配置页** ✓
invoke saveSettings 75/20/14 → 200，view.config 立刻变成新值；config.json 里 worlds.quota 同步落盘；
                               随后改回 80/10/7 ✓
渲染检查                     → 7 张卡全在；截图 docs/panel.png
视觉复核（看图）             → 「刷新」「手动添加账号」有填充/描边/圆角，读得出是按钮；
                               「桌宠在用」仍是状态标签（本来就该是标签的样子）
```

## 11. 配置改成自己画的页签 + 价目表瘦身（2026-10-16 晚）

使用者要求：行为类设置搬回【配置】页并在那儿给一个【保存】按钮；价目表去掉 5 小时/周/月请求额度三列、
只留【月额度 $】。做法见 `docs/NOTES.md` 的「面板上的按钮与『保存』」：**不再声明框架配置组**
（它是 400ms 防抖即时保存），改为**再声明一个面板** `settings`（框架里一个面板 = 一个页签）当「配置」页，
表单底部一个保存按钮 → `invoke('saveSettings')` → `ctx.persist()` 一次写回。扩展版本 **0.1.5**。

```
vitest run           → 88 个测试全过（面板测试改成两个页签各挂一次；新增「配置页签」两条）
tsc 双 tsconfig      → 0 错
pnpm check:extension → 通过：console(): 2 个面板, 0 个配置组, 1 份提示词文档
```

真机：

```
manifest        → panels=quota,settings；configGroups=0 ✓
verify-instance → 12 项全过（含「两个页签声明在」「配置不再交给框架的配置页」）
渲染检查        → 用量额度页 6 张卡（提醒卡已搬走）；价目表头是 模型/上下文/输入/M/输出/M/缓存读/M/缓存写/M/月额度 $，
                  断言「不含 5 小时额度、不含周额度、不含 51300」✓
                  切到「配置」页签：提醒阈值/Hermes 数据目录/Command Code 密钥 都在、1 个「保存」按钮、
                  3 个「选择…」路径选择器 ✓
截图            → docs/panel.png（用量额度）、docs/panel-settings.png（配置）、docs/panel-pricing.png（价目卡）
```

## 12. 没验证到的

- **官方安装版的升级路径**：本机没装 NSIS 安装版，所以「升级后 `data\`（含扩展）保留」是读
  `installer/nsis.nsh` 的 `customRemoveFiles` 与 `app/main.cjs` 的 `CORTICO_EXTENSIONS_DIR` 得出的结论，
  没有实测过一次真实升级。
- **Coo 真的开口说那句话**：dev 实例没配模型端点、bot 处于暂停，所以只验证到「事件进了库、标着要投递」。
  真正开口那一步要有一个能用的模型端点。
- **`ctx.storeSecret` 真的写进 `<botDir>/.env`**：这条路径只在单测里用假的秘密存储走过（真写要一把真 Key，
  本轮不敢拿真 Key 去验）。框架源码里它写的就是 `<botDir>/.env` 并同步 `process.env`，与面板文案一致；
  等你放一个真账号进去，`build\data\home\companion\.env` 里会出现 `QUOTA_COMMANDCODE_1=…`。
- **账号不止一个时的界面观感**：真机上只有一个号（桌宠里那个 Command Code 端点，已自动记录）。
  多号（两个端点）在单测里过：切过去就用那一把密钥、`inUse` 只标桌宠当前在用的那个；
  要真验得在桌宠「模型供应商」页再配一个 Command Code 端点。
- **Command Code 的 OAuth 登录**：没有实现，也做不了「面板里输账号密码」——官方 CLI 的登录是浏览器
  OAuth（临时本地回调，token 落 `~/.commandcode/auth.json`），本机连 `~/.commandcode/` 都还没有
  （没用过官方 CLI 登录）。面板走的是「用桌宠端点那把 Key 问 whoami」，见 `docs/VENDORS.md`。
- **浏览器缓存**：面板产物的 URL 里带的是包版本（`0.1.0`），没有内容哈希；改完面板要重启进程，
  必要时强刷控制台（普通扩展由框架按版本分配 URL，内建 World 才带内容哈希）。

## 13. 迁移到官方安装版 v0.2.4（2026-10-18）

目标：装官方安装版，把功能、形象、记忆、配置整套搬过去；顺手把项目目录从 `Coopanion-Usage` 改成 `CooLuCostom`。

做法：先把旧实例的 `data\home`（8.9 MB：`companion/config.json` 里的 `skin.figure=whale`、`companion/workspace`
的记忆、`companion/data/quota/accounts.json`、`providers/CommandCode`）与 `data\extensions`（我们那个包）
预置到 `D:\Sorftware\Coopanion\data`，再静默安装 `Coopanion-Setup-0.2.4.exe /S /D=D:\Sorftware\Coopanion`，然后启动。

```
安装        → D:\Sorftware\Coopanion\Coopanion.exe（245 MB，NSIS 未签名）✓；预置的 data\ 未被安装器动过 ✓
首启        → 12 秒后控制台 127.0.0.1:17788 200 ✓
              日志：World 已启动: console / desktop-pet / coopanion / quota ✓
数据继承    → /api/status：displayName=Coo，modelConnection=CommandCode（api.commandcode.ai/provider/v1）ready=true，
              loop.messageCount=355（历史会话带过来了）✓
形象        → config.json: figure=whale / scheme=deepseek / outfit=maid ✓；桌宠页 7797 200 ✓
扩展        → /api/extensions: cortico-world-quota@0.1.5 loaded=true ✓
              /api/webui/manifest: world:quota availability=active；lamps=2（Command Code 在线 / Hermes 用量）；
              badges=5（套餐 GOAT / 账号 1 / 5 小时 1% / 本周 2% / 本月余额 $69.43）；panels=quota,settings ✓
自检        → node scripts/verify-instance.mjs 17788 → 12 项全过 ✓
              （「控制台页 world:quota 在 manifest 里 — 200 /api/webui/manifest」「面板产物可取 —
              /assets/extensions/cortico-world-quota/0.1.5/console.js 200, 29.8 KB」
              「密钥来源 — account:test@gmail.com · CORTICO_KEY_COMMANDCODE」）
渲染检查    → 13 项全过 ✓：6 张卡、额度进度条 3 条、价目表只留「月额度 $」、账号/供应商/模型/价目四卡都在、
              「配置」页签 1 个保存按钮 + 3 个路径选择器、面板产物请求 200
同步脚本    → node scripts/sync-extension-to-app.mjs → 重新构建并拷进官方版 ✓（dist/console.js 29.8 KB）
快捷方式    → 桌面「桌宠 Coo.lnk」→ D:\Sorftware\Coopanion\Coopanion.exe ✓（安装器自带的 Coopanion.lnk 同指）
改名        → D:\Work_AI\Coopanion-Usage → D:\Work_AI\Git_Lu\CooLuCostom（分片搬；首提交 b836e7f 完好）；
              仓内 8 处写死路径已改；dev 实例里的扩展链接已重指新路径 ✓
```

这次没验证到的：

- 官方版托盘的**开机自动启动**开关（现在可点了，但点它属于界面操作，我没替你点）；
- `--background` 参数在新版是否真「静默起在托盘」：源码里只有写入处、没有判断处（旧版如此，新版未复读）；
- 官方版对**旧契约扩展**的长期态度：v0.2.0 说明写「Cortico 下一个大版本起不再加载」，届时要把 `cortico.api`
  升到新号并对齐接口；
- 日志里出现过一条 `Provider attempt failed; retrying { err: 'Delta before content part' }`（新版 responses
  兼容模块的一次重试），没有复现，先记着。
