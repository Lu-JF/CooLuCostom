# 桌宠定时推送研究热点 · 技术方案
> **实施状态**：本计划的研究结论已落地为 `extension-interest-push`（World id `interest-push`，显示名「兴趣推送」）。
> 与计划的差异：推送形式为气泡多轮对话且**不含跳转**（详情由使用者自己打开）；arXiv 由分类 RSS 改为官方检索 API
> （RSS 不接受检索式且周末为空）；Crossref 改用记录创建日期；摘要以 OpenAlex 与 Semantic Scholar 两级回填；
> 期刊集合从 10 家扩到 28 家。验收记录见 `docs/VERIFICATION.md` 第 12 节。

> 编写时间：2026-10-16（Asia/Shanghai）
> 数据来源说明：文中所有 API 与 URL 均以 `curl` 实际访问一次；凡出现状态码、字段名、限额的，均取自实际请求的返回体或响应头；未经过实际验证的内容，均在正文中显式标注「**未验证**」。
> 目标读者：CooLuCostom 扩展的后续维护者。
> 范围：本方案仅涉及方案设计，不含扩展代码，不改动仓库现有文件。

---

## 0. 结论

本方案可行，工作量属于「小到中」级别。原因在于桌宠侧所需的机制均已实现并在运行中：World 提供 `setInterval` 定时器、`host.pushEvent` 事件投递、配置组，以及面板 `ctx.invoke` 数据面。上述能力均为「用量额度」World 已在使用的实现。本方案需要新增的部分仅有四项：**拉取数据、去重、过滤、节流**。

- **第一版（可用版本）约半天到一天**：1 个数据源（arXiv 官方 RSS）+ 落盘去重 + 面板 3 个开关。
- **完整版（多源 + 相关度 + 口语化）约 3～5 天**：多源接入、配额、评分排序、失败退避、面板调参。

**关键风险点三项**（均非技术难点，但直接影响方案能否落地）：

1. **arXiv 的查询语法存在解析差异**。`+` 分隔的多个词默认按 **OR** 解析而非 AND。实测 `all:bearing+fault+diagnosis` 被解析为 `all:bearing OR all:fault OR all:diagnosis`，返回 38017 篇（其中大量为量子计算等无关内容）。必须写作 `all:bearing+AND+all:"fault+diagnosis"` 才能得到 122 篇精准结果。**直接复制既有脚本会带入该问题**（本机 `arxiv` skill 的脚本即存在此问题，见第 4 节）。
2. **去重游标必须落盘**。现有 World 的提醒游标 `firedByAccount` 为**纯内存**实现（`world.ts:75`），进程重启后即丢失。新闻推送若沿用该做法，每次重启都会重复推送当天已推过的条目。
3. **Papers with Code 已停运**。其 API 目前 302 跳转至 `huggingface.co/papers/trending`。因此任何基于 PwC 抓取热门论文的既有方案均不可用，应直接采用 HF Daily Papers（该接口自带 AI 摘要与关键词）。

**另需说明的是**：质量较高的数据源（arXiv RSS、IEEE Spectrum、Nature、HF Daily Papers、Crossref）**全部免费、全部不需要 key**，且**全部实测返回 200 可用**。需要 key 的数据源（OpenAlex 免费 key、Semantic Scholar 免费 key）反而可以暂不接入。

---

## 1. 结论：可行性与工作量

### 1.1 已具备的能力（无需重做，可沿用用量额度 World 的写法）

| 能力 | 现有实现（`extension/src/world.ts`） | 新闻推送的沿用方式 |
|---|---|---|
| 定时触发 | `start()` 中 `refresh()` + `schedule()`；`setInterval(minutes*60_000)`，`timer.unref?.()`；`stop()` 清除定时器 | 沿用，更换 `pollMinutes` 并替换拉取逻辑 |
| 向 bot 投递事件 | `host.pushEvent({type,ts,source,origin:'internal',senderKey,text,meta})`，外层包 `try/catch`（投递失败不得导致循环终止） | 沿用，`type` 改为 `news.item` |
| 配置组 | `QUOTA_CONFIG_GROUP`（`worlds.quota.*` 键 + `x-hot`/`x-path` + schema 描述） | 新开一个 `world:news` 组 |
| 面板 | `console()` 声明 `panels`、`invoke(panel,method,args,language)` 数据面、`config:[...]` | 增加一页「研究热点」 |
| 交给 bot 的话术 | `promptDocs` + `role:'envPrompt'` 指向 `ENV_PROMPT.md`；注释明确「只陈述事实，是否播报与播报方式由 envPrompt 决定」 | 沿用同一机制：事件只包含标题与链接，是否播报由 bot 决定 |
| 并发合并 | `inflight` promise，同一时刻仅一次取数 | 沿用，避免面板与定时器并发 |
| 时区 | `opts.timezone` 注入 | 用于实现白天推送、夜间静默 |

### 1.2 需新增的内容（新增工作量如下）

1. **数据源适配器**（arXiv RSS 解析，统一为 `{id,title,url,summary,published,source,tags}`）
2. **落盘去重表**（不再使用内存 Set）
3. **相关度过滤**（关键词与分类；嵌入相似度可后续再议）
4. **每日配额与时间窗**（白天推送、每天最多 N 条）
5. **面板旋钮与一个「立即试推」按钮**

### 1.3 工作量分级

| 版本 | 内容 | 估时 | 风险 |
|---|---|---|---|
| **MVP** | arXiv RSS 单源 + 落盘去重 + 面板开关（源/间隔/每天上限） | **半天～1 天** | 低。均为既有实现套路 |
| **v1** | 增加 1～2 个行业源（IEEE Spectrum / HF Daily Papers）+ 关键词过滤 + 白天窗口 + 失败退避 | **1～2 天** | 低 |
| **v2** | 增加多源、分类权重、Crossref 补充 IEEE TIE 早期文章、LLM 摘要与口语化、面板可视化调整 | **3～5 天** | 中（LLM 摘要的幻觉与费用） |

**唯一可称为难点的环节**是相关度排序是否准确。若仅按分类拉取 arXiv，一天的 cs.LG 与 eess.SP 合计有几百篇，全部推送等同骚扰。**必须**有过滤与配额，否则该功能会在一周内被关闭。

---

## 2. 数据源分析

### 2.1 总表（状态码均取自实际请求）

