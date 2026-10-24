# `[tags] cortico-world-dailypaper`（英文版）

提交到 `Pal-AI-Lab/cortico-extensions`，标题：

```
[tags] cortico-world-dailypaper
```

正文（官方格式：一行一项 `键: 值`）：

```text
package: cortico-world-dailypaper
remove: injection-risk
reason: Scraped titles, abstracts and authors no longer enter an origin:'internal' event. Since 0.12.1 the event body carries only an id, and the paper text is returned by our own read-only tool paper_read as a tool result.
evidence: https://github.com/Lu-JF/CooLuCostom/blob/main/extension-interest-push/src/world.ts#L156-L182 (paper_read tool) ; https://github.com/Lu-JF/CooLuCostom/blob/main/extension-interest-push/src/world.ts#L661-L681 (news.item body: id + instruction only) ; https://github.com/Lu-JF/CooLuCostom/blob/main/extension-interest-push/src/world.ts#L699-L721 (tool output wrapped in begin/end markers, control chars stripped, abstract truncated) ; https://github.com/Lu-JF/CooLuCostom/blob/main/extension-interest-push/src/ENV_PROMPT.md#L40-L47 (env prompt treats the markers as reference only) ; https://www.npmjs.com/package/cortico-world-dailypaper/v/0.13.1
```

命令行等价：

```bash
gh issue create -R Pal-AI-Lab/cortico-extensions \
  --title "[tags] cortico-world-dailypaper" \
  --body $'package: cortico-world-dailypaper\nremove: injection-risk\nreason: Scraped titles, abstracts and authors no longer enter an origin:\'internal\' event; since 0.12.1 the event carries only an id and paper_read returns the text as a tool result.\nevidence: https://github.com/Lu-JF/CooLuCostom/blob/main/extension-interest-push/src/world.ts#L156-L182 ; https://github.com/Lu-JF/CooLuCostom/blob/main/extension-interest-push/src/world.ts#L661-L681 ; https://github.com/Lu-JF/CooLuCostom/blob/main/extension-interest-push/src/world.ts#L699-L721 ; https://www.npmjs.com/package/cortico-world-dailypaper/v/0.13.1'
```

维护者若要运行时的先后顺序，把这段贴成评论或截图附上：

```text
1 end_turn
2 paper_read {'id': '0d82f45e'}
3 pet_say    【excited】这篇我给 7.5 分…
4 pet_say    三块:先用动态多尺度卷积去噪自编码器预处理…
5 pet_ask    ['不感兴趣', '讲讲方法和结果', '讲讲创新点']
```

## 备注

- 标签 id 是 `injection-risk`，来自 `index.json` 的 `overrides`，人工加的，只有维护者改动或合并 PR 才会消失。
- 0.12.1 起改走工具回执；0.12.2–0.13.1 是参数与界面调整，不改变这条判定。
- 若维护者要求先发布再复核：`cortico-world-dailypaper@0.13.1` 已在 npm，`latest` 即此版本。
