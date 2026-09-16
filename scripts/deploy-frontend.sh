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
#   ./scripts/deploy-frontend.sh            备份 → 归位 → 上传 → 对账 → 重建镜像 → 重验 → 双路验收
#   ./scripts/deploy-frontend.sh upload     只上传与对账（不重建）
#   ./scripts/deploy-frontend.sh check      只做线上验收
#   ALLOW_DIRTY=1 ./scripts/deploy-frontend.sh   越过「public/ 必须已提交」门禁（后果见下方不变量）
#
# 设计约束（沿用工作区既有教训）：
#   · tar 原地解包**只覆盖不删除** → 发布后必须按清单对账，逐个删掉线上多余文件
#   · ssh/scp 参数含 /home/... 会被 MSYS 误转 → 逐个前置 MSYS_NO_PATHCONV=1
#   · set -e 下 `grep | wc -l` 未命中会让脚本静默中止 → 计数行尾加 `|| true`
#
# 发布不变量（违反则下一次服务端 git pull 必失败，故设门禁卡住）：
#   **发布内容 == 本机 HEAD 的 public/**。
#   服务端 $APP_DIR 同时是「git 工作区」与「docker build 上下文」，而 public/ 是被
#   git 跟踪的目录：发布即覆盖 git 跟踪文件，工作区随即出现本地修改。若这份内容
#   与远端 main 不一致，下一次服务端 `git pull` 会以
#   「Your local changes would be overwritten by merge」整体失败 —— 连 src/ 的更新
#   一起卡住，且报错指向 public/，极容易被当成误报去 `git checkout` 掉（那会静默
#   回退线上前端）。
#   解法不是「发布后再 commit」（那会在服务端制造一个永不入库的提交，与远端分叉
#   后仍会冲突），而是维持上述不变量：成立时 git 只在「取回内容 == 本地内容」时
#   放行工作区写入，于是 pull 永不被 public/ 挡住。故 upload 前置一道门禁，
#   非「已提交」的 public/ 直接拒绝（ALLOW_DIRTY=1 可明确越过，代价见告警文本）；
#   上传前再把服务端 public/ 归位到 git 基线，清掉历史遗留的脏。
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

C_OK=$'\033[32m'; C_DIM=$'\033[2m'; C_ERR=$'\033[31m'; C_WARN=$'\033[33m'; C_OFF=$'\033[0m'
ok()   { printf '%s  ✓ %s%s\n' "$C_OK" "$*" "$C_OFF"; }
warn() { printf '%s  ! %s%s\n' "$C_WARN" "$*" "$C_OFF"; }
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
  step "门禁：本地 public/ 已提交（发布不变量）"
  local dirty
  dirty="$(git status --porcelain -- public || true)"
  if [ -n "$dirty" ]; then
    printf '%s\n' "$dirty" | sed 's/^/    /'
    if [ "${ALLOW_DIRTY:-0}" = "1" ]; then
      warn "public/ 有未提交改动，ALLOW_DIRTY=1 已明确越过"
      warn "服务端 public/ 将与本机 HEAD 不一致：下一次服务端 git pull 可能整体失败"
      warn "且下一次发布会先把服务端 public/ 归位到 git 基线，这次改动在服务端不留痕"
    else
      die "public/ 有未提交改动，拒绝发布：先 git commit，或 ALLOW_DIRTY=1 明确越过"
    fi
  else
    ok "public/ 与 HEAD 一致"
  fi

  step "预检：本地 public/ 无身份标识"
  if grep -rInE "$TOKENS" public/ 2>/dev/null | head -5 | grep -q .; then
    grep -rInE "$TOKENS" public/ | head -5
    die "本地 public/ 含身份标识，拒绝发布"
  fi
  ok "本地 public/ 干净"

  step "备份线上 public/ → .deploy-backups/（移出 git 工作区）"
  # 备份必须放在 git 工作区之外：放在 $APP_DIR 根会成为未跟踪目录（污染 git status，
  # 又被 docker build 上下文吃进去）。早期版本就是这样（public.bak.<ts>），这里顺手收编。
  local ts; ts="$(date +%Y%m%d-%H%M%S)"
  rsh "cd '$APP_DIR' && mkdir -p .deploy-backups && for d in public.bak.*; do [ -d \"\$d\" ] || continue; mv \"\$d\" \".deploy-backups/public-\${d#public.bak.}\" && echo \"  收编旧备份 \$d\"; done" || true
  rsh "cd '$APP_DIR' && cp -a public '.deploy-backups/public-$ts' && du -sh '.deploy-backups/public-$ts'"
  ok "已备份 .deploy-backups/public-$ts"

  step "服务端 public/ 归位到 git 基线"
  # 目的：让本次发布的 diff 基线 == git HEAD，而不是「上一次脚本故障留下的半成品」。
  # 只动 public/，不碰 src/（两通道互不牵连是本脚本的设计意图）。
  rsh "cd '$APP_DIR' && git checkout -- public && git clean -fdq public && echo '  已归位'"
  ok "服务端 public/ == 其 HEAD 的 public"

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

  step "自检：服务端 public/ 未留下会挡住 git pull 的本地修改"
  # 这是上面那条不变量的**可复现断言**（发布流程最容易静默坏掉的地方）：
  # 空 = 服务端 HEAD 与工作区内容一致，pull 永不被 public/ 挡住。
  local after
  after="$(rsh "cd '$APP_DIR' && git status --porcelain -- public" || true)"
  if [ -z "$after" ]; then
    ok "服务端 public/ 与其 HEAD 一致 —— git pull 不会被 public/ 挡住"
  else
    printf '  服务端 public/ 相对其 HEAD 有差异：\n'
    printf '%s\n' "$after" | sed 's/^/    /'
    warn "通常意味着本机这次改动尚未 push（服务端 HEAD 还是旧 public），push 后自动持平"
    warn "若本机改动本就不打算入库，此状态下不要在服务端执行 git pull"
  fi

  step "备份保留策略（.deploy-backups/ 只留最近 3 份）"
  rsh "cd '$APP_DIR/.deploy-backups' && ls -1d public-* 2>/dev/null | LC_ALL=C sort -r | tail -n +4 | while IFS= read -r d; do rm -rf -- \"\$d\" && echo \"  已删除旧备份 \$d\"; done" || true
  ok "保留策略已应用"
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
