# CooLuCostom

Coopanion 桌宠的两个扩展，均以 Cortico World 包形式提供，不修改 Coopanion 源码。

| 扩展 | 包名 | World id | 控制台显示名 | 功能 |
|---|---|---|---|---|
| 用量额度 | `cortico-world-quota` | `quota` | 用量额度 | 套餐额度、滚动窗口与本机 Hermes 用量，越阈值时由桌宠提醒 |
| 论文推送 | `cortico-world-dailypaper` | `interest-push` | 论文推送 | 按节奏抓取研究方向的论文，用气泡对话介绍，详情留在面板 |

两个包相互独立，数据目录、页签与提示词各自一套，可只装其中一个。

## 安装

**从扩展市场安装**（推荐）：控制台「扩展」页搜索 `cortico-world-dailypaper`，或

```bash
cd <安装目录>/data/extensions && corepack pnpm add cortico-world-dailypaper
```

**从本仓库装到本机官方版**：

```bash
# 安装版：https://github.com/Pal-AI-Lab/Coopanion/releases
node scripts/sync-extension-to-app.mjs      # 构建面板产物并复制两个扩展到安装目录
```

重启桌宠，在控制台切换至高级模式，WORLD 分组下出现「用量额度」与「论文推送」。

## 构建与测试

```bash
cd extension                # 或 extension-interest-push
npm install
npm run typecheck
npm test                    # 用量额度 88 项 / 论文推送 160 项
npm run build
```

## 一、用量额度

页面含四部分：

- **套餐额度**：月度余额、5 小时与每周滚动窗口、计划可用模型与单价、按模型划分的额度。
- **账号**：使用桌宠已配置的 Command Code 端点凭证，无需重复录入密钥。
- **本机 Hermes 用量**：调用次数与 token 统计，可切 1、7、30、90 天。
- **阈值提醒**：窗口用量达到阈值时产生内部事件，由桌宠以气泡提示。

进入页面拉取一次，其后由卡片按钮手动刷新；后台轮询仅用于阈值提醒。

| 数据 | 来源 |
|---|---|
| 套餐额度 | `api.commandcode.ai` 的 `/alpha/billing/credits`、`/alpha/billing/subscriptions`、`/alpha/whoami` |
| 模型清单 | `api.commandcode.ai/provider/v1/models` |
| 计划价目 | `commandcode.ai/docs/plans/<计划>`、`/docs/resources/pricing-limits`，缓存 12 小时 |
| Hermes 用量 | 本机 `state.db` 的 `session_model_usage` 表，只读 |

## 二、论文推送

### 页签

| 页签 | 内容 |
|---|---|
| 推送 | 大肥鱼速评（十星与总分）→ 论文速览（标题与摘要）→ 中文译文 → 详情（期刊与分区、上线日期、作者与机构、发表、DOI、爬取源、打开原文、下载原文）；顶部「换一篇」 |
| 列表 | 抓取到的条目与速评缩略，标注「已读」「无摘要」「已见刊 / 预印本」，点击切到推送页 |
| 兴趣记录 | 收藏的条目，按时间倒序，可打开原文、下载、移除 |
| 配置 | 推送节奏、数据源、期刊集合、翻译术语表四张卡片；另有「重新爬取一次」「立刻推一条（试）」 |

### 配置项

- **推送节奏**：两种模式二选一，点各自左上角开关即时切换——随机推送（最小间隔、每天最多几条）或定时推送（推送时刻）；另有允许推送的星期与暂停到。气泡对话固定 4 轮。
- **数据源**：研究领域关键词、arXiv 源（只读）、抓取窗口、每刊条数、期刊延迟、Crossref 邮箱、只推送有摘要的条目、没有可推条目时允许推缺摘要的（仅手动）、下载目录、OpenAlex 密钥。
- **期刊集合**：只读列表（刊名、ISSN、分区）。按 8 位 ISSN 新增，刊名与分区自动识别，保存时试抓一篇，抓不到不入库；另有「检测全部期刊」逐家验证。
- **翻译术语表**：只读列表，底部按「英文 / 中文」增加词条，行尾 ✕ 删除。

