# 桌宠定时推送研究热点 · 技术方案

> 调研时间：2026-10-16（Asia/Shanghai）
> 调研方式：所有 API/URL 均用 `curl` 实际访问一次，下文凡出现状态码、字段名、限额的，都是**本次实测返回**；凡没有实测到的，显式标注「**未验证**」。
> 目标读者：CooLuCostom 扩展的下一位维护者（或本人）。
> 范围：只做方案，不含扩展代码；不改动仓库现有文件。

---

## 0. 结论（先看这段）

**好做，而且是「小到中」的工作量。** 因为桌宠这边**该有的机制都已经跑通了**——World 有 `setInterval` 定时器、有 `host.pushEvent` 把事件塞给 bot、有配置组、有面板 `ctx.invoke` 数据面，全都是「用量额度」World 里已经在用的东西。真正要新写的只有四块：**拉数据、去重、过滤、节流**。

- **第一版（能用）≈ 半天到一天**：1 个数据源（arXiv 官方 RSS）+ 落盘去重 + 面板 3 个开关。
- **完整版（多源 + 相关度 + 口语化）≈ 3～5 天**：多源、配额、评分排序、失败退避、面板调参。

**最难/最容易踩坑的三件事**（都不是技术难点，是「不踩就白干」的点）：

1. **arXiv 的查询语法是个陷阱**——`+` 分隔的词默认是 **OR** 不是 AND。实测 `all:bearing+fault+diagnosis` 被解析成 `all:bearing OR all:fault OR all:diagnosis`，返回 38017 篇（全是量子计算之类的噪声）。必须写 `all:bearing+AND+all:"fault+diagnosis"` 才是 122 篇精准结果。**照抄现成脚本会踩这个坑**（本机 `arxiv` skill 的脚本就踩了，见 §4）。
2. **去重游标必须落盘**。现有 World 的提醒游标 `firedByAccount` 是**纯内存**的（`world.ts:75`），进程一重启就忘。新闻推送如果照抄这个做法，每次重启都会把当天的一批重新推一遍。
3. **Papers with Code 已经死了**。它的 API 现在 302 到 `huggingface.co/papers/trending`。任何「PwC 抓热门论文」的老方案都作废，直接用 HF Daily Papers（它甚至自带 AI 摘要和关键词）。

**好消息**：真正高质量的源（arXiv RSS、IEEE Spectrum、Nature、HF Daily Papers、Crossref）**全部免费、全部不需要 key**，而且**全部实测 200 可用**。需要 key 的那几家（OpenAlex 免费 key、Semantic Scholar 免费 key）反而可以先不接。

---

## 1. 结论：好不好做、工作量

### 1.1 已经具备的（不用重做，直接借用量额 World 的写法）

| 能力 | 现有实现（`extension/src/world.ts`） | 新闻推送怎么用 |
|---|---|---|
| 定时触发 | `start()` 里 `refresh()` + `schedule()`；`setInterval(minutes*60_000)`，`timer.unref?.()`；`stop()` 清定时器 | 照抄，换一个 `pollMinutes` 和一段拉取逻辑 |
| 给 bot 投事件 | `host.pushEvent({type,ts,source,origin:'internal',senderKey,text,meta})`，外面包 `try/catch`（投递失败不能弄死循环） | 照抄，`type` 换成 `news.item` |
| 配置组 | `QUOTA_CONFIG_GROUP`（`worlds.quota.*` 键 + `x-hot`/`x-path` + schema 描述） | 新开一个 `world:news` 组 |
| 面板 | `console()` 声明 `panels`、`invoke(panel,method,args,language)` 数据面、`config:[...]` | 加一页「研究热点」 |
| 交给 bot 的话术 | `promptDocs` + `role:'envPrompt'` 指向 `ENV_PROMPT.md`；注释明确「只陈述事实，要不要说、怎么说在 envPrompt 里」 | 同一个套路：事件只放标题+链接，播报与否交给 bot |
| 并发合并 | `inflight` promise，同一时刻只有一次取数 | 照抄，避免面板和定时器打架 |
| 时区 | `opts.timezone` 注入 | 用来做「白天才推、夜间静默」 |

### 1.2 要新写的（这就是全部工作量）

1. **数据源适配器**（arXiv RSS 解析 → 统一成 `{id,title,url,summary,published,source,tags}`）
2. **落盘的去重表**（不能再用内存 Set）
3. **相关度过滤**（关键词/分类；嵌入相似度可以后放）
4. **每日配额 + 时间窗**（白天才推、每天最多 N 条）
5. **面板旋钮 + 一个「立即试推」按钮**

### 1.3 工作量分级

| 版本 | 内容 | 估时 | 风险 |
|---|---|---|---|
| **MVP** | arXiv RSS 单源 + 落盘去重 + 面板开关（源/间隔/每天上限）| **半天～1 天** | 低。全是已有套路 |
| **v1** | + 1～2 个行业源（IEEE Spectrum / HF Daily Papers）+ 关键词过滤 + 白天窗口 + 失败退避 | **1～2 天** | 低 |
| **v2** | + 多源、分类权重、Crossref 补 IEEE TIE 早期文章、LLM 摘要/口语化、面板可视化调整 | **3～5 天** | 中（LLM 摘要的幻觉与费用） |

**唯一算得上「难点」的**：相关度排序做得对不对。如果只按分类拉 arXiv，一天 cs.LG+eess.SP 加起来几百篇，全推等于骚扰。**必须**有过滤+配额，否则这功能一周内就会被关掉。

---

## 2. 数据源调研

### 2.1 总表（状态码均为本次实测）

