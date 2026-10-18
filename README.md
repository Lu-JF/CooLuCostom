# CooLuCostom

面向桌宠 [Coopanion](https://github.com/Pal-AI-Lab/Coopanion) 的用量看板扩展。扩展以 Cortico World 包的
形式提供，不修改 Coopanion 源码，在控制台内新增一个「用量额度」页面，包含以下内容：

- **Command Code 套餐额度**：月度余额、5 小时与每周两个滚动窗口、订阅计划可用的模型与单价、按模型划分的额度。
- **账号**：自动使用桌宠中已配置的 Command Code 端点凭证（即桌宠的原生接入方式）；面板不读取密码，
  也不要求重复录入密钥。
- **本机 Hermes 用量**：调用次数与 token 统计，按 1、7、30、90 天四个范围切换。
- **阈值提醒**：窗口用量达到设定阈值时产生内部事件，由桌宠 Coo 以气泡形式提示。

供应商切换以下拉框形式预留，各供应商的接入条件与取数位置见 `docs/VENDORS.md`。

## 取数策略

进入页面时拉取一次，其后由各卡片的按钮手动刷新，不做自动轮询。后台轮询仅服务于阈值提醒。

面板数据面提供两个方法：`state` 返回当前持有的读数，用于快速出图；`refresh` 执行网络取数并更新读数。
在两个滚动窗口的重置时间、以及套餐周期间隔上，两者行为一致。

## 运行方式

同一份扩展源码有两种运行方式。

| 运行方式 | 桌宠来源 | 扩展安装方式 | 适用场景 |
|---|---|---|---|
| 官方安装版 | `D:\Sorftware\Coopanion\Coopanion.exe`（v0.2.4） | `node scripts/sync-extension-to-app.mjs`，复制到 `<应用>\data\extensions` | 日常使用；具备托盘菜单与开机自动启动开关 |
| 源码实例 | `upstream\coopanion`，以 `pnpm run dev` 启动 | 控制台「扩展」页填写本目录的绝对路径 | 扩展开发；跟踪上游提交 |

官方安装版的数据目录位于程序目录旁的 `data\`，其中 `data\home` 存放配置、记忆与角色，`data\extensions`
存放扩展。程序更换目录后，安装版会依据 `%LOCALAPPDATA%\Coopanion\data-location.json` 中记录的位置，
询问继承既有数据或新建数据。

## 目录结构

```
CooLuCostom\
├─ extension\            # 扩展包 cortico-world-quota
│  ├─ src\index.ts       # WorldDefinition 入口
│  ├─ src\world.ts       # 取数、阈值判定、提醒事件、控制台声明、工具定义、账号与价目数据面
│  ├─ src\sources.ts     # 供应商登记表；Command Code 已实现，其余为预留接缝
│  ├─ src\native.ts      # 读取桌宠端点凭证（providers/<端点>/{config.json,.env}）
│  ├─ src\accounts.ts    # 账号表：原生端点账号与手动添加账号，仅记录变量名与密钥尾四位
│  ├─ src\commandcode.ts # billing 与 whoami 接口封装、密钥来源判定、容错解析
│  ├─ src\pricing.ts     # 官网计划页与价目页解析，输出模型、单价与按模型额度，缓存 12 小时
│  ├─ src\hermes.ts      # 只读 state.db 的 session_model_usage 表
│  ├─ src\alerts.ts      # 阈值判定；同一窗口同一档位只提醒一次，游标按账号隔离
│  ├─ src\console\       # 控制台面板：两个页签（六张卡片与「配置」页）
│  ├─ src\ENV_PROMPT.md  # 提供给 bot 的说明：提醒事件的处理方式与工具用法
│  ├─ scripts\           # 面板产物构建、装进实例、控制台渲染检查
│  └─ tests\             # 88 项测试：sqlite 聚合、取数、价目页解析、端点目录、面板渲染
├─ scripts\
│  ├─ verify-instance.mjs        # 对运行中的实例执行只读检查
│  ├─ sync-extension-to-app.mjs  # 构建面板产物并复制进官方安装版
│  ├─ create-shortcut-to-app.ps1 # 生成指向官方安装版的桌面快捷方式
│  ├─ start-pet.cmd / start-pet.vbs   # 源码实例的隐藏窗口启动器
│  └─ create-desktop-shortcut.ps1
├─ upstream\             # 上游源码检出，不属于本仓库的代码
│  ├─ coopanion\         # Coopanion 源码，含实例数据 build\data
│  └─ cortico\           # Cortico 框架源码，用于执行官方契约校验
└─ docs\
   ├─ NOTES.md           # 接口、配置语义与注意事项
   ├─ VENDORS.md         # 各供应商的接入条件与取数位置
   ├─ INSTALL.md         # 安装步骤
   ├─ VERIFICATION.md    # 验证记录与未验证项
   └─ panel*.png         # 控制台截图（本地保留，未纳入仓库）
```

## 构建与测试

```bash
cd extension
npm install            # 或 pnpm install
npm run typecheck      # 校验 Node 侧与浏览器侧两份 tsconfig
npm test               # 88 项测试
npm run build          # 生成 dist/console.js 与 dist/console.css
```

`dist/` 为面板产物，manifest 中的 `cortico.consoleClient` 与 `consoleStyle` 指向该目录，缺少产物时
扩展页会提示产物缺失，页面无内容。

## 安装

### 官方安装版

```bash
# 1. 从官方 releases 获取安装包并按当前用户安装
#    https://github.com/Pal-AI-Lab/Coopanion/releases  →  Coopanion-Setup-<版本>.exe
#    静默安装至指定目录：Coopanion-Setup-0.2.4.exe /S /D=D:\Sorftware\Coopanion

# 2. 构建面板产物并把扩展复制进安装版
node scripts/sync-extension-to-app.mjs                 # 默认目标 D:\Sorftware\Coopanion
```

安装完成后，通过托盘菜单重启桌宠，在控制台左栏切换至高级模式，WORLD 分组下即出现「用量额度」。

桌面快捷方式的生成命令为 `powershell -File scripts/create-shortcut-to-app.ps1`。托盘菜单中的「开机自动
启动」在安装版上可用；源码模式下该项由 `enabled: app.isPackaged` 控制，处于禁用状态。

### 源码实例

```bash
cd upstream/coopanion
CI=true pnpm install                    # 非交互环境须设置 CI=true
node node_modules/electron/install.js   # 补下载 Electron 运行时
CORTICO_START_PAUSED=1 pnpm run dev     # 控制台 127.0.0.1:<端口>，桌宠页 127.0.0.1:7797/pet
```

网络受限时使用镜像：

```bash
CI=true npm_config_registry=https://registry.npmmirror.com \
  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ pnpm install
```

扩展装入源码实例的步骤见 `docs/INSTALL.md`。

## 验证

对运行中的实例执行检查。端口取 `core.log` 中记录的 `127.0.0.1:<端口>`，或官方安装版
`data\home\companion\config.json` 的 `web.port`。

```bash
node scripts/verify-instance.mjs <端口>              # 只读检查并启用 World
node scripts/verify-instance.mjs <端口> --alerts     # 一并验证提醒链路，会临时修改阈值
cd extension && node scripts/check-panel-render.mjs <端口> [electron.exe]   # 真实控制台中的渲染检查
```

渲染检查脚本在不提供 Electron 路径时，会在仓库内自动查找可用运行时。已通过的检查项与未验证项见
`docs/VERIFICATION.md`。

## 数据来源

| 数据 | 来源 | 凭证 |
|---|---|---|
| 套餐额度 | `api.commandcode.ai` 的 `/alpha/billing/credits`、`/alpha/billing/subscriptions`、`/alpha/whoami` | 需要密钥，只读 |
| 模型清单 | `api.commandcode.ai/provider/v1/models` | 无需密钥 |
| 计划价目 | `commandcode.ai/docs/plans/<计划>` 与 `/docs/resources/pricing-limits`，均为公开页面 | 无需密钥，解析后缓存 12 小时 |
| Hermes 用量 | 本机 `state.db` 的 `session_model_usage` 表 | 只读打开，不写入 |

除上述请求外不产生其他网络访问，不包含遥测。面板中手动添加的密钥经框架的秘密存储写入部署目录的 `.env`，
变量名形如 `QUOTA_COMMANDCODE_1`；账号表仅保存变量名与密钥尾四位。

## 与上游升级的关系

扩展安装于 `<安装目录>\data\extensions`。安装包升级仅删除 Electron 自身文件，`data\` 目录保留，
因此扩展与配置不会因升级而丢失。

扩展运行时需要与框架的契约版本一致。`package.json` 中的 `cortico.api` 须等于运行时框架的 world 契约号
（当前为 5）。框架发生不兼容变更时会提升该编号，旧版本包将被拒绝加载，扩展页会提示需要升级。此时应修改
`cortico.api`、按框架变更对齐接口，再执行 `npm run build` 并重启进程。接口与迁移说明见
[Cortico 的 docs/extensions.md](https://github.com/Pal-AI-Lab/Cortico/blob/main/docs/extensions.md)。

上游 v0.2.x 的兼容性情况：契约号 5 的扩展可在 v0.2.4 上正常加载，官方发布说明指出按旧接口编写的扩展
仍可使用，至下一个大版本为止。同时控制台的路由已更名，涉及 `/api/webui/manifest` 与
`/api/webui/providers/<页>/panels/<面板>/<方法>`，设置页路径为 `/coopanion/<hash>`。详见 `docs/NOTES.md`。

## 隐私

仓库内的文档与测试夹具统一使用 `test@gmail.com` 与 `C:\Users\user\...` 作为占位值，不包含真实账号邮箱与
本机用户名。`docs/panel*.png` 为真实控制台截图，其中包含账号邮箱与密钥尾号，因此未纳入仓库。