推送时刻用「时 + 分」两个数字输入框，星期为七个切换按钮。切换推送模式即时生效并给出提示；改最小间隔或推送时刻后按新配置重排定时器。

### 数据源

| 源 | 接口 |
|---|---|
| 期刊 | Crossref `journals/<ISSN>/works`，默认 28 家（中科院一区与 JCR Q1） |
| arXiv | `export.arxiv.org/api/query` |
| 每日论文榜 | Hugging Face `api/daily_papers` |
| 摘要与机构回填 | OpenAlex（按 DOI 批量、按标题单查，需 `OPENALEX_API_KEY`），摘要另用 Semantic Scholar 兜底 |
| 翻译与速评 | 桌宠配置的模型端点 `POST {baseUrl}/responses` |

### 行为

- **推送与页签同步**：推送后页签显示该条，页面每 20 秒核对一次并在变更时重画；重启后仍停在刚推的那篇；「立刻推一条」以页面上那篇为准，不可推时顺延下一篇，推完页签跟过去；手动试推不计入每日条数。
- **资料取用**：推送事件只带编号，论文题录与摘要由 `paper_read` 工具按编号返回；模型读的是工具回执，抓取到的第三方文本不会以内部通知的身份进入对话。
- **随机推送**：两次推送至少相隔最小间隔，到点先以 0.83 的概率推，没推成就再等一段指数分布的额外时间（均值 0.3 倍最小间隔）；累计概率在最小间隔的 2.5 倍左右到 90%。每日条数上限只在随机模式生效，顶部读数在定时模式只报条数。下一次时刻落盘，跨天不清，重启后接着算。
- **抓取与推送分开**：抓取每天一次，由「上次检查」与「重新爬取一次」驱动；推送时刻只做推送判断，不会顺带抓取。
- **速评**：每篇生成一次并落盘，推送前若无速评会先生成；推送页、列表、气泡共用同一份，界面只显示总分。
- **翻译**：按术语表翻译标题与摘要，同一篇只调用一次模型。
- **无摘要条目不自动推送**：保留在列表并每日重试，期刊延迟天数用于跳过刚发表的文章；打开「没有可推条目时允许推缺摘要的」后，手动推送会带上它们并注明源未提供摘要。
- **可推池为空时**：返回一条说明，给出总条数、已推条数、判为不感兴趣条数与缺摘要条数。
- **已见刊优先**：期刊条目，以及 arXiv 上带 `journal_ref` 或正式 DOI 的条目算已见刊，列表与推送优先；预印本排在后面。
- **机构未知的不收录**：OpenAlex 有记录但查不到机构的条目从列表中剔除，已推送过的保留。这两条规则固定在代码里，不在配置页暴露。
- **长动作**：翻译、速评、重新爬取在按钮旁显示进度，不遮挡页面。
- **缓存**：译文与速评只保留当前列表中的条目。
- **配置快照**：保存与抓取后写入 `news/config-snapshot.json`，配置被重置时启动自动恢复。

### 数据目录

`<数据目录>/news/`：

```
items.json            条目列表
seen.json             去重记录
state.json            已读、已推、窗口状态
records.json          兴趣记录
config-snapshot.json  配置快照
reviews/              速评缓存
translated/           译文缓存
papers/               下载的原文
```

## 验证

```bash
node scripts/verify-instance.mjs <端口>
node scripts/verify-instance.mjs <端口> --alerts
cd extension-interest-push && node scripts/check-panel-render.mjs <端口>
```

端口见 `core.log` 或 `data/home/companion/config.json` 的 `web.port`。

## 与上游升级

扩展装在 `<安装目录>\data\extensions`，升级只替换程序文件，`data\` 保留。`package.json` 的 `cortico.api` 须与运行时框架的契约号一致（当前为 5）。

## 隐私

仓库内文档与测试夹具使用 `test@gmail.com` 与 `C:\Users\user\` 作为占位值，不含真实账号信息。
