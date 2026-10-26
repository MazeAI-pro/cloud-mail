# mytada.ai 独立部署

所有命令从 `mail-worker` 运行，使用 Node 22.12+（本机已验证 Cursor 的 arm64 Node 24.5）。始终指定 `--config wrangler-mytada.toml`，不要使用默认 deploy。此配置不读取或复制现有 mazeai.pro 的 vars、secrets、用户或邮件。

| 项目 | 值 |
| --- | --- |
| Account | `070412c4db637c7d39470106bee7bd84` |
| Worker / hostname | `cloud-mail-mytada` / `mail.mytada.ai` |
| D1 | `cloud-mail-mytada` / `1e201159-61c1-4647-a4b9-0bc0552fe62e` |
| KV | `dad8c724860e412e8a7e799688a0d8bc` |
| R2 | `cloud-mail-mytada-attachments` |
| 管理员 | `admin@mytada.ai` |

## 离线初始化（新空数据库一次性操作）

不访问 `/api/init/:secret`，不通过公开注册创建管理员。这两个入口在独立 Worker 中永久禁用。以下本地脚本使用临时 Miniflare D1，从现有 migration 生成全新 schema、权限、关闭注册的 settings 和管理员密码 hash，无任何云端读写。输入密码建议使用密码管理器生成 24 字符随机密码。

```sh
umask 077
read -s 'MYTADA_ADMIN_PASSWORD?New mytada admin password: '
export MYTADA_ADMIN_PASSWORD
node scripts/bootstrap-mytada.mjs /private/tmp/mytada-bootstrap-private
unset MYTADA_ADMIN_PASSWORD
```

输出目录必须不存在，权限 0700；文件 0600。`bootstrap.sql` 含管理员 hash，不提交、不打印；`kv-bootstrap.json` 含初始非敏感设置；`r2-ready.txt` 是固定健康标记。保存密码至批准的密码管理器；导入成功后删除生成文件。初始化脚本不会生成 JWT 或 API 密钥。

核对目标是上表新建资源，且 D1 无业务表，再执行：

```sh
node node_modules/wrangler/bin/wrangler.js d1 execute cloud-mail-mytada --config wrangler-mytada.toml --remote --file /private/tmp/mytada-bootstrap-private/bootstrap.sql
node node_modules/wrangler/bin/wrangler.js kv bulk put /private/tmp/mytada-bootstrap-private/kv-bootstrap.json --config wrangler-mytada.toml --binding kv --remote
node node_modules/wrangler/bin/wrangler.js r2 object put cloud-mail-mytada-attachments/deployment/ready --config wrangler-mytada.toml --remote --file /private/tmp/mytada-bootstrap-private/r2-ready.txt
```

SQL 会在已有表时失败；不能用于升级。升级应使用经过审阅的显式 migration，不重跑 bootstrap。不要复制其他部署的 KV `setting:` 或 `public_key:`。

初始配置：`register=1`（关闭）、`reg_key=0`（要求注册码，额外防线）、`send=1`（关闭发信）、`receive=0`（接收开启）、`no_recipient=1`（未知邮箱不保存）。管理员通过 SQL 已创建，权限由 `env.admin` 精确匹配授予。即便管理员误将 setting 注册开关打开，独立入口仍会拒绝注册；ready 检查也会失败。

## 独立密钥与部署

通过密码管理器或受控脚本生成三个各不相同、至少 32 字符的随机值：`jwt_secret`、`managed_api_token`、`monitor_token`。只通过 secret 命令的标准输入或交互输入传递，勿写进命令参数、URL、日志或仓库。逐个执行：

```sh
node node_modules/wrangler/bin/wrangler.js secret put jwt_secret --config wrangler-mytada.toml
node node_modules/wrangler/bin/wrangler.js secret put managed_api_token --config wrangler-mytada.toml
node node_modules/wrangler/bin/wrangler.js secret put monitor_token --config wrangler-mytada.toml
node node_modules/wrangler/bin/wrangler.js deploy --config wrangler-mytada.toml --dry-run
node node_modules/wrangler/bin/wrangler.js deploy --config wrangler-mytada.toml
```

`keep_vars=false`，关闭 workers.dev、preview URL 和 Worker observability。飞书/people 的 HTTP 路由和运行时集成均禁用；不要配置这些集成密钥。无需生成旧式 KV public token；`genToken` 和 `addUser` 在本部署不可用。

