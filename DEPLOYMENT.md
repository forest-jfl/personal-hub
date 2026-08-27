# Personal Hub 部署手册（完整版）

> 适用版本：Personal Hub v1.0.0（Node.js + TypeScript + Express + MySQL/MariaDB）  
> 适用系统：**Ubuntu 22.04 / 24.04**（其他 Debian 系相近；CentOS 需自行替换包管理命令）  
> 场景：个人 + 朋友使用，部署在**有公网 IP 的远程 Ubuntu 服务器**上

---

## 0. 这份手册有什么

- 一份**可直接照抄执行的命令行部署流程**（含一键脚本与手动两种路径）
- 所有**配置项（`.env`）逐项解释**，以及如何生成安全密钥
- **HTTPS / 防火墙 / 备份恢复 / 升级 / 故障排查**等运维内容
- 全部命令与默认值均与源码一致（见 `src/config`、`deploy/`、`.env.example`）

如果你只想最快跑起来，直接看 **第 3 章「快速部署」** 即可。

---

## 1. 系统架构与部署拓扑

```
           公网用户
              │  http(s):80/443
              ▼
        ┌─────────────┐
        │   Nginx     │   反向代理 + 静态 TLS 终结（可选）
        │ (80 / 443)  │
        └──────┬──────┘
               │  proxy_pass http://127.0.0.1:3000
               ▼
        ┌─────────────┐
        │ Personal Hub│   Node.js / Express（systemd 托管）
        │  :3000       │   监听 127.0.0.1（仅本机，不直连公网）
        └──┬──────┬───┘
           │      │
   ┌───────▼┐  ┌──▼──────────┐   ┌──────────────┐
   │ MariaDB│  │ uploads/    │   │ sessions 表  │
   │  :3306 │  │ 上传实体文件 │   │ (会话落库)   │
   └────────┘  └─────────────┘   └──────────────┘
```

要点：

- 应用**只监听 `127.0.0.1:3000`**，外部流量统一经 Nginx 反代，避免直接暴露 Node 进程。
- 会话（Cookie）**落库到 `sessions` 表**（由 `express-mysql-session` 自动建表），重启服务不丢登录态，未来多实例也可共用。
- 文件上传的**实体文件**存在 `UPLOAD_DIR`（默认 `./uploads`），**元数据**（文件名、大小、归属等）存在 `files` 表。
- 数据库结构由 `schema.sql` 在**每次启动自动执行**（`IF NOT EXISTS` 幂等），无需手动建表；初始管理员仅在账号不存在时播种一次。

---

## 2. 前置要求

| 项目     | 要求                                                        |
| ------ | --------------------------------------------------------- |
| 操作系统   | Ubuntu 22.04 或 24.04（root 权限）                             |
| 服务器    | 有**公网 IP**；建议 ≥ 1 vCPU / 1 GB 内存（小规模足够）                   |
| 访问     | 已能通过 SSH 以 root 登录                                        |
| 域名（推荐） | 一个已解析到服务器公网 IP 的域名；仅用 IP 也能跑（HTTP），但**生产建议上 HTTPS**       |
| 端口     | 服务器需放行 **22(SSH) / 80(HTTP) / 443(HTTPS)**；3306 **不**对外暴露 |

> 说明：本机 MySQL/MariaDB 只在 `127.0.0.1:3306` 监听，不会被公网访问；3306 无需在防火墙放行。

---

## 3. 快速部署（推荐路径）

### 3.1 概览

```
准备环境(setup.sh) → 获取代码 → 配置.env → 安装构建 → systemd 托管 → Nginx 反代 → 防火墙 → 验证
```

### 3.2 登录服务器并以 root 准备环境

```bash
# 在本地终端 SSH 登录（请替换为你的服务器 IP）
ssh root@你的服务器公网IP

# 在服务器上，运行一键环境脚本（安装 Node20 + MariaDB + Nginx，并建库建用户）
sudo bash deploy/setup.sh
```

脚本会：

1. `apt update` 并安装 `curl gnupg ca-certificates ufw`
2. 安装 Node.js 20 LTS（NodeSource）
3. 安装 `mariadb-server` 与 `nginx`，并启动 / 开机自启 MariaDB
4. 交互式让你输入**数据库用户密码**，然后创建数据库 `personal_hub` 与专用账号 `personal_hub`
5. 配置 `ufw` 放行 `OpenSSH` 与 `Nginx Full`（**脚本不会自动 `ufw enable`**，避免锁死连接，见 3.8）

