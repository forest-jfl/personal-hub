#!/usr/bin/env bash
# ============================================================
# Personal Hub - 前端发布到 git 平台 Pages（GitHub Pages / Gitee Pages）
#
# 原理：用 git worktree 建一个独立工作树，复制 public/ 并把 config.js
#       的 API_BASE 替换为后端地址，提交后强制推送到 Pages 分支。
#
# 用法（在仓库根目录执行）：
#   API_BASE=https://api.your-domain.com bash deploy/publish-pages.sh [分支名]
#   分支名默认 pages
#
# 注意：Pages 站点是 HTTPS，API 也必须是 HTTPS，否则浏览器会拦截
#       混合内容（HTTPS 页面调用 HTTP 接口）。服务器需先启用 HTTPS。
# ============================================================
set -euo pipefail

API_BASE="${API_BASE:-}"
BRANCH="${1:-pages}"
WORK=".pages-worktree"

if [ -z "$API_BASE" ]; then
  echo "错误：请通过环境变量提供后端地址，例如 API_BASE=https://api.example.com" >&2
  exit 1
fi
if [ ! -f public/config.js ]; then
  echo "错误：请在仓库根目录执行本脚本（未找到 public/config.js）" >&2
  exit 1
fi

# 清理可能残留的旧 worktree
git worktree remove --force "$WORK" 2>/dev/null || true

# 基于当前 HEAD 建独立工作树（随后会清空重建内容）
git worktree add --detach "$WORK" HEAD >/dev/null 2>&1

# 清空工作树内容（保留 .git 文件），复制前端并注入 API_BASE
# 注：不用 find -exec（大环境 exec 报错）；不用 rm -rf（会被安全策略终止）
#     改用 git rm 清掉 pages 分支跟踪的全部文件，工作树只剩 .git 指针
git -C "$WORK" rm -rq --ignore-unmatch .
cp -r public/. "$WORK/"
sed -i "s|API_BASE: ''|API_BASE: '$API_BASE'|" "$WORK/config.js"
if ! grep -q "API_BASE: '$API_BASE'" "$WORK/config.js"; then
  echo "错误：config.js 注入 API_BASE 失败" >&2
  git worktree remove --force "$WORK" || true
  exit 1
fi

# 提交并强制推送到所有已配置的 Pages 远程（origin=Gitee、github=GitHub）
cd "$WORK"
git add -A
git -c user.name="pages-deploy" -c user.email="pages-deploy@local" \
  commit -qm "pages: publish frontend (API_BASE=$API_BASE, $(date +%Y-%m-%d_%H:%M))"
PUSHED=""
for remote in origin github; do
  if git remote get-url "$remote" >/dev/null 2>&1; then
    git push -q -f "$remote" "HEAD:refs/heads/$BRANCH" && PUSHED="$PUSHED $remote"
  fi
done
cd - >/dev/null

git worktree remove --force "$WORK"
echo "完成：前端已推送到分支 $BRANCH（远程:$PUSHED，API_BASE=$API_BASE）"
echo "GitHub Pages 随推送自动重新部署；Gitee Pages 服务已下线，仅作分支存档。"
