# 接口与实现说明

本文档记录扩展使用的接口、数据形状、配置语义与已知问题的处理方式。

## Command Code 套餐额度接口

以下三个接口为 CLI 内部使用，没有公开文档，解析一律按容错处理。

```
GET https://api.commandcode.ai/alpha/billing/credits
    → { credits: { monthlyCredits, purchasedCredits, freeCredits, creditThreshold, belowThreshold },
        windowLimits: { limited, exceeded, fiveHour: { used, cap, exceeded, resetAt }, weekly: { ... } },
        sandboxAccess, sandboxMinutes }
      resetAt 为 epoch 毫秒
GET https://api.commandcode.ai/alpha/billing/subscriptions
    → { success, data: { id, status, planId, currentPeriodStart, currentPeriodEnd, cancelAtPeriodEnd, ... } }
      planId 形如 individual-goat、individual-pro-v1、individual-provider
GET https://api.commandcode.ai/alpha/whoami
    → { success, user: { id, name, userName, email }, org }
```

认证方式为 `Authorization: Bearer <apiKey>`。额度相关数据仅由上述 billing 两个接口与 whoami 提供，
其余额度类路径均返回 404。模型清单由 `/provider/v1/models` 提供，携带密钥与否均可访问，当前为 89 个模型，
字段为 `id`、`name`、`context_length`、`supported_endpoints`。价目与计划可用模型没有对应接口，须解析
官网页面，见下文「计划页与价目页」。

### 月度额度的判定

接口返回的 `credits.monthlyCredits` 表示剩余额度，响应中不含月度总额。百分比按公开的套餐额度换算，对应关系为
Go 10、GOAT 70、Pro 80、Max 10× 150、Max 20× 300、Team Pro 40，来源为 commandcode.ai 的「Usage Limits」
与套餐页。无法识别套餐时只报告剩余额度，不推测百分比。套餐表变动或账户更换套餐时，可将
`worlds.quota.monthlyAllowanceUsd` 设为具体数值以覆盖默认判定。

## 密钥来源

密钥的查找顺序与 CLI 一致：扩展配置中的手填密钥，其次为环境变量 `COMMAND_CODE_API_KEY`、
`COMMANDCODE_API_KEY`、`COMMAND_CODE_KEY`，再次为 `~/.commandcode/auth.json` 的 `apiKey` 字段，
最后为指定的 `.env` 文件。Hermes 用户的密钥位于 `%LOCALAPPDATA%\hermes\.env`，变量名为
`COMMANDCODE_API_KEY`，因此默认的 `envFile` 指向该文件。

## Hermes 用量

数据来自 `%LOCALAPPDATA%\hermes\state.db` 的 `session_model_usage` 表。该表以「会话、模型、计费端点、任务」为
粒度累计，字段包括 `api_call_count`、`input_tokens`、`output_tokens`、`cache_read_tokens`、
`cache_write_tokens`、`reasoning_tokens`、`estimated_cost_usd`、`actual_cost_usd`、`first_seen`、`last_seen`。

- 数据库以只读方式打开。若 Hermes 正在写入且 WAL 无法读取，则先将 `state.db` 与其 `-wal`、`-shm` 文件复制到
  临时目录，再读取副本。
- `cost_*` 字段对 commandcode 全部为 0 或 `unknown`，因为中转站不返回单价，Hermes 无法计算费用。这也是将
  供应商额度与本机用量放在同一页对照的原因。
- 统计口径：`days` 窗口按 `last_seen` 筛选，模型表按「模型、计费端点」分组，`sessions` 为整库会话数。
- 宿主 Node 不含 `node:sqlite` 时，回退读取 `<Hermes 数据目录>/quota-usage.json`，形状见 `src/hermes.ts` 的
  `readExport`，字段名的驼峰与下划线写法均可识别。

## 账号与密钥存储