| 源 | 端点 | 需要 key | 实测状态 | 能拿到「标题+链接+摘要+时间」 | 限额（实测/官方） |
|---|---|---|---|---|---|
| arXiv API | `export.arxiv.org/api/query` | 否 | **200** | ✅ Atom XML 全都有 | 官方 TOS：**每 3 秒最多 1 次请求，单连接** |
| arXiv RSS | `rss.arxiv.org/rss/<分类>` | 否 | **200** | ✅ **描述里直接带摘要 + announce type** | 同上（属 legacy API） |
| arXiv 邮件订阅 | `info.arxiv.org/help/subscribe.html` | 否 | **200** | 邮件（非 API） | — |
| Semantic Scholar | `.../graph/v1/paper/search` | 否（有 key 更高） | **429**（无 key，反复重试仍 429） | — | 共享池被限 |
| Semantic Scholar **/bulk** | `.../graph/v1/paper/search/bulk` | 否 | **200** ✅ | ✅ JSON | 走另一个池，实测可用 |
| OpenAlex | `api.openalex.org/works` | 否（建议免费 key） | **200/429 交替** | ✅ JSON（摘要是**倒排索引**） | **1000 credits/天，按 IP 共享** |
| Crossref | `api.crossref.org/works` | 否 | **200** ✅ | ✅（无摘要，只有题录） | **1 req/s，并发 1** |
| Papers with Code | `paperswithcode.com/api/v1/...` | — | **已死**，302 到 HF | ❌ | — |
| HF Daily Papers | `huggingface.co/api/daily_papers` | 否 | **200** ✅ | ✅ **自带 ai_summary + ai_keywords** | 未见到明确限额 |
| IEEE Spectrum | `spectrum.ieee.org/feeds/feed.rss` | 否 | **200** | ✅ 30 条 | — |
| Nature | `nature.com/nature.rss` | 否 | **200** | ✅ | — |
| Nature 工程子刊 | `nature.com/subjects/engineering.rss` | 否 | **200** | ✅ | — |
| Science news | `science.org/rss/news_current.xml` | 否 | **200** | ✅（RDF 格式） | — |
| MSR 博客 | `microsoft.com/en-us/research/feed/` | 否 | **200** | ✅ | — |
| Google AI 博客 | `blog.google/technology/ai/rss/` | 否 | **200** | ✅ | — |
| OpenAI | `openai.com/blog/rss.xml` | 否 | **200** | ✅（"OpenAI News"） | — |
| DeepMind | `deepmind.google/blog/rss.xml` | 否 | **200** | ✅ **但响应是 gzip**，必须 `--compressed` | — |
| 机器之心 | `jiqizhixin.com/rss` | — | **200 但返回 HTML**（SPA 页，非 feed）；`/rss/all`、`/rss/category/1` = **404** | ❌ | 无官方 feed |
| 量子位 | `qbitai.com/feed` | — | **200（0 条）→ 再访问 403 size 0** | ❌ | 不稳定/像蜜罐 |
| 雷峰网 | `leiphone.com/feed` | 否 | **200** | ✅ 517KB | — |
| 36氪 | `36kr.com/feed` | — | **200 但 text/html**（非 feed） | ❌ | — |
| IT之家 | `ithome.com/rss/` | 否 | **200** | ✅ | — |
| 智源社区 | `hub.baai.ac.cn/rss` | — | **404** | ❌ | 未找到 feed |
| TechXplore ML/AI | `techxplore.com/rss-feed/machine-learning-ai-news/` | 否 | **200** | ✅ | — |
| ScienceDaily AI | `sciencedaily.com/rss/computers_math/artificial_intelligence.xml` | 否 | **200** | ✅ | — |
| phys.org ML/AI | `phys.org/rss-feed/technology-news/...` | 否 | **404** | **未验证**（路径待确认） | — |
| **IEEE Xplore** | `ieeexplore.ieee.org/...` | — | **418**（反爬拦死） | ❌ | **不能程序化访问** |
| IEEE TIE 早期文章 | → 改走 Crossref `journals/0278-0046` | 否 | **200** ✅ | 题录（无摘要） | 1 req/s |

### 2.2 学术侧逐条

#### ① arXiv API —— 免 key，但语法是最大的坑

- 端点：`https://export.arxiv.org/api/query`（GET，返回 Atom XML）
- **实测**：`search_query=cat:cs.LG&sortBy=submittedDate&sortOrder=descending&max_results=3` → **HTTP 200**，2.5s，8438 字节；`opensearch:totalResults` = 293610。
- **排序参数**（官方 user-manual 实测抓取）：`sortBy` = `relevance` | `lastUpdatedDate` | `submittedDate`，`sortOrder` = `ascending` | `descending`；分页 `start` + `max_results`。
- **限额**（官方 TOS 原文，实抓 `info.arxiv.org/help/api/tou.html`）：
  > "When using the legacy APIs (including OAI-PMH, RSS, and the arXiv API), **make no more than one request every three seconds**, and limit requests to a single connection at a time."
- **关键字语法实测（重要）**：

  | 你写的 | arXiv 实际解析成 | 实测条数 | 结论 |
  |---|---|---|---|
  | `all:bearing+fault+diagnosis` | `all:bearing **OR** all:fault OR all:diagnosis` | 38017（噪声） | ❌ 默认是 OR |
  | `all:neural%20architecture%20search`（单前缀多词） | `all:neural **OR** all:architecture OR all:search` | 427031（噪声） | ❌ 同上 |
  | `all:bearing+AND+all:"fault diagnosis"` | 原样 AND | **122（全相关）** | ✅ 必须显式 AND + 引号 |
  | `ti:"neural architecture search"` | 原样 | 850 | ✅ 标题短语很干净 |
  | `cat:cs.LG+OR+cat:eess.SP` | 原样 | 327441 | ✅ 分类可用 |

- **返回字段**：`<title>` / `<id>`（含版本，如 `http://arxiv.org/abs/2610.22372v1`）/ `<published>` / `<summary>`（摘要）/ `<author><name>` / `<category term="...">`。
- 建议：**不要用它做「日更订阅」**，用下面的 RSS；它适合做「按关键词/作者定向搜索」。

#### ② arXiv RSS —— 本次调研里「性价比最高」的源 ★

- 端点：`https://rss.arxiv.org/rss/<分类>`（和 `export.arxiv.org/rss/<分类>` 返回同一份）
- **实测**：`/rss/cs.LG` → **HTTP 200**，`application/rss+xml`，**991832 字节**，**467 条 item**；`eess.SP` / `cs.CV` / `cs.AI` / `eess.AS` 全部 **200**。
- **单条 item 字段（实测抓取 cs.LG 第 1 条）**：
  - `title`: `FlowBudget: Training-Free Sampling-Budget Estimation for Flow Matching Models`
  - `link`: `https://arxiv.org/abs/2610.20636`
  - `description`: `arXiv:2610.20636v1 **Announce Type: new** Abstract: Sampling from continuous flow-based generators...` ← **摘要和「新增/替换/交叉」类型都在里面**
  - `pubDate`: `Fri, 16 Oct 2026 00:00:00 -0400`
  - `guid`: `oai:arXiv.org:2610.20636v1`
  - `category`: `cs.LG`；`dc:creator`: 作者列表
