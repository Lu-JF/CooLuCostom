# 论文推送（cortico-world-dailypaper）

Cortico World 扩展：按研究关键词跟踪期刊与 arXiv，把新论文用桌宠气泡讲一遍，完整信息留在控制台。

仓库：https://github.com/Lu-JF/CooLuCostom

## 功能

- **四个页签**：推送、列表、兴趣记录、配置。
- **期刊与预印本**：Crossref 期刊检索（可自定义 ISSN 名单，默认 28 家工程类一区/Q1 刊）、arXiv 关键词检索、Hugging Face 每日论文榜。
- **已见刊优先**：arXiv 记录带 `journal_ref` 或正式 DOI 时按已发表处理，列表与推送都排在预印本前面。
- **作者机构**：从 OpenAlex 取作者单位，查不到机构的条目不入列表。
- **大肥鱼速评**：每篇一次，给出两三句评价与一个总分，推送页、列表与气泡共用同一份缓存。
- **中文译文**：按术语表翻译标题与摘要，译文落盘缓存。
- **摘要回填**：Crossref 没有摘要的刊，按 DOI 走 OpenAlex、再按标题补，最后用 Semantic Scholar 兜底。
- **推送节奏**：检查间隔、每日上限、推送时刻、静默时段、星期、暂停；保存即生效。
- **数据目录**：`<数据目录>/news/`，含条目、已读、兴趣记录、速评与译文缓存、下载的原文。

## 安装

在 Coopanion 控制台「扩展」页搜索 `cortico-world-dailypaper`，或：

```
cd extensions && corepack pnpm add cortico-world-dailypaper
```

重启进程后在「World 总览」启用。

## 配置

控制台「论文推送 → 配置」四张卡片，各自保存：

| 卡片 | 内容 |
|---|---|
| 推送节奏 | 检查间隔、每日上限、对话轮数、推送时刻、静默时段、允许的星期、暂停到 |
| 数据源 | 关键词、arXiv 分类、抓取窗口、每刊条数、期刊延迟天数、Crossref 邮箱、只推有摘要、下载目录 |
| 期刊集合 | 刊名、ISSN、分区标签、分组 |
| 翻译术语表 | 英文与中文对照 |

OpenAlex 密钥在「配置 → 数据源 → 摘要与机构的数据源密钥」里填：在 openalex.org 用邮箱免费申请，
邮件里的链接点开就能拿到 key。密钥只写入部署目录的 `.env`，不写配置文件、也不回显。
不填也能用，只是摘要与机构回填会走共享额度，高峰时段可能被限流。

`S2_API_KEY` 仍只从环境变量读取，可选。

## 数据来源

| 源 | 接口 |
|---|---|
| 期刊 | Crossref `journals/<ISSN>/works` |
| arXiv | `export.arxiv.org/api/query` |
| 每日论文榜 | Hugging Face `api/daily_papers` |
| 摘要与机构 | OpenAlex、Semantic Scholar |
| 速评与翻译 | 当前桌宠配置的模型端点 |

## 隐私

- 论文数据与摘要是公开的学术信息，扩展不采集个人数据。
- 除上述学术接口外，只与你自己配置的模型端点通信。
- 抓取到的条目、速评与译文只写入本机数据目录。

## 许可

MIT。