账号表位于 `<ctx.dataDir>/quota/accounts.json`，记录名称、供应商、来源、变量名、密钥尾四位、邮箱、套餐、
最近检查时间与失败原因。`ctx.dataDir` 为桌宠实例的数据目录，源码实例中即 `build\data\home\companion\data`。
账号按 `origin` 分为两类。

- **native**：桌宠中配置的模型端点，即原生接入方式。端点凭证的布局为：

  ```
  <home>/providers/<端点名>/config.json   { kind, baseUrl, secret: "<.env 中的变量名>", spec, ... }
  <home>/providers/<端点名>/.env          <变量名>=<密钥>
  ```

  `src/native.ts` 仅识别 baseUrl 指向 `commandcode.ai` 的端点。每轮取数前重新扫描端点目录，使桌宠中更换端点
  或密钥后能立即生效。端点被登记为账号，id 由端点名固定生成，已存在则更新，不存在则新增，首个被发现的端点
  自动成为当前账号。密钥每轮从端点 `.env` 现读，不复制到其他位置。登录邮箱与套餐通过同一把密钥查询
  `whoami` 与 `billing/subscriptions` 回填，回填后账号名称即显示邮箱。桌宠是否正在使用该端点由
  `<botDir>/config.json` 的 `activeProvider` 判定。

- **manual**：在面板中手动添加的账号，用于不在桌宠端点中的凭证。密钥经 `ctx.storeSecret` 写入部署目录的
  `.env`，变量名形如 `QUOTA_COMMANDCODE_1`，账号表仅保存变量名与尾四位。只有此类账号可在面板中删除。

取数所用密钥的优先级为：当前账号的密钥，其次为配置中手填的密钥，再次为环境变量、登录文件、指定的 `.env`。
切换账号会重置提醒游标，游标按账号 id 分组。账号仅服务于本页的额度与价目取数；桌宠对话所使用的端点由
「模型供应商」页决定。

Command Code 不提供账号密码登录接口。官方 CLI 的登录采用浏览器 OAuth，因此无法在面板中通过账号密码切换账号。
面板显示的邮箱由端点密钥调用 `whoami` 获得，并非读取浏览器 cookie。详见 `docs/VENDORS.md`。

## 取数策略

- 进入页面时先由 `state` 渲染已有读数，再执行一次 `refresh` 取网络数据；其后不再自动取数，如需更新则使用各
  卡片的按钮，包括额度「刷新」、模型「刷新」与价目「抓取」。
- `state` 仅返回内存中的读数，例外情形是 Hermes 统计范围变化时重新读取本机数据库。
- World 的后台轮询（`worlds.quota.pollMinutes`，默认 10 分钟）只服务于阈值提醒。设为 0 时，取数仅发生在面板
  操作或工具调用时。

## 计划页与价目页

计划可用模型、单价与计划额度在官网页面提供，无对应接口，因此采用页面解析，实现见 `src/pricing.ts`。

- 计划页 `https://commandcode.ai/docs/plans/<go|goat|pro|max|ultra|provider|teams-pro>` 为服务端渲染，包含
  三张以模型名对齐的表格：模型与上下文及单价；按模型的请求额度；按模型的月度额度。
- 全局价目页 `https://commandcode.ai/docs/resources/pricing-limits` 的模型数据位于 Next.js 的 RSC JSON 中，
  渲染结果为 CSS grid 而非 `<table>`，因此优先解析该 JSON，失败时回退解析表格。
- 解析过程全程容错：`$0.10` 解析为 0.1，`Free` 解析为 0 并置 `free` 标记，`—` 解析为 null，脚注内容归入
  `caps`。无法识别的内容只会使对应字段缺失，并记录到 `notes`，不抛出异常。
- 解析结果缓存于 `<ctx.dataDir>/quota/plan-<slug>.json`，默认有效期 12 小时。请求失败时使用缓存，包括已过期
  的缓存，并附带 `reason` 说明。面板的「抓取」按钮传入 `maxAgeMs: 0` 以强制重新获取。
- planId 到 slug 的映射由 `planSlugFor` 提供，无法识别时回退至全局价目页。账号或套餐变更导致 planId 变化时，
  自动重新获取。