- **为什么好**：一次请求 = 一个分类的全部当日新增，**自带摘要**，**有 announce type 可以只挑 `new`**，免 key，还能按分类组合。**这就是 MVP 的首选源。**

#### ③ Semantic Scholar —— 单条搜索被限，**/bulk 端点实测可用**

- `https://api.semanticscholar.org/graph/v1/paper/search?query=...` → **429**，且间隔 8 秒重试仍是 **429**，报错原文：
  `{"message": "Too Many Requests. Please wait and try again or apply for a key for higher rate limits."}`
  → **本机 IP 的共享池被限死了，无 key 基本不可用。**
- **但** `https://api.semanticscholar.org/graph/v1/paper/search/bulk?query="bearing fault diagnosis"` → **HTTP 200** ✅，返回 `{total: 2319, token: ...}`，`data[]` 字段有 `title / publicationDate / citationCount / abstract / externalIds`。
  → 走的是另一个池。**要按主题批量捞、且要摘要，用 /bulk。**
- 注意：实测那批 `externalIds.ArXiv` 是 `None`（都是期刊论文，没有 arXiv ID）——所以 **S2 和 arXiv 的重叠没有想象中高**。

#### ④ OpenAlex —— 可用，但**按 IP 共享配额**，会周期性 429

- 端点：`https://api.openalex.org/works`
- **实测**：第一次 **429**（`X-RateLimit-Remaining: 0`，`X-RateLimit-Reset: 37059`）；约十几分钟后再试 → **HTTP 200**（`X-RateLimit-Remaining: 613`）。→ **同一 IP 的共享预算会被别人耗尽，改 `mailto` 不提升额度**。
- 官方在返回体里直接写明（实测原文）：
  > "No API key, so this request shares one free daily budget (**$0.10**) with everyone on your network's IP address. The mailto parameter doesn't raise this limit. Get a free key with its own **$1/day** at https://openalex.org/settings/api … An AI agent can get one for its user in one call: **POST https://api.openalex.org/api-keys** with `{"email": "..."}`"
  → 每次查询 `cost_usd: 0.001`。
- **字段实测**：`display_name`(标题) / `publication_date` / `type` / `cited_by_count` / `doi` / `id` / `ids` / `open_access` / `primary_location.source` / `keywords` / `topics` / `is_retracted`，以及 **`abstract_inverted_index`**（注意：摘要存的是**倒排索引**，要自己拼回文本）。
- **按期刊过滤实测可用**：`?filter=primary_location.source.issn:0278-0046&sort=publication_date:desc` → **200**，`count: 22688`（IEEE TIE 全库）。**这是「不碰 IEEE Xplore」拿到 TIE 新文章的一条正路。**

#### ⑤ Crossref —— 免 key、稳定、是 IEEE Xplore 的正经绕行 ★

- 端点：`https://api.crossref.org/works`
- **实测**：`?query.bibliographic=bearing+fault+diagnosis&rows=2` → **HTTP 200**，2.1s，`total-results: 1087399`；字段 `DOI / title / issued / container-title / type`。
- **限额实测（响应头）**：`x-rate-limit-limit: 1`，`x-rate-limit-interval: 1s`，`x-concurrency-limit: 1` → **每秒 1 次、并发 1**。无 key，加 `mailto=` 进 polite pool。
- **期刊级查询实测（关键）**：`https://api.crossref.org/journals/0278-0046/works?rows=5&sort=published&order=desc` → **HTTP 200**，`total-results: 22420`，返回的正是 IEEE TIE 的最新文章（`10.1109/tie.2026.3675078` 等）。
  → **IEEE Xplore 对脚本返回 418，但 Crossref 能拿到 TIE 的题录+DOI。** 想盯「导师关注的期刊有没有出新文章」，走这条。

#### ⑥ Papers with Code —— **已停运，别再规划它** ★

- 实测 `https://paperswithcode.com/api/v1/papers/?page=1` → 最终 URL 变成 **`https://huggingface.co/papers/trending`**，返回 **`text/html`**（不是 JSON）。
- 结论：**PwC 已被 Hugging Face 收编**。所有基于 PwC API 的老方案作废。

#### ⑦ Hugging Face Daily Papers —— 免 key，**自带 AI 摘要与关键词** ★

- 端点：`https://huggingface.co/api/daily_papers?limit=N` → **HTTP 200**，`application/json`。
- **字段实测（完整）**：
  - `paper.id`（= arXiv ID，如 `2610.16105`）/ `paper.authors[]` / `paper.publishedAt` / `paper.submittedOnDailyAt` / `paper.title` / `paper.summary` / **`paper.ai_summary`** / **`paper.ai_keywords`** / `paper.ai_summary_model` / `paper.upvotes` / `paper.discussionId`
  - 顶层还有 `publishedAt` / `numComments` / `submittedBy` / `isAuthorParticipating`
- 页面 `https://huggingface.co/papers`（**200**）按 **GitHub stars 活跃度**排序，有 Daily/Weekly/Monthly 视图，并**提供每日邮件订阅**。
- **价值**：别人已经帮你做了「从当天几百篇里挑出热门的」这件事，而且**摘要都是现成的**，扩展里连 LLM 都不用调。

### 2.3 行业/新闻侧逐条

- **IEEE Spectrum** `https://spectrum.ieee.org/feeds/feed.rss` → **200**，30 条，字段 `title/link/pubDate/category`。首条实测：`Chasing China's Monazite Monopoly` / `2026-10-15 14:54:03 +0000`。**免 key、稳定。**
- **Nature** `https://www.nature.com/nature.rss` → 200；工程子刊 `https://www.nature.com/subjects/engineering.rss` → 200；`nnano.rss` → 200。
- **Science** `https://www.science.org/rss/news_current.xml` → 200，RDF 格式，标题 "Latest News from Science Magazine"。
- **大厂博客全部实测 200**：MSR `https://www.microsoft.com/en-us/research/feed/`、Google AI `https://blog.google/technology/ai/rss/`、OpenAI `https://openai.com/blog/rss.xml`（标题 "OpenAI News"）、**DeepMind `https://deepmind.google/blog/rss.xml`（注意：响应是 gzip，不加 `--compressed` 拿到的是乱码二进制）**。
- **国内源现状（实测，结论偏负面）**：
  - **机器之心**：`/rss` 返回 **200 但是 HTML**（新版前端 SPA），`/rss/all`、`/rss/category/1` 均 **404**。→ **没有可用的官方 feed。**
  - **量子位**：`qbitai.com/feed` 第一次 **200 但 0 条 item**，隔一会再访问直接 **403 size 0**。→ **不稳定，别依赖**。
  - **雷峰网** `leiphone.com/feed` → **200**，`application/rss+xml`，517KB ✅（国内 AI 新闻里少数能用的）
  - **IT之家** `ithome.com/rss/` → **200** ✅；**36氪** `/feed` → 200 但是 HTML ❌；**智源社区** `hub.baai.ac.cn/rss` → **404** ❌
  - 备选：TechXplore ML/AI `https://techxplore.com/rss-feed/machine-learning-ai-news/` → 200 ✅；ScienceDaily AI → 200 ✅
