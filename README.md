# Coopanion-Usage

给桌宠 [Coopanion](https://github.com/Pal-AI-Lab/Coopanion) 加一页「用量额度」：**Command Code 套餐额度**
（月度余额、5 小时与每周滚动窗口、**订阅计划可用的模型与单价、按模型的额度**）+ **账号**（自动取用桌宠里
配置的 Command Code 端点，也就是「原生接入方式」；面板不碰你的密码/Key）+ **本机 Hermes 的 token 统计**，
窗口用量越过阈值时由 Coo 在气泡里说一声。供应商切换只留一个下拉，各家的备忘在 `docs/VENDORS.md`。

取数策略：**进入这一页拉一次 + 各卡按钮手动刷**，不做自动轮询（后台轮询只为「越过阈值提醒」服务）。
`state` 只回手上那份读数（实测 0.02s 出图），要新的网络读数走 `refresh`（实测约 2.3s）。

做成 **Cortico World 扩展包**（`extension/`），不改 Coopanion 一行代码：控制台「扩展」页填本目录绝对路径即可安装。

```
D:\Work_AI\Coopanion-Usage\
├─ extension\            # 扩展包 cortico-world-quota，装进 Coopanion 的就是它
│  ├─ src\index.ts       # WorldDefinition 入口
│  ├─ src\world.ts       # 取数、阈值判定、提醒事件、控制台声明、两个工具、账号与价目数据面
│  ├─ src\sources.ts     # 供应商登记表：Command Code 有实现，其余是带说明的接缝
│  ├─ src\native.ts      # 读桌宠自己的端点凭证（providers/<端点>/{config.json,.env}）
│  ├─ src\accounts.ts    # 账号表（原生端点账号 + 手动加的；只存变量名与尾四位）
│  ├─ src\commandcode.ts # /alpha/billing/* 三个接口 + 密钥来源 + 容错解析
│  ├─ src\pricing.ts     # 官网计划页/价目页 → 模型 + 单价 + 按模型的额度（12 小时缓存）
│  ├─ src\hermes.ts      # 只读 state.db 的 session_model_usage
│  ├─ src\alerts.ts      # 阈值判定（同窗口同档只报一次，游标按账号分开）
│  ├─ src\console\       # 控制台面板：七张卡（额度 / 账号 / 供应商 / 模型 / 价目 / Hermes / 提醒）
│  ├─ src\ENV_PROMPT.md  # 交给 bot 的说明：提醒事件怎么处理、工具怎么用
│  ├─ scripts\           # 构建面板产物；把包装进某份实例；真控制台渲染检查
│  └─ tests\             # 85 个测试（真 sqlite 聚合、假 fetch 取数、价目页夹具、端点目录、jsdom 面板渲染）
├─ scripts\
│  ├─ verify-instance.mjs        # 对着跑着的实例核对：装没装上、页与数据通不通、提醒链通不通
│  ├─ start-pet.cmd              # 桌面快捷方式用的启动脚本（已在跑就不重复起）
│  └─ create-desktop-shortcut.ps1
├─ upstream\             # 上游检出（不是我们写的代码）
│  ├─ coopanion\         # Coopanion 源码检出 = 正在跑的那只桌宠的实例
│  │  ├─ build\data\     # 这份实例的数据：config.json、logs\core.log、extensions\、home\providers\
│  │  └─ vendor\cortico\ # 子模块，钉在 Coopanion 同一 commit
│  └─ cortico\           # Cortico 框架检出，用来跑官方契约校验 check:extension
└─ docs\
   ├─ NOTES.md           # 用了哪些接口、哪些坑
   ├─ VENDORS.md         # 各家供应商要什么、将来从哪儿查；Command Code 的账号与登录是怎么回事
   ├─ INSTALL.md         # 装进 Coopanion 的手把手步骤
   ├─ VERIFICATION.md    # 验证记录：跑过什么、结果是什么、什么没验证
   └─ panel*.png         # 真控制台截图（渲染检查顺带拍的）
```

## 快速验证

```bash
cd extension
npm install            # 或 pnpm install
npm run typecheck      # Node 侧 + 浏览器侧两份 tsconfig
npm test               # 85 个测试
npm run build          # dist/console.js + dist/console.css（面板 bundle，安装前必须先构建）
```

对着已经跑起来的实例核对（端口取 `upstream\coopanion\build\data\logs\core.log` 里的 `127.0.0.1:<端口>`）：

```bash
node scripts/verify-instance.mjs <端口>              # 只读检查 + 启用 World
node scripts/verify-instance.mjs <端口> --alerts     # 连提醒链路一起验（会临时改阈值）
cd extension && node scripts/check-panel-render.mjs <端口> <electron.exe>   # 真控制台里的 DOM 渲染
```

已跑通的证据与没验证到的部分见 `docs/VERIFICATION.md`。

## 起这份 dev 实例

```bash
cd upstream/coopanion
CI=true pnpm install                    # 非交互环境必须给 CI=true，否则 pnpm 拒绝重建 node_modules
node node_modules/electron/install.js   # pnpm 常跳过 electron 的 postinstall，这一步补下载运行时
CORTICO_START_PAUSED=1 pnpm run dev     # 控制台 127.0.0.1:<端口>，桌宠页 127.0.0.1:7797/pet
```

国内网络慢时给镜像：

```bash
CI=true npm_config_registry=https://registry.npmmirror.com \
  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ pnpm install
```

## 装进 Coopanion

见 `docs/INSTALL.md`。一句话版本：控制台左栏切到**高级模式** → 「扩展」页 → 手动安装 → 填本目录的绝对路径
→ 重启进程 → 「World 总览」启用 `quota`。

## 它读什么、不发什么

- 套餐额度：`api.commandcode.ai` 的 `/alpha/billing/credits`、`/alpha/billing/subscriptions`、`/alpha/whoami`，
  带上你的密钥，只读。
- 模型清单：`api.commandcode.ai/provider/v1/models`（不带密钥也通）。
- 计划价目：`commandcode.ai/docs/plans/<计划>` 与 `/docs/resources/pricing-limits` 两个**公开网页**，
  不带密钥，抓回来解析完缓存 12 小时。
- Hermes 用量：本机 `state.db`，只读打开，不写、不加锁。
- 账号密钥：面板里加的 Key 经框架的秘密存储写进**部署目录的 `.env`**（`<botDir>\.env`，变量名形如
  `QUOTA_COMMANDCODE_1`），账号表里只有变量名与尾四位。
- 出网的就上面这几个请求；没有任何遥测。

## 与 Coopanion 升级的关系

扩展住在 `<安装目录>\data\extensions`，安装包升级只删 Electron 自己的文件（`installer/nsis.nsh` 的
`customRemoveFiles`），`data\` 保留，所以**扩展与配置不会被升级清掉**。

会变的是契约版本：`package.json` 里的 `cortico.api` 必须等于运行时框架那一版的 world 契约号（当前 **5**）。
框架做了不兼容改动就会加这个号，旧包会被拒载并在「扩展」页显示「需要升级」。这时要做的是把 `cortico.api`
改成新号、按框架的改动对齐接口，再 `npm run build`，重启进程。接口与迁移说明在
[Cortico 的 docs/extensions.md](https://github.com/Pal-AI-Lab/Cortico/blob/main/docs/extensions.md)。
