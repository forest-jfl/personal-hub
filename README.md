# Personal Hub

个人博客 + 文件管理平台。以 **CSDN 风格博客主页**为应用主入口，面向 **自己 + 朋友** 的小规模使用场景。

- **博客主页**（`/`）：顶部导航 + 左侧文章流（摘要/分类/浏览量/分页）+ 右侧边栏（作者卡片、热门文章、分类、归档）
- **文章详情**（`/post?slug=`）：Markdown 渲染、阅读计数、文章信息
- **写作编辑**（`/editor`）：Markdown 编辑 + 实时预览，存草稿或发布
- **管理控制台**（`/console`）：**隐藏页面**，入口在右上角头像下拉菜单；文章 / 文件 / 用户管理三个板块整合于此，不再作为独立导航标签
- **多用户**：初始管理员通过环境变量播种，管理员可在控制台创建朋友账号
- **双端运行**：本地由 Express 同源托管前端；前端也可托管到 GitHub Pages / Gitee Pages，跨域调用 API

技术栈：**Node.js + TypeScript + Express + MySQL/MariaDB**，前端**零构建**（原生 JS/CSS 多文件静态页）。

---

## 1. 目录结构

```
personal-hub/
├── package.json            # 依赖与脚本
├── tsconfig.json
├── .env.example            # 环境变量样例
├── schema.sql              # 数据库结构（启动时自动执行 + 存量库自动补列）
├── deploy/                 # Ubuntu 部署脚本 / systemd / Nginx
├── src/
│   ├── server.ts           # 入口：连接校验→迁移→监听
│   ├── app.ts              # Express 装配（CORS / 会话 / 页面路由 / 静态托管）
│   ├── config/index.ts     # 集中配置（env 优先，含 CORS_ORIGINS / SESSION_CROSS_SITE）
│   ├── db/                 # 连接池 + 迁移/播种
│   ├── models/  repositories/  services/  middleware/  routes/
│   └── utils/logger.ts
└── public/                 # 静态前端（零构建，可整体发布到 git 平台 Pages）
    ├── config.js           # ★ 前端运行配置：API_BASE（托管时改这里）
    ├── assets/style.css    # 全站样式
    ├── assets/api.js       # API 封装 + 顶部导航渲染 + 工具函数
    ├── index.html          # 博客主页（应用主入口）
    ├── post.html           # 文章详情
    ├── editor.html         # 写作编辑
    ├── console.html        # 管理控制台（隐藏入口）
    └── login.html          # 登录页
```

---

## 2. 本地开发

```bash
npm install
cp .env.example .env        # 填好数据库连接与管理员凭据（CORS_ORIGINS 留空即可）
npm run dev                 # ts-node 启动，默认 http://127.0.0.1:3000
```

页面入口：`http://127.0.0.1:3000/`（博客主页；首次用 `.env` 里的 `ADMIN_USERNAME/ADMIN_PASSWORD` 登录）。

---

## 2.1 git 平台托管前端（GitHub Pages / Gitee Pages）

前端是纯静态文件，可直接发布到任意 git 平台 Pages，后端继续跑在自己的服务器上。

**一键发布脚本**（在仓库根目录执行，把前端推送到 `pages` 分支并注入 API_BASE）：

```bash
API_BASE=https://api.your-domain.com bash deploy/publish-pages.sh pages
```

发布后到 git 平台仓库设置中开启 Pages、选择 `pages` 分支即可。

**启用前的前置条件**（按顺序完成）：

1. **服务器必须先有 HTTPS**：Pages 页面是 HTTPS，调用 HTTP 接口会被浏览器拦截（混合内容）。等域名解析好后上 Caddy/certbot。
2. **后端 `.env` 追加**：
   ```ini
   CORS_ORIGINS=https://<用户名>.github.io,https://<用户名>.gitee.io
   SESSION_CROSS_SITE=true
   SESSION_SECURE=true      # 跨站 Cookie 要求 HTTPS
   ```
   重启后端服务（Docker 部署：`docker compose up -d`）。
3. 重新执行发布脚本，确保 `API_BASE` 使用 `https://` 地址。

> 注意：跨站场景 Cookie 以 `SameSite=None` 下发，必须全程 HTTPS；本地模式（`API_BASE=''`）不受影响。

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
| GET | `/api/public/posts` | 否 | 已发布文章（分页 `page/pageSize`、`category`、`q` 标题搜索，含摘要） |
| GET | `/api/public/meta` | 否 | 侧边栏元数据（分类统计 / 按月归档 / 热门文章） |
| GET | `/api/public/posts/:slug` | 否 | 单篇已发布文章（含渲染 HTML，自增阅读量） |

页面：`/`（博客主页）、`/post?slug=`（详情）、`/login`、`/editor`（需登录）、`/console`（需登录，隐藏入口）。
旧链接 `/blog`、`/app` 等自动重定向到主页。

---

## 7. 安全说明

- 密码使用 bcrypt（cost=12）哈希存储；会话 Cookie 设 `httpOnly` + `sameSite`，启用 HTTPS 后建议 `SESSION_SECURE=true`。
- 所有数据库访问均使用参数化查询，避免 SQL 注入。
- 反向代理后已设置 `trust proxy`，可正确获取客户端真实 IP。
- 博客正文由可信用户撰写并以 Markdown 渲染为 HTML（服务端 `marked` 渲染），**未做 HTML 消毒**——请仅发布可信内容，避免粘贴外部不可信 HTML。
- 生产环境务必修改 `.env` 中的 `SESSION_SECRET` 与 `ADMIN_PASSWORD`，并启用 HTTPS。