- **国内学术库程序化访问（知网/万方）—— 目前**基本不可行****：
  - **知网**：确有「知网研学开放平台」（`/openx/` 前缀，JWT 认证，`用户名+密码` 换 token）。但文档明确列出权限错误码：`400431 IP 或域名限制访问`、`400432 IP/域名不在白名单`、`404406 会员权限不足`，且需**三方应用入驻**。域名是 `http://`（非 https），且我看到的入口是**高校代理域名**（`.utuedu.com`）。
    → 结论：**个人项目拿不到稳定可用的知网接口**。（字段细节来自其文档页，**未做鉴权实测**。）
  - **万方**：开放平台 `https://apps.wanfangdata.com.cn/open/docs`，有「API 网关 / JSAPI / 开放 API 列表 / OAuth2.0」，但需要**注册应用**、走「我的应用」流程。
    → 结论：**需要申请，不是免 key 的公开接口**（**未做鉴权实测**）。
- **IEEE Xplore / IEEE TIE 早期访问**：`https://ieeexplore.ieee.org/xpl/RecentIssue.jsp?punumber=41` → **HTTP 418**；`https://ieeexplore.ieee.org/rss/TOC41.XML` → **HTTP 418**。**反爬直接拦死，不要尝试爬。**
  → 替代：**Crossref 的 `journals/0278-0046/works`（实测 200）** 或 **OpenAlex 的 ISSN 过滤（实测 200）**。
- **X / Twitter**：不可行了 —— 官方 API 要付费，免费层基本只读不了内容（本次**未实测**，按常识判断不列入方案）。

---

## 3. 技术路线（能落地的管道）

```
[定时器] → [拉取] → [规范化] → [落盘去重] → [相关度过滤] → [排序/配额] → [投递节奏] → [pushEvent] → bot 决定说或不说
```

### 3.1 定时触发：用 World 自己的 `setInterval`（照抄现有写法）

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
- **生命周期**：`start(host)` 里先 `await this.refresh(...)` 再 `schedule()`；`stop()` 必须 `clearInterval` + 置空 host（现有代码已经这么做）。
- **桌宠不是常驻服务器**：定时器活在 Electron 进程里，**App 关了就不跑**。所以推送是「开机期间尽力而为」，**不能承诺「每天必到」**。设计上要接受漏推，并用「下次启动补看最近 24h」来兜底。
- **建议**：新闻源的检查频率**不需要 10 分钟一次**。源本身是日更的（arXiv RSS 每个工作日更新一次），推荐 `pollMinutes` 默认 **60～180**，或者干脆用「每天到点检查一次」的模式：定时器可以跑得勤（比如每 30 分钟醒一次），但**只在跨过目标投递时刻时才真正拉取**。
- **注意 `unref()`**：现有代码调了它，意味着定时器不会把进程钉住。保持这个行为即可。

### 3.2 拉取与规范化

- **MVP 只拉 arXiv RSS**：`https://rss.arxiv.org/rss/{cat}`，分类可多选（如 `cs.LG` + `eess.SP`）。
- **请求要带的头**：一个可识别的 `User-Agent`（arXiv 要求）。**用 Node/Electron 的 `fetch`**——**不要用 Python 的 `urllib`**，本机实测 Python 那条路握手就挂（见 §4.2）。
- **节流**：arXiv 官方是 **3 秒 1 次**。多分类就串行 + `await sleep(3000)`，别并发。
- **DeepMind 那种 gzip 响应**：Node `fetch` 会自动解压；如果手动发请求要显式接受 gzip。
- **规范化成统一结构**（所有源都映射到它）：

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

### 3.3 去重：**必须落盘**，这是最容易做错的一步

- **键的选择**（按可靠性排序）：
  - arXiv RSS：用 `guid`（形状 `oai:arXiv.org:2610.20636v1`）**去掉版本后缀** → `oai:arXiv.org:2610.20636`。**去掉 `v1/v2` 很重要**，否则同一篇论文每次改版都会当成新论文推一遍。
  - Crossref：`DOI`（小写化）。
  - 通用兜底：`url` 规范化（去 query、去尾斜杠、小写 host）。
  - **不要用标题做键**——arXiv 标题重排（大小写/换行）会导致重复。
- **存哪里**：`opts.dataDir`（现有 World 已经在这里放 `quota/accounts.json`）。建议 `dataDir/news/seen.json`。
- **警告**：**别照抄现有的 `firedByAccount: Map<string, Set<string>>`**（`world.ts:75`）——那个是**纯内存**的，注释也写了它按账号分游标，但**没有任何落盘**。新闻推送如果内存去重，**每次重启都会重推当天全部**。
- **保留期**：只留最近 N 天（比如 14 天）的键，文件别无限长。
- **写盘容错**：照抄现有 `persistAccounts()` 的做法——`try/catch` 包住，写不进去不能让取数循环掉线。

### 3.4 相关度过滤（三档，按代价递增）

| 档 | 做法 | 代价 | 精度 | 建议 |
|---|---|---|---|---|
| **① 分类/源** | 只订阅 `cs.LG`、`eess.SP`、`eess.AS`；`announce_type` 只取 `new` | **零** | 低（一天几百篇） | MVP 必选，但**不够** |
| **② 关键词** | 标题+摘要命中白名单词（`fault diagnosis`、`bearing`、`neural architecture search`、`DARTS`、`hardware-aware`、`edge`、`quantization`…），带加权（标题命中 > 摘要命中） | **极低**（纯字符串） | 中 | **v1 主力方案，性价比最高** |
| **③ 嵌入相似度** | 把用户兴趣描述 embedding 化，对每篇算余弦相似度取 topN | **高**：要模型/API、要跑几百次 embedding | 高 | 放 v2。**对桌宠来说性价比差**（要联网、要费用、要延迟） |

