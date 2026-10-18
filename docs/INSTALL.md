# 装进 Coopanion

扩展包在 `../extension`（包名 `cortico-world-quota`，World id `quota`）。

## 0. 官方安装版（推荐，一条命令）

```bash
# 从官方 releases 装（本机已装在 D:\Sorftware\Coopanion；静默指定目录：/S /D=<目录>）
# 然后把扩展构建好并拷进去：
node scripts/sync-extension-to-app.mjs                # 默认 D:\Sorftware\Coopanion
```

`sync-extension-to-app.mjs` 做三件事：构建面板产物 → 拷 `extension/`（不含 node_modules）到
`<应用>\data\extensions\node_modules\cortico-world-quota` → 在 `<应用>\data\extensions\package.json`
的 `dependencies` 里登记这个包名。**框架是按这份 dependencies + `node_modules\<包名>` 找扩展的**，缺一处就不加载。
装完在托盘点「重启」，左栏高级模式的 WORLD 组里就会出现「用量额度」。

官方版的数据在**程序旁边的 `data\`**：`data\home`（配置、记忆、角色、原生端点凭证）与 `data\extensions`（扩展）。
把旧实例的这两块拷过来就是「整只搬过去」。下面的步骤是把扩展装进**源码实例**的另一条路。

## 1. 源码实例里的安装（`pnpm run dev` 那一只）

```bash
cd ../extension
npm install
npm run build      # 生成 dist/console.js 与 dist/console.css
```

`dist/` 是面板 bundle，manifest 的 `cortico.consoleClient` / `consoleStyle` 指的就是它。缺了它扩展页会
说明「面板产物不在」，页面也就没有内容。

1. 打开 Coopanion 的设置窗口，左栏底部把它切到**高级模式**（普通模式左栏只列桌宠那几页，扩展页不在其中）。
2. 进「扩展」页 → 手动安装 → 选**本机目录**，填这个包的绝对路径：
   `D:\Work_AI\Git_Lu\CooLuCostom\extension`
3. 安装页会先做一次只读检查（类别、manifest、产物），通过后以 `link:` 方式装进
   `<安装目录>\data\extensions`，改源码重启即生效。
4. 重启进程（安装页会提示「待重启」）。V0.2.x 起，旧契约（`api: 5`）的包仍会加载，扩展页会标注「按旧契约编写」。

命令行的等价做法（在 `<安装目录>\data\extensions` 里）：

```bash
pnpm add --ignore-workspace link:D:/Work_AI/Git_Lu/CooLuCostom/extension
```

## 2. 启用

新装的 World 默认 `enabled: false`（契约要求）。两种启用方式：

- 控制台「World 总览」页找到「用量额度」→ 启用；
- 或直接改部署配置 `data\home\<部署>\config.json` 的 `worlds.quota.enabled: true`。

启用后左栏「World」组下多出这一页，页内三张卡：套餐额度、Hermes 用量、提醒。

## 3. 密钥与路径

页面里的【配置】页签是扩展自己画的（表单填完点【保存】一次写回，不走框架那种边打边存）：

| 项 | 默认 | 说明 |
|---|---|---|
| `commandcodeKey` | 空 | 留空时依次看环境变量、`~/.commandcode/auth.json`、`.env` 文件 |
| `envFile` | 空 → `<Hermes 数据目录>/.env` | 这里读 `COMMAND_CODE_API_KEY` / `COMMANDCODE_API_KEY` |
| `hermesHome` | 空 → `HERMES_HOME` → `%LOCALAPPDATA%\hermes` | `state.db` 所在目录 |
| `alertPercent` | 80 | 任一窗口到这个百分比提醒一次；0 关掉 |
| `pollMinutes` | 10 | 检查间隔；0 只在打开面板或问 bot 时取 |
| `hermesDays` | 7 | 面板与工具默认的统计天数 |

密钥来源在页面顶部标出来（配置 / 环境变量 / 命令行登录文件 / .env）。取不到时卡片写明原因，不会报错死掉。

## 4. 让 Coo 说出来

提醒是一条内部事件（`quota.window`），正文已经写明窗口、用量、重置时间与本月余额。Coopanion 的 Coo
拿到事件后按 `src/ENV_PROMPT.md` 那段说明决定说不说、怎么说（默认：值得打扰时说一两句，深夜或对方在忙
用 `pet_quiet`，不凭记忆报数）。

`quota_status` 与 `quota_hermes` 两个工具随时可以问：「额度还有多少」「hermes 今天跑了多少 token」。

## 5. 排查

| 现象 | 看哪里 |
|---|---|
| 官方版里看不到这一页 | 先 `node scripts/sync-extension-to-app.mjs`，再托盘点「重启」；确认左栏是高级模式 |
| 自检脚本报 404 | 路由随版本变：v0.2.x 是 `/api/webui/manifest`，更早是 `/api/console/manifest`，`verify-instance.mjs` 两条都会试 |
| 扩展页显示「需要升级」 | 运行时的契约号变了，见根 README 最后一节 |
| 卡片写「取不到（command code rejected the key）」 | 密钥过期或换了：改 `worlds.quota.commandcodeKey`，或在 CLI 里重新登录 |
| 卡片写「读不到 Hermes 的用量库」 | `state.db` 不在默认位置：填 `hermesHome`（Hermes 的 `hermes dump` 会打印它的 home） |
| 页面在左栏里找不到 | 还在普通模式；或 World 没启用 |
| 改了源码没生效 | 源码实例：`npm run build` 后重启进程；官方版：先升 `extension/package.json` 的 version（产物地址带版本号，浏览器缓存是 immutable），再跑 `sync-extension-to-app.mjs`，然后重启 |