## 供应商接缝

`src/sources.ts` 中包含一张供应商登记表。commandcode 已实现 `fetchQuota`、`fetchModels` 与 `planPageUrl`；
其余 8 家仅有 `implemented: false` 与说明字段，分别记录所需凭证与取数位置，均为候选待核实项。切换到未实现的
供应商时不发起任何请求，读数栏显示「未实现」。当前供应商保存在 `worlds.quota.source`，面板下拉框直接写入该
配置项。

## 面板实现要点

### 按钮样式

控制台的页面级样式将 `.btn` 重定义为透明背景与透明边框，仅在悬停时改变颜色；`.btn.sm` 尺寸较小，在表格中与
普通文本难以区分。扩展在 `.quota-shell` 作用域内重新定义按钮外观，包含浅色填充、可见描边、阴影与按下位移，
颜色由 `color-mix` 从主题变量调和，兼容浅色与深色主题。该做法不修改框架样式，不受框架升级影响。

### 「配置」页签与保存语义

框架的配置页采用 400 毫秒防抖即时保存，输入过程中即会写入配置，没有「先编辑、后提交」模式。为避免数值输入到
一半被存入，扩展不将配置段声明给框架，而是自行声明第二个面板作为「配置」页：框架中每个面板对应一个页签，因此
第二个面板即为所需页面。该页以分组表单呈现提醒、连接与路径三类字段，底部设有「保存」按钮，点击后调用
`invoke('saveSettings')`，由 World 端逐字段校验并夹紧取值范围，再通过 `ctx.persist` 一次性写回。路径类字段
使用 `ctx.pickPath` 提供本机选择器。密钥输入框留空表示保持原有密钥，避免保存时清空已存内容。

框架的 `POST /api/config` 实际接受未声明的配置键，只是不对其进行渲染，因此不声明并不阻止写入。

## 已知问题与处理

1. **vitest 无法解析 `node:sqlite`**。静态导入与动态导入均会被解析为名为 `sqlite` 的第三方包。解决方式为使用
   `createRequire(import.meta.url)('node:sqlite')`，`src/hermes.ts` 采用该写法。
2. **面板产物只能以 `import type` 引用框架**。任何运行时导入都会导致 esbuild 报模块无法解析。因此共享类型
   集中定义在 `src/view-types.ts`，该文件不引用任何带 Node 依赖的模块，浏览器侧 tsconfig 也能编译。
3. **浏览器侧 tsconfig 需启用 node 类型**。面板所引用的类型链会涉及带 `node:` 内置模块的框架源码，
   Coopanion 自身的 web tsconfig 亦采用相同设置。
4. **普通模式不显示该页面**。Coopanion 普通模式的左栏不包含扩展贡献的页面，扩展页仅在高级模式下出现。因此
   提醒功能通过气泡呈现，页面访问需切换至高级模式。
5. **提醒去重依赖游标**。游标形式为「窗口、重置时刻、档位」。窗口重置后 `resetAt` 变化，同一档位才会再次提醒；
   服务端未提供 `resetAt` 时，退化为以订阅周期为锚点，避免每轮重复提醒。
6. **契约包的双重解析**。开发期 `cortico/*` 由 npm 上的 `cortico` 包解析；装入宿主后由框架的模块钩子解析到其
   自身运行的源码。两处的 `WorldDefinition` 形状一致，契约号均为 5。
7. **sparse-checkout 会导致角色资源缺失**。仅检出部分目录时，角色资源目录不在工作树中，切换至该角色会失败并
   回退为默认角色，且回退结果会写入配置。操作该仓库时应使用完整检出。
8. **依赖需要重建的情形**。非交互环境下启动源码实例时会校验依赖状态，不匹配时尝试重建，缺少 TTY 会报错，
   设置 `CI=true` 后执行一次 `pnpm install` 即可。`electron` 的 postinstall 常被跳过，需手动执行
   `node_modules/electron` 目录下的 `install.js`。网络受限时同时配置 registry 与 Electron 镜像。
