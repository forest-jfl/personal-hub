#!/usr/bin/env bash
# Personal Hub - Ubuntu 一键环境准备脚本
# 用途：在全新的 Ubuntu 22.04/24.04 服务器上安装 Node、MariaDB、Nginx，
#       并创建数据库与专用账号。运行：sudo bash deploy/setup.sh
# 注意：本脚本只准备“系统环境 + 数据库”，不部署应用代码本身。
set -euo pipefail

if [[ $EUID -ne 0 ]]; then echo "请使用 root 运行：sudo bash deploy/setup.sh"; exit 1; fi

# ---- 可覆盖的变量（也可交互输入）----
DB_NAME="${DB_NAME:-personal_hub}"
DB_USER="${DB_USER:-personal_hub}"
DB_PASSWORD="${DB_PASSWORD:-}"
PUBLIC_DOMAIN="${PUBLIC_DOMAIN:-}"

echo "==> 1/5 更新软件包并安装基础依赖"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y -q curl gnupg ca-certificates ufw

echo "==> 2/5 安装 Node.js 20 LTS (NodeSource)"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -q nodejs
fi
echo "     node: $(node -v)  npm: $(npm -v)"

echo "==> 3/5 安装 MariaDB 与 Nginx"
apt-get install -y -q mariadb-server nginx
systemctl enable mariadb nginx
systemctl start mariadb

echo "==> 4/5 创建数据库与账号"
if [[ -z "$DB_PASSWORD" ]]; then
  read -s -r -p "请输入数据库用户 [$DB_USER] 的密码: " DB_PASSWORD
  echo
fi
if [[ -z "$DB_PASSWORD" ]]; then echo "密码不能为空"; exit 1; fi

# 全新 MariaDB 的 root 默认用 unix_socket 本地免密登录
mysql -u root <<SQL
CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASSWORD}';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'localhost';
FLUSH PRIVILEGES;
SQL
echo "     数据库 ${DB_NAME} 与用户 ${DB_USER} 已就绪"

echo "==> 5/5 防火墙（可选，仅允许 SSH/HTTP/HTTPS）"
ufw allow OpenSSH
ufw allow 'Nginx Full'
# 如需立即启用：ufw --force enable （脚本内不自动启用，避免锁死连接）

echo
echo "==================== 完成 ===================="
echo "数据库名 : $DB_NAME"
echo "数据库用户: $DB_USER"
echo "请把以上信息写入部署目录的 .env："
echo "    DB_HOST=127.0.0.1"
echo "    DB_PORT=3306"
echo "    DB_NAME=$DB_NAME"
echo "    DB_USER=$DB_USER"
echo "    DB_PASSWORD=<你刚输入的密码>"
echo
echo "下一步："
echo "  1) 把本项目放到 /opt/personal-hub（git clone 或 scp）"
echo "  2) cp .env.example .env 并填好各项（尤其 SESSION_SECRET、ADMIN_PASSWORD）"
echo "  3) cd /opt/personal-hub && npm ci && npm run build"
echo "  4) sudo cp deploy/web-service.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now personal-hub"
echo "  5) sudo cp deploy/nginx-web-service.conf /etc/nginx/sites-available/personal-hub && sudo ln -s /etc/nginx/sites-available/personal-hub /etc/nginx/sites-enabled/ && sudo nginx -t && sudo systemctl reload nginx"
echo "  6) （推荐）sudo apt install certbot python3-certbot-nginx && sudo certbot --nginx -d <你的域名>"