记录脚本输出的：`DB_NAME` / `DB_USER` / 你输入的 `DB_PASSWORD`。

> 若想自定义库名/用户名，可在运行前导出环境变量：`DB_NAME=myhub DB_USER=myhub_user sudo -E bash deploy/setup.sh`

### 3.3 获取代码到服务器

任选一种把代码放到 `/opt/personal-hub`：

**方式 A：git clone（推荐，便于后续升级）**

> ⚠️ **私有仓库必须先授权服务器拉取**，否则 `git clone` 会因无权限失败。二选一：
> - **部署公钥（推荐）**：在服务器生成密钥并把公钥加到 Gitee 仓库的「部署公钥」（见下方步骤）。
> - **HTTPS + 私人令牌**：clone 时用 `https://gitee.com/<用户名>/personal-hub.git`，密码处填 Gitee 私人令牌（不是登录密码）。

**A-1 配置服务器拉取权限（部署公钥）**

```bash
# 在远程服务器上生成一对 SSH 密钥（如已有可跳过）
ssh root@服务器公网IP
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""   # 一路回车

# 打印公钥，复制其全部内容
cat ~/.ssh/id_ed25519.pub
```

然后到 **Gitee → 进入 personal-hub 仓库 → 管理 → 部署公钥 → 添加公钥**，把上面 `cat` 输出的内容粘贴进去并保存（标题随意，如 `ubuntu-server`）。

**A-2 克隆代码**

```bash
ssh root@服务器公网IP
cd /opt
git clone git@gitee.com:<你的Gitee用户名>/personal-hub.git
cd personal-hub
```

> 验证：能成功 clone 即说明部署公钥已生效。若仍提示 `Permission denied (publickey)`，请确认公钥已正确添加到仓库的「部署公钥」（不是「个人公钥」），且 clone 地址用的是 SSH 形式。

**方式 B：本地打包后上传**

```bash
# 本地（开发机）先打包
cd personal-hub
tar czf personal-hub.tar.gz --exclude=node_modules --exclude=dist --exclude=.git .

# 上传到服务器
scp personal-hub.tar.gz root@服务器IP:/opt/
# 服务器上解压
ssh root@服务器IP
mkdir -p /opt/personal-hub && tar xzf /opt/personal-hub.tar.gz -C /opt/personal-hub
```

### 3.4 配置 `.env`（关键一步）

```bash
cd /opt/personal-hub
cp .env.example .env
nano .env          # 或 vim .env
```

**逐项填写说明：**

| 变量                    | 在本手册中的值                       | 说明                                            |
| --------------------- | ----------------------------- | --------------------------------------------- |
| `NODE_ENV`            | `production`                  | 生产模式，关闭堆栈泄露                                   |
| `PORT`                | `3000`                        | 应用监听端口（Nginx 反代到此）                            |
| `HOST`                | `127.0.0.1`                   | **只监听本机**，外部经 Nginx 访问                        |
| `PUBLIC_BASE_URL`     | `http://你的域名` 或 `http://公网IP` | 生成链接/重定向用的对外基址                                |
| `DB_HOST`             | `127.0.0.1`                   |                                               |
| `DB_PORT`             | `3306`                        |                                               |
| `DB_NAME`             | `personal_hub`                | 与 setup.sh 输出一致                               |
| `DB_USER`             | `personal_hub`                | 与 setup.sh 输出一致                               |
| `DB_PASSWORD`         | `<你在 setup.sh 里输入的密码>`        |                                               |
| `DB_CONNECTION_LIMIT` | `10`                          | 连接池上限                                         |
| `SESSION_SECRET`      | **必须改**                       | 会话签名密钥，见下方生成方法                                |
| `SESSION_MAX_AGE`     | `86400000`                    | 会话有效期（毫秒）= 24 小时                              |
| `SESSION_SECURE`      | `false`（先），上 HTTPS 后改 `true`  | 仅 HTTPS 时允许 Cookie 经 TLS                      |
| `UPLOAD_DIR`          | `./uploads`                   | 上传文件目录（服务会自动创建）                               |
| `MAX_FILE_SIZE`       | `52428800`                    | 单文件上限 50MB（与 Nginx `client_max_body_size` 对齐） |
| `ADMIN_USERNAME`      | `admin`（可改）                   | 初始管理员登录名                                      |
| `ADMIN_PASSWORD`      | **必须改**                       | 初始管理员密码（bcrypt 哈希入库）                          |
| `ADMIN_DISPLAY_NAME`  | `Administrator`               | 显示名                                           |

