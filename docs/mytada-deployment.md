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

当前 Cloudflare Workers 保持 **Free**，按用户明确要求暂不升级，尚未确认 Paid。资源独立不代表套餐额度独立，同一账户的相关套餐额度共享；正式上线前应按实际 CPU 用量与调用量评估容量和是否需要升级。

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

已在 mytada.ai 启用 Cloudflare Email Routing catch-all → `cloud-mail-mytada`，使用该 zone 的 Cloudflare 指定 MX/TXT。不得调整 mazeai.pro 的路由。未知地址按设置丢弃，仅先通过 ensureMailbox 分配的地址接收业务邮件。

## 托管 API 与监控

基础地址 `https://mail.mytada.ai/api`。独立入口拒绝含百分号编码的 URL pathname（HTTP 400），避免与下游 Hono 解码路由产生鉴权差异；使用文档中的字面路径，业务参数放在 JSON body，query 的正常编码不受影响。四个 POST：`/public/ensureMailbox`、`/public/emailList`、`/public/sendEmail`、`/public/attachment`。Header 为 `Authorization: <managed_api_token>`，**不带 Bearer 前缀**。稳定 externalKey 格式仍是 `tada:<scope>:<UUID>`；新地址为 `u` + 八位数字 + `@mytada.ai`。列表必须传非空 `ownerEmail` 做邮箱范围限制，缺省返回 HTTP 400，不支持全库查询；附件传 `ownerEmail`、`emailId`、`attId`。

`GET /health/live` 公开返回 `{ok:true}`，不查询依赖。`GET /health/ready` 必须用 `Authorization: <monitor_token>`（无 Bearer）；200/503 返回 `{ok,checks:{d1,kv,r2}}`，缺少鉴权401。检查最新 account schema、注册关闭、固定 KV/R2 标记，单次最长约3秒，不返回用户数据、错误详情或secret。当前 CN 探测器每60秒检查一次，避免额外高频探测。KV 标记传播存在最终一致性，初次导入后稍候重试。

## Resend 配置及明确限制

已使用现有 **sylhelios** Resend 账号完成配置，账户共享、域名和凭据独立，不复用其他域名的 token。2026-10-26 控制台显示当前套餐 **Free**，每月 3,000 封、每天 100 封，域名占用 **2/3**；发送额度由账号下各域名共享。后续按需付费，额度和方案变更以控制台为准。

| 项目 | 已部署状态 |
| --- | --- |
| 域名 | `mytada.ai`，Verified |
| Resend domain ID | `9e9718a0-c91e-4deb-90cc-cba28e00d2bc` |
| 新密钥名称 | `mytada-mail-production` |
| 权限 | Sending access，仅限 `mytada.ai` |
| 凭据保存与接入 | 用户已保存至私密文件，已接入本部署；文档不记录密钥值 |
| 发信开关 | `send=0`，已启用；bootstrap 的初始值仍是关闭 |

`gennovel.app` 最近30天有2封邮件，最近一封为控制台显示的 10月1日 01:30 StoryLord 登录验证码。UI 可核查范围仅30天，未能核实最近三个月总量，不能据此断言三个月没有使用。原域名、DNS 与 `novel` 密钥保留，未停用。

mytada.ai 的域名验证已完成。后续维护只调整该域所需 DKIM/SPF/DMARC，不覆盖 Cloudflare Email Routing 根域入站 MX。轮换 Resend key 时，用管理员登录 `https://mail.mytada.ai`，在系统设置的 Resend token 映射中替换 `mytada.ai` 的 key；该操作同时刷新 KV 设置缓存。直接改 D1 设置不会刷新 KV，不能仅改 D1。API 保存设置同样通过管理员登录会话调用 `/api/setting/set`，不要把 token 放在 URL。Resend key 存在本部署 D1/KV 设置内，与 Worker `managed_api_token` 不同。

此部署以 Tada 托管 API 为主：匿名 `/attachments/` 与 `/api/oss/` 被阻断，管理网页旧式附件下载及内嵌附件预览因此不可用；需通过授权的 `/public/attachment` 读取。不要将 R2 设置为公开桶来绕过鉴权。

旧 `/api/webhooks` 无签名校验，已禁用。发送接口成功表示 Resend 已接受请求，数据库停留 SENT；不会据 webhook 自动变为 DELIVERED/BOUNCED/COMPLAINED。实际投递状态看独立 Resend 域的后台，不能把 API 接受当最终投递。本次已完成下述受控收发与附件验收；后续使用授权测试收件人，不群发。

## 验证与回滚

2026-10-26 已部署 `https://mail.mytada.ai`，Worker 版本 `52a215bf-2d4f-48cf-907c-233fcde9382b`。D1/KV/R2 与 JWT、托管 API、监控秘密均独立；内部 Worker 设置的 SHA-256 在操作前后完全相同。证据目录：[mytada-mail-20261026](/Users/helios/Documents/agent/artifacts/mytada-mail-20261026)。

线上验收结果：

