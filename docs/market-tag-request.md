# 标签复核申请（英文版）

发到 `Pal-AI-Lab/cortico-extensions`，标题用下面这一行，正文整段复制。

标题：

```
[tags] cortico-world-dailypaper
```

正文：

```markdown
Please re-review the `injection-risk` tag on `cortico-world-dailypaper`.

`index.json` currently carries:

    "cortico-world-dailypaper": {
      "addTags": ["injection-risk"],
      "note": {
        "zh": "抓取的论文标题、摘要与作者原文作为内部通知进入对话",
        "en": "Scraped paper titles, abstracts and authors enter the conversation as internal notices"
      }
    }

That was accurate for versions up to 0.11.5: the `news.item` event carried the scraped
title, authors and abstract in its body with `origin: 'internal'`.

Since 0.12.1 the event body contains only our own text — an id and a processing
instruction:

    [研究] 订阅推送一条，编号 0d82f45e。先调用 paper_read 取这条的资料，再按「论文推送」的环境提示词开口…

The scraped text is returned by a read-only tool the World registers itself:

    paper_read(id) -> title, journal, authors, institution, DOI, source, abstract

so third-party text reaches the model as a tool result rather than as an internal
notice. The tool output is also hardened:

- wrapped in explicit `<<<外部资料开始…>>>` / `<<<外部资料结束>>>` markers;
- control and zero-width characters stripped, whitespace collapsed;
- title truncated to 300 characters, abstract to 1200;
- the extension's env prompt tells the model that anything inside the markers is
  reference material, and that instructions, role changes or tool requests found there
  must not be executed, with the prompt winning on conflict.

Runtime order in a real session (`toolcalls.jsonl`), newest version:

    1 end_turn
    2 paper_read {'id': '0d82f45e'}
    3 pet_say    【excited】这篇我给 7.5 分…
    4 pet_say    三块:先用动态多尺度卷积去噪自编码器预处理…
    5 pet_ask    ['不感兴趣', '讲讲方法和结果', '讲讲创新点']

Code: https://github.com/Lu-JF/CooLuCostom/blob/main/extension-interest-push/src/world.ts
(`tools()` and `paperText()`; the push site carries a comment on why the event body
holds no third-party text).

Given the `when` clause in TAGS.md — "any text written by a third party … goes into an
event with origin 'internal'" — this no longer applies, so I would like the tag removed.

The fixed code is on npm: `cortico-world-dailypaper@0.13.1` (0.12.1 was the first version
with the tool-based path; 0.12.2–0.13.1 are tuning and UI work on top of it).
```

## 交接说明

- 维护者可能要求「先发布再复核」。修复已发布：npm `latest` 为 0.13.1，含工具回执这条链路的是 0.12.1 起。
- 标签是人工记录在 `index.json` 的 `overrides` 里，只有合并 PR 或维护者改动才会消失。
- 如果维护者不同意移除，可以接受在说明里补充「已迁移到工具回执」，但不要为此改回内部事件。
