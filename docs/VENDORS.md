# 供应商备忘（面板里不再放这张表）

「用量额度」页的**供应商**卡只留一个下拉：切到哪家，额度/模型/价目就按哪家取。这份文档记的是
「每家要什么、将来从哪儿查」——面板里不显示，接的时候看这里。

现状：**只有 Command Code 有实现**。其余 8 家在 `src/sources.ts` 里各有一条 `QuotaSource` 记录，
`implemented: false`，切过去不发任何请求，读数只写「未实现」。

| 供应商 | 需要什么 | 将来从哪儿查（候选，待核实） |
|---|---|---|
| Command Code | API Key（同一个 Key 查额度、模型、价目） | 额度：`/alpha/billing/credits`、`/alpha/billing/subscriptions`、`/alpha/whoami`；模型：`/provider/v1/models`；价目与计划额度：官网计划页 `commandcode.ai/docs/plans/<计划>` |
| OpenAI | 管理密钥（Admin Key），普通 Key 读不了 | `GET /v1/organization/costs`、`/v1/organization/usage/completions` |
| Anthropic | 管理密钥（Admin Key） | `GET /v1/organizations/cost_report`、`/usage_report/messages`；额度本身只在 Console 看 |
| DeepSeek | API Key | `GET /user/balance`（余额与币种）；价目抓官网价目页 |
| OpenRouter | API Key | `GET /api/v1/credits`（已用/总额）、`GET /api/v1/key`（当前 Key 限额）；模型价目 `GET /api/v1/models` 自带价格字段 |
| Kimi / Moonshot | API Key | `GET /v1/users/me/balance` |
| 智谱 GLM | API Key（余额只在控制台） | 没有公开的余额接口；将来或按控制台网页抓取，登录态会过期 |
| 通义千问 / 百炼 | API Key + 阿里云账号 | 百炼没有公开余额接口，用量走阿里云账单；将来或按账单页抓取 |
| 自定义（OpenAI 兼容中转） | Base URL + API Key + 「这家额度在哪儿看」 | 多数只给 OpenAI 兼容的模型列表；额度要么没有接口，要么得配一个自定义取数脚本 |

接一家要做的事：在 `src/sources.ts` 加一条并实现 `fetchQuota`（必做）、`fetchModels`（可选，
模型清单卡用它）、`planPageUrl`（可选，价目卡用它），然后 `npm run build`、重启进程。
面板与 `world.ts` 都不用改——下拉里自动多一项。

## Command Code 的账号与登录（这部分容易误会，写清楚）

- **没有「账号密码」接口**。官方 CLI 的 `/login` 是**浏览器 OAuth**（起一个临时的本地回调服务器，
  浏览器里登录，token 落到 `~/.commandcode/auth.json`）；CLI 的排错文档也写着登录失败就
  `logout` 再 `login`。所以「在面板里输账号密码」这条路对 Command Code 不成立。
- 面板显示的 `test@gmail.com` **不是读 cookie 得来的**：那是用**你桌宠里那把 key** 调
  Command Code 自己的 `GET /alpha/whoami` 问出来的（套餐同理，来自 `/alpha/billing/subscriptions`）。
  也就是说：**你在网页上登录的那个账号 = 这把 key 所属的账号**，面板显示的就是它。
- **面板怎么拿 key（桌宠原生方式）**：桌宠给每个模型端点单独存一份凭证——

  ```
  <home>/providers/<端点名>/config.json   { kind, baseUrl, secret: "<.env 里的变量名>", spec, … }
  <home>/providers/<端点名>/.env          <变量名>=<密钥>
  ```

  面板读取**指向 `commandcode.ai` 的那些端点**（`src/native.ts`），用同一把密钥问额度，
  自动把端点记成一条账号（显示登录邮箱、套餐、密钥尾四位、以及桌宠是否正在用它说话）。
  换号 = 在桌宠的「模型供应商」页换端点；加号 = 在那边再加一个端点。
  面板不写这些文件，也不需要你再贴一次 Key。
- 面板里那个「手动添加账号」是后备：给不在桌宠端点里的号（填那个号的 API Key）。它写进部署
  目录的 `.env`（变量名形如 `QUOTA_COMMANDCODE_1`），账号表里只有变量名与尾四位，密码类的东西
  一概不存。
- 一个端点都没有、但确实有凭证在用时（例如 Key 来自 `%LOCALAPPDATA%\hermes\.env` 或扩展配置），
  面板也会把这一栏记下来，名字用 `whoami` 问出的邮箱，标记为「手动添加」。