- 新邮箱创建、幂等重试均 HTTP 200；列表缺少 `ownerEmail` 返回 400。
- 健康检查通过；匿名 readiness 为 401，注册/init/oss 为 404，编码 oss 路径为 400。
- 真实 Resend → Cloudflare 入站成功；私有附件读取内容一致，使用错误邮箱读取附件返回 404。
- 托管 `sendEmail` → `delivered@resend.dev` 成功；Resend UI 中两封测试邮件均显示 Delivered。外发收件人是 Resend 官方模拟地址，**未验证 Gmail 等真实外部收件箱实投**。
- 管理员登录 HTTP 200。

监控已部署到 CN ACK，接入既有 Managed Prometheus 与 Grafana。6条正式规则均为 Normal，沿用飞书「基建报警」联系点；隔离测试实际触发与恢复通知均已验证。Grafana UI 可编辑，未标记 Provisioned。运行方式、告警阈值、验收证据与覆盖边界见 [监控 README](/Users/helios/Documents/agent/artifacts/mytada-mail-20261026/monitoring/README.md)。

尚未完成的边界：Tada 业务配置尚未切换；Resend 退信等签名回调尚未接入；费用及用量指标尚未接入；管理后台旧匿名附件下载/预览不可用。健康监控不能替代邮件最终投递监控，受控收发验收也不等于 Tada 业务已切流。

本地验证：`node node_modules/vitest/vitest.mjs run --config vitest.unit.config.js`，然后上述 dry-run（包含 Vue build）。部署后核对 live、带鉴权 ready、匿名注册/init/oss/webhook=404、缺 API token=401、ensureMailbox 重试返回同一 mytada 地址、入站邮件及私有附件。不要用真实用户内容做探针。

回滚仅操作 `cloud-mail-mytada` 的 Worker 版本或停止 mytada.ai 的邮件路由，不删除 D1/KV/R2 数据，不对原部署执行默认 wrangler 命令。新部署没有使用 `/init` 进行升级的后门。

## 邮箱地址功能预览（2026-11-12）

**此预览经用户明确授权，共享线上 mytada D1、KV、R2。目标功能是修改邮箱地址的 `localPart`，旧地址停用，仅新地址保留；这会影响线上邮箱身份，当前编辑尚未开放。独立 Worker 不代表数据隔离。** 不要用真实用户数据进行自动写入测试，也不要调整共享设置或发送邮件来检查部署。

- 配置：`mail-worker/wrangler-mytada-profile-preview.toml`；Worker：`cloud-mail-mytada-profile-preview`。
- 地址：<https://mail-profile-preview.mytada.ai>。原 workers.dev 地址保留，但 ACK 到该地址连接超时，Tada 预览应使用此独立 custom hostname。
- 应用代码：`19ad339544e3440c5193ae4392c99286d31c6d21`；Worker 部署版本：`78eb59e8-5cbe-4bb9-b6eb-6531ae7afd20`。
- 预览仅绑定 `mail-profile-preview.mytada.ai`，没有 cron 或 Email Routing；生产 `mail.mytada.ai` route 和 `cloud-mail-mytada` Worker 未更新。共享 KV 中的线上发信设置保持原样。
- `jwt_secret`、`managed_api_token`、`monitor_token` 为预览独立生成，通过 Wrangler secret bulk 导入；密钥值不写入 Git。Tada 预览使用同一个预览 `managed_api_token`，Authorization 不带 Bearer。

复现构建与部署时，从 `mail-worker` 运行以下命令，并确认独立预览 Worker 名称及共享资源范围；严禁省略 `--config`。本机复用 arm64 依赖时使用 Cursor 的 arm64 Node。

```sh
node node_modules/wrangler/bin/wrangler.js deploy --config wrangler-mytada-profile-preview.toml --dry-run
node node_modules/wrangler/bin/wrangler.js deploy --config wrangler-mytada-profile-preview.toml
# The private JSON file contains only the three independent preview secrets.
node node_modules/wrangler/bin/wrangler.js secret bulk /path/to/private-preview-secrets.json --config wrangler-mytada-profile-preview.toml
```

当前预览配置未设置 `MAILBOX_ADDRESS_EDIT_ENABLED`，默认关闭；生产共享 D1 未执行本次地址迁移，schema gate 尚未开放。`mailboxProfile` 兼容未迁移 schema；`renameMailbox` 和 `finalizeMailboxRename` 为新协议接口。启用地址修改需要单独批准生产兼容升级和迁移，不能仅打开 flag 绕过此边界。生产 Worker 未更新。

本次部署已验证公开 live=200、匿名 ready=401。前一版本曾验证授权 ready=200（D1/KV/R2 正常）；本次授权只读检查另行记录，不将旧验证当作新版本证据。未执行地址修改、数据库迁移或邮件收发测试。回滚此预览只操作独立预览 Worker 版本，不回滚、删除或重建共享资源。

独立 hostname 创建前，Workers domains API 确认无同名绑定，DNS 查询返回 NXDOMAIN；OAuth 不具备 DNS records list 权限。当前普通 DNS 与 TLS 访问正常；ACK 访问仍应独立核验。
