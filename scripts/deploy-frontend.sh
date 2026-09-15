#!/usr/bin/env bash
# ============================================================================
# 前端发布脚本 —— 只发布 public/（品牌名、样式、字体、静态页），不碰 src/。
#
# 为什么单独一个脚本、而不是直接 git pull + docker compose up：
#   镜像里 `COPY public ./public` 是**构建期**写进镜像的，不是挂载。
#   所以改前端要么重建镜像，要么起不了作用；而重建镜像又会把 src/ 一起编译。
#   本脚本刻意**只替换 public/**，让服务端 src/ 保持它自己的（已提交）版本 ——
#   这样「前端改版」与「后端在制品」两件事不会被迫一起上线。
#
# 用法：
#   ./scripts/deploy-frontend.sh            备份 → 上传 → 对账 → 重建镜像 → 双路验收
#   ./scripts/deploy-frontend.sh upload     只上传与对账（不重建）
#   ./scripts/deploy-frontend.sh check      只做线上验收
#
# 设计约束（沿用工作区既有教训）：
#   · tar 原地解包**只覆盖不删除** → 发布后必须按清单对账，逐个删掉线上多余文件
#   · ssh/scp 参数含 /home/... 会被 MSYS 误转 → 逐个前置 MSYS_NO_PATHCONV=1
#   · set -e 下 `grep | wc -l` 未命中会让脚本静默中止 → 计数行尾加 `|| true`
# ============================================================================

set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-47.238.246.132}"
REMOTE_USER="${REMOTE_USER:-jfl}"
REMOTE="${REMOTE_USER}@${REMOTE_HOST}"
APP_DIR="${APP_DIR:-/home/jfl/personal-hub}"
SITE_URL="${SITE_URL:-https://blog.jiangfulin.com/}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new)

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

C_OK=$'\033[32m'; C_DIM=$'\033[2m'; C_ERR=$'\033[31m'; C_OFF=$'\033[0m'
ok()   { printf '%s  ✓ %s%s\n' "$C_OK" "$*" "$C_OFF"; }
step() { printf '\n%s── %s %s\n' "$C_DIM" "$*" "$C_OFF"; }
die()  { printf '%s  ✗ %s%s\n' "$C_ERR" "$*" "$C_OFF" >&2; exit 1; }
_fail=0
bad()  { printf '%s  ✗ %s%s\n' "$C_ERR" "$*" "$C_OFF"; _fail=1; }

rsh() { MSYS_NO_PATHCONV=1 ssh "${SSH_OPTS[@]}" "$REMOTE" "$@"; }

# 与 personal-homepage / vps/deploy.sh 同一份脱敏词表。
# 域名不在表内：站点本身就挂在 blog.jiangfulin.com 上，地址栏里本来就有。
TOKENS='蒋富林|Jiang Fulin|JFL|1419658084|workalin|forest-jfl|反欺诈|资金流向|案件|进项发票|调单|龙虎榜|持仓'

# ── 上传与对账 ──────────────────────────────────────────────────────────────
do_upload() {
  step "预检：本地 public/ 无身份标识"
  if grep -rInE "$TOKENS" public/ 2>/dev/null | head -5 | grep -q .; then
    grep -rInE "$TOKENS" public/ | head -5
    die "本地 public/ 含身份标识，拒绝发布"
  fi
  ok "本地 public/ 干净"

  step "备份线上 public/"
  local ts; ts="$(date +%Y%m%d-%H%M%S)"
  rsh "cd '$APP_DIR' && cp -a public 'public.bak.$ts' && ls -d public.bak.$ts"
  ok "已备份为 public.bak.$ts"

  step "上传（tar 流式，不经中转目录）"
  # 注意：tar 原地解包只覆盖不删除
  tar -czf - public | rsh "tar -xzf - -C '$APP_DIR'"
  ok "已解包到 $APP_DIR"

  step "陈旧文件对账（tar 只覆盖不删除）"
  # 线上有的、本地没有的 → 逐个删掉。否则旧版静态资源会永远留在线上。
  local local_list remote_list stale
  local_list="$(cd public && find . -type f | LC_ALL=C sort)"
  remote_list="$(rsh "cd '$APP_DIR/public' && find . -type f | LC_ALL=C sort")"
  stale="$(LC_ALL=C comm -13 <(printf '%s\n' "$local_list") <(printf '%s\n' "$remote_list") || true)"
  if [ -n "$stale" ]; then
    printf '  线上多出以下文件（本地已不存在，逐个删除）：\n'
    printf '%s\n' "$stale" | sed 's/^/    - /'
    # 逐个删、逐条日志；路径来自两端 find 的差集，不含通配符
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      rsh "cd '$APP_DIR/public' && rm -f -- '$f'"
    done <<< "$stale"
    ok "已删除 $(printf '%s\n' "$stale" | grep -c . || true) 个陈旧文件"
  else
    ok "线上无多余文件"
  fi
}

