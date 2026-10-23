# 安装步骤

扩展包位于 `../extension`，包名 `cortico-world-quota`，World id 为 `quota`。面板产物为
manifest 中 `cortico.consoleClient` 与 `cortico.consoleStyle` 指向的 `dist/` 目录，缺少该目录时扩展页会提示
产物缺失，页面无内容，因此安装前须先构建：

```bash
cd ../extension
npm install
npm run build      # 生成 dist/console.js 与 dist/console.css
```

## 1. 官方安装版

```bash
# 从官方 releases 获取安装包并按当前用户安装
#   https://github.com/Pal-AI-Lab/Coopanion/releases  →  Coopanion-Setup-<版本>.exe
#   静默安装至指定目录：Coopanion-Setup-0.2.4.exe /S /D=<目录>

# 构建面板产物并把扩展复制进安装版
node scripts/sync-extension-to-app.mjs                # 默认目标目录 D:\Sorftware\Coopanion
```

`sync-extension-to-app.mjs` 对 `PACKAGES` 里的每个包依次完成三步：构建面板产物；将该包目录（不含
`node_modules`）复制到 `<应用>\data\extensions\node_modules\<包名>`；在
`<应用>\data\extensions\package.json` 的 `dependencies` 中登记该包名。框架按 `dependencies` 中的包名到
`node_modules` 下查找扩展，两处须同时具备，否则扩展不会被加载。当前登记两个包：
`cortico-world-quota`（用量额度）与 `cortico-world-interest-push`（论文推送）。

安装完成后，通过托盘菜单重启桌宠，将控制台左栏切换至高级模式，WORLD 分组下即出现「用量额度」与「论文推送」。

启用「论文推送」：World 的默认 `enabled` 为 false，需在 `<应用>\data\home\companion\config.json` 的
`worlds` 里加上 `"interest-push": { "enabled": true }`，或在控制台的 World 总览里启用；其余字段由扩展的
默认值补齐（28 家期刊、46 条术语、6 条关键词）。

官方安装版的数据目录位于程序目录旁的 `data\`，其中 `data\home` 存放配置、记忆、角色与端点凭证，
`data\extensions` 存放扩展。迁移已有实例时，将原实例的这两个目录复制过来即可。

## 2. 源码实例

适用场景为以 `pnpm run dev` 启动的实例，扩展开发时使用该方式，改动源码后重启即生效。

1. 打开 Coopanion 设置窗口，将左栏底部切换至高级模式。普通模式左栏不包含扩展页。
2. 进入「扩展」页，选择手动安装，以本机目录方式填写扩展包的绝对路径。
3. 安装页会先执行只读检查，校验类别、manifest 与产物，通过后以 `link:` 方式安装到
   `<安装目录>\data\extensions`。
4. 按提示重启进程。

命令行等价操作，在 `<安装目录>\data\extensions` 目录下执行：

```bash
pnpm add --ignore-workspace link:<扩展包绝对路径>
```

## 3. 启用

新安装的 World 默认 `enabled` 为 `false`，两种启用方式：

- 在控制台「World 总览」页找到「用量额度」，点击启用；
- 修改部署配置 `data\home\<部署>\config.json`，将 `worlds.quota.enabled` 设为 `true`。

启用后，左栏 WORLD 分组下出现该页面，页面包含「用量额度」与「配置」两个页签。

## 4. 配置

页面内的「配置」页签由扩展自行实现，表单填写完成后点击「保存」一次性写回，不采用框架配置页的即时保存方式。
可配置项均写入 `worlds.quota`。

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `commandcodeKey` | 空 | 留空时依次查找环境变量、`~/.commandcode/auth.json`、`.env` 文件 |
| `envFile` | 空，取 `<Hermes 数据目录>/.env` | 从该文件读取 `COMMAND_CODE_API_KEY` 或 `COMMANDCODE_API_KEY` |
| `hermesHome` | 空，取 `HERMES_HOME` 或 `%LOCALAPPDATA%\hermes` | `state.db` 所在目录 |
| `alertPercent` | 80 | 任意窗口用量达到该百分比时提醒一次，设为 0 表示关闭 |
| `pollMinutes` | 10 | 后台检查间隔，设为 0 表示仅在打开面板或调用工具时取数 |
| `hermesDays` | 7 | 面板与工具默认的统计天数 |
| `monthlyAllowanceUsd` | 0 | 月度额度，设为 0 表示按套餐名采用公开数值 |
| `source` | `commandcode` | 当前供应商 |

密钥来源会在页面顶部标明。取值失败时卡片会显示具体原因，不会中断页面。

## 5. 提醒与工具

提醒以内部事件形式产生，事件名为 `quota.window`，正文包含窗口、用量、重置时间与本月余额。桌宠 Coo 依据
`src/ENV_PROMPT.md` 中的说明决定是否提示以及提示方式。

`quota_status` 与 `quota_hermes` 两个工具用于按需查询额度与本机用量。

## 6. 排查

| 现象 | 处理方式 |
|---|---|
| 扩展页提示需要升级 | 运行时契约号发生变化，参见根目录 README 的「与上游升级的关系」一节 |
| 卡片提示密钥被拒绝 | 密钥失效或已更换，修改 `worlds.quota.commandcodeKey`，或重新执行 CLI 登录 |
| 卡片提示无法读取 Hermes 用量库 | `state.db` 不在默认位置，填写 `hermesHome` |
| 左栏中找不到该页面 | 当前为普通模式，或 World 未启用 |
| 修改源码后页面未更新 | 源码实例执行 `npm run build` 后重启进程；安装版须先提升 `extension/package.json` 的版本号，再执行 `sync-extension-to-app.mjs`，然后重启 |
| 安装版中看不到该页面 | 执行 `sync-extension-to-app.mjs`，重启桌宠，并确认左栏处于高级模式 |
| 自检脚本返回 404 | 路由随版本变化，v0.2.x 为 `/api/webui/manifest`，更早版本为 `/api/console/manifest`，`verify-instance.mjs` 会依次尝试 |
