# 验证记录

本文档记录各阶段执行的验证项目、结果与未验证项。验证环境为 Windows 11，Node 24.21.0，Electron 44.4.4。

## 1. 单元测试与类型检查

```bash
cd extension
npm run typecheck     # Node 侧与浏览器侧两份 tsconfig
npm test
npm run build
```

当前结果：两份 tsconfig 均无错误；`vitest run` 共 88 项测试通过，分布如下。

| 测试文件 | 项数 | 覆盖内容 |
|---|---|---|
| `commandcode.test.ts` | 14 | 三个接口的解析，含字段缺失与异常值类型；套餐名与月度额度换算；重置时刻的三种写法；密钥来源的四层顺序；401 与网络中断 |
| `hermes.test.ts` | 4 | 真实 sqlite 聚合，含按模型与端点分组、时间窗口过滤、日粒度统计、会话计数；数据库缺失；导出文件回退 |
| `alerts.test.ts` | 7 | 阈值与用尽的区分；同窗口同档位只提醒一次；窗口重置后可再次提醒；月度额度百分比 |
| `accounts.test.ts` | 8 | 密钥尾四位掩码；变量名避让；落盘与损坏文件处理；增删与切换；账号密钥优先级 |
| `sources.test.ts` | 3 | 登记表形状；未实现供应商的说明字段完整性；Command Code 三个方法的归一化 |
| `pricing.test.ts` | 16 | 计划页三张表对齐；全局价目页 RSC JSON 解析；容错；缓存与回退 |
| `world.test.ts` | 15 | 挂载取数与提醒触发；提醒关闭与阈值 0 时不触发；无密钥时不抛异常；提示词、工具与控制台声明；账号增删切换与提醒游标按账号隔离；账号表落盘后重建实例仍然生效；`saveSettings` 的取值夹紧与写回 |
| `native.test.ts` | 5 | 端点凭证目录的识别；仅匹配指向 commandcode.ai 的端点；每轮重新扫描 |
| `console-panel.test.ts` | 16 | 面板挂载渲染各卡片；刷新与统计范围切换；密钥与 Hermes 数据缺失时的提示；账号与供应商交互；价目表渲染与空态；「配置」页签的表单与保存载荷；路径选择器数量 |

## 2. 官方契约校验

```bash
cd <Cortico 检出>
pnpm install --ignore-scripts
pnpm check:extension <扩展目录>
```

结果：

```
框架契约: world v5 / provider v5 / bot v6
  ✓ manifest: kind=world, api=5
  ✓ 默认导出符合 world 的形状; id = quota
  ✓ 浏览器端产物: dist/webui.js （页 id world:quota）
  ✓ 浏览器端样式: dist/webui.css
  ✓ defaults() / create() / tools(): quota_status, quota_hermes / envPromptVars() / console()
扩展检查通过。
```

`console()` 的声明为 2 个面板、0 个配置组、1 份提示词文档。

## 3. 源码实例的端到端检查

实例为 Coopanion `pnpm run dev`，扩展以目录联接方式装入 `build/data/extensions`，控制台位于
`127.0.0.1:17788`。

```bash
node scripts/verify-instance.mjs 17788 --alerts
```

结果为 14 项全部通过，包括控制台可用、扩展已加载、清单中存在 `world:quota` 且面板产物可取、World 处于
`active` 且提供两个工具、数据面 `state` 返回正常、额度与 Hermes 用量可读、密钥来源可识别、提醒事件进入事件库
且正文只陈述事实。事件库中的记录 `origin` 为 `internal`，`contextDelivery` 为 `deliver`，即会进入 bot 上下文
并由 Coo 决定是否提示。

## 4. 控制台渲染检查

```bash
node extension/scripts/check-panel-render.mjs <端口> [electron.exe]
```

脚本启动一个最小 Electron 窗口打开该页面，经 CDP 读取 DOM，验证面板已挂载、进度条与表格已渲染、数据已取到、
面板产物请求正常、页面无报错，并可选地截图。该页面仅在高级模式下出现于左栏，脚本会预先将
`localStorage` 中的 `companion.mode` 设为 `advanced`。不提供 Electron 路径时，脚本会在仓库内自动查找。

## 5. 多账号、供应商接缝、模型与价目

本轮增加账号的增删切换、供应商下拉、可用模型清单、计划价目与按模型额度。测试增至 73 项，两份 tsconfig 无错误，
契约校验通过。真机核对结果：

