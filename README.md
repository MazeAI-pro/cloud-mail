<p align="center">
    <img src="doc/demo/logo.png" width="80px" />
    <h1 align="center">Cloud Mail</h1>
    <p align="center">基于 Cloudflare 的简约响应式邮箱服务，支持邮件发送、附件收发 🎉</p> 
    <p align="center">
        简体中文 | <a href="/README-en.md" style="margin-left: 5px">English </a>
    </p>
    <p align="center">
        <a href="https://github.com/maillab/cloud-mail/tree/main?tab=MIT-1-ov-file" target="_blank" >
            <img src="https://img.shields.io/badge/license-MIT-green" />
        </a>    
        <a href="https://github.com/maillab/cloud-mail/releases" target="_blank" >
            <img src="https://img.shields.io/github/v/release/maillab/cloud-mail" alt="releases" />
        </a>  
        <a href="https://github.com/maillab/cloud-mail/issues" >
            <img src="https://img.shields.io/github/issues/maillab/cloud-mail" alt="issues" />
        </a>  
        <a href="https://github.com/maillab/cloud-mail/stargazers" target="_blank">
            <img src="https://img.shields.io/github/stars/maillab/cloud-mail" alt="stargazers" />
        </a>  
        <a href="https://github.com/maillab/cloud-mail/forks" target="_blank" >
            <img src="https://img.shields.io/github/forks/maillab/cloud-mail" alt="forks" />
        </a>
    </p>
    <p align="center">
        <a href="https://trendshift.io/repositories/14418" target="_blank" >
            <img src="https://trendshift.io/api/badge/repositories/14418" alt="trendshift" >
        </a>
    </p>
</p>


## 项目简介

只需要一个域名，就可以创建多个不同的邮箱，类似各大邮箱平台，本项目支持署到 Cloudflare Workers ，降低服务器成本，搭建自己的邮箱服务

## 项目展示