| 源 | 端点 | 需要 key | 实测状态 | 可获取「标题+链接+摘要+时间」 | 限额（实测/官方） |
|---|---|---|---|---|---|
| arXiv API | `export.arxiv.org/api/query` | 否 | **200** | 可获取，Atom XML 全都有 | 官方 TOS：**每 3 秒最多 1 次请求，单连接** |
| arXiv RSS | `rss.arxiv.org/rss/<分类>` | 否 | **200** | 可获取，**描述中直接包含摘要与 announce type** | 同上（属 legacy API） |
| arXiv 邮件订阅 | `info.arxiv.org/help/subscribe.html` | 否 | **200** | 邮件（非 API） | — |
| Semantic Scholar | `.../graph/v1/paper/search` | 否（有 key 更高） | **429**（无 key，反复重试仍为 429） | — | 共享池被限 |
| Semantic Scholar **/bulk** | `.../graph/v1/paper/search/bulk` | 否 | **200**（可用） | 可获取，JSON | 走另一个池，实测可用 |
| OpenAlex | `api.openalex.org/works` | 否（建议免费 key） | **200/429 交替** | 可获取，JSON（摘要为**倒排索引**） | **1000 credits/天，按 IP 共享** |
| Crossref | `api.crossref.org/works` | 否 | **200**（可用） | 可获取（无摘要，只有题录） | **1 req/s，并发 1** |
| Papers with Code | `paperswithcode.com/api/v1/...` | — | **已停运**，302 至 HF | 不可获取 | — |
| HF Daily Papers | `huggingface.co/api/daily_papers` | 否 | **200**（可用） | 可获取，**自带 ai_summary + ai_keywords** | 未见明确限额 |
| IEEE Spectrum | `spectrum.ieee.org/feeds/feed.rss` | 否 | **200** | 可获取，30 条 | — |
| Nature | `nature.com/nature.rss` | 否 | **200** | 可获取 | — |
| Nature 工程子刊 | `nature.com/subjects/engineering.rss` | 否 | **200** | 可获取 | — |
| Science news | `science.org/rss/news_current.xml` | 否 | **200** | 可获取（RDF 格式） | — |
| MSR 博客 | `microsoft.com/en-us/research/feed/` | 否 | **200** | 可获取 | — |
| Google AI 博客 | `blog.google/technology/ai/rss/` | 否 | **200** | 可获取 | — |
| OpenAI | `openai.com/blog/rss.xml` | 否 | **200** | 可获取（"OpenAI News"） | — |
| DeepMind | `deepmind.google/blog/rss.xml` | 否 | **200** | 可获取，**但响应为 gzip**，必须使用 `--compressed` | — |
| 机器之心 | `jiqizhixin.com/rss` | — | **200 但返回 HTML**（SPA 页，非 feed）；`/rss/all`、`/rss/category/1` = **404** | 不可获取 | 无官方 feed |
| 量子位 | `qbitai.com/feed` | — | **200（0 条）→ 再次访问 403 size 0** | 不可获取 | 不稳定，疑似蜜罐 |
| 雷峰网 | `leiphone.com/feed` | 否 | **200** | 可获取，517KB | — |
| 36氪 | `36kr.com/feed` | — | **200 但 text/html**（非 feed） | 不可获取 | — |
| IT之家 | `ithome.com/rss/` | 否 | **200** | 可获取 | — |
| 智源社区 | `hub.baai.ac.cn/rss` | — | **404** | 不可获取 | 未找到 feed |
| TechXplore ML/AI | `techxplore.com/rss-feed/machine-learning-ai-news/` | 否 | **200** | 可获取 | — |
| ScienceDaily AI | `sciencedaily.com/rss/computers_math/artificial_intelligence.xml` | 否 | **200** | 可获取 | — |
| phys.org ML/AI | `phys.org/rss-feed/technology-news/...` | 否 | **404** | **未验证**（路径待确认） | — |
| **IEEE Xplore** | `ieeexplore.ieee.org/...` | — | **418**（反爬拦截） | 不可获取 | **不能程序化访问** |
| IEEE TIE 早期文章 | 改走 Crossref `journals/0278-0046` | 否 | **200**（可用） | 题录（无摘要） | 1 req/s |

### 2.2 学术侧逐条

#### ① arXiv API：免 key，但查询语法存在解析差异

- 端点：`https://export.arxiv.org/api/query`（GET，返回 Atom XML）
- **实测**：`search_query=cat:cs.LG&sortBy=submittedDate&sortOrder=descending&max_results=3` → **HTTP 200**，2.5s，8438 字节；`opensearch:totalResults` = 293610。
- **排序参数**（官方 user-manual 实测抓取）：`sortBy` = `relevance` | `lastUpdatedDate` | `submittedDate`，`sortOrder` = `ascending` | `descending`；分页 `start` + `max_results`。
- **限额**（官方 TOS 原文，实抓 `info.arxiv.org/help/api/tou.html`）：
  > "When using the legacy APIs (including OAI-PMH, RSS, and the arXiv API), **make no more than one request every three seconds**, and limit requests to a single connection at a time."
- **关键字语法实测结果**：

  | 输入写法 | arXiv 实际解析结果 | 实测条数 | 结论 |
  |---|---|---|---|
  | `all:bearing+fault+diagnosis` | `all:bearing **OR** all:fault OR all:diagnosis` | 38017（噪声） | 默认按 OR 解析 |
  | `all:neural%20architecture%20search`（单前缀多词） | `all:neural **OR** all:architecture OR all:search` | 427031（噪声） | 同上 |
  | `all:bearing+AND+all:"fault diagnosis"` | 原样 AND | **122（全部相关）** | 必须显式 AND 加引号 |
  | `ti:"neural architecture search"` | 原样 | 850 | 标题短语结果干净 |
  | `cat:cs.LG+OR+cat:eess.SP` | 原样 | 327441 | 分类可用 |

- **返回字段**：`<title>` / `<id>`（含版本，如 `http://arxiv.org/abs/2610.22372v1`）/ `<published>` / `<summary>`（摘要）/ `<author><name>` / `<category term="...">`。
- 建议：**不用于日更订阅**，日更订阅使用下述 RSS；该接口适合按关键词或作者进行定向搜索。

#### ② arXiv RSS：性价比最高的数据源

- 端点：`https://rss.arxiv.org/rss/<分类>`（与 `export.arxiv.org/rss/<分类>` 返回同一份内容）
- **实测**：`/rss/cs.LG` → **HTTP 200**，`application/rss+xml`，**991832 字节**，**467 条 item**；`eess.SP` / `cs.CV` / `cs.AI` / `eess.AS` 全部 **200**。
- **单条 item 字段（实测抓取 cs.LG 第 1 条）**：
  - `title`: `FlowBudget: Training-Free Sampling-Budget Estimation for Flow Matching Models`
  - `link`: `https://arxiv.org/abs/2610.20636`
  - `description`: `arXiv:2610.20636v1 **Announce Type: new** Abstract: Sampling from continuous flow-based generators...`，该字段同时包含摘要与「新增/替换/交叉」类型
  - `pubDate`: `Fri, 16 Oct 2026 00:00:00 -0400`
  - `guid`: `oai:arXiv.org:2610.20636v1`
  - `category`: `cs.LG`；`dc:creator`: 作者列表