```
state    → accounts {activeId: null, list: []}；sources 9 项（commandcode 加 8 个未实现）；
           models 89 个；pricing GOAT 计划 65 行，来源为实时抓取
pricing  → 强制重抓得到 65 行，示例：Claude Haiku 5.5 单价 $0.10/$0.50 每百万 token，
           请求额度 5 小时 5970、每周 14900、每月 29900，月度额度 $20；
           DeepSeek V4.1 Flash Fast 单价 $0.16/$0.58，月度额度 $60；
           免费模型单价记 0 并标注 free
models   → 89 个模型，来自 /provider/v1/models
addAccount（无效密钥）→ HTTP 500 并返回密钥被拒绝，账号表保持为空，部署 .env 中未产生 QUOTA_ 变量
价目缓存 → <dataDir>/quota/plan-goat.json
```

控制台渲染检查通过，7 张卡片与价目表均正常渲染。

本轮发现的问题：渲染检查读取到的是旧面板产物。面板产物 URL 中仅含包版本号，Electron 的 userData 中的 HTTP
缓存将上一次运行的旧 `console.js` 提供给页面，导致页面内容与代码不一致。处理方式为渲染检查每次运行使用独立的
`app.setPath('userData', ...)` 并禁用 HTTP 缓存。

## 6. 账号改为端点自动记录与取数策略调整

本轮将账号来源改为桌宠端点凭证的自动记录，取数改为进入页面拉取一次并由按钮手动刷新，供应商卡片仅保留下拉框，
说明迁移至 `docs/VENDORS.md`。扩展版本为 0.1.2。

测试 85 项通过，两份 tsconfig 无错误，契约校验通过。真机核对结果：

```
state    → 0.02s 返回，读取内存中的读数
refresh  → 2.30s，执行网络取数
账号栏   → { id: acc_native_commandcode, label: test@gmail.com, email: test@gmail.com,
            planLabel: GOAT, keyHint: ••••xYkS, origin: native, active: true, inUse: true }
            id 由端点名固定生成并每轮更新；邮箱与套餐由端点密钥查询 whoami 与 subscriptions 回填
sources  → 9 项，面板仅显示下拉框
models   → 89 个；pricing → GOAT 计划 65 行
渲染检查 → 7 张卡片正常；账号表 1 行，供应商表 0 行
```

## 7. 按钮样式与会话保存

问题为面板中按钮与普通文本难以区分，框架配置页缺少保存按钮且采用即时保存。处理方式见 `docs/NOTES.md` 的
「面板实现要点」。测试增至 87 项，两份 tsconfig 无错误，契约校验通过，扩展版本由 0.1.3 升至 0.1.4。真机结果：

```
GET /api/config              → world:quota 声明 7 个字段（source、monthlyAllowanceUsd、commandcodeKey、
                               commandcodeBaseUrl、hermesHome、envFile、authFile），
                               阈值、间隔、统计天数不再出现在配置页
invoke saveSettings          → 返回 200，view.config 立即更新，config.json 中 worlds.quota 同步落盘
渲染检查                     → 7 张卡片正常
视觉复核                     → 「刷新」与「手动添加账号」具有填充、描边与圆角，可识别为按钮；
                               「桌宠在用」保持状态标签形式
```

## 8. 「配置」页签与价目表列调整

本轮将行为类设置移至自定义的「配置」页并提供保存按钮，价目表去除三列请求额度，仅保留月度额度。实现方式为不再
声明框架配置组，改为声明第二个面板 `settings`，表单底部设置保存按钮，通过 `invoke('saveSettings')` 与
`ctx.persist` 一次性写回。测试 88 项通过，两份 tsconfig 无错误，契约校验通过，扩展版本 0.1.5。真机结果：

```
manifest        → panels=quota,settings；configGroups=0
verify-instance → 12 项全部通过
渲染检查        → 用量额度页 6 张卡片；价目表表头为模型、上下文、输入/M、输出/M、缓存读/M、缓存写/M、
                  月额度 $，并确认不含 5 小时额度与周额度列；
                  「配置」页签包含提醒阈值、Hermes 数据目录、Command Code 密钥，1 个保存按钮，
                  3 个路径选择器
```

## 9. 迁移至官方安装版 v0.2.4

迁移方式为先将原实例的 `data\home`（包含角色配置 `skin.figure=whale`、记忆工作区、账号表与端点凭证）与
`data\extensions` 复制到 `D:\Sorftware\Coopanion\data`，再以 `Coopanion-Setup-0.2.4.exe /S /D=...` 静默安装
并启动。结果：

