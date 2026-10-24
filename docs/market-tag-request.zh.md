# `[tags] cortico-world-dailypaper`（中文版）

提交到 `Pal-AI-Lab/cortico-extensions`，标题：

```
[tags] cortico-world-dailypaper
```

正文（官方格式：一行一项 `键: 值`，中文键同样认）：

```text
包名: cortico-world-dailypaper
去: injection-risk
理由: 抓取的论文标题、摘要与作者原文不再以 origin:'internal' 的事件进入对话；0.12.1 起事件正文只带编号，正文资料由本世界的只读工具 paper_read 以工具回执返回。
证据: https://github.com/Lu-JF/CooLuCostom/blob/main/extension-interest-push/src/world.ts#L156-L182（paper_read 工具）; https://github.com/Lu-JF/CooLuCostom/blob/main/extension-interest-push/src/world.ts#L661-L681（news.item 正文只有编号与要求）; https://github.com/Lu-JF/CooLuCostom/blob/main/extension-interest-push/src/world.ts#L699-L721（回执加首尾标记、清控制字符、摘要截断）; https://github.com/Lu-JF/CooLuCostom/blob/main/extension-interest-push/src/ENV_PROMPT.md#L40-L47（提示词把标记之间当资料）; https://www.npmjs.com/package/cortico-world-dailypaper/v/0.13.1
```

命令行等价：

```bash
gh issue create -R Pal-AI-Lab/cortico-extensions \
  --title "[tags] cortico-world-dailypaper" \
  --body $'包名: cortico-world-dailypaper\n去: injection-risk\n理由: 抓取的论文标题、摘要与作者原文不再以 origin:\'internal\' 的事件进入对话；0.12.1 起事件正文只带编号，资料由只读工具 paper_read 以工具回执返回。\n证据: https://github.com/Lu-JF/CooLuCostom/blob/main/extension-interest-push/src/world.ts#L156-L182 ; https://github.com/Lu-JF/CooLuCostom/blob/main/extension-interest-push/src/world.ts#L661-L681 ; https://github.com/Lu-JF/CooLuCostom/blob/main/extension-interest-push/src/world.ts#L699-L721 ; https://www.npmjs.com/package/cortico-world-dailypaper/v/0.13.1'
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