- **该源的优势**：一次请求即可获得一个分类当日全部新增内容，**自带摘要**，**含 announce type 可仅筛选 `new`**，免 key，且支持按分类组合。**为 MVP 的首选源。**

#### ③ Semantic Scholar：单条搜索受配额限制，**/bulk 端点实测可用**

- `https://api.semanticscholar.org/graph/v1/paper/search?query=...` → **429**，且间隔 8 秒重试仍为 **429**，报错原文：
  `{"message": "Too Many Requests. Please wait and try again or apply for a key for higher rate limits."}`
  → **本机 IP 的共享池已被限制，无 key 基本不可用。**
- **但** `https://api.semanticscholar.org/graph/v1/paper/search/bulk?query="bearing fault diagnosis"` → **HTTP 200**，返回 `{total: 2319, token: ...}`，`data[]` 字段包含 `title / publicationDate / citationCount / abstract / externalIds`。
  → 该端点走另一个池。**按主题批量获取且需要摘要时，使用 /bulk。**
- 注意：实测该批结果的 `externalIds.ArXiv` 为 `None`（均为期刊论文，没有 arXiv ID），故 **S2 与 arXiv 的重叠程度低于预期**。

#### ④ OpenAlex：可用，但**按 IP 共享配额**，会周期性返回 429

- 端点：`https://api.openalex.org/works`
- **实测**：首次请求 **429**（`X-RateLimit-Remaining: 0`，`X-RateLimit-Reset: 37059`）；约十几分钟后重试 → **HTTP 200**（`X-RateLimit-Remaining: 613`）。**同一 IP 的共享预算会被其他使用者耗尽，改用 `mailto` 不提升额度。**
- 官方在返回体中直接说明（实测原文）：
  > "No API key, so this request shares one free daily budget (**$0.10**) with everyone on your network's IP address. The mailto parameter doesn't raise this limit. Get a free key with its own **$1/day** at https://openalex.org/settings/api … An AI agent can get one for its user in one call: **POST https://api.openalex.org/api-keys** with `{"email": "..."}`"
  → 每次查询 `cost_usd: 0.001`。
- **字段实测**：`display_name`(标题) / `publication_date` / `type` / `cited_by_count` / `doi` / `id` / `ids` / `open_access` / `primary_location.source` / `keywords` / `topics` / `is_retracted`，以及 **`abstract_inverted_index`**（摘要以**倒排索引**形式存储，需自行拼回文本）。
- **按期刊过滤实测可用**：`?filter=primary_location.source.issn:0278-0046&sort=publication_date:desc` → **200**，`count: 22688`（IEEE TIE 全库）。**该查询是不访问 IEEE Xplore 而获取 TIE 新文章的可行途径。**

#### ⑤ Crossref：免 key、稳定，是访问 IEEE Xplore 内容的可行替代

- 端点：`https://api.crossref.org/works`
- **实测**：`?query.bibliographic=bearing+fault+diagnosis&rows=2` → **HTTP 200**，2.1s，`total-results: 1087399`；字段 `DOI / title / issued / container-title / type`。
- **限额实测（响应头）**：`x-rate-limit-limit: 1`，`x-rate-limit-interval: 1s`，`x-concurrency-limit: 1`，即**每秒 1 次、并发 1**。无 key，可通过 `mailto=` 进入 polite pool。
- **期刊级查询实测（关键）**：`https://api.crossref.org/journals/0278-0046/works?rows=5&sort=published&order=desc` → **HTTP 200**，`total-results: 22420`，返回的正是 IEEE TIE 的最新文章（`10.1109/tie.2026.3675078` 等）。
  → **IEEE Xplore 对脚本返回 418，而 Crossref 可获取 TIE 的题录与 DOI。** 需要跟踪特定期刊是否出现新文章时，采用该途径。

#### ⑥ Papers with Code：**已停运，不应再纳入规划**

- 实测 `https://paperswithcode.com/api/v1/papers/?page=1` → 最终 URL 变为 **`https://huggingface.co/papers/trending`**，返回 **`text/html`**（非 JSON）。
- 结论：**PwC 已由 Hugging Face 接管**。所有基于 PwC API 的既有方案均不可用。

#### ⑦ Hugging Face Daily Papers：免 key，**自带 AI 摘要与关键词**

- 端点：`https://huggingface.co/api/daily_papers?limit=N` → **HTTP 200**，`application/json`。
- **字段实测（完整）**：
  - `paper.id`（即 arXiv ID，如 `2610.16105`）/ `paper.authors[]` / `paper.publishedAt` / `paper.submittedOnDailyAt` / `paper.title` / `paper.summary` / **`paper.ai_summary`** / **`paper.ai_keywords`** / `paper.ai_summary_model` / `paper.upvotes` / `paper.discussionId`
  - 顶层另有 `publishedAt` / `numComments` / `submittedBy` / `isAuthorParticipating`
- 页面 `https://huggingface.co/papers`（**200**）按 **GitHub stars 活跃度**排序，提供 Daily/Weekly/Monthly 视图，并**提供每日邮件订阅**。
- **该源的价值**：已由第三方完成「从当天几百篇中筛选热门」这一环节，且**摘要现成**，扩展端无需调用 LLM。

### 2.3 行业与新闻侧逐条

- **IEEE Spectrum** `https://spectrum.ieee.org/feeds/feed.rss` → **200**，30 条，字段 `title/link/pubDate/category`。首条实测：`Chasing China's Monazite Monopoly` / `2026-10-15 14:54:03 +0000`。**免 key、稳定。**
- **Nature** `https://www.nature.com/nature.rss` → 200；工程子刊 `https://www.nature.com/subjects/engineering.rss` → 200；`nnano.rss` → 200。
- **Science** `https://www.science.org/rss/news_current.xml` → 200，RDF 格式，标题 "Latest News from Science Magazine"。
- **大厂博客均实测 200**：MSR `https://www.microsoft.com/en-us/research/feed/`、Google AI `https://blog.google/technology/ai/rss/`、OpenAI `https://openai.com/blog/rss.xml`（标题 "OpenAI News"）、**DeepMind `https://deepmind.google/blog/rss.xml`（响应为 gzip，不加 `--compressed` 得到的是乱码二进制）**。
- **国内源现状（实测，结论偏负面）**：
  - **机器之心**：`/rss` 返回 **200 但为 HTML**（新版前端 SPA），`/rss/all`、`/rss/category/1` 均为 **404**。**没有可用的官方 feed。**
  - **量子位**：`qbitai.com/feed` 首次 **200 但 0 条 item**，间隔一段时间后再次访问为 **403 size 0**。**稳定性不足，不宜依赖。**
  - **雷峰网** `leiphone.com/feed` → **200**，`application/rss+xml`，517KB（国内 AI 新闻源中少数可用者）
  - **IT之家** `ithome.com/rss/` → **200**；**36氪** `/feed` → 200 但为 HTML；**智源社区** `hub.baai.ac.cn/rss` → **404**
  - 备选：TechXplore ML/AI `https://techxplore.com/rss-feed/machine-learning-ai-news/` → 200；ScienceDaily AI → 200