- **强烈建议 v1 只用 ①②**。关键词表做成配置项（面板可编辑），用户自己就能调。
- 关键词匹配注意：**大小写不敏感**、**`NAS` 这种短词要用词边界**（否则 `nasal`、`Nash` 会中）。

### 3.5 排序与配额

- 排序建议（简单的加权和就够）：
  - 关键词命中数（标题权重 ×3）
  - 是否有 `ai_keywords` / `upvotes`（HF 源）= 热度信号
  - 发表时间（越新越靠前）
- **每日硬配额**：`每天最多 N 条`，默认 **1～3 条**。**这一项比排序算法重要得多**——没有配额，再好的排序也会变成骚扰。
- 配额计数也要落盘（跟去重表放一起），否则重启就重置。

### 3.6 摘要与口语化：**先别在扩展里做 LLM**

三条路，我的建议写在最后：

| 方案 | 代价 | 风险 |
|---|---|---|
| **A. 扩展里不调 LLM，事件里给「标题 + 一句话（源的摘要原样，截断）+ 链接」** | **零** | 无幻觉。**推荐 MVP 用这个** |
| **B. 让 bot 自己组织语言**（事件里只说「有 3 条新的」，bot 用工具去取详情再说） | 低（复用 bot 已有的模型） | bot 可能夸大或脑补；需要在 `ENV_PROMPT.md` 里明确「不许编造摘要内容」 |
| **C. 扩展里直接调 LLM 生成中文摘要** | 高（要 API key、要钱、要延迟、要处理失败） | **幻觉风险最高**：论文摘要翻译/压缩时编造数字或方法名，用户看不出来 |

- **建议**：MVP = A，v1 = A + 给 bot 的 envPrompt 里写清楚话术（≈B）。**C 明确不建议放在第一版**——除非用户自己愿意承担「摘要是模型编的」这个风险，并且摘要**必须**标注「AI 生成，可能有误」。
- 现有 World 的设计哲学也支持 A：`world.ts` 注释写得很清楚——**「只做机械计算……说什么、什么时候说，交给 bot 判断」**。新闻推送应该沿用这条边界：**扩展负责「取到事实」，bot 负责「怎么说」。**
- 如果一定要 A 里的「中文」：arXiv 的摘要是英文。**别在扩展里翻译**（那就要 LLM 了）；要么原样给英文，要么交给 bot 翻。

### 3.7 投递节奏

- **白天才推、夜间静默**：用注入的 `opts.timezone`，判断当前小时是否在 `[pushStartHour, pushEndHour)`（比如 9:00–22:00）。窗口外**只入队不投递**，进窗口后补投。
- **每轮的 flag**：照抄 `pushAlert` 的写法（`world.ts:380-403`）——`host.pushEvent({type, ts, source, origin:'internal', senderKey, text, meta})`，**外面包 `try/catch`**，投递失败不能弄死循环。
  - `type` 建议 `news.item` / `news.digest`；`meta` 里带 `{source, url, published, tags}` 供 bot 需要时引用。
  - `ts` 用 `nowIso(this.opts.timezone)`（现有代码就是这么做）。
- **一次推一条 还是一条推多条**：建议**每轮最多推 1 条**（配额内），避免气泡刷屏；剩余的下轮再说。
- **节流**：即使 `pollMinutes=30`，也要保证「同一时刻只有一次取数」——照抄 `inflight` 合并（`world.ts:299-303`）。

### 3.8 配置项（面板要哪些旋钮）

新增配置组（形状照 `QUOTA_CONFIG_GROUP`，键名 `worlds.news.*`）：

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `false` | 契约要求默认关闭 |
| `sources` | string[] | `['arxiv:cs.LG','arxiv:eess.SP']` | 订阅哪些源 |
| `pollMinutes` | integer | `60` | 检查间隔；0 = 关 |
| `keywords` | string[] | `['fault diagnosis','bearing','neural architecture search','DARTS','hardware-aware','edge']` | 相关度白名单 |
| `maxPerDay` | integer | `2` | 每日上限（**最重要的旋钮**） |
| `pushStartHour` / `pushEndHour` | integer | `9` / `22` | 静默窗口 |
| `includeAbstract` | boolean | `true` | 事件里是否带摘要（关了更像「只给标题+链接」） |
| `minKeywords` | integer | `1` | 命中几个关键词才算相关 |

交互面：
- `console()` 里加一页 panel「研究热点」，用 `invoke` 暴露 `state` / `seen`（最近推过什么）/ `testPush`（**手动试推一条**，调试必备）/ `clearSeen`（清空去重表）。
- 建议在面板上显示「上次检查时间 / 今日已推 N 条 / 各源最后成功时间」——**源失败要显性可见**，不能静默。

### 3.9 失败与退避

- **每个源独立记状态**（最后成功时间、最后错误）。一个源挂了**不能**让其他源也停。
- **退避**：失败后按指数退避（1×→2×→4×，封顶几小时），成功后重置。别在源 503 时每分钟去撞。
- **绝不把「拉取失败」当成「没有新闻」**——这是 `competitor-news-monitor` skill 里明确写的坑，值得照搬：
  > "A source failure means unknown coverage, not 'no news' — record it."
- **游标只在成功时推进**：这次拉成功了才更新 `seen` 和检查时间；失败了下次还得覆盖同一时间段。
- **离线**：桌宠离线时定时器照跑但请求失败，走上面的退避，**不要**把失败写进去重表。

---

## 4. Hermes 已有的可复用件（本机实测）

