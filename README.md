# Personal Hub

个人文件管理与博客平台。面向 **自己 + 朋友** 的小规模使用场景，部署在远程 Ubuntu 服务器上。

- **文件管理**：网页上传 / 下载 / 删除，元数据存数据库，实体文件落盘。
- **个人博客**：后台新增 / 编辑 / 删除文章（Markdown），并提供 **公开阅读页**。
- **多用户**：初始管理员通过环境变量播种，管理员可在后台创建朋友账号（普通用户 / 管理员）。
- **认证**：服务端 Session（Cookie，会话落库 `sessions` 表）。

技术栈：**Node.js + TypeScript + Express + MySQL/MariaDB**，零前端构建（页面为内联 JS 的静态 HTML）。

---

## 1. 目录结构

```
personal-hub/
├── package.json            # 依赖与脚本
├── tsconfig.json
├── .env.example            # 环境变量样例
├── schema.sql              # 数据库结构（启动时自动执行）
├── deploy/
│   ├── setup.sh            # Ubuntu 一键装 Node/MariaDB/Nginx 并建库
│   ├── web-service.service # systemd 服务单元
│   └── nginx-web-service.conf # Nginx 反向代理配置
├── src/
│   ├── server.ts           # 入口：连接校验→迁移→监听
│   ├── app.ts              # Express 装配
│   ├── config/index.ts     # 集中配置（env 优先）
│   ├── db/                 # 连接池 + 迁移/播种
│   ├── models/             # 类型定义
│   ├── repositories/       # 数据访问（参数化查询）
│   ├── services/           # 业务逻辑（密码哈希等）
│   ├── middleware/         # 鉴权/校验/错误处理
│   ├── routes/             # 各 API 路由
│   └── utils/logger.ts
└── public/                 # 静态页面（login/app/blog/post）
```

---

## 2. 本地开发

```bash
npm install
cp .env.example .env        # 填好数据库连接与管理员凭据
npm run dev                 # ts-node 启动，默认 http://127.0.0.1:3000
```

页面入口：`http://127.0.0.1:3000/login`（首次用 `.env` 里的 `ADMIN_USERNAME/ADMIN_PASSWORD` 登录）。

---

## 3. 远程 Ubuntu 部署（命令行）

### 3.1 准备服务器环境（仅首次）

```bash
# 在服务器上，以 root 运行一键脚本
sudo bash deploy/setup.sh
# 按提示输入数据库用户密码；脚本会安装 Node20/MariaDB/Nginx 并建库建用户
```

> 若不想用脚本，也可手动：`apt install -y mariadb-server nginx`、`curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt install -y nodejs`，再手动 `CREATE DATABASE/USER`。

### 3.2 部署应用

```bash
# 把代码放到 /opt/personal-hub（git clone 或 scp）
sudo mkdir -p /opt/personal-hub
sudo cp -r . /opt/personal-hub/
cd /opt/personal-hub

sudo cp .env.example .env
sudo nano .env             # 关键项：DB_*、SESSION_SECRET、ADMIN_PASSWORD、PUBLIC_BASE_URL、HOST=127.0.0.1

# 安装依赖并构建
sudo npm ci
sudo npm run build         # 产出 dist/

# 交给 systemd 托管（用 www-data 用户运行）
sudo cp deploy/web-service.service /etc/systemd/system/
sudo chown -R www-data:www-data /opt/personal-hub
sudo systemctl daemon-reload
sudo systemctl enable --now personal-hub
sudo systemctl status personal-hub   # 确认 active
```

### 3.3 反向代理（Nginx）

```bash
sudo cp deploy/nginx-web-service.conf /etc/nginx/sites-available/personal-hub
sudo ln -s /etc/nginx/sites-available/personal-hub /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

至此可通过 `http://<服务器IP或域名>` 访问。

### 3.4 启用 HTTPS（公网必选）

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
# 再把 .env 的 SESSION_SECURE 改为 true，并 sudo systemctl restart personal-hub
```

---

## 4. 常用运维命令

```bash
sudo systemctl restart personal-hub   # 改了 .env 后重启
sudo journalctl -u personal-hub -f    # 查看日志
sudo systemctl reload nginx           # 改了 Nginx 配置后
```

---

## 5. 配置项（`.env`）

| 变量 | 说明 | 默认 |
|---|---|---|
| `NODE_ENV` | `production`/`development` | `development` |
| `PORT` / `HOST` | 监听端口 / 地址（反代后建议 `127.0.0.1`） | `3000` / `127.0.0.1` |
| `DB_*` | MySQL/MariaDB 连接 | 见 `.env.example` |
| `SESSION_SECRET` | 会话签名密钥（≥32 位随机串） | — |
| `SESSION_MAX_AGE` | 会话有效期(ms) | `86400000` |
| `SESSION_SECURE` | HTTPS 时设 `true` | `false` |
| `UPLOAD_DIR` | 上传文件目录 | `./uploads` |
| `MAX_FILE_SIZE` | 单文件上限(字节) | `52428800`(50MB) |
| `ADMIN_*` | 首次播种的管理员 | — |

---

## 6. API 一览

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/health` | 否 | 健康检查 |
| POST | `/api/auth/login` | 否 | 登录 `{username,password}` |
| POST | `/api/auth/logout` | 是 | 登出 |
| GET | `/api/auth/me` | 是 | 当前用户 |
| GET | `/api/users` | 管理员 | 用户列表 |
| POST | `/api/users` | 管理员 | 创建用户 |
| DELETE | `/api/users/:id` | 管理员 | 删除用户 |
| GET | `/api/posts` | 是 | 文章列表（管理员看全部，普通用户看自己） |
| POST | `/api/posts` | 是 | 新建文章 |
| PUT | `/api/posts/:id` | 是(作者/管理员) | 更新 |
| DELETE | `/api/posts/:id` | 是(作者/管理员) | 删除 |
| GET | `/api/files` | 是 | 文件列表 |
| POST | `/api/files` | 是 | 上传（`multipart/form-data`，字段名 `file`） |
| GET | `/api/files/:id/download` | 是 | 下载 |
| DELETE | `/api/files/:id` | 是(拥有者/管理员) | 删除 |
| GET | `/api/public/posts` | 否 | 已发布文章（含渲染 HTML） |
| GET | `/api/public/posts/:slug` | 否 | 单篇已发布文章 |

页面：`/login`、`/`（管理台，需登录）、`/blog`、`/blog/post?slug=`（公开阅读）。

---

## 7. 安全说明

- 密码使用 bcrypt（cost=12）哈希存储；会话 Cookie 设 `httpOnly` + `sameSite`，启用 HTTPS 后建议 `SESSION_SECURE=true`。
- 所有数据库访问均使用参数化查询，避免 SQL 注入。
- 反向代理后已设置 `trust proxy`，可正确获取客户端真实 IP。
- 博客正文由可信用户撰写并以 Markdown 渲染为 HTML（服务端 `marked` 渲染），**未做 HTML 消毒**——请仅发布可信内容，避免粘贴外部不可信 HTML。
- 生产环境务必修改 `.env` 中的 `SESSION_SECRET` 与 `ADMIN_PASSWORD`，并启用 HTTPS。
