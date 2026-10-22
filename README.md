# CooLuCostom

Coopanion 桌宠的两个扩展，均以 Cortico World 包形式提供，不修改 Coopanion 源码。

| 扩展 | 包名 | World id | 控制台显示名 | 功能 |
|---|---|---|---|---|
| 用量额度 | `cortico-world-quota` | `quota` | 用量额度 | 套餐额度、滚动窗口与本机 Hermes 用量，越阈值时由桌宠提醒 |
| 兴趣推送 | `cortico-world-interest-push` | `interest-push` | 兴趣推送 | 按节奏抓取研究方向的论文，用气泡对话介绍，详情留在面板 |

两个包相互独立，数据目录、页签与提示词各自一套，可只装其中一个。

## 安装

```bash
# 安装版：https://github.com/Pal-AI-Lab/Coopanion/releases
node scripts/sync-extension-to-app.mjs      # 构建面板产物并复制两个扩展到安装目录
```

重启桌宠，在控制台切换至高级模式，WORLD 分组下出现「用量额度」与「兴趣推送」。

## 构建与测试

```bash
cd extension                # 或 extension-interest-push
npm install
npm run typecheck
npm test                    # 用量额度 88 项 / 兴趣推送 147 项
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

## 二、兴趣推送

### 页签

| 页签 | 内容 |
|---|---|
| 推送 | 大肥鱼速评（十星与总分）→ 论文速览（标题与摘要）→ 中文译文 → 详情（期刊与分区、上线日期、作者与机构、DOI、爬取源、打开原文、下载原文）；顶部「换一篇」 |
| 列表 | 抓取到的条目与速评缩略，标注「已读」「无摘要」，点击切到推送页 |
| 兴趣记录 | 收藏的条目，按时间倒序，可打开原文、下载、移除 |
| 配置 | 推送节奏、数据源、期刊集合、翻译术语表四张卡片，各带保存按钮；另有「重新爬取一次」「立刻推一条（试）」 |

### 配置项

- **推送节奏**：检查间隔、每日条数上限、气泡对话轮数上限、推送时刻、静默时段、允许推送的星期、暂停到。
- **数据源**：研究领域关键词、arXiv 分类、抓取窗口天数、每刊条数、期刊延迟天数、Crossref 邮箱、只推送有摘要的条目、没有可推条目时允许推缺摘要的（仅手动）、下载目录。
- **期刊集合**：刊名、ISSN、分区标签、分组，可增删。
- **翻译术语表**：英文与中文对照，可增删。

时刻用「时 + 分」下拉，星期为七个切换按钮，标签类配置点 ✕ 删除。保存后立即生效，定时器按新配置重排；推送时刻落在静默时段内时，配置页列出这些时刻。

### 数据源

| 源 | 接口 |
|---|---|
| 期刊 | Crossref `journals/<ISSN>/works`，默认 28 家（中科院一区与 JCR Q1） |
| arXiv | `export.arxiv.org/api/query` |
| 每日论文榜 | Hugging Face `api/daily_papers` |
| 摘要与机构回填 | OpenAlex（按 DOI 批量、按标题单查），摘要另用 Semantic Scholar 兜底 |
| 翻译与速评 | 桌宠配置的模型端点 `POST {baseUrl}/responses` |

### 行为

- **推送与页签同步**：推送后页签显示该条，页面每 20 秒核对一次并在变更时重画；重启后仍停在刚推的那篇；「立刻推一条」以页面上那篇为准，不可推时顺延下一篇，推完页签跟过去；手动试推不计入每日条数。
- **速评**：每篇生成一次并落盘，推送前若无速评会先生成；推送页、列表、气泡共用同一份，界面只显示总分。
- **翻译**：按术语表翻译标题与摘要，同一篇只调用一次模型。
- **无摘要条目不自动推送**：保留在列表并每日重试，期刊延迟天数用于跳过刚发表的文章；打开「没有可推条目时允许推缺摘要的」后，手动推送会带上它们并注明源未提供摘要。
- **可推池为空时**：返回一条说明，给出总条数、已推条数、判为不感兴趣条数与缺摘要条数。
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