**生成安全的 `SESSION_SECRET`：**

```bash
openssl rand -hex 32
# 把输出粘贴到 .env 的 SESSION_SECRET
```

> ⚠️ 切勿保留示例里的 `change_me_*` 默认值上线。管理员密码后续也可在页面里修改。

### 3.5 安装依赖并构建

```bash
cd /opt/personal-hub
npm ci                 # 干净安装（用 package-lock.json）
npm run build          # tsc 编译到 dist/
```

构建成功会产出 `dist/` 目录。

### 3.6 交给 systemd 托管

```bash
# 复制服务单元
sudo cp deploy/web-service.service /etc/systemd/system/
# 让 www-data 拥有应用目录（systemd 以 www-data 运行）
sudo chown -R www-data:www-data /opt/personal-hub
# 重新加载并启动
sudo systemctl daemon-reload
sudo systemctl enable --now personal-hub
# 确认状态
sudo systemctl status personal-hub
```

看到 `active (running)` 即成功。服务会自动：连库 → 建表/播种管理员 → 建 uploads 目录 → 监听 3000。

> 服务单元要点：`User=www-data`、`WorkingDirectory=/opt/personal-hub`、`EnvironmentFile=/opt/personal-hub/.env`、`Restart=on-failure`、`After=mariadb.service`。

### 3.7 配置 Nginx 反向代理

```bash
sudo cp deploy/nginx-web-service.conf /etc/nginx/sites-available/personal-hub
sudo ln -s /etc/nginx/sites-available/personal-hub /etc/nginx/sites-enabled/
# 把配置里的 server_name 改成你的域名（或公网 IP）
sudo nano /etc/nginx/sites-available/personal-hub
sudo nginx -t && sudo systemctl reload nginx
```

在配置文件中把 `server_name your-domain.com;` 改成你的域名或公网 IP。

### 3.8 防火墙（ufw）

```bash
# 放行必要端口（setup.sh 已加规则，这里确保启用）
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'     # 同时放行 80 与 443
sudo ufw --force enable
sudo ufw status                  # 确认 22/80/443 ALLOW
```

> 务必**先 `allow OpenSSH` 再 `enable`**，避免把自己挡在门外。3306 不要放行。

### 3.9 首次启动与验证

```bash
# 健康检查（应返回 {"status":"ok",...}）
curl -s http://127.0.0.1:3000/health

# 浏览器访问
#   http://你的域名        （或 http://公网IP）
# 用 .env 里的 ADMIN_USERNAME / ADMIN_PASSWORD 登录
```

登录后进入管理台，可：上传/下载文件、写博客、创建朋友账号（角色 `user`）。  
博客公开阅读页：`/blog` 与 `/blog/post?slug=<slug>`（无需登录）。

---

## 4. 启用 HTTPS（公网强烈推荐）

```bash
# 安装 Certbot（Nginx 插件）
sudo apt install -y certbot python3-certbot-nginx

# 申请证书并自动改写 Nginx（域名须已解析到本机）
sudo certbot --nginx -d 你的域名

# 生效后，把 SESSION_SECURE 改为 true，让 Cookie 仅经 TLS 传输
sudo nano /opt/personal-hub/.env      # SESSION_SECURE=true
sudo systemctl restart personal-hub
```

Certbot 会自动：

- 为 Nginx 增加 443 监听与证书配置
- 配置 80 → 443 的 HTTP 跳转

证书默认 90 天有效，自动续期（Certbot 安装时会加入系统 timer）。

> 仅用 IP、没有域名时，可暂时用 HTTP；但**任何公网暴露都建议 HTTPS**，否则账号密码以明文传输。

---

## 5. 手动部署（不使用 setup.sh）

若你希望完全手动控制，或服务器已部分就绪：