9. **真实宿主与测试替身的 DOM 差异**。`ctx.ui.sheet()` 生成的结构为 `div.sheet.tabbed > h3 + .sheetbody`，
   而非 `section.sheet`，DOM 断言须按真实结构编写。
10. **路由中的页面 id 经过编码**。导航地址形如 `#/provider/world%3Aquota`。此外普通模式会将非桌宠页面重定向，
    访问该页面需先切换至高级模式，即设置 `localStorage['companion.mode']` 为 `advanced`。
11. **面板产物存在 HTTP 缓存**。产物响应头为 `Cache-Control: public, max-age=31536000, immutable`，URL 中仅
    包含包版本号。版本号不变时，此前获取过旧产物的客户端在有效期内不会重新请求，于是出现代码已更新而页面仍为
    旧版的现象。可靠的处理方式是提升 `package.json` 的版本号使 URL 变化，再重启应用；使用方重新打开页面即可。
    渲染检查脚本为每次运行指定独立的 `userData` 目录并禁用 HTTP 缓存。
12. **长页面整页截图会超时**。内容高度超过视口且卡片头为固定定位时，整页截图会在等待字体阶段超时。改为提高视口
    高度后截取视口，并允许截图失败不影响整体判定。
13. **World 的目录与秘密存储**。`ctx.dataDir` 为桌宠实例的数据目录，不是应用数据根目录；`ctx.storeSecret` 的
    实现为写入 `<botDir>/.env` 并同步进程环境，`ctx.secret` 读取时以进程环境优先，其次为该 `.env` 文件。写入
    缓存文件前需自行创建目录。
14. **面板调用的方法须与 World 的分支一致**。面板调用的每个方法名均须在 `world.ts` 的 `invoke` 中有对应分支，
    否则返回 500。该问题在 jsdom 替身中不会暴露，仅在实际控制台中出现，因此渲染检查应对可交互元素执行真实点击，
    而不只断言文案。

## 与官方安装版的兼容性