在 mytada.ai 的 Cloudflare Email Routing 配置 catch-all → `cloud-mail-mytada`，只使用该 zone 的 Cloudflare 指定 MX/TXT。不得调整 mazeai.pro 的路由。未知地址按设置丢弃，仅先通过 ensureMailbox 分配的地址接收业务邮件。

## 托管 API 与监控

基础地址 `https://mail.mytada.ai/api`。独立入口拒绝含百分号编码的 URL pathname（HTTP 400），避免与下游 Hono 解码路由产生鉴权差异；使用文档中的字面路径，业务参数放在 JSON body，query 的正常编码不受影响。四个 POST：`/public/ensureMailbox`、`/public/emailList`、`/public/sendEmail`、`/public/attachment`。Header 为 `Authorization: <managed_api_token>`，**不带 Bearer 前缀**。稳定 externalKey 格式仍是 `tada:<scope>:<UUID>`；新地址为 `u` + 八位数字 + `@mytada.ai`。列表必须传非空 `ownerEmail` 做邮箱范围限制，缺省返回 HTTP 400，不支持全库查询；附件传 `ownerEmail`、`emailId`、`attId`。

`GET /health/live` 公开返回 `{ok:true}`，不查询依赖。`GET /health/ready` 必须用 `Authorization: <monitor_token>`（无 Bearer）；200/503 返回 `{ok,checks:{d1,kv,r2}}`，缺少鉴权401。检查最新 account schema、注册关闭、固定 KV/R2 标记，单次最长约3秒，不返回用户数据、错误详情或secret。建议每5分钟检查，避免高频探测。KV 标记传播存在最终一致性，初次导入后稍候重试。

## Resend 配置及明确限制

初始发信关闭。按用户最新安排，使用现有 **sylhelios** Resend 账号，为 **mytada.ai** 新增独立域名并创建仅允许该域名发送的新 API key；账户共享，域名和凭据保持独立，不复用其他域名的 token。账户发送额度由各域名共享，从免费方案起步，后续按需付费（具体额度与可用性以该账号当前控制台为准）。

先检查现有 `gennovel.app` 最近三个月的使用情况；检查期间保留旧域名、密钥和 DNS，不停用旧域名。若控制台或 API 记录保留期不足三个月，应明确记录可核查范围，不能据此断言没有使用。

为 **mytada.ai** 完成域名验证，按该域名给出的记录设置 DKIM/SPF，按需设置 DMARC；不要修改 Cloudflare Email Routing 根域入站 MX。

用新管理员登录 `https://mail.mytada.ai`，在系统设置的 Resend token 映射中添加 `mytada.ai` 对应的独立 key，然后启用发送（`send=0`）；该操作会同时刷新 KV 设置缓存。直接改 D1 设置不会刷新 KV，不能仅改 D1。使用 API 保存设置时同样通过管理员登录会话调用 `/api/setting/set`，不要把 token 放在 URL。密钥存储在本部署 D1/KV 设置内，不是 Worker `managed_api_token`。

此部署以 Tada 托管 API 为主：匿名 `/attachments/` 与 `/api/oss/` 被阻断，管理网页旧式附件下载及内嵌附件预览因此不可用；需通过授权的 `/public/attachment` 读取。不要将 R2 设置为公开桶来绕过鉴权。

旧 `/api/webhooks` 无签名校验，已禁用。发送接口成功表示 Resend 已接受请求，数据库停留 SENT；不会据 webhook 自动变为 DELIVERED/BOUNCED/COMPLAINED。实际投递状态看独立 Resend 域的后台，不能把 API 接受当最终投递。启用外发后用授权测试收件人验证收发及附件，不群发。

## 验证与回滚

2026-10-26 部署记录：Worker 版本 `52a215bf-2d4f-48cf-907c-233fcde9382b` 已部署，健康检查验证通过。邮件收发端到端验证尚未完成，健康检查通过不代表邮件已经可正常投递。

本地验证：`node node_modules/vitest/vitest.mjs run --config vitest.unit.config.js`，然后上述 dry-run（包含 Vue build）。部署后核对 live、带鉴权 ready、匿名注册/init/oss/webhook=404、缺 API token=401、ensureMailbox 重试返回同一 mytada 地址、入站邮件及私有附件。不要用真实用户内容做探针。

回滚仅操作 `cloud-mail-mytada` 的 Worker 版本或停止 mytada.ai 的邮件路由，不删除 D1/KV/R2 数据，不对原部署执行默认 wrangler 命令。新部署没有使用 `/init` 进行升级的后门。