- **国内学术库程序化访问（知网/万方）目前基本不可行**：
  - **知网**：确有「知网研学开放平台」（`/openx/` 前缀，JWT 认证，以`用户名+密码`换取 token）。但文档明确列出以下权限错误码：`400431 IP 或域名限制访问`、`400432 IP/域名不在白名单`、`404406 会员权限不足`，且需要**三方应用入驻**。域名使用 `http://`（非 https），可见入口为**高校代理域名**（`.utuedu.com`）。
    → 结论：**个人项目无法获得稳定可用的知网接口。**（字段细节来自其文档页，**未做鉴权实测**。）
  - **万方**：开放平台 `https://apps.wanfangdata.com.cn/open/docs`，提供「API 网关 / JSAPI / 开放 API 列表 / OAuth2.0」，但需要**注册应用**并走「我的应用」流程。
    → 结论：**需要申请，不是免 key 的公开接口**（**未做鉴权实测**）。
- **IEEE Xplore / IEEE TIE 早期访问**：`https://ieeexplore.ieee.org/xpl/RecentIssue.jsp?punumber=41` → **HTTP 418**；`https://ieeexplore.ieee.org/rss/TOC41.XML` → **HTTP 418**。**存在反爬拦截，不宜尝试抓取。**
  → 替代方案：**Crossref 的 `journals/0278-0046/works`（实测 200）** 或 **OpenAlex 的 ISSN 过滤（实测 200）**。
- **X / Twitter**：不可用。官方 API 需付费，免费层基本无法读取内容（**未实测**，按一般情况判断，不纳入本方案）。

---

## 3. 技术路线（可落地的处理管道）

```
[定时器] → [拉取] → [规范化] → [落盘去重] → [相关度过滤] → [排序/配额] → [投递节奏] → [pushEvent] → bot 决定说或不说
```

### 3.1 定时触发：使用 World 自身的 `setInterval`（沿用现有写法）

现状（`world.ts:283-292`）：

```ts
private schedule(): void {
  if (this.timer) clearInterval(this.timer);
  this.timer = null;
  const minutes = Number(this.opts.cfg.pollMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return;   // 0 = 关
  this.timer = setInterval(() => { void this.refresh({ reason: 'poll' }); }, Math.min(1440, minutes) * 60_000);
  this.timer.unref?.();     // 不阻止进程退出
}
```

要点：
- **生命周期**：`start(host)` 中先 `await this.refresh(...)` 再 `schedule()`；`stop()` 必须 `clearInterval` 并置空 host（现有代码已如此实现）。
- **桌宠并非常驻服务器**：定时器运行于 Electron 进程内，**App 关闭后即停止运行**。因此推送属于「开机期间尽力而为」，**不能承诺「每天必到」**。设计上应接受漏推，并以「下次启动补看最近 24h」作为兜底。
- **建议**：新闻源的检查频率**不需要 10 分钟一次**。源本身为日更（arXiv RSS 每个工作日更新一次），推荐 `pollMinutes` 默认取 **60～180**；也可采用「每天到点检查一次」的模式：定时器可以较频繁地唤醒（例如每 30 分钟一次），但**仅在跨过目标投递时刻时才真正拉取**。
- **关于 `unref()`**：现有代码已调用，其效果是定时器不会阻止进程退出。保持该行为即可。

### 3.2 拉取与规范化

- **MVP 仅拉取 arXiv RSS**：`https://rss.arxiv.org/rss/{cat}`，分类可多选（如 `cs.LG` + `eess.SP`）。
- **请求头**：需携带可识别的 `User-Agent`（arXiv 的要求）。**应使用 Node/Electron 的 `fetch`**，**不应使用 Python 的 `urllib`**；本机实测 Python 该路径在握手阶段即失败（见 §4.2）。
- **节流**：arXiv 官方限制为 **3 秒 1 次**。多分类时应串行并 `await sleep(3000)`，不应并发。
- **gzip 响应（如 DeepMind）**：Node `fetch` 会自动解压；若手动发起请求需显式接受 gzip。
- **规范化统一结构**（所有源均映射为该结构）：

```ts
interface NewsItem {
  key: string;        // 去重主键
  source: string;     // 'arxiv:cs.LG' | 'ieee-spectrum' | 'hf-daily'
  title: string;
  url: string;
  summary?: string;   // arXiv RSS / HF 有；Crossref 没有
  published: string;  // ISO
  tags?: string[];    // 分类 / ai_keywords
}
```

### 3.3 去重：**必须落盘**

- **键的选择**（按可靠性排序）：
  - arXiv RSS：使用 `guid`（形状 `oai:arXiv.org:2610.20636v1`）**去除版本后缀**后为 `oai:arXiv.org:2610.20636`。**去除 `v1/v2` 很重要**，否则同一篇论文每次改版都会被当作新论文推送一次。
  - Crossref：使用 `DOI`（小写化）。
  - 通用兜底：使用规范化后的 `url`（去 query、去尾斜杠、host 小写）。
  - **不应使用标题作为键**；arXiv 标题在大小写与换行上的差异会导致重复。
- **存储位置**：`opts.dataDir`（现有 World 已在此存放 `quota/accounts.json`）。建议使用 `dataDir/news/seen.json`。
- **注意**：**不应沿用现有的 `firedByAccount: Map<string, Set<string>>`**（`world.ts:75`）。该结构为**纯内存**实现，注释虽写明按账号分游标，但**没有任何落盘**。新闻推送若使用内存去重，**每次重启都会重复推送当天全部条目**。
- **保留期**：只保留最近 N 天（例如 14 天）的键，避免文件无限增长。
- **写盘容错**：沿用现有 `persistAccounts()` 的做法，以 `try/catch` 包裹，写盘失败不应导致取数循环中断。

### 3.4 相关度过滤（三档，按代价递增）