```
安装        → D:\Sorftware\Coopanion\Coopanion.exe（245 MB，安装包未做数字签名）；预置的 data\ 未被安装器修改
首次启动    → 约 12 秒后控制台 127.0.0.1:17788 返回 200
              日志记录 World 已启动：console、desktop-pet、coopanion、quota
数据继承    → /api/status：displayName=Coo，modelConnection=CommandCode 且 ready=true，
              loop.messageCount=355（历史会话已继承）
角色        → config.json 中 figure=whale、scheme=deepseek、outfit=maid；桌宠页 7797 返回 200
扩展        → /api/extensions：cortico-world-quota@0.1.5 loaded=true
              /api/webui/manifest：world:quota 状态为 active，2 个灯，5 个徽章，面板为 quota 与 settings
自检        → node scripts/verify-instance.mjs 17788 → 12 项全部通过，含新版路由 /api/webui/manifest
              与面板产物 /assets/extensions/cortico-world-quota/0.1.5/console.js（29.8 KB）
渲染检查    → 13 项全部通过：6 张卡片、3 条进度条、价目表仅保留月度额度、「配置」页签含保存按钮与 3 个
              路径选择器
同步脚本    → node scripts/sync-extension-to-app.mjs 完成构建与复制
快捷方式    → 桌面「桌宠 Coo.lnk」指向 D:\Sorftware\Coopanion\Coopanion.exe
目录调整    → 项目目录由 Coopanion-Usage 迁至 D:\Work_AI\Git_Lu\CooLuCostom，仓内路径引用同步更新，
              源码实例中的扩展链接已重新指向
```

## 10. 仓库上传前的隐私处理

处理规则与实现见 `docs/NOTES.md` 的「隐私约定」。核对结果：仓库可达历史中的每个提交均不含真实邮箱、
校邮箱与本机用户名；三个提交中曾跟踪的真实控制台截图已从全部提交中移除；提交作者信息按本人身份保留。
远程仓库的默认分支与本地 HEAD 一致，文件清单共 59 项，不含 PNG 文件。

## 11. 未验证项

- **官方安装版的升级路径**：本机未执行过完整的版本升级流程，因此「升级后 `data\` 与扩展保留」的结论来自
  `installer/nsis.nsh` 的 `customRemoveFiles` 信息与 `app/main.cjs` 的 `CORTICO_EXTENSIONS_DIR` 设置，未经
  实际升级验证。
- **Coo 实际播报提醒内容**：源码实例未配置可用的模型端点，因此仅验证到事件进入事件库并标记为待投递。
- **`ctx.storeSecret` 写入 `<botDir>/.env`**：该路径仅在单元测试中通过替身验证。框架实现为写入
  `<botDir>/.env` 并同步进程环境，与面板文案一致。
- **多账号的界面表现**：实际环境中只有一个账号（桌宠中的 Command Code 端点）。多账号场景由单元测试覆盖。
- **Command Code 的 OAuth 登录**：未实现。官方 CLI 采用浏览器 OAuth 流程，令牌写入
  `~/.commandcode/auth.json`；本机未使用过该登录方式。面板采用端点密钥查询 whoami 的方式获取账号信息。
- **面板产物的浏览器缓存**：产物 URL 中仅含包版本号，不含内容哈希，因此修改后需提升版本号并重启进程。
- **`--background` 参数的行为**：源码中仅存在写入该参数的位置，未发现对应的判断逻辑，其实际效果未验证。
- **日志中的重试记录已定位**：`Provider attempt failed; retrying { err: 'Delta before content part' }` 来自
  `protocol/open-responses/stream.ts` 的解析器——它要求同一个内容段先有 `response.content_part.added` 才有增量。
  本机 Command Code 端点在**开启思考**时先发一串 `response.reasoning.delta`（不带 `.added`），解析器因此拒绝；
  以 `reasoning: { effort: 'none' }` 或 `'minimal'` 请求时流是合规的（`content_part.added` → `output_text.delta`
  → `done`）。这是端点协议与框架解析器的兼容问题，与扩展无关，但会让桌宠在开启思考时无法回话。
- **论文推送的气泡实测：已通过**。端点思考等级改为 `none` 后，实测一次推送得到完整气泡对话：
  `pet_say`（带人设口癖与表情标记）→ `pet_ask`（三个选项）→ 使用者点选 → 继续深讲两段；
  回执 `desktop-pet.answer` 落库，对应条目在工作台里被认领为已读。

## 12. 论文推送扩展的验收

`extension-interest-push`（`cortico-world-interest-push`，World id `interest-push`）。

单元测试与类型检查：

```bash
cd extension-interest-push
npx vitest run           # 12 个文件 160 项通过（含「换一篇」「无摘要只翻标题」「陈旧 HF 条目会被清掉」
                         #   「补到的摘要写回已有条目」「只推有摘要的条目」「按标题补摘要的标题匹配」
                         #   「兴趣记录增删落盘」「可选配额密钥」等用例）
npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.web.json --noEmit   # 0 错
npm run build            # dist/webui.js ~20 KB · dist/webui.css ~3 KB
```

覆盖面：Crossref / arXiv / 每日论文榜三种源的规范化与抓取参数、arXiv 检索式与 Atom 解析、相关性过滤、
OpenAlex 与 Semantic Scholar 的摘要回填、去重落盘、调度判定（窗口内首推、同窗口只推一次、窗口外、
静默、星期、每日上限、暂停）、术语表解析与哈希、骰子提示词与译文提取、World 的抓取/推送/回执/配置夹紧/翻译
链路、控制台声明。

真机（官方安装版 v0.2.4，`D:\Sorftware\Coopanion`）：

| 检查 | 结果 |
|---|---|
| 实例自检 `node scripts/verify-instance.mjs --alerts` | 31 项通过（含论文推送：manifest 页与四个页签、产物可取、World 激活与三条读数、列表数据面、条目字段、调度读数、设置项齐全、分区标签，以及**推完「推送」页跟到刚推那篇、连点两次不会连着推同一篇、第二次推完页签也跟过去、推送正文第二行是速评与分数**；quota 的提醒窗口那一项会因「该窗口已提醒过」偶发不过，与扩展无关） |
| 渲染检查 `node extension-interest-push/scripts/check-panel-render.mjs 17788` | 41 项通过（新增「字段排版整齐：标签等宽、不压控件」）（含六次真点击：换一篇切到下一篇、点一次速评拿到星星与分数、点一次翻译看到「翻译中…」→「翻译成功」、保存本组提示已保存、收进兴趣记录后「兴趣记录」页确实多出一行、记录行带打开原文与移除） |（推送页排第一且自上而下为「大肥鱼速评 / 论文速览 / 中文译文 / 详情」、速度卡是 10 星制、速览里标题与摘要都有内容、翻译按钮在摘要下方、刷新与换一篇、已取消下拉、详情键列不再占固定宽度、列表 60 条且不出现「未读」字样、配置四组卡片、时刻与关键词为标签、时刻菜单能选到 10:15、星期七个按钮全亮且独占一行、期刊表有表头且第四列已取消、期刊 28 行 × 4 格、术语 46 行 × 2 格且标签里没有「每行」说明、两个编辑表格完全展开无滚动、每组一个「保存本组」、路径选择器、无资源失败） |
| 真实抓取 | 一轮 190 条，入库 60 条：Crossref 43（28 家期刊）、arXiv 14、每日论文榜 3（相关性过滤前 39）；日期最新 2026-10-18，无未来日期 |
| 摘要回填 | OpenAlex 与 Semantic Scholar 两轮合计补 31 条；两处都没有的条目在列表标「无摘要」 |
| 端点思考等级 | `providers/CommandCode/config.json` 的 `thinking` 由 true 改为 false、`reasoningEffort` 由 low 改为 none（改前已备份）|
| 气泡对话 | 实测一条推送：`pet_say` 说一两句（`【星星眼】…库…<excited>`）→ `pet_ask` 给三个选项 → 使用者点选 → 再深讲两段；回执被认领为已读 |
| 翻译 | **标题与摘要一起翻**，按「第一行标题、空行、摘要」拆开：有摘要的条目 13.0 秒给出两段（标题`SETAREH 变换：一种…`、摘要术语与数字保留），无摘要的条目 4.1 秒只给标题译文并落在标题位；第二次命中缓存 0.01 秒 |
| 换一篇 | 在详情页点「换一篇」切到列表顺序的下一条，末尾回到第一条 |
| 配置逐组保存 | 每组保存后回读校验：一致提示「已保存」，被夹到合法范围提示「个别数值按合法范围调整」，请求出错提示「未生效，请重试」 |
| 下载原文 | 开放获取条目落盘 704572 字节到 `<数据目录>/news/papers/<编号>-<标题>.pdf` |
| 摘要策略 | 一轮抓 120 条（延迟窗口跳过最近 14 天）：列表从 54 条（37 条无摘要，68%）缩到 **17 条、无摘要 0 条**；Crossref 从未给这几家刊摘要（2024 年的记录也没有该字段），老文章的摘要来自 OpenAlex |
| 期刊延迟窗口 | `journalDelayDays` 默认 14；实测抓取量 187 → 120 条，且名单里不再出现「年轻又无摘要」的条目 |
| 事件投递 | `news.item` 进事件库，正文含标题、期刊与分区、作者与团队、DOI、爬取源、摘要、编号 |
| 框架自带契约检查 | 未运行：上游源码树的依赖在目录改名后成断链，需 `CI=true pnpm install` 修复；等价的加载与声明校验由实例自检与真机加载提供 |

未实测：桌宠按提示词脚本进行气泡多轮对话（原因见第 11 节末两条）。