Windows 安装版的数据目录位于程序目录旁的 `data\`。位置判定顺序为环境变量 `CORTICO_COMPANION_DATA`、程序旁的
`data\`、`%LOCALAPPDATA%\Coopanion\data-location.json` 中记录的位置，实现见 `app/data-dir.cjs` 的 `locateData`。
由于程序旁的 `data\` 优先级最高，迁移时将原实例的 `data\home` 与 `data\extensions` 复制进 `<安装目录>\data`
后再首次启动，即可继承配置、记忆、角色与端点凭证。安装器不修改 `data\`，卸载时亦保留。

扩展在安装版中的识别条件为：`extensions\package.json` 的 `dependencies` 中包含包名，且包位于
`extensions\node_modules\<包名>`，两处需同时满足。源码实例使用 `link:` 软链，安装版使用实体副本，避免仓库移动
或删除后链接失效。复制工作由 `scripts/sync-extension-to-app.mjs` 完成。

上游 v0.2.x 调整了控制台路由：清单由 `/api/console/manifest` 改为 `/api/webui/manifest`，面板方法由
`/api/console/providers/<页>/panels/<面板>/<方法>` 改为 `/api/webui/providers/...` 且仅接受 POST 请求，设置页
路径调整为 `/coopanion/<hash>`。契约号为 5 的扩展仍可正常加载，官方发布说明指出按旧接口编写的扩展可继续使用，
至下一个大版本为止。自检脚本兼容新旧两套路由。

其他注意事项：包含中文字符的 PowerShell 脚本须保存为带 BOM 的 UTF-8，否则 PowerShell 5.1 会按 ANSI 解析并在
字符串处报语法错误。仓库目录改名后，pnpm 在 `node_modules` 中创建的绝对路径软链会全部失效，实际文件位于
`.pnpm` 目录下，重新执行一次 `pnpm install` 可修复。

## 兴趣推送实现要点

### 取数

- **Crossref 用记录创建日期**：期刊常把期号日期标到明年，`filter=from-pub-date` 与 `sort=published`
  会把一堆未来日期顶到列表最前。改用 `from-created-date` / `until-created-date` 与 `sort=created`，
  展示日期优先 `published-online`，其次 `created`，最后才 `issued`。
- **Elsevier 不给摘要**：Crossref 的 `abstract` 字段对 EAAI、Measurement、Applied Soft Computing、
  Expert Systems with Applications 等普遍为空，OpenAlex 对新文章也常没有。因此按 DOI 两级回填：
  先 OpenAlex（一次可查 25 个 DOI 的倒排索引），再 Semantic Scholar（一次 POST 最多 500 个 DOI）。
  两处都没有的条目在列表里标「无摘要」，推送时优先挑有摘要的。
- **arXiv 分类 RSS 不接受检索式**：`rss.arxiv.org/rss/<cat>` 只给该分类当日新条目，关键词加在 query 上会被忽略，
  周末还是空的。改用 `export.arxiv.org/api/query`，按 `all:"短语"` 之间 OR 检索、按提交时间排序。
- **Hugging Face 日榜是整条 AI 榜单**：不加过滤会把 40 条通用 AI 论文灌进列表。`relevance.ts` 做相关性判定
  （命中关键词短语，或两个以上关键词词根，或两个以上领域兜底词），实测把 39 条压到 3 条。

### 调度

- 检查与打扰分开：`checkTimer` 按 `checkMinutes` 抓取只更新列表；`pushTimer` 只在下一次推送时刻到点触发，
  到点才走 `schedule.decide`（静默时段、星期、每日上限、同窗口只推一次、暂停全部在这里挡）。
  只用一个定时器会漏窗口——检查间隔若不落在窗口内，推送永远不会发生。
- `state.json` 里的 `answerCursor` 记录读到哪条事件；收到 `desktop-pet.answer` 回执时，用事件库往前找最近的
  `news.item` 认领归属，命中「不感兴趣」一类的词就把它记进 `dismissed`，不再推送。

### 翻译

- 用桌宠自己配置的模型端点，读法同用量额度扩展：`<botDir>/config.json` 的 `activeProvider` 指向
  `<botDir>/../providers/<端点>/config.json` 与同目录 `.env`。**providers 在 botDir 旁边而不是里面**，
  只找 `<botDir>/providers` 会一直报「找不到可用的模型端点」。
- 请求体 `POST {baseUrl}/responses`，`input` 用 `[{ role, content: [{ type: 'input_text', text }] }]`。
  响应里推理与正文是两类 item：`{type:'reasoning', content:[{type:'reasoning_text'}]}` 与
  `{type:'message', content:[{type:'output_text'}]}`。只取后者——先前的实现把所有 item 的文本拼起来，
  译文里混进了模型的思考过程。
- 译文按条目落盘，缓存键是「提示词版本 + 模型 + 术语表哈希」：改术语表或换模型会自动重译，改提示词措辞时
  手动提升 `PROMPT_VERSION`。
- 摘要下载非开放获取时不给 PDF：`pdfUrl` 只在源明确给出可公开取的 PDF（arXiv、PMC、DOAJ 或 `.pdf` 直链）
  时才填，其余给「打开原文」，不绕付费墙。

### 面板

- **推送页（原「详情」）排第一**，并且 `activeItem()` 在没显式选过时默认落在最新一条上：这一页打开就该有内容，
  否则首屏只会看到一句「还没有条目」。选中的条目被挤出列表时也回落到第一条。页签名是「推送」，卡里那块仍叫「详情」。
- **速览卡把标题与摘要合在一起**：标题一行加粗、摘要一段浅色并用一条分隔线隔开；源没给摘要时写明原因而不是留白；
  译文卡与它同构，翻译按钮夹在原文与译文之间。
- **键值表第一列用 width:1px 加 nowrap**：框架的 kvtable 首列是固定 40% 宽，照搬会留下一大片空白；
  缩到内容宽才贴得紧。空态提示（placeholder）默认居中且上下留 30px，面板里改成靠左收紧。
- **配置逐组保存**：四组卡片各有「保存本组」，一次写回整段配置，然后**回读校验**——值确实变了说明写回成功，
  与提交值一致提示「已保存」，被夹到合法范围时提示「个别数值按合法范围调整」，请求出错提示「未生效，请重试」。
- **能选就别打**：推送时刻与静默起止用 00:00–23:45 的下拉菜单（一刻钟一档，能设 10:15），星期用七个可切换按钮，
  短字符串（时刻、关键词、arXiv 分类）做成标签横排，减少手打与占位。
- **模型输出格式变了要升 `PROMPT_VERSION`**：翻译的拆解规则或提示词措辞一改，旧缓存就不该再用；
  只改代码不升版本号会一直读到按旧规则拆的缓存（一次「译文只有标题」的现象就是这么来的）。
- 每页面板的数据面方法走 `POST /api/webui/providers/<页>/panels/<面板>/<方法>`，**请求体是 `{ args: [...] }`**，
  不是裸数组；裸数组会被当成空参数（调试时容易误判成「方法没生效」）。
- 面板只能调自己那页的方法：把「立即检查一次」「立刻推一条」放在 `invoke` 顶端对三个页签统一放行，
  而不是让列表页去调配置页的方法。
- 列表页点击条目后，尽力把 hash 切到详情页签（`#/provider/<页>/<面板>`）；切不过去也不影响使用，
  详情页签自带条目下拉。