| 档 | 做法 | 代价 | 精度 | 建议 |
|---|---|---|---|---|
| **① 分类/源** | 只订阅 `cs.LG`、`eess.SP`、`eess.AS`；`announce_type` 只取 `new` | **零** | 低（一天几百篇） | MVP 必选，但**不足** |
| **② 关键词** | 标题与摘要命中白名单词（`fault diagnosis`、`bearing`、`neural architecture search`、`DARTS`、`hardware-aware`、`edge`、`quantization`…），带加权（标题命中 > 摘要命中） | **极低**（纯字符串） | 中 | **v1 主力方案，性价比最高** |
| **③ 嵌入相似度** | 将用户兴趣描述 embedding 化，对每篇计算余弦相似度并取 topN | **高**：需模型/API，需执行几百次 embedding | 高 | 放 v2。**对桌宠而言性价比差**（需联网、需费用、有延迟） |

- **建议 v1 仅采用 ①②**。关键词表作为配置项（面板可编辑），用户可自行调整。
- 关键词匹配注意：**大小写不敏感**；**`NAS` 这类短词需使用词边界**，否则 `nasal`、`Nash` 会被误命中。

### 3.5 排序与配额

- 排序建议（简单加权和即可）：
  - 关键词命中数（标题权重 ×3）
  - 是否具有 `ai_keywords` / `upvotes`（HF 源），作为热度信号
  - 发表时间（越新越靠前）
- **每日硬配额**：每天最多 N 条，默认 **1～3 条**。**该项的重要性高于排序算法**；没有配额时，再好的排序也会造成打扰。
- 配额计数同样需要落盘（与去重表放在一起），否则重启即重置。

### 3.6 摘要与口语化：**第一版不在扩展内调用 LLM**

三种方案如下：

| 方案 | 代价 | 风险 |
|---|---|---|
| **A. 扩展内不调用 LLM，事件中包含「标题 + 一句话（源摘要原样，截断）+ 链接」** | **零** | 无幻觉。**MVP 推荐采用** |
| **B. 由 bot 自行组织语言**（事件中仅说明「有 3 条新的」，bot 用工具获取详情后播报） | 低（复用 bot 已有的模型） | bot 可能夸大或脑补；需在 `ENV_PROMPT.md` 中明确「不得编造摘要内容」 |
| **C. 扩展内直接调用 LLM 生成中文摘要** | 高（需 API key、费用、延迟，并需处理失败） | **幻觉风险最高**：论文摘要翻译或压缩时编造数字或方法名，用户难以察觉 |

- **建议**：MVP 采用 A；v1 采用 A，并在给 bot 的 envPrompt 中写明话术（接近 B）。**C 明确不建议放在第一版**，除非用户愿意承担「摘要由模型生成」这一风险，且摘要**必须**标注「AI 生成，可能有误」。
- 现有 World 的设计边界支持方案 A：`world.ts` 注释写明**「只做机械计算……说什么、什么时候说，交给 bot 判断」**。新闻推送应沿用该边界：**扩展负责取得事实，bot 负责表达方式。**
- 若需要方案 A 中的「中文」：arXiv 摘要为英文。**不应在扩展内翻译**（那将需要 LLM）；可原样提供英文，或交由 bot 翻译。

### 3.7 投递节奏

- **白天推送、夜间静默**：使用注入的 `opts.timezone`，判断当前小时是否落在 `[pushStartHour, pushEndHour)`（例如 9:00–22:00）。窗口外**只入队不投递**，进入窗口后补投。
- **每轮投递**：沿用 `pushAlert` 的写法（`world.ts:380-403`），即 `host.pushEvent({type, ts, source, origin:'internal', senderKey, text, meta})`，**外层包 `try/catch`**，投递失败不得导致循环终止。
  - `type` 建议为 `news.item` / `news.digest`；`meta` 中携带 `{source, url, published, tags}`，供 bot 需要时引用。
  - `ts` 使用 `nowIso(this.opts.timezone)`（现有代码即如此）。
- **单条推送与多条推送**：建议**每轮最多推送 1 条**（配额内），避免气泡刷屏；其余条目留待下一轮。
- **节流**：即使 `pollMinutes=30`，也需保证「同一时刻只有一次取数」，沿用 `inflight` 合并（`world.ts:299-303`）。

### 3.8 配置项（面板所需旋钮）

新增配置组（形状参照 `QUOTA_CONFIG_GROUP`，键名为 `worlds.news.*`）：

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `false` | 契约要求默认关闭 |
| `sources` | string[] | `['arxiv:cs.LG','arxiv:eess.SP']` | 订阅的源 |
| `pollMinutes` | integer | `60` | 检查间隔；0 = 关 |
| `keywords` | string[] | `['fault diagnosis','bearing','neural architecture search','DARTS','hardware-aware','edge']` | 相关度白名单 |
| `maxPerDay` | integer | `2` | 每日上限（**最重要的旋钮**） |
| `pushStartHour` / `pushEndHour` | integer | `9` / `22` | 静默窗口 |
| `includeAbstract` | boolean | `true` | 事件中是否携带摘要（关闭后更接近「只给标题+链接」） |
| `minKeywords` | integer | `1` | 命中几个关键词才判定为相关 |

交互面：
- 在 `console()` 中增加一页 panel「研究热点」，通过 `invoke` 暴露 `state` / `seen`（最近推过什么）/ `testPush`（**手动试推一条**，调试必需）/ `clearSeen`（清空去重表）。
- 建议在面板上显示「上次检查时间 / 今日已推 N 条 / 各源最后成功时间」。**源失败应显性可见，不应静默。**

### 3.9 失败与退避

- **每个源独立记录状态**（最后成功时间、最后错误）。单个源故障**不应**导致其他源停止。
- **退避**：失败后按指数退避（1×→2×→4×，封顶几小时），成功后重置。源返回 503 时不应以每分钟的频率重试。
- **不应将「拉取失败」等同于「没有新闻」**。`competitor-news-monitor` skill 对此有明确说明，可直接借鉴：
  > "A source failure means unknown coverage, not 'no news' — record it."
- **游标仅在成功时推进**：本次拉取成功后才更新 `seen` 与检查时间；失败时下次仍需覆盖同一时间段。
- **离线**：桌宠离线时定时器照常运行但请求会失败，按上述退避处理，**不应**将失败写入去重表。

---

## 4. Hermes 已有的可复用件（本机实测）