路径：`C:\Users\user\AppData\Local\hermes\skills\`

### 4.1 总表

| Skill | 是什么 | 结论 | 理由 |
|---|---|---|---|
| **arxiv** | `SKILL.md`（arXiv + Semantic Scholar 的 curl 用法）+ `scripts/search_arxiv.py`（纯 stdlib） | **需改造** | 知识可复用；**脚本本机跑不起来**，且查询语法有 bug（见下） |
| **blogwatcher** | 文档化 `blogwatcher-cli`（RSS/Atom 监控 CLI，SQLite 状态） | **可直接复用（作为外部工具）**；**不适合内嵌进 World** | 是独立 Go 二进制 + 自己的 DB，不是库 |
| **competitor-news-monitor** | 纯**方法论**（无代码）：watchlist → cron tick → 采集 → **按事件去重** → 重要度评估 → digest | **可直接借鉴（设计）** | 去重/退避/「失败≠无新闻」的原则正是我们要的 |
| **grounded-citations** | `scripts/sources.py`（纯 stdlib 的 url→[n] 台账，`add/list/render/verify`） | **可直接复用（可选）** | 若将来要产出「本周热点」纪要并附引用，直接拿来 |

### 4.2 arxiv skill —— **脚本实测跑不通**（重要）

- 脚本内容：用 **`urllib.request`** 请求 `https://export.arxiv.org/api/query?...`，`User-Agent: HermesAgent/1.0`，`timeout=15`。
- **实测结果：直接失败**：
  ```
  ssl.SSLEOFError: [SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of protocol (_ssl.c:1016)
  ```
  复现确认：**同一台机器、同一个 URL，`curl` 拿到 200，Python `urllib` 握手就 EOF**（本机 Python 走 OpenSSL、curl 走 Schannel）。→ **本机环境下 Python urllib 到 `export.arxiv.org` 的链路不可用。**
- **另一个 bug（更隐蔽）**：脚本第 36 行用 `'+AND+'.join(parts)` 把 `all:`/`au:`/`cat:` 之间有加 AND，**但单个 `all:` 里的多词没处理**——第 28 行 `f'all:{quote(query)}'` 会把 `"neural architecture search"` 变成 `all:neural%20architecture%20search`，**实测被 arXiv 解析成 OR（427031 条）**。所以脚本的多词查询结果是错的。
- **结论：需改造。** 可复用的是：① 端点与参数字典；② XML 字段名（`a:title`/`a:id`/`a:published`/`a:summary`/`a:category`）；③ `sortBy` 映射表。**不可复用的是 transport（改 curl / Node fetch）和查询拼装（改成显式 AND + 引号）。**
- 顺带：`SKILL.md` 里写「arXiv ~1 req/3s」「Semantic Scholar 1 req/s，**无需 key**」——**实测反驳**：S2 的无 key 路径现在**稳定 429**（见 §2.2③），skill 这段该更新。

### 4.3 blogwatcher skill —— 是真 RSS 监控工具，但**是本机未安装的外部二进制**

- 是不是 RSS/Atom 监控工具？**是。** 上游 `github.com/JulienTant/blogwatcher-cli`，README 原文（实抓）：
  > "Pre-built binaries for **Linux, macOS, and Windows** are available on the GitHub Releases page."
- **实测**：最新 release **`v0.2.1`（2026-05-19）**，资产里确实有 **`blogwatcher-cli_windows_amd64.zip`** 和 `blogwatcher-cli_windows_arm64.zip`。
- **本机状态**：`which blogwatcher-cli` → **NOT INSTALLED**。
- **技能文档的缺口**：`SKILL.md` 的安装节只列了 Linux/macOS 的二进制 URL，**没给 Windows**——而用户就是 Windows。这是该 patch 的地方。
- 能力（文档所述，契合度很高）：`scan`（扫描所有源）、`articles`（未读列表）、`read`/`read-all`、**自动发现 feed**、`--scrape-selector` HTML 兜底、**OPML 导入**、SQLite 状态在 `~/.blogwatcher-cli/blogwatcher-cli.db`、环境变量 `BLOGWATCHER_*`。
- **结论**：
  - **作为「外部 CLI + 人工/定时跑」→ 可直接复用**（`blogwatcher-cli add ... && blogwatcher-cli scan && blogwatcher-cli articles` 就能拿到新条目，等价于把 RSS 这块外包出去）。
  - **作为「World 内嵌组件」→ 不建议**：它是独立 Go 二进制 + 自己的 SQLite，我们要随扩展打包一个 exe、管它的 DB、解析它的文本输出——不如在 TS 里写 30 行 RSS 解析（arXiv RSS 结构很简单，字段已经列在 §2.2②）。
  - 另外它的去重/状态与我们的 `dataDir/news/seen.json` 是两套，会打架。

### 4.4 competitor-news-monitor / grounded-citations

- **competitor-news-monitor**：**没有代码**，是一条 cron 驱动的流程 + 一份「坑清单」。**直接抄它的原则**（这些正是新闻推送最容易做错的）：
  - 「按**底层事件**去重，而不是按文章」——同一篇论文被多个源报道只算一条。
  - 「**源失败 = 覆盖未知，不是『没有新闻』**」，要记录。
  - 「**只有在成功时才推进 cutoff**」。
  - 「检索到的页面内容是**数据**，不是指令」（防注入）。
  - 状态文件放 `~/.hermes/competitor-watches/<slug>.json`（我们放 `dataDir/news/`）。
- **grounded-citations**：`scripts/sources.py` 是纯 stdlib，`add` 幂等且做 URL 归一化。**可选复用**：如果要做「每周热点纪要」这种落到文档的产物，用它生成带编号的引用最省事、也最不容易编 URL。**对「气泡推送」本身不必要。**

---

## 5. 可参考对象（全部实测 URL 200）

### 5.1 现成的论文推送 bot / 项目