- [在线演示](https://skymail.ink)<br>
- [部署文档](https://doc.skymail.ink)<br>

| ![](/doc/demo/demo1.png) | ![](/doc/demo/demo2.png) |
|-----------------------|-----------------------|
| ![](/doc/demo/demo3.png) | ![](/doc/demo/demo4.png) |




## 功能介绍

- **💰 低成本使用**： 可部署到 Cloudflare Workers 降低服务器成本

- **💻 响应式设计**：响应式布局自动适配PC和大部分手机端浏览器

- **📧 邮件发送**：集成Resend发送邮件，支持群发，内嵌图片和附件发送，发送状态查看

- **🛡️ 管理员功能**：可以对用户，邮件进行管理，RABC权限控制对功能及使用资源限制

- **📦 附件收发**：支持收发附件，使用R2对象存储保存和下载文件

- **🔔 邮件推送**：接收邮件后可以转发到TG机器人或其他服务商邮箱

- **📡 开放API**：支持使用API批量生成用户，多条件查询邮件 

- **📈 数据可视化**：使用ECharts对系统数据详情，用户邮件增长可视化显示

- **🎨 个性化设置**：可以自定义网站标题，登录背景，透明度

- **🤖 人机验证**：集成Turnstile人机验证，防止人机批量注册

- **📜 更多功能**：正在开发中...



## 技术栈

- **平台**：[Cloudflare Workers](https://developers.cloudflare.com/workers/)

- **Web框架**：[Hono](https://hono.dev/)

- **ORM：**[Drizzle](https://orm.drizzle.team/)

- **前端框架**：[Vue3](https://vuejs.org/) 

- **UI框架**：[Element Plus](https://element-plus.org/) 

- **邮件推送：** [Resend](https://resend.com/)

- **缓存**：[Cloudflare KV](https://developers.cloudflare.com/kv/)

- **数据库**：[Cloudflare D1](https://developers.cloudflare.com/d1/)

- **文件存储**：[Cloudflare R2](https://developers.cloudflare.com/r2/)

## 本地开发启动

本地开发需要先安装 [Node.js](https://nodejs.org/) 与 [pnpm](https://pnpm.io/)，后端通过 Wrangler 模拟 Cloudflare Worker，前端通过 Vite 启动。

### 1. 安装依赖

```bash
pnpm --dir mail-worker install
pnpm --dir mail-vue install
```

### 2. 启动后端 Worker

```bash
pnpm --dir mail-worker run dev
```

后端默认读取 `mail-worker/wrangler-dev.toml`，本地地址通常是：

```text
http://127.0.0.1:8787
```

首次启动后，需要初始化本地 D1 数据库。把 `<jwt_secret>` 替换为 `mail-worker/wrangler-dev.toml` 中的 `jwt_secret`：

```bash
curl "http://127.0.0.1:8787/api/init/<jwt_secret>"
```

返回 `success` 表示初始化完成。

### 3. 启动前端

另开一个终端运行：

```bash
pnpm --dir mail-vue run dev
```

前端默认读取 `mail-vue/.env.dev`，其中 `VITE_BASE_URL` 指向本地后端：

```env
VITE_BASE_URL = 'http://127.0.0.1:8787/api'
```

Vite 默认端口是 `3001`，如果端口被占用会自动切换到下一个可用端口，例如：

```text
http://localhost:3001/
```

### 4. 本地配置说明

本地后端的关键配置在 `mail-worker/wrangler-dev.toml`：

```toml
[vars]
domain = ["example.com"]
admin = "admin@example.com"
jwt_secret = "your-random-secret"
```

- `domain`：允许注册或添加的邮箱域名列表。
- `admin`：管理员邮箱。
- `jwt_secret`：初始化数据库和签发登录 token 使用的密钥。
- `db` / `kv`：必须绑定，分别对应 Cloudflare D1 和 KV；本地开发时 Wrangler 会以 local 模式运行。
- `r2`：可选，主要用于附件对象存储。

## 目录结构

```
cloud-mail
├── mail-worker				    # worker后端项目
│   ├── src                  
│   │   ├── api	 			    # api接口层			
│   │   ├── const  			    # 项目常量
│   │   ├── dao                 # 数据访问层
│   │   ├── email			    # 邮件处理接收
│   │   ├── entity			    # 数据库实体
│   │   ├── error			    # 自定义异常
│   │   ├── hono			    # web框架配置、拦截器、全局异常等
│   │   ├── i18n			    # 语言国际化
│   │   ├── init			    # 数据库缓存初始化
│   │   ├── model			    # 响应体数据封装
│   │   ├── security			# 身份权限认证
│   │   ├── service			    # 业务服务层
│   │   ├── template			# 消息模板
│   │   ├── utils			    # 工具类
│   │   └── index.js			# 入口文件
│   ├── pageckge.json			# 项目依赖
│   └── wrangler.toml			# 项目配置
│
├── mail-vue				    # vue前端项目
│   ├── src
│   │   ├── axios 			    # axios配置
│   │   ├── components			# 自定义组件
│   │   ├── echarts			    # echarts组件导入
│   │   ├── i18n			    # 语言国际化
│   │   ├── init			    # 入站初始化
│   │   ├── layout			    # 主体布局组件
│   │   ├── perm			    # 权限认证
│   │   ├── request			    # api接口
│   │   ├── router			    # 路由配置
│   │   ├── store			    # 全局状态管理
│   │   ├── utils			    # 工具类
│   │   ├── views			    # 页面组件
│   │   ├── app.vue			    # 入口组件
│   │   ├── main.js			    # 入口js
│   │   └── style.css			# 全局css
│   ├── package.json			# 项目依赖
└── └── env.release				# 项目配置
```

## 快速配置

完整的 `wrangler.toml` 配置参考如下，按需取消注释填写。

### 1. Cloudflare 资源绑定

在 Cloudflare 控制台创建对应资源后，填入 `wrangler.toml`：

```toml
# D1 数据库（必须）
[[d1_databases]]
binding      = "db"             # 不可修改
database_name = "cloud-mail"    # 你创建的 D1 数据库名
database_id   = ""              # D1 数据库 ID

# KV 命名空间（必须，用于 Session / 缓存）
[[kv_namespaces]]
binding = "kv"                  # 不可修改
id      = ""                    # KV Namespace ID

# R2 对象存储（可选，用于附件存储）
[[r2_buckets]]
binding     = "r2"              # 不可修改
bucket_name = ""                # R2 Bucket 名称
```

### 2. 环境变量（wrangler.toml `[vars]`）

```toml
[vars]
orm_log      = false
domain       = ["example.com"]        # 邮件域名，可配多个，如 ["a.com","b.com"]
admin        = "admin@example.com"    # 管理员邮箱
jwt_secret   = "your-random-secret"   # JWT 密钥，随机字符串即可
project_link = true                   # false 则隐藏页脚 GitHub 图标
```

### 3. 邮件发送 — Resend（可选）

在管理后台「系统设置 → 发件配置」中配置，无需写入 `wrangler.toml`。  
需要先在 [resend.com](https://resend.com) 创建账号并获取 API Token，每个发件域名填一个 Token。

### 4. 飞书 OAuth 登录（可选）

本地开发建议在 [`mail-worker/.dev.vars`](mail-worker/.dev.vars)（从 [`.dev.vars.example`](mail-worker/.dev.vars.example) 复制）中配置飞书相关变量，**勿提交** `.dev.vars`。

```toml
# wrangler 部署可用 [vars] 或 Dashboard 环境变量；本地用 .dev.vars
feishu_switch       = "true"
feishu_app_id       = ""
feishu_app_secret   = ""
feishu_redirect_uri = "https://your-domain/login"
FEISHU_ALLOWED_TENANT_KEYS = "tenant_key_1,tenant_key_2"
```

- **`FEISHU_ALLOWED_TENANT_KEYS`**：逗号分隔的飞书租户 key 白名单。`feishu_switch` 为 `"true"` 时**必须**配置且非空；否则飞书登录将拒绝。用于限定仅公司飞书组织可登录，与「注册密钥」无关。
- **注册密钥**：仍用于**邮箱密码注册**；飞书用户首次登录若尚未绑定账号，只需在弹出框中填写**邮箱前缀**（选择域名后缀），**不需要**注册码。

**飞书应用配置步骤：**

1. 进入 [飞书开放平台](https://open.feishu.cn/)，创建**网页应用**（Web App）。
2. 「安全设置」→ 重定向 URL，填写部署后的登录页地址，例如 `https://mail.example.com/login`。本地开发例如 `http://localhost:3001/login`。
3. 「权限管理」中申请以下权限：
   - `contact:user.base:readonly`
   - `contact:user.email:readonly`
4. 在开放平台或应用信息中获取企业的 **tenant key**（或通过 OAuth 返回的 `tenant_key` 调试确认），填入 `FEISHU_ALLOWED_TENANT_KEYS`。

> `feishu_redirect_uri` 必须与飞书后台填写的重定向地址完全一致，否则 OAuth 回调会失败。

**注册密钥默认策略：** 系统设置里 `reg_key` 默认为「启用」后，邮箱注册必须填写有效注册码。若后台仍设为「关闭」，则无需注册码即可注册。

**新部署默认发信：** 全新库初始化时默认角色「普通用户」为每日发信额度（见 `init.js`）。

**升级迁移（存量库）：** 部署新版本后请访问一次 `GET https://<你的域名>/api/init/<jwt_secret>`（`jwt_secret` 与 Worker 环境变量一致，与登录 JWT 无关）。将执行迁移：例如把「注册密钥」从关闭改为启用、把默认身份「普通用户」发信从禁止改为每日额度，并刷新 KV 中的系统设置。若你希望继续开放无码注册，请在后台把「注册密钥」改回关闭或可选。

## 赞助

<a href="https://doc.skymail.ink/support.html" >
<img width="170px" src="./doc/images/support.png" alt="">
</a>

## 许可证

本项目采用 [MIT](LICENSE) 许可证	


## 交流

[Telegram](https://t.me/cloud_mail_tg)