路径：`C:\Users\user\AppData\Local\hermes\skills\`

### 4.1 总表

| Skill | 内容 | 结论 | 理由 |
|---|---|---|---|
| **arxiv** | `SKILL.md`（arXiv + Semantic Scholar 的 curl 用法）+ `scripts/search_arxiv.py`（纯 stdlib） | **需改造** | 知识可复用；**脚本在本机无法运行**，且查询语法存在缺陷（见下） |
| **blogwatcher** | 文档化 `blogwatcher-cli`（RSS/Atom 监控 CLI，SQLite 状态） | **可作为外部工具直接复用**；**不适合内嵌进 World** | 为独立 Go 二进制并自带 DB，不是库 |
| **competitor-news-monitor** | 纯**方法论**（无代码）：watchlist → cron tick → 采集 → **按事件去重** → 重要度评估 → digest | **设计上可直接借鉴** | 去重、退避、「失败≠无新闻」等原则正是本方案所需 |
| **grounded-citations** | `scripts/sources.py`（纯 stdlib 的 url→[n] 台账，`add/list/render/verify`） | **可选复用** | 若将来需产出「本周热点」纪要并附引用，可直接使用 |

### 4.2 arxiv skill：**脚本在本机无法运行**

- 脚本内容：使用 **`urllib.request`** 请求 `https://export.arxiv.org/api/query?...`，`User-Agent: HermesAgent/1.0`，`timeout=15`。
- **实测结果：直接失败**：
  ```
  ssl.SSLEOFError: [SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of protocol (_ssl.c:1016)
  ```
  复现确认：**同一台机器、同一个 URL，`curl` 返回 200，Python `urllib` 在握手阶段即 EOF**（本机 Python 使用 OpenSSL，curl 使用 Schannel）。即**本机环境下 Python urllib 到 `export.arxiv.org` 的链路不可用**。
- **另一处缺陷（较隐蔽）**：脚本第 36 行使用 `'+AND+'.join(parts)`，在 `all:`/`au:`/`cat:` 之间加入了 AND，**但单个 `all:` 内的多词未作处理**；第 28 行 `f'all:{quote(query)}'` 会将 `"neural architecture search"` 变为 `all:neural%20architecture%20search`，**实测被 arXiv 解析为 OR（427031 条）**。因此脚本的多词查询结果不正确。
- **结论：需改造。** 可复用的部分为：① 端点与参数字典；② XML 字段名（`a:title`/`a:id`/`a:published`/`a:summary`/`a:category`）；③ `sortBy` 映射表。**不可复用的部分为 transport（应改为 curl 或 Node fetch）与查询拼装（应改为显式 AND 加引号）。**
- 补充：`SKILL.md` 中写明「arXiv ~1 req/3s」「Semantic Scholar 1 req/s，**无需 key**」，**与实测不符**：S2 的无 key 路径目前**稳定返回 429**（见 §2.2③），该段内容应更新。

### 4.3 blogwatcher skill：可用的 RSS 监控工具，但属**本机未安装的外部二进制**

- 是否为 RSS/Atom 监控工具：**是。** 上游为 `github.com/JulienTant/blogwatcher-cli`，README 原文（实抓）：
  > "Pre-built binaries for **Linux, macOS, and Windows** are available on the GitHub Releases page."
- **实测**：最新 release 为 **`v0.2.1`（2026-05-19）**，资产中包含 **`blogwatcher-cli_windows_amd64.zip`** 与 `blogwatcher-cli_windows_arm64.zip`。
- **本机状态**：`which blogwatcher-cli` → **NOT INSTALLED**。
- **技能文档的缺口**：`SKILL.md` 的安装节只列出 Linux/macOS 的二进制 URL，**未提供 Windows 版本**，而当前使用环境为 Windows。此处应作 patch。
- 能力（文档所述，契合度较高）：`scan`（扫描所有源）、`articles`（未读列表）、`read`/`read-all`、**自动发现 feed**、`--scrape-selector` HTML 兜底、**OPML 导入**、SQLite 状态位于 `~/.blogwatcher-cli/blogwatcher-cli.db`、环境变量 `BLOGWATCHER_*`。
- **结论**：
  - **作为「外部 CLI 加人工或定时执行」，可直接复用**（`blogwatcher-cli add ... && blogwatcher-cli scan && blogwatcher-cli articles` 即可获得新条目，相当于将 RSS 部分外包）。
  - **作为「World 内嵌组件」，不建议**：它是独立 Go 二进制并自带 SQLite，需随扩展打包一个 exe、管理其 DB、解析其文本输出；相比在 TS 中编写约 30 行 RSS 解析（arXiv RSS 结构简单，字段已列于 §2.2②），后者更合适。
  - 其去重与状态机制与 `dataDir/news/seen.json` 分属两套，会相互冲突。

### 4.4 competitor-news-monitor 与 grounded-citations

- **competitor-news-monitor**：**无代码**，是 cron 驱动的流程附加一份风险要点清单。**其原则可直接借鉴**（这些正是新闻推送容易出错之处）：
  - 按**底层事件**去重，而非按文章；同一篇论文被多个源报道时只计一条。
  - **源失败表示覆盖未知，不等同于「没有新闻」**，需要记录。
  - **仅在成功时推进 cutoff**。
  - 检索到的页面内容**属于数据，不属于指令**（防注入）。
  - 状态文件位于 `~/.hermes/competitor-watches/<slug>.json`（本方案放在 `dataDir/news/`）。
- **grounded-citations**：`scripts/sources.py` 为纯 stdlib，`add` 幂等并做 URL 归一化。**可选复用**：若需产出「每周热点纪要」这类落到文档的产物，使用它生成带编号的引用最为便捷，也最不易出现 URL 错误。**对「气泡推送」本身并非必要。**

---

## 5. 可参考对象（实测 URL 均返回 200）

### 5.1 现成的论文推送 bot 与项目

