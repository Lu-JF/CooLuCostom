# 供应商接入说明

「用量额度」页的**供应商**卡片提供一个下拉框；选择某家供应商后，额度、模型与价目均按该家取数。
本文档记录各供应商的接入条件与取数位置，供后续接入时参考，不在面板中展示。

当前状态：仅 Command Code 已实现。其余 8 家在 `src/sources.ts` 中各有一条 `QuotaSource` 记录，
`implemented` 为 `false`；切换至这些供应商时不发起任何请求，读数栏显示「未实现」。

| 供应商 | 所需凭证 | 取数位置（候选，待核实） |
|---|---|---|
| Command Code | API Key，同一把密钥用于额度、模型与价目 | 额度：`/alpha/billing/credits`、`/alpha/billing/subscriptions`、`/alpha/whoami`；模型：`/provider/v1/models`；价目与计划额度：`commandcode.ai/docs/plans/<计划>` |
| OpenAI | 组织管理密钥，普通密钥无法读取 | `GET /v1/organization/costs`、`GET /v1/organization/usage/completions` |
| Anthropic | 组织管理密钥 | `GET /v1/organizations/cost_report`、`GET /v1/organizations/usage_report/messages`；额度余额仅在 Console 提供 |
| DeepSeek | API Key | `GET /user/balance`，返回余额与币种；单价取自官网价目页 |
| OpenRouter | API Key | `GET /api/v1/credits` 返回已用与总额，`GET /api/v1/key` 返回当前密钥限额；`GET /api/v1/models` 自带价格字段 |
| Kimi / Moonshot | API Key | `GET /v1/users/me/balance` |
| 智谱 GLM | API Key；余额仅在控制台提供 | 无公开余额接口，如按控制台页面抓取，登录态会过期 |
| 通义千问 / 百炼 | API Key 与阿里云账号 | 无公开余额接口，用量需查阿里云账单，如按账单页抓取需登录 |
| 自定义（OpenAI 兼容中转） | Base URL、API Key，以及该家的额度查询方式 | 多数仅提供 OpenAI 兼容的模型列表；额度或无接口，或需自定义取数脚本 |

接入一家供应商需要在 `src/sources.ts` 中新增一条记录并实现 `fetchQuota`；`fetchModels`（供模型清单卡片
使用）与 `planPageUrl`（供价目卡片使用）为可选。完成后执行 `npm run build` 并重启进程即可，面板与
`world.ts` 无需修改，下拉框会自动增加对应条目。

## Command Code 的账号与登录

- Command Code 不提供账号密码登录接口。官方 CLI 的 `/login` 采用浏览器 OAuth 流程，启动本地回调服务器
  并在浏览器中完成登录，令牌写入 `~/.commandcode/auth.json`。因此面板无法实现「输入账号密码切换账号」。
- 面板显示的账号邮箱并非读取浏览器 cookie 得到，而是使用桌宠中配置的密钥调用 Command Code 的
  `GET /alpha/whoami` 获取；套餐信息来自 `/alpha/billing/subscriptions`。换言之，网页上登录的账号与
  该密钥所属账号一致，面板显示的是后者。
- 密钥的获取方式为桌宠原生接入。桌宠为每个模型端点单独保存凭证：

  ```
  <home>/providers/<端点名>/config.json   { kind, baseUrl, secret: "<.env 中的变量名>", spec, ... }
  <home>/providers/<端点名>/.env          <变量名>=<密钥>
  ```

  面板读取其中 baseUrl 指向 `commandcode.ai` 的端点（实现见 `src/native.ts`），使用同一把密钥查询额度，
  并自动登记为一条账号记录，显示登录邮箱、套餐、密钥尾四位以及桌宠是否正在使用该端点。更换账号等同于在
  桌宠的「模型供应商」页更换端点；新增账号等同于在该页新增端点。面板不写入这些文件，也不要求重新录入密钥。
- 面板中的「手动添加账号」为备用方式，适用于未出现在桌宠端点中的账号。该方式将密钥写入部署目录的 `.env`
  （变量名形如 `QUOTA_COMMANDCODE_1`），账号表仅保存变量名与密钥尾四位。
- 若不存在对应端点但确实存在可用凭证，例如密钥来自 `%LOCALAPPDATA%\hermes\.env` 或扩展配置，面板同样会
  记录该凭证，账号名称取自 `whoami` 返回的邮箱，来源标记为「手动添加」。