# ── 重建镜像 ────────────────────────────────────────────────────────────────
do_rebuild() {
  step "重建 app 镜像并重启（public/ 是构建期 COPY 进镜像的，必须重建）"
  rsh "cd '$APP_DIR' && docker compose build app 2>&1 | tail -5 && docker compose up -d app 2>&1 | tail -5"
  ok "容器已重启"
  # 给 node 进程一点时间完成迁移与监听
  sleep 6
  rsh "cd '$APP_DIR' && docker compose ps app --format '{{.Status}}'"
}

# ── 验收 ────────────────────────────────────────────────────────────────────
do_check() {
  step "第一路：服务器内部直连（绕过 Cloudflare，验源站）"
  local title code
  code="$(rsh "curl -s -o /dev/null -w '%{http_code}' -H 'Host: blog.jiangfulin.com' http://127.0.0.1:3000/" || true)"
  [ "$code" = "200" ] && ok "源站首页 200" || bad "源站首页 $code"
  title="$(rsh "curl -s -H 'Host: blog.jiangfulin.com' http://127.0.0.1:3000/ | grep -o '<title>[^<]*</title>' | head -1" || true)"
  case "$title" in *半山*) ok "源站标题：$title" ;; *) bad "源站标题未含品牌名：$title" ;; esac

  step "第二路：经 Cloudflare（验用户真实链路）"
  local html
  html="$(curl -sL --max-time 25 "$SITE_URL" || true)"
  [ -n "$html" ] || die "抓取 $SITE_URL 失败"

  case "$html" in *'<title>半山日志</title>'*) ok "线上标题为「半山日志」" ;;
    *) bad "线上标题异常：$(printf '%s' "$html" | grep -o '<title>[^<]*</title>' | head -1)" ;; esac
  case "$html" in *'Personal Hub'*) bad "线上仍有旧品牌 Personal Hub" ;; *) ok "无旧品牌残留" ;; esac

  # 三层脱敏：只看 HTML（运行时文本与 DOM 属性由 scripts/verify-ui.mjs 覆盖）
  local hits
  hits="$(printf '%s' "$html" | grep -oE "$TOKENS" | sort -u | tr '\n' ' ' || true)"
  [ -z "$hits" ] && ok "线上 HTML 无身份标识与领域词" || bad "线上 HTML 命中：$hits"
  case "$html" in *'email-protection'*) bad "出现 Cloudflare 邮箱混淆产物" ;; *) ok "无邮箱混淆产物" ;; esac

  # 关键静态资源必须可达（尤其新增的字体目录与首屏脚本，漏传会静默失效：
  # 字体回退到系统字体、hero.js 缺失则时钟一直停在 --:--:--，页面照样 200）
  local path
  for path in /assets/style.css /assets/api.js /assets/hero.js /gallery.html \
              /assets/fonts/public-sans-latin-400-normal.woff2 /favicon.svg; do
    code="$(curl -sL --max-time 20 -o /dev/null -w '%{http_code}' "${SITE_URL%/}$path" || true)"
    [ "$code" = "200" ] && ok "$path 200" || bad "$path $code"
  done

  step "三验：把本地验收脚本指向线上（只读）"
  TARGET_URL="$SITE_URL" node scripts/verify-ui.mjs 2>&1 | tail -8
}

# ── 强制边缘重验（缓存穿透）──────────────────────────────────────────────────
# 为什么需要这一步：`express.static` 对**非 HTML** 资源带 `max-age=14400`（4 小时），
# 而 HTML 页面是 `no-cache`。于是部署后浏览器会是「新页面 + 旧 CSS/JS」——
# 对一个以改版为目的的发布，这等于改造没生效，而且只在真实用户那里复现
# （本机全新 profile 也躲不过 CF 边缘缓存，本次即因此把旧 api.js 渲染出旧品牌名）。
# 这里用带 no-cache 的请求逐个戳一遍，逼 CF 回源重验，把窗口从 4 小时压到秒级。
# 彻底的做法是给资源加内容版本号（`?v=<hash>`），但那需要在零构建项目里引入构建步骤，
# 属另一个决策；在 README 里记为已知项。
do_purge() {
  step "强制边缘重验静态资源（绕开 4 小时缓存）"
  local p code
  for p in /assets/style.css /assets/api.js /assets/hero.js /favicon.svg; do
    code="$(curl -sIL --max-time 20 -H 'Cache-Control: no-cache' -H 'Pragma: no-cache' \
      -o /dev/null -w '%{http_code}' "${SITE_URL%/}$p" || true)"
    [ "$code" = "200" ] && ok "$p 已重验（$code）" || bad "$p 重验失败（$code）"
  done
}

case "${1:-deploy}" in
  upload) do_upload ;;
  check)  do_check ;;
  deploy) do_upload; do_rebuild; do_purge; do_check ;;
  *) die "用法：$0 [deploy|upload|check]" ;;
esac

if [ "$_fail" -ne 0 ]; then
  printf '\n%s  验收有失败项，请检查上方 ✗%s\n' "$C_ERR" "$C_OFF" >&2
  exit 1
fi
printf '\n%s  发布完成：%s%s\n' "$C_OK" "$SITE_URL" "$C_OFF"