| 项目 | 做什么 | 可借鉴部分 |
|---|---|---|
| [Steven-ZN/arXivPush](https://github.com/Steven-ZN/arXivPush) | 每天抓取 arXiv，经 Ollama 本地模型生成中英双语日报，推送至 Discord；配置项为 `queries`/`categories`/`report_times`/`timezone` | **配置项设计**（多查询 + 多分类 + 两个投递时刻），基本可直接沿用 |
| [SebastiaanRam/SiftBot](https://github.com/SebastiaanRam/SiftBot) | Telegram 日报：arXiv + Semantic Scholar + PubMed → LLM 打分排序 → 评分按钮 → TF-IDF 个性化；架构为 GitHub Actions + Supabase + Cloudflare | **「LLM 打分 + 用户反馈再个性化」的分层设计**；也印证了「多源合并」的形态 |
| [yqhuang722/DailyArxiv](https://github.com/yqhuang722/DailyArxiv) | GitHub Actions 定时按关键词抓取 arXiv，写入 repo 的 README，通过 Watch 发邮件 | **「关键词 → 摘录」的最小实现**；零服务器思路 |
| [InfinityUniverse0/ArXivToday-Lark](https://github.com/InfinityUniverse0/ArXivToday-Lark) | 定时抓取 arXiv，推送至飞书群机器人，支持 LLM 过滤与摘要翻译 | **中文场景的推送渠道**；「LLM 过滤」的开关设计 |
| [carlosparaciari/ArXivBot](https://github.com/carlosparaciari/ArXivBot) | Telegram：关键词搜索 + **指定分类的当日提交** | 「按分类查看当日新论文」的实现方式 |
| [yuandong-tian/arXiv_recbot](https://github.com/yuandong-tian/arXiv_recbot) | Telegram：每日推荐 + 用户点赞/收藏影响推荐模型 | **偏好反馈对推送内容的影响机制**（本方案可预留接口而不实现） |
| [Hugging Face Daily Papers](https://huggingface.co/papers) | 社区投票 + GitHub stars 活跃度排序的每日论文榜，提供邮件订阅 | **可直接作为数据源**（`/api/daily_papers`，自带 ai_summary/ai_keywords），省去「从几百篇中筛选热门」的环节 |

### 5.2 RSS → LLM 摘要工具（结构上最接近本方案）

| 项目 | 做什么 | 可借鉴部分 |
|---|---|---|
| [JohnXu22786/rss-digest](https://github.com/JohnXu22786/rss-digest) | **插件形态**（DeepSeek Harness bundle）：订阅管理 + 定时拉取 + **去重（精确哈希 + token-Jaccard 近似去重，CJK 感知 bigram）** + LLM 摘要 + 每日 Markdown 简报；**模型不可用时降级为抽取式摘要** | **架构最接近**：`scheduler.ts` / `store.ts`（版本化 JSON 原子落盘）/ `summarizer.ts`（**降级契约**）/ `digest.ts`。其中**「LLM 不可用时降级」与「落盘 store」两点尤其值得关注**。MIT，79 个测试 |
| [yinan-c/RSSbrew](https://github.com/yinan-c/RSSbrew) | 自托管：聚合 RSS + 自定义过滤 + AI 摘要 + 日/周简报 | **自定义过滤器的产品形态**，即面板上如何配置规则 |
| [edsu/rss-digest](https://github.com/edsu/rss-digest) | CLI：从 GReader 兼容阅读器（FreshRSS/Miniflux）取 24h 未读，生成单段 LLM 摘要；MIT | **「将往期摘要回喂给模型以避免重复讲述同一事件」**这一防重复技巧 |
| [banana2556/rssdigest](https://github.com/banana2556/rssdigest) | GitHub Actions 定时将 RSS 转为每日邮件摘要 | 零服务器方案（本方案不需要，桌宠本身在运行） |

### 5.3 商业与半商业产品（对标与集成可行性）

| 产品 | 做什么 | 结论 |
|---|---|---|
| [Hugging Face Daily Papers](https://huggingface.co/papers) | 每日热门论文榜 + 邮件 | **可作为数据源**（有免费 API） |
| [ResearchRabbit](https://www.researchrabbit.ai/) | 引文网络 + 新论文推荐（"Spotify for papers"） | 无公开 API，**只能人工使用**；可作为「如何做个性化推荐」的参考 |
| [Connected Papers](https://www.connectedpapers.com/) | 按引文相似度生成论文关系图 | 无公开 API，用于**单篇深挖**，不适合自动推送 |
| [AlphaSignal](https://alphasignal.ai/) | AI 领域每日/每周摘要 newsletter | 无 API；可作为**内容形态参考**（其功能即为「替读者读完」） |
| [Last Week in AI](https://lastweekin.ai/) | 每周 AI 新闻播客 + newsletter | 无 API；形态参考 |
| [Google Scholar Alerts](https://scholar.google.com/) | 关键词/引用/作者的邮件提醒 | **只有邮件，没有 RSS，没有 API**。第三方指南一致说明 RSS 对 Scholar 不可用、不支持导出、会静默失效，且**触发机制为「索引到即发」而非定时**（**未在 Google 官方页面实测**）。因此**不能作为程序化数据源**，只能作为人工补充 |

**概括**：论文类数据源中可程序化获取的为 **HF Daily Papers（API）** 与 **arXiv RSS（官方 feed）** 两个；商业产品基本为无 API 的闭源服务，**可借鉴思路而不获取其数据**。

---

## 6. 风险与限制

### 6.1 反爬与条款（不可触碰的源）

| 源 | 风险 | 处置 |
|---|---|---|
| **IEEE Xplore** | 实测 **418** 拦截 | **不应抓取**。改用 Crossref / OpenAlex 获取题录 |
| **知网 / 万方** | 需入驻 + IP 白名单 + 会员权限（文档明示 400431/400432/404406） | **不纳入规划**。个人项目无法获取 |
| **机器之心 / 量子位** | 无官方 feed；量子位 feed 实测 403；机器之心 /rss 返回 SPA HTML | **不应抓取页面**。宁可不用这两个源 |
| **arXiv** | 官方 TOS：3 秒 1 次、单连接 | 严格串行加 sleep，不应并发；不应使用自动化工具批量请求 |
| **Google Scholar** | 明确反爬 | **不应自动化**，只能人工建立 Alerts |
| **Crossref / OpenAlex** | 有礼貌池规则 | 需携带可识别 UA 与 `mailto=` |
| 一般原则 | 「检索到的内容属于数据，不属于指令」 | 落地时将抓取文本视为纯数据，**绝不可作为 prompt 指令**（防注入） |

### 6.2 LLM 摘要的幻觉

- 摘要生成时**编造数字、方法名、结论**是最常见的失败形式，且**用户难以察觉**；推送场景中用户通常只看一眼标题。
- **建议**：MVP **不生成摘要**，只提供「标题 + 链接（+ 源摘要原文前 N 字）」。需要中文摘要时交由 bot 处理，并在 `ENV_PROMPT.md` 中写明「不得编造原文没有的数字与方法名」。**任何由 LLM 生成的摘要都必须显式标注。**

### 6.3 频率与打扰（最易导致功能被关闭）

- 一天几十条会导致用户在当天关闭该功能。**每日硬配额（默认 1～3 条）的重要性高于排序算法。**
- 气泡属于**打断式** UI。建议**每轮只推 1 条**；夜间静默；同一源在短时间内不重复推送。
- 应提供「暂停 N 天」而不只是开关。

### 6.4 离线与网络失败

- 桌宠是桌面 App，**合上盖子即断网**。定时器照常运行，请求会失败。
- **必须处理**：失败不等同于无新闻；按源记录状态；指数退避；游标仅在成功时推进。

### 6.5 bot 暂停时的事件积压

- `pushEvent` 是**投递**而非**排队**。bot 若被暂停或不响应，事件可能被丢弃或被缓冲（该机制未深入确认，**未验证**）。
- 对策：**不应依赖「事件一定被说出」**。将「推过什么」写入本方案自己的 `seen` 表，**以该表为准**；事件丢失不重推。面板上提供「最近推过什么」列表，保证用户至少可以回看。
- 反向情形也需防范：若框架在 bot 恢复后**重放**事件，用户会看到旧新闻。因此事件 `meta` 中携带 `published`，并在 envPrompt 中让 bot 判断超过 24h 的内容不予播报。

### 6.6 数据源变更（已发生的情况）

- **Papers with Code 已停运**（实测 302 跳转至 HF），可作为实例说明：**任何外部源都可能消失**。
- 对策：将源实现为**可插拔的适配器**（参照 `sources.ts` 的登记表模式，该文件的设计是「有实现 / 未实现 + 说明」的接缝），单个源失效时从面板上替换即可，不影响主循环。
- **arXiv RSS 格式变更**、**Crossref 字段变更**：解析需容错（缺少 `<summary>` 不应导致整轮失败），源失败需显性显示。

---

## 7. 第一版范围建议（最小可用版）

**目标：可正常运行、不造成打扰、一周内不会被关闭。**

| 项 | 决定 | 理由 |
|---|---|---|
| **源** | **只选 1 个：arXiv RSS**（`/rss/cs.LG` + `/rss/eess.SP`，2 个分类） | 免 key、官方、**自带摘要**、一次请求获取当日全部新增、可按 `announce_type:new` 过滤 |
| **摘要策略** | **不生成 LLM 摘要**。事件文本 = 中文前缀 + **论文英文标题** + 链接（可选携带源摘要前 100 字） | 零幻觉风险、零费用、零延迟。中文表述交由 bot 的 envPrompt |
| **每日条数** | **默认 2 条**（硬上限，落盘计数） | 气泡为打断式 UI，宜少不宜多 |
| **过滤** | 分类 + **关键词白名单**（标题权重 > 摘要），`minKeywords=1` | 成本极低，效果明显 |
| **节奏** | 检查间隔 `pollMinutes=60`；投递窗口 `9:00–22:00`；**每轮最多 1 条**；跨窗口入队次日补投 | 白天推送、夜间安静 |
| **去重** | `dataDir/news/seen.json`，键 = arXiv `guid` **去版本号**，保留 14 天 | **必须落盘**，否则重启后会重复推送 |
| **配置旋钮** | `enabled` / `sources` / `keywords` / `maxPerDay` / `pollMinutes` / `pushStartHour` / `pushEndHour` / `includeAbstract` | 8 个即可满足；面板上增加「立即试推」与「清空去重表」 |
| **失败处理** | 按源记录「最后成功/最后错误」，指数退避，游标仅在成功时推进；面板显性显示源状态 | 失败不应静默 |
| **明确不做** | 多源、嵌入相似度、LLM 摘要与翻译、知网/万方、IEEE Xplore 抓取、X/Twitter、机器之心/量子位 | 或者无法获取，或者性价比低，或者存在条款与幻觉风险 |
| **估时** | **半天～1 天** | 全部复用已有 World 机制 |

**验收标准（完成后如何判定通过）**
1. 面板可显示「上次检查时间 / 今日已推 N 条 / 各源最后成功时间」。
2. 手动点击「试推」后，桌宠气泡中出现一条**标题可点击、链接正确**的论文。
3. **重启桌宠后不重复推送**已推过的条目（去重表落盘生效）。
4. 断网时不死循环，不退化为「没有新闻」，恢复网络后能够自愈。
5. 一天结束后，实际推送条数 **≤ `maxPerDay`**，且夜间不推送任何条目。

**第二版可增加的内容（按性价比排序）**
1. HF Daily Papers（免 key，自带 ai_summary 与热度排序，可作为「精选」源）。**性价比最高的下一步。**
2. Crossref `journals/0278-0046/works`（跟踪 IEEE TIE 新文章，绕开 Xplore 的 418）。
3. IEEE Spectrum RSS（行业新闻，稳定）。
4. 面板上的关键词编辑 UI。
5. LLM 摘要（**最后考虑**，且必须标注）。

---

## 附录 A：验证方法与环境

- 环境：Windows 11 + git-bash（MSYS）；`curl 8.19.0 (x86_64-w64-mingw32, Schannel)`；`Python 3.11.16`；Node 侧为 Electron 运行时。
- 时间：2026-10-16。
- 方法：对每个端点使用 `curl -s -w "HTTP:%{http_code} TIME:%{time_total}"` 实取，必要时使用 `-L` 跟随跳转、`--compressed` 解压；XML/JSON 经 Python 解析后打印真实字段。所有状态码、字段名与限额数字均取自**实际返回体或响应头**。
- 未验证清单（明确标注）：
  - phys.org ML/AI RSS 路径（本次 **404**，正确路径未知）。
  - OpenAlex `abstract_inverted_index` 拼回文本的具体算法（仅确认其为倒排索引）。
  - 知网/万方的接口字段与鉴权流程（仅阅读公开文档页，**未做真实鉴权请求**）。
  - Google Scholar Alerts「无 RSS/无导出/会静默失效」（来自第三方指南，**未在 Google 官方页实测**）。
  - X/Twitter 免费层可用性（未实测）。
  - `host.pushEvent` 在 bot 暂停时是否排队或丢弃（未验证，按「可能丢弃」设计）。

## 附录 B：可直接使用的端点速查

```bash
# arXiv：只拿最新（注意 AND + 引号）
curl -s 'https://export.arxiv.org/api/query?search_query=all:bearing+AND+all:%22fault+diagnosis%22&sortBy=submittedDate&sortOrder=descending&max_results=10'

# arXiv 官方 RSS：当日新增（自带摘要 + announce type）
curl -s 'https://rss.arxiv.org/rss/eess.SP'

# HF Daily Papers：自带 AI 摘要 + 关键词
curl -s 'https://huggingface.co/api/daily_papers?limit=10'

# Crossref：IEEE TIE 最新题录（绕开 Xplore 的 418）
curl -s 'https://api.crossref.org/journals/0278-0046/works?rows=10&sort=published&order=desc&select=DOI,title,issued,containerTitle&mailto=you@example.com'

# OpenAlex：按 ISSN 看期刊新文（注意 IP 共享配额）
curl -s 'https://api.openalex.org/works?filter=primary_location.source.issn:0278-0046&sort=publication_date:desc&per_page=10&mailto=you@example.com'

# Semantic Scholar：单条搜索会 429，用 /bulk
curl -s 'https://api.semanticscholar.org/graph/v1/paper/search/bulk?query=%22bearing+fault+diagnosis%22&fields=title,publicationDate,abstract,citationCount'

# 行业新闻（全部 200、免 key）
curl -s 'https://spectrum.ieee.org/feeds/feed.rss'
curl -s 'https://www.nature.com/nature.rss'
curl -s --compressed 'https://deepmind.google/blog/rss.xml'   # 注意 --compressed
```