```bash
# 1) 安装 Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt install -y nodejs

# 2) 安装 MariaDB + Nginx
sudo apt update
sudo apt install -y mariadb-server nginx

# 3) 初始化数据库安全设置（按需）
sudo mysql_secure_installation

# 4) 建库建用户
sudo mysql -u root <<'SQL'
CREATE DATABASE IF NOT EXISTS personal_hub CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'personal_hub'@'localhost' IDENTIFIED BY '你的强密码';
GRANT ALL PRIVILEGES ON personal_hub.* TO 'personal_hub'@'localhost';
FLUSH PRIVILEGES;
SQL

# 5) 之后从 3.3「获取代码」继续（配置 .env 时填入上面的 DB_*）
```

---

## 6. 配置项完整参考（`.env`）

| 变量                    | 默认值                             | 说明                    |
| --------------------- | ------------------------------- | --------------------- |
| `NODE_ENV`            | `development`                   | 设 `production` 关闭详细错误 |
| `PORT`                | `3000`                          | 应用端口                  |
| `HOST`                | `127.0.0.1`                     | 监听地址                  |
| `PUBLIC_BASE_URL`     | `http://localhost:3000`         | 对外基址（链接/重定向）          |
| `DB_HOST`             | `127.0.0.1`                     |                       |
| `DB_PORT`             | `3306`                          |                       |
| `DB_USER`             | `personal_hub`                  |                       |
| `DB_PASSWORD`         | `change_me`                     |                       |
| `DB_NAME`             | `personal_hub`                  |                       |
| `DB_CONNECTION_LIMIT` | `10`                            | 连接池大小                 |
| `SESSION_SECRET`      | `dev_insecure_secret_change_me` | **生产必须改**             |
| `SESSION_MAX_AGE`     | `86400000`                      | 会话有效期(ms)             |
| `SESSION_SECURE`      | `false`                         | HTTPS 时设 `true`       |
| `UPLOAD_DIR`          | `./uploads`                     | 上传目录                  |
| `MAX_FILE_SIZE`       | `52428800`                      | 单文件上限(字节)=50MB        |
| `ADMIN_USERNAME`      | `admin`                         | 初始管理员名                |
| `ADMIN_PASSWORD`      | `change_me_admin_password`      | 初始管理员密码               |
| `ADMIN_DISPLAY_NAME`  | `Administrator`                 | 显示名                   |

---

## 7. 日常运维

```bash
# 重启（修改 .env 或代码后）
sudo systemctl restart personal-hub

# 停止 / 启动
sudo systemctl stop personal-hub
sudo systemctl start personal-hub

# 查看实时日志
sudo journalctl -u personal-hub -f

# 查看最近 100 行日志
sudo journalctl -u personal-hub -n 100

# 查看服务状态
sudo systemctl status personal-hub

# 修改 Nginx 配置后
sudo nginx -t && sudo systemctl reload nginx
```

应用启动顺序（见 `src/server.ts`）：校验数据库连接 → 执行 `schema.sql`（幂等建表 + 播种管理员）→ 创建 `uploads` 目录 → 监听端口。任意一步失败都会在日志中报错。

---

## 8. 升级更新

```bash
cd /opt/personal-hub
git pull                 # 或重新上传解压
npm ci
npm run build
sudo systemctl restart personal-hub
```

> 升级前建议先备份（见第 9 章）。数据库结构由 `schema.sql` 幂等管理，新表/字段通常无需手动迁移；若未来有大版本 schema 变更，请先读对应版本说明。

---

## 9. 备份与恢复

### 9.1 备份

```bash
# 1) 备份数据库（含结构+数据）
sudo mkdir -p /var/backups/personal-hub
sudo mysqldump -u personal_hub -p personal_hub \
  | gzip > /var/backups/personal-hub/db_$(date +%F).sql.gz

# 2) 备份上传文件目录
sudo tar czf /var/backups/personal-hub/uploads_$(date +%F).tar.gz -C /opt/personal-hub uploads

# 3)（可选）备份 .env 与配置
sudo cp /opt/personal-hub/.env /var/backups/personal-hub/env_$(date +%F).bak
```

建议用 `cron` 每日自动备份（示例略，注意 `.env` 含密码，备份权限收紧）。

### 9.2 恢复

```bash
# 恢复数据库
gunzip -c /var/backups/personal-hub/db_YYYY-MM-DD.sql.gz | mysql -u personal_hub -p personal_hub

# 恢复上传文件
sudo tar xzf /var/backups/personal-hub/uploads_YYYY-MM-DD.tar.gz -C /opt/personal-hub
sudo chown -R www-data:www-data /opt/personal-hub/uploads
sudo systemctl restart personal-hub
```

