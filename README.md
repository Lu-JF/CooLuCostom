# CooLuCostom

面向桌宠 [Coopanion](https://github.com/Pal-AI-Lab/Coopanion) 的两个扩展，均以 Cortico World 包形式提供，
不修改 Coopanion 源码，装上后在控制台出现为独立页面。

| 扩展 | 包名 | World id | 控制台显示名 | 作用 |
|---|---|---|---|---|
| 用量额度 | `cortico-world-quota` | `quota` | 用量额度 | 看套餐额度、滚动窗口与本机 Hermes 用量，越阈值时让桌宠提醒 |
| 兴趣推送 | `cortico-world-interest-push` | `interest-push` | 兴趣推送 | 按节奏抓订阅方向的论文，用气泡对话介绍，详情留在面板里 |

两个包各自独立：数据目录不同、页签不同、提示词不同，可以只装其中一个。

## 仓库结构

```
CooLuCostom\
├─ extension\                 # 扩展包 cortico-world-quota（用量额度）
│  ├─ src\world.ts            # 取数、阈值判定、提醒事件、控制台声明、工具定义
│  ├─ src\sources.ts          # 供应商登记表；Command Code 已实现，其余为预留接缝
│  ├─ src\native.ts           # 读取桌宠端点凭证（providers/<端点>/{config.json,.env}）
│  ├─ src\accounts.ts         # 账号表：只记录变量名与密钥尾四位
│  ├─ src\commandcode.ts      # billing 与 whoami 接口封装、密钥来源判定
│  ├─ src\pricing.ts          # 官网计划页与价目页解析，缓存 12 小时
│  ├─ src\hermes.ts           # 只读 state.db 的 session_model_usage 表
│  ├─ src\console\            # 控制台面板
│  └─ tests\                  # 88 项测试
├─ extension-interest-push\    # 扩展包 cortico-world-interest-push（兴趣推送）
│  ├─ src\world.ts            # 调度、抓取、推送、回执、译文与速评、面板方法
│  ├─ src\fetch.ts            # Crossref 期刊检索
│  ├─ src\arxiv.ts            # arXiv 检索 API
│  ├─ src\hf.ts               # 每日论文榜与相关性过滤
│  ├─ src\backfill.ts         # 摘要回填（OpenAlex / Semantic Scholar）
│  ├─ src\journals.ts         # 28 家期刊与分区标签
│  ├─ src\glossary.ts         # 术语表与默认术语
│  ├─ src\translate.ts        # 学术翻译（不带人设，译文落盘缓存）
│  ├─ src\review.ts           # 大肥鱼速评（每篇一次，落盘缓存）
│  ├─ src\model.ts            # 调桌宠端点：取正文、网络错误重试一次
│  ├─ src\pick.ts             # 自动推送与手动试推的挑条规则
│  ├─ src\schedule.ts         # 窗口、静默时段与星期的判定
│  ├─ src\console\            # 面板（推送 / 列表 / 兴趣记录 / 配置）
│  ├─ src\ENV_PROMPT.md       # 气泡对话的环境提示词
│  └─ tests\                  # 142 项测试
├─ scripts\
│  ├─ verify-instance.mjs        # 对运行中的实例执行只读检查（覆盖两个扩展）
│  └─ sync-extension-to-app.mjs  # 构建面板产物并把两个扩展复制进安装版
└─ docs\
   ├─ NOTES.md           # 接口、配置语义与注意事项
   ├─ VENDORS.md         # 各供应商的接入条件与取数位置
   ├─ INSTALL.md         # 安装步骤
   └─ VERIFICATION.md    # 验证记录与未验证项
```

## 运行方式

| 运行方式 | 桌宠来源 | 扩展安装方式 | 适用场景 |
|---|---|---|---|
| 官方安装版 | `D:\Sorftware\Coopanion\Coopanion.exe`（v0.2.4） | `node scripts/sync-extension-to-app.mjs`，复制到 `<应用>\data\extensions` | 日常使用 |
| 源码实例 | `upstream\coopanion`，`pnpm run dev` 启动 | 控制台「扩展」页填写扩展包的绝对路径 | 扩展开发 |

官方安装版的数据目录位于程序目录旁的 `data\`：`data\home` 存放配置、记忆与角色，`data\extensions`
存放扩展。程序更换目录后，安装版会依据 `%LOCALAPPDATA%\Coopanion\data-location.json` 询问继承既有数据或新建。

## 安装

```bash
# 1. 从官方 releases 获取安装包并按当前用户安装
#    https://github.com/Pal-AI-Lab/Coopanion/releases  →  Coopanion-Setup-<版本>.exe

# 2. 构建面板产物，把两个扩展复制进安装版
node scripts/sync-extension-to-app.mjs
```

安装完成后通过托盘菜单重启桌宠，在控制台左栏切换至高级模式，WORLD 分组下出现「用量额度」与「兴趣推送」。
源码实例的安装步骤见 `docs/INSTALL.md`。

## 构建与测试

两个包结构一致，命令在各包目录内执行：

```bash
npm install
npm run typecheck      # Node 侧与浏览器侧两份 tsconfig
npm test               # 用量额度 88 项 / 兴趣推送 142 项
npm run build          # 生成 dist/console.js 与 dist/console.css
```

`dist/` 为面板产物，manifest 中的 `cortico.consoleClient` 与 `consoleStyle` 指向该目录。

## 验证

```bash
node scripts/verify-instance.mjs <端口>              # 只读检查并启用两个 World
node scripts/verify-instance.mjs <端口> --alerts     # 一并验证提醒链路与推送同步，会真实推一条
cd extension && node scripts/check-panel-render.mjs <端口> [electron.exe]   # 真实控制台渲染检查
cd extension-interest-push && node scripts/check-panel-render.mjs <端口> "" --shot <前缀>  # 附带截图
```

端口取 `core.log` 中记录的 `127.0.0.1:<端口>`，或官方安装版 `data\home\companion\config.json` 的 `web.port`。
检查项与未验证项见 `docs/VERIFICATION.md`。

---

## 一、用量额度（`cortico-world-quota`）

控制台内新增「用量额度」页面，包含：

- **Command Code 套餐额度**：月度余额、5 小时与每周两个滚动窗口、订阅计划可用的模型与单价、按模型划分的额度。
- **账号**：自动使用桌宠中已配置的 Command Code 端点凭证；面板不读取密码，也不要求重复录入密钥。
- **本机 Hermes 用量**：调用次数与 token 统计，按 1、7、30、90 天四个范围切换。
- **阈值提醒**：窗口用量达到设定阈值时产生内部事件，由桌宠以气泡形式提示。

供应商切换以下拉框形式预留，各供应商的接入条件见 `docs/VENDORS.md`。

### 取数策略

进入页面时拉取一次，其后由各卡片的按钮手动刷新，不做自动轮询；后台轮询仅服务于阈值提醒。
面板数据面提供两个方法：`state` 返回当前持有的读数，用于快速出图；`refresh` 执行网络取数并更新读数。

### 数据来源

| 数据 | 来源 | 凭证 |
|---|---|---|
| 套餐额度 | `api.commandcode.ai` 的 `/alpha/billing/credits`、`/alpha/billing/subscriptions`、`/alpha/whoami` | 需要密钥，只读 |
| 模型清单 | `api.commandcode.ai/provider/v1/models` | 无需密钥 |
| 计划价目 | `commandcode.ai/docs/plans/<计划>` 与 `/docs/resources/pricing-limits` | 无需密钥，解析后缓存 12 小时 |
| Hermes 用量 | 本机 `state.db` 的 `session_model_usage` 表 | 只读打开，不写入 |

手动添加的密钥经框架的秘密存储写入部署目录的 `.env`，变量名形如 `QUOTA_COMMANDCODE_1`；
账号表仅保存变量名与密钥尾四位。

---

## 二、兴趣推送（`cortico-world-interest-push`）

按设定节奏从学术数据源抓取研究方向的论文，把命中的条目用**气泡多轮对话**介绍，完整信息留在控制台。

### 页签

| 页签 | 内容 |
|---|---|
| 推送 | 自上而下：**大肥鱼速评**（十星与总分，附两三句评价）→ **论文速览**（标题一行、摘要一段，源未给摘要时写明）→ **中文译文**（与原文同构；「翻译」按钮夹在原文与译文之间）→ **详情**（期刊与分区、上线日期、作者与团队、DOI、爬取源、打开原文、下载原文）。顶部按钮：换一篇 |
| 列表 | 抓到的条目（标题、期刊与分区、上线日期、来源）与速评缩略；已读标「已读」，源未给摘要标「无摘要」，点一条切到推送页 |
| 兴趣记录 | 从「推送」页收下来的条目，按收藏时间倒序；可打开原文、下载、移除 |
| 配置 | 四张卡片，各带自己的保存按钮并在保存后回读校验：推送节奏（频率与上限、时段、星期与暂停）、数据源（研究兴趣、抓取窗口、摘要策略、下载）、期刊集合、翻译术语表。另有「重新爬取一次」与「立刻推一条（试）」 |

编辑方式：推送时刻、研究领域关键词、arXiv 分类是标签（横排，点 ✕ 删除）；时刻与静默起止用「时 + 分」
两个下拉，全程点选；暂停到用日期选择；允许推送的星期是七个可切换按钮且独占一行；期刊集合与翻译术语表
是逐行表格，完全展开、不用滚动。

### 数据源与取法

| 源 | 取法 | 说明 |
|---|---|---|
| 期刊 | Crossref `journals/<ISSN>/works` | 默认 28 家（中科院一区与 JCR Q1），按记录创建日期筛选排序 |
| arXiv | `export.arxiv.org/api/query` | 关键词按短语 OR 检索、按提交时间排序 |
| 每日论文榜 | Hugging Face `api/daily_papers` | 整条 AI 榜单，用关键词做相关性过滤 |
| 摘要回填 | OpenAlex（按 DOI 批量、按标题单查），其次 Semantic Scholar | 出版社常常不存摘要，三层兜底，补上的注明来源，同一条每天再试一次 |
| 翻译与速评 | 桌宠自己配置的模型端点 | `POST {baseUrl}/responses`；翻译不带人设，译文与速评均落盘缓存 |

推送节奏默认：每 120 分钟检查一次，只在 10:30 / 13:00 / 19:30 三个窗口打扰，每天最多 2 条，
22:30–08:30 静默（只检查不打扰），气泡对话最多 3 轮。全部可在「配置」页签修改。

### 大肥鱼速评

每篇论文由桌宠读标题与摘要，写两三句评价并给一个 0–10 的总分（面板为十星）。打分时综合创新点、
领域贡献度、研究方向相关性、实验设置与写作质量，这些只写在提示词里，界面只显示总分。

- **每篇只评一次**：结果落在 `news/reviews/<id>.json`，推送页、列表页与气泡共用同一份。
- **推送页**：速评卡排在论文速览上方；未评过时提供「让大肥鱼评一下」。
- **列表页**：已评的显示星星与评语，未评的给「速评」按钮。
- **气泡推送**：事件正文首段即速评与分数，环境提示词要求先复述速评再介绍论文。

### 摘要缺失与期刊延迟窗口

IEEE 与 Elsevier 家族的刊物（TIE、TIM、Measurement、EAAI、ESWA、Neural Networks 等）在 Crossref 里
**没有 `abstract` 字段**，与取数无关。处理方式：

- **无摘要不推送**（`requireAbstract` 默认开）：条目保留在列表中标记「无摘要」，每日重试。
- **期刊延迟窗口**（`journalDelayDays`，默认 14 天）：跳过最近 14 天发表的期刊文章，等摘要被 OpenAlex
  一类源抓到再收；arXiv 与每日论文榜不受影响。设为 0 关闭。
- **每日重试**：同一条 24 小时后再试一次，一轮最多按标题追问 8 条，补到的会写回已有条目。
- **可选密钥**：OpenAlex 与 Semantic Scholar 的免费额度按 IP 共享，可把 `OPENALEX_API_KEY`、
  `S2_API_KEY` 放进环境变量（不写入配置文件）。

### 推送与「推送」页签对齐

推出去一篇之后，「推送」页签跟到那一篇，页面上看到的始终是气泡刚讲的那篇。

- 定时推送推哪篇，页面切到哪篇。
- 「立刻推一条」以页面上那篇为准；若它已推过、无摘要或判过「不感兴趣」，顺延到下一篇能推的，推完页面跟过去。
- 手动试推不计入每日条数。

### 配置何时生效

- 保存配置后立即重排两个定时器（周期性抓取与下一次推送窗口），改推送时刻、星期或检查间隔都不需要重启。
- 配置会写入 `news/config-snapshot.json`。安装版升级偶尔会把 `worlds.interest-push` 重置为默认值，
  启动时若发现期刊从多家变成不足 5 家、或推送时刻被清空，会用快照恢复并写回配置。
- 静默时段覆盖某个推送时刻时，该窗口本次不推送（也不会补推），配置页会在「时段」下方以提示条列出这些时刻。

### 界面

配色取 DeepSeek 深蓝（`#4D6BFE`）配大肥鱼的浅蓝，星星为金色；颜色均由主题变量混色，深色模式自动适配。

- 按钮有底色、描边与悬停反馈；主操作（换一篇、翻译、重新爬取一次、保存）用蓝色渐变填充，删除按钮为灰色 `×`。
- 配置页分三层：卡片 → 小节（频率与上限、时段、星期与暂停、研究兴趣、抓取窗口、摘要策略、下载）→ 字段；
  标签固定 132px 成一列。
- 卡片内留 18/20px 内边距（控制台默认把 `.sheet` 的左右内边距压成 0）。
- 顶部只在真正暂停时显示「已暂停 · 日期」，平时不出现。

### 长动作不阻塞页面

翻译、速评与「重新爬取一次」耗时从十几秒到一分钟。这些动作都不弹整页遮罩：按钮旁显示进度，
结束后原地写出结果（`翻译成功` 或失败原因），期间页面可正常使用。

### 速评与译文的共用缓存

速评与译文按条目 id 各存一份（`news/reviews/<id>.json`、`news/translated/<id>.json`），推送页、列表页、
气泡与兴趣记录读的是同一份，不会重复调用模型。列表每天被新抓取覆盖，缓存随之清理：只保留当前列表里的条目，
存储不会无限增长。

### 数据目录

部署数据目录的 `news/` 下：`items.json`（列表快照）、`seen.json`（去重）、`state.json`（已读、已推、窗口游标）、
`records.json`（兴趣记录）、`translated/`（译文缓存）、`reviews/`（速评缓存）、`papers/`（下载的原文）。

---

## 与上游升级的关系

扩展安装于 `<安装目录>\data\extensions`。安装包升级仅删除 Electron 自身文件，`data\` 目录保留，
因此扩展与配置不会因升级丢失。

扩展运行时需要与框架的契约版本一致：`package.json` 中的 `cortico.api` 须等于运行时框架的 world 契约号
（当前为 5）。框架发生不兼容变更时会提升该编号，旧包将被拒绝加载。此时应修改 `cortico.api`、按框架变更
对齐接口，再执行 `npm run build` 并重启进程。接口说明见
[Cortico 的 docs/extensions.md](https://github.com/Pal-AI-Lab/Cortico/blob/main/docs/extensions.md)。

v0.2.x 的兼容情况：契约号 5 的扩展可在 v0.2.4 上加载；控制台路由已更名，涉及 `/api/webui/manifest` 与
`/api/webui/providers/<页>/panels/<面板>/<方法>`，设置页路径为 `/coopanion/<hash>`。详见 `docs/NOTES.md`。

## 隐私

仓库内的文档与测试夹具统一使用 `test@gmail.com` 与 `C:\Users\user\...` 作为占位值，不含真实账号邮箱与
本机用户名。`docs/panel*.png` 为真实控制台截图，包含账号邮箱与密钥尾号，因此未纳入仓库。