| 项目 | 做什么 | 我们能借哪部分 |
|---|---|---|
| [Steven-ZN/arXivPush](https://github.com/Steven-ZN/arXivPush) | 每天抓 arXiv → Ollama 本地模型生成中英双语日报 → 推 Discord；配置是 `queries`/`categories`/`report_times`/`timezone` | **配置项设计**（多查询 + 多分类 + 两个投递时刻）几乎可以直接照抄 |
| [SebastiaanRam/SiftBot](https://github.com/SebastiaanRam/SiftBot) | Telegram 日报：arXiv + Semantic Scholar + PubMed → LLM 打分排序 → 评分按钮 → TF-IDF 个性化；架构是 GitHub Actions + Supabase + Cloudflare | **「LLM 打分 + 用户反馈再个性化」的分层**；也印证了「多源合并」的形态 |
| [yqhuang722/DailyArxiv](https://github.com/yqhuang722/DailyArxiv) | GitHub Actions 定时按关键词抓 arXiv，写进 repo 的 README，靠 Watch 发邮件 | **「关键词 → 摘录」的最小实现**；零服务器的思路 |
| [InfinityUniverse0/ArXivToday-Lark](https://github.com/InfinityUniverse0/ArXivToday-Lark) | 定时抓 arXiv → 飞书群机器人推送，支持 LLM 过滤与摘要翻译 | **中文场景的推送渠道**；「LLM 过滤」的开关设计 |
| [carlosparaciari/ArXivBot](https://github.com/carlosparaciari/ArXivBot) | Telegram：关键词搜索 + **指定分类的当日提交** | 「按分类看当日新论文」这个动作的实现方式 |
| [yuandong-tian/arXiv_recbot](https://github.com/yuandong-tian/arXiv_recbot) | Telegram：每日推荐 + 用户点赞/收藏影响推荐模型 | **偏好反馈会怎么改变推送内容**（我们可留接口不做） |
| [Hugging Face Daily Papers](https://huggingface.co/papers) | 社区投票 + GitHub stars 活跃度排序的每日论文榜，有邮件订阅 | **直接当数据源用**（`/api/daily_papers`，自带 ai_summary/ai_keywords）——省掉「从几百篇里挑热门」这件事 |

### 5.2 RSS → LLM 摘要的工具（结构上最接近我们要做的）

| 项目 | 做什么 | 我们能借哪部分 |
|---|---|---|
| [JohnXu22786/rss-digest](https://github.com/JohnXu22786/rss-digest) | **插件形态**（DeepSeek Harness bundle）：订阅管理 + 定时拉取 + **去重（精确哈希 + token-Jaccard 近似去重，CJK 感知 bigram）** + LLM 摘要 + 每日 Markdown 简报；**模型不可用时降级为抽取式摘要** | **架构最接近**：`scheduler.ts` / `store.ts`（版本化 JSON 原子落盘）/ `summarizer.ts`（**降级契约**）/ `digest.ts`。尤其「**LLM 挂了要降级**」和「**落盘 store**」这两点。MIT，79 个测试 |
| [yinan-c/RSSbrew](https://github.com/yinan-c/RSSbrew) | 自托管：聚合 RSS + 自定义过滤 + AI 摘要 + 日/周简报 | **自定义过滤器的产品形态**（面板上怎么让人配规则） |
| [edsu/rss-digest](https://github.com/edsu/rss-digest) | CLI：从 GReader 兼容阅读器（FreshRSS/Miniflux）取 24h 未读 → LLM 生成单段摘要；MIT | **「把往期摘要回喂给模型避免重复讲同一件事」**这个防止重复的技巧很值得学 |
| [banana2556/rssdigest](https://github.com/banana2556/rssdigest) | GitHub Actions 定时把 RSS 变成每日邮件摘要 | 零服务器方案（我们不需要，桌宠本身就在跑） |

### 5.3 商业/半商业产品（对标与「能不能集成」）

| 产品 | 做什么 | 结论 |
|---|---|---|
| [Hugging Face Daily Papers](https://huggingface.co/papers) | 每日热门论文榜 + 邮件 | ✅ **可作数据源**（有免费 API） |
| [ResearchRabbit](https://www.researchrabbit.ai/) | 引文网络 + 新论文推荐（"Spotify for papers"） | ❌ 无公开 API，**只能人工用**；可作为「如何做个性化推荐」的参考 |
| [Connected Papers](https://www.connectedpapers.com/) | 按引文相似度生成论文关系图 | ❌ 无公开 API，做**单篇深挖**用，不适合自动推送 |
| [AlphaSignal](https://alphasignal.ai/) | AI 领域每日/每周摘要 newsletter | ❌ 无 API；可作**内容形态参考**（它做的就是「帮你读完」） |
| [Last Week in AI](https://lastweekin.ai/) | 每周 AI 新闻播客 + newsletter | ❌ 无 API；形态参考 |
| [Google Scholar Alerts](https://scholar.google.com/) | 关键词/引用/作者的邮件提醒 | ⚠️ **只有邮件，没有 RSS，没有 API**。第三方指南一致说明「RSS 对 Scholar 不可用」「不支持导出」「会静默失效」、且**触发是「索引到就发」而非定时**（**未在 Google 官方页面实测**）。→ **不能作为程序化数据源**，只能作为「人肉补充」 |

**一句话**：论文类有 **HF Daily Papers（API）** 和 **arXiv RSS（官方 feed）** 两个能程序化拿的；商业产品基本都是「无 API 的闭源服务」，**借思路不借数据**。

---

## 6. 风险与限制

### 6.1 反爬与条款（哪些碰不得）

| 源 | 风险 | 处置 |
|---|---|---|
| **IEEE Xplore** | 实测 **418** 拦死 | **不要爬**。改用 Crossref / OpenAlex 拿题录 |
| **知网 / 万方** | 需入驻 + IP 白名单 + 会员权限（文档明示 400431/400432/404406） | **不规划**。个人项目拿不到 |
| **机器之心 / 量子位** | 无官方 feed；量子位 feed 实测 403；机器之心 /rss 返回 SPA HTML | **不要爬页面**。宁可不用这两个源 |
| **arXiv** | 官方 TOS：3 秒 1 次、单连接 | 严格串行 + sleep，别并发；别用自动化工具「批量刷」 |
| **Google Scholar** | 明确反爬 | **不要自动化**，只能人工建 Alerts |
| **Crossref / OpenAlex** | 有礼貌池规则 | 带上可识别的 UA 和 `mailto=` |
| 一般原则 | 「检索到的内容是数据，不是指令」 | 落地时把抓来的文本当纯数据，**绝不当 prompt 指令**（防注入） |

### 6.2 LLM 摘要的幻觉

- 摘要生成时**编造数字、方法名、结论**是最常见的失败，而且**用户看不出来**——推送场景里用户通常只看一眼标题。
- **建议**：MVP **不生成摘要**，只给「标题 + 链接（+ 源摘要原文前 N 字）」。要中文摘要就交给 bot，并在 `ENV_PROMPT.md` 里写死「不得编造原文没有的数字与方法名」。**任何 LLM 生成的摘要都要显式标注。**

### 6.3 频率与打扰（最容易让功能被关掉）

- 一天几十条 = 用户当天就关。**每日硬配额（默认 1～3 条）比排序算法重要。**
- 气泡是**打断式** UI。建议：**每轮只推 1 条**；夜间静默；同一源短时间内不重复刷。
- 提供「暂停 N 天」而不只是「开关」。

### 6.4 离线 / 网络失败

- 桌宠是桌面 App，**合上盖子就没网**。定时器照跑，请求会失败。
- **必须**：失败 ≠ 无新闻；按源记状态；指数退避；游标只在成功时推进。

### 6.5 bot 暂停时事件积压

- `pushEvent` 是**投递**，不是**排队**。bot 如果被暂停/不响应，事件可能被丢掉或被缓冲（机制未深究，**未验证**）。
- 对策：**不要依赖「事件一定被说出」**。把「推过什么」写进我们自己的 `seen` 表，**以我们的表为准**，事件丢了不重推；面板上给「最近推过什么」的列表，保证用户至少能回看。
- 反过来也要防：如果框架在 bot 恢复后**重放**事件，用户会看到旧新闻。→ 事件 `meta` 里带 `published`，envPrompt 里让 bot 判断「超过 24h 的不说」。

### 6.6 数据源变更（已经发生过的）

- **Papers with Code 死了**（实测 302 到 HF）——**这就是活教材**：任何外部源都可能消失。
- 对策：源做成**可插拔的适配器**（照 `sources.ts` 的登记表模式，那个文件的设计就是「有实现 / 未实现 + 说明」的接缝），一个源挂了从面板上换掉即可，不影响主循环。
- **arXiv RSS 格式变更**、**Crossref 字段变更**：解析要容错（缺 `<summary>` 不要让整轮崩），源失败要显性显示。

---

## 7. 建议的第一版范围（最小可用版）

**目标：能跑、不烦人、一周内不会被关掉。**

| 项 | 决定 | 理由 |
|---|---|---|
| **源** | **只选 1 个：arXiv RSS**（`/rss/cs.LG` + `/rss/eess.SP`，2 个分类） | 免 key、官方、**自带摘要**、一次请求拿全当日新增、`announce_type:new` 可过滤 |
| **要不要摘要** | **不要 LLM 摘要**。事件文本 = 中文前缀 + **论文英文标题** + 链接（可选带源摘要前 100 字） | 零幻觉风险，零费用，零延迟。中文表述交给 bot 的 envPrompt |
| **每天几条** | **默认 2 条**（硬上限，落盘计数） | 气泡是打断式 UI，宁少勿多 |
| **过滤** | 分类 + **关键词白名单**（标题权重 > 摘要），`minKeywords=1` | 成本极低，效果立竿见影 |
| **节奏** | 检查间隔 `pollMinutes=60`；投递窗口 `9:00–22:00`；**每轮最多 1 条**；跨窗口入队次日补 | 白天才烦人、夜里安静 |
| **去重** | `dataDir/news/seen.json`，键 = arXiv `guid` **去版本号**，保留 14 天 | **必须落盘**，否则重启重推 |
| **配置旋钮** | `enabled` / `sources` / `keywords` / `maxPerDay` / `pollMinutes` / `pushStartHour` / `pushEndHour` / `includeAbstract` | 8 个够用；面板上加一个「立即试推」和「清空去重表」 |
| **失败处理** | 按源记「最后成功/最后错误」，指数退避，游标只在成功时推进；面板显性显示源状态 | 失败不能静默 |
| **明确不做** | 多源、嵌入相似度、LLM 摘要/翻译、知网/万方、IEEE Xplore 爬取、X/Twitter、机器之心/量子位 | 要么拿不到，要么性价比差，要么有条款/幻觉风险 |
| **估时** | **半天～1 天** | 全部复用已有 World 机制 |

**验收标准（做完了怎么算成）**
1. 面板能看到「上次检查时间 / 今日已推 N 条 / 各源最后成功时间」。
2. 手动点「试推」，桌宠气泡里出现一条**标题可点、链接正确**的论文。
3. **重启桌宠后不重复推送**已经推过的条目（去重表落盘生效）。
4. 断网时不死循环、不退化成「没有新闻」，恢复网络后能自愈。
5. 一天过去，实际推送条数 **≤ `maxPerDay`**，且夜间一条都不推。

**第二版可以加的（按性价比排序）**
1. HF Daily Papers（免 key，白送 ai_summary + 热度排序，当作「精选」源）——**性价比最高的下一步**
2. Crossref `journals/0278-0046/works`（盯 IEEE TIE 新文章，绕开 Xplore 418）
3. IEEE Spectrum RSS（行业新闻，稳定）
4. 面板上的关键词编辑 UI
5. LLM 摘要（**最后再考虑**，且必须标注）

---

## 附录 A：验证方法与环境

- 环境：Windows 11 + git-bash（MSYS）；`curl 8.19.0 (x86_64-w64-mingw32, Schannel)`；`Python 3.11.16`；Node 侧为 Electron 运行时。
- 时间：2026-10-16。
- 方法：对每个端点用 `curl -s -w "HTTP:%{http_code} TIME:%{time_total}"` 实取，必要时 `-L` 跟跳转、`--compressed` 解压；XML/JSON 用 Python 解析后打印真实字段。所有状态码、字段名、限额数字均取自**实际返回体或响应头**。
- 未验证清单（明确标注）：
  - phys.org ML/AI RSS 路径（本次 **404**，正确路径未知）。
  - OpenAlex `abstract_inverted_index` 拼回文本的具体算法（只确认了它是倒排索引）。
  - 知网/万方的接口字段与鉴权流程（只读了公开文档页，**未做真实鉴权请求**）。
  - Google Scholar Alerts「无 RSS/无导出/会静默失效」（来自第三方指南，**未在 Google 官方页实测**）。
  - X/Twitter 免费层可用性（未实测）。
  - `host.pushEvent` 在 bot 暂停时是否排队或丢弃（未验证，按「可能丢」设计）。

## 附录 B：可直接用的端点速查

```bash
# arXiv：只拿最新（注意 AND + 引号！）
curl -s 'https://export.arxiv.org/api/query?search_query=all:bearing+AND+all:%22fault+diagnosis%22&sortBy=submittedDate&sortOrder=descending&max_results=10'

# arXiv 官方 RSS：当日新增（自带摘要 + announce type）★
curl -s 'https://rss.arxiv.org/rss/eess.SP'

# HF Daily Papers：自带 AI 摘要 + 关键词 ★
curl -s 'https://huggingface.co/api/daily_papers?limit=10'

# Crossref：IEEE TIE 最新题录（绕开 Xplore 的 418）★
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
