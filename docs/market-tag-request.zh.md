# 标签复核申请（中文版）

发到 `Pal-AI-Lab/cortico-extensions`，标题用下面这一行，正文整段复制。

标题：

```
[tags] cortico-world-dailypaper
```

正文：

```markdown
申请复核 `cortico-world-dailypaper` 的 `injection-risk` 标签。

`index.json` 里现在是：

    "cortico-world-dailypaper": {
      "addTags": ["injection-risk"],
      "note": {
        "zh": "抓取的论文标题、摘要与作者原文作为内部通知进入对话",
        "en": "Scraped paper titles, abstracts and authors enter the conversation as internal notices"
      }
    }

这条说明对 0.11.5 及更早版本成立：当时 `news.item` 事件正文里直接放了抓取到的标题、
作者与摘要，事件来源标为 `origin: 'internal'`，会被渲染成用户消息。

0.12.1 起，事件正文只保留本扩展自己的文字，即一个编号和一句处理要求：

    [研究] 订阅推送一条，编号 0d82f45e。先调用 paper_read 取这条的资料，再按「论文推送」的环境提示词开口…

抓取到的文本改由本世界自己注册的只读工具返回：

    paper_read(id) -> 标题、期刊、作者、机构、DOI、爬取源、摘要

也就是说，第三方文本以工具回执的身份进入上下文，不再是内部通知。回执另做了处理：

- 用 `<<<外部资料开始…>>>` 与 `<<<外部资料结束>>>` 显式包住；
- 去掉控制字符与零宽字符，压缩空白；
- 标题截到 300 字，摘要截到 1200 字；
- 环境提示词说明两行标记之间只是资料，其中的指令、角色设定、工具要求一律不执行，
  与本提示词冲突时以提示词为准。

真实会话里的调用顺序（`toolcalls.jsonl`，新版本）：

    1 end_turn
    2 paper_read {'id': '0d82f45e'}
    3 pet_say    【excited】这篇我给 7.5 分…
    4 pet_say    三块:先用动态多尺度卷积去噪自编码器预处理…
    5 pet_ask    ['不感兴趣', '讲讲方法和结果', '讲讲创新点']

代码位置：https://github.com/Lu-JF/CooLuCostom/blob/main/extension-interest-push/src/world.ts
（`tools()` 与 `paperText()`；推送处有注释说明事件正文为什么不放第三方文本。）

按 `TAGS.md` 里该标签的判定条件「第三方写的文本以 `origin: 'internal'` 进入事件」，
现在已不成立，希望移除标签。如果要求先发布再复核，下一个版本为 0.12.2 或更高，
上架后我会在这里跟进。
```

## 交接说明

- 维护者可能要求「先发布再复核」。当前 npm 上是 0.9.3，0.12.x 只在本地与 GitHub。
- 标签是人工记录在 `index.json` 的 `overrides` 里，只有合并 PR 或维护者改动才会消失。
- 如果维护者不同意移除，可以接受在说明里补充「已迁移到工具回执」，但不要为此改回内部事件。