---

## 10. 安全加固清单

- [ ] 已修改 `SESSION_SECRET` 与 `ADMIN_PASSWORD`（非默认值）
- [ ] 已启用 HTTPS（`SESSION_SECURE=true`）
- [ ] 防火墙仅放行 22/80/443，3306 不暴露
- [ ] `HOST=127.0.0.1`，应用不直接暴露公网
- [ ] 数据库专用账号 `personal_hub`，仅授权本库
- [ ] 定期备份数据库与 `uploads`
- [ ] 博客正文由**可信用户**撰写（服务端 `marked` 渲染 Markdown，**未做 HTML 消毒**，请勿粘贴不可信外部 HTML）
- [ ] 系统补丁：定期 `apt update && apt upgrade`

---

## 11. 常见问题排查（FAQ）

**Q1：访问域名显示 502 Bad Gateway**

- Nginx 配了反代但 Node 没起：`sudo systemctl status personal-hub`；看日志 `sudo journalctl -u personal-hub -n 50`
- 多半是 `.env` 里 `DB_*` 错或 MariaDB 没启动：`sudo systemctl status mariadb`

**Q2：登录后立刻被弹回 / 会话不保持**

- 检查 MariaDB 中 `sessions` 表是否自动创建（首次启动应自动建）
- 若多实例/集群，需共用同一数据库会话存储（本部署为单机，无需额外处理）

**Q3：上传大文件报 413 / 请求体过大**

- Nginx `client_max_body_size` 与 `.env` 的 `MAX_FILE_SIZE` 需一致（默认均 50MB）
- 改 Nginx 配置后 `sudo nginx -t && sudo systemctl reload nginx`

**Q4：改了 `.env` 不生效**

- `.env` 由 systemd 的 `EnvironmentFile` 读取，**必须重启服务**：`sudo systemctl restart personal-hub`

**Q5：数据库连不上（`无法连接数据库`）**

- 确认 `DB_HOST/PORT/USER/PASSWORD/NAME` 与 setup.sh 输出一致
- 确认 MariaDB 在跑：`sudo systemctl status mariadb`
- 确认用户只允许 `localhost`（`'personal_hub'@'localhost'`），不要填 `127.0.0.1` 以外地址

**Q6：忘记管理员密码**

- 直连数据库重置（bcrypt cost=12）：用应用逻辑不便直接改，可临时在 DB 把该用户 `password_hash` 清空后用页面「忘记密码」类流程——当前版本无自助重置，最稳妥是：
  ```bash
  sudo mysql -u personal_hub -p personal_hub -e \
    "UPDATE users SET password_hash='' WHERE username='admin';"
  ```
  然后改 `.env` 的 `ADMIN_PASSWORD` 并重启服务，**再次启动时不会自动重置已有账号**——因此请改用页面内修改密码功能（管理台提供），或删掉该用户行让启动重新播种（会丢失其文章归属，慎用）。

**Q7：如何换端口 / 多实例**

- 改 `.env` 的 `PORT`，同步改 Nginx `proxy_pass`，重启两者。
- 单机多实例需各自独立 `PORT`、独立 `UPLOAD_DIR`、共用同一 MariaDB（会话表天然共享）。

---

## 12. 卸载

```bash
# 停止并移除服务
sudo systemctl disable --now personal-hub
sudo rm -f /etc/systemd/system/web-service.service
sudo systemctl daemon-reload

# 移除 Nginx 站点
sudo rm -f /etc/nginx/sites-enabled/personal-hub /etc/nginx/sites-available/personal-hub
sudo systemctl reload nginx

# 删除应用目录（会丢失上传文件与本地配置，先备份！）
sudo rm -rf /opt/personal-hub

# （可选）删除数据库与用户
sudo mysql -u root -e "DROP DATABASE IF EXISTS personal_hub; DROP USER IF EXISTS 'personal_hub'@'localhost';"
```

---

## 附：与 README 的关系

- `README.md`：面向**开发者/使用者**，介绍功能、目录、API、本地开发。
- `DEPLOYMENT.md`（本文件）：面向**运维部署**，提供从零到上线的完整命令行流程、配置、HTTPS、备份、排障。

两者互补；首次上线请以此文件为准。