### 事件与提示词

- **事件正文里要写清「该做什么」**。人设里写着「安静也是一种回答」，只在系统前缀里交代用法时，
  bot 收到推送会直接 `end_turn` 不出声。把一句「请按环境提示词开口：先 pet_say 再 pet_ask，不要沉默」
  放进事件正文第一行后就正常开口了——正文就在模型眼前，比远处的系统前缀管用。
- **环境提示词里的占位符名不能带连字符**。模板渲染只认 `[\w.]` 一类的名字，`{{interest-push.status}}`
  会被原样留成字面量；改成 `{{interestpush.status}}` 才替换。
- **事件不要带 `snapshot` 标签**。那是状态类事件的保留语义，普通通知照 World 的默认投递即可（额度那次也没带）。
- **问答回执要尽快认领**。`desktop-pet.answer` 一到就该把对应条目记成已读、必要时记成「不再推送」；
  挂在两小时一次的检查里会拖很久才生效，改为 15 秒一次只读事件库的扫描（不发网络请求）。
  归属靠「回执之前最近的一条 `news.item`」：`senderKey` 就是条目编号。

### 面板（续）

- **`ctx.invoke(method, args)` 的第一个参数是方法名，不是页签名**。面板由 `ctx.panelId` 决定，
  写成 `ctx.invoke('detail', ['next'])` 会当成「调用 detail 这个方法」，落进未知分支却仍返回一份视图，
  表面上页面不报错，实际什么都没做——「刷新」「换一篇」「翻译」因此全部失灵过一次。
  渲染检查现在会真点「换一篇」和「保存本组」，把这类哑失效挡住。
- **时刻选择做成「时 + 分」两个下拉**：单一 96 项的下拉不好翻，直接手打又容易写错；两栏点选即可，
  存量里不在 5 分钟档上的值会临时补一个选项，原值照旧显示。

## 隐私约定

仓库内的文档与测试夹具统一使用 `test@gmail.com` 与 `C:\Users\user\...` 作为占位值，不包含真实账号邮箱与本机
用户名。`docs/panel*.png` 为真实控制台截图，包含账号邮箱与密钥尾号，因此未纳入仓库。提交作者信息保留本人身份，
不参与打码。历史内容的清理使用 `git filter-branch --tree-filter` 逐个提交处理，处理前需备份 `.git`。内容变更
会导致提交哈希变化，文档中引用旧哈希的位置须同步更新。
