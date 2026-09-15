# 半山日志 (Banshan Log)

个人博客 + 文件管理平台。以 **CSDN 风格博客主页**为应用主入口，面向 **自己 + 朋友** 的小规模使用场景。

- **博客主页**（`/`）：首屏（北京时间时钟 + 引言）+ 顶部导航 + 左侧文章流（封面缩略图/摘要/分类/浏览量/分页）+ 右侧边栏（作者卡片、热门文章、分类、归档）
- **文章详情**（`/post?slug=`）：Markdown 渲染、封面头图、插图点击放大、阅读计数、文章信息
- **写作编辑**（`/editor`）：Markdown 编辑 + 实时预览，封面选择（上传 / 从图片库挑），存草稿或发布
- **图片库**（`/gallery`）：本人上传图片的网格视图，复制图床链接 / 放大 / 删除（删除前提示被哪些文章用作封面）
- **管理控制台**（`/console`）：**隐藏页面**，入口在右上角头像下拉菜单；文章 / 文件 / 用户管理三个板块整合于此，不再作为独立导航标签
- **多用户**：初始管理员通过环境变量播种，管理员可在控制台创建朋友账号
- **双端运行**：本地由 Express 同源托管前端；前端也可托管到 GitHub Pages，跨域调用 API

技术栈：**Node.js + TypeScript + Express + MySQL/MariaDB**，前端**零构建**（原生 JS/CSS 多文件静态页）。

---

## 0. 品牌与视觉（对外身份约定）

站点对外**只使用笔名「半山 / Banshan」**，不出现真实姓名、邮箱、与其它平台的账号名。这是硬要求，
不是文案偏好 —— 因此它同时被两个东西守住：样式层的约定 + 可执行的门禁（见 §6.7）。

| 项目 | 约定 |
| --- | --- |
| 站名 | 半山日志（`Personal Hub` 已全面弃用） |
| 作者 | 半山 / Banshan |
| 对外链接 | 只留站点自身与 GitHub；不留邮箱、不留 Real-name 相关站点 |
| 抓取 UA | `BanshanLogFeedBot/1.0`（对外可见，含品牌名） |
| 作品/项目描述 | 只写技术做法，不写业务领域（领域词比姓名更容易被检索到） |

**视觉**与个人主页同源：暗色底 + 玻璃拟态面板 + 氛围渐变 + 展示衬线（拉丁）。
两侧共用同一套数值令牌与同一套自托管字体（`public/assets/fonts/`，无外部 CDN）。

- 令牌定义在 `public/assets/style.css` 的 `:root`，与 `personal-homepage/src/styles/tokens.css` 同名同值 —— **改主题要两处一起改**
- `:root { color-scheme: dark }` 是必需的：没有它，输入框/滚动条会走 UA 的浅色控件样式
- 隐藏一律用 `.hidden` 类（`display: none !important`），不用 `hidden` 属性 —— 属性会被作者样式盖过

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
    ├── assets/style.css    # 全站样式（暗色玻璃拟态；令牌在 :root）
    ├── assets/fonts/       # 自托管字体（与个人主页同一套 woff2）
    ├── assets/api.js       # API 封装 + 顶部导航渲染 + 工具函数
    ├── assets/hero.js      # 首屏时钟与引言轮换（仅 index.html 引用）
    ├── index.html          # 博客主页（应用主入口）
    ├── post.html           # 文章详情
    ├── editor.html         # 写作编辑
    ├── gallery.html        # 图片库（需登录）
    ├── console.html        # 管理控制台（隐藏入口）
    └── login.html          # 登录页
scripts/
├── deploy-frontend.sh      # 发布 public/ 到线上（备份→上传→对账→重建镜像→重验→双路验收）
├── preview-mock.mjs        # 本地预览服务（静态 + 同形 mock API，供改样式时看真渲染）
├── check-css-coverage.mjs  # 类名覆盖率对账（全量重写样式表后必跑）
└── verify-ui.mjs           # 浏览器级视觉与脱敏验收（自带静态服务，可指向线上）
```

**线上形态**：`47.238.246.132` 上的 Docker Compose（`personal-hub-app-1` / `-db-1` / `-caddy-1`），
入口 `https://blog.jiangfulin.com/`，源码目录 `/home/jfl/personal-hub`。

发布前端：`./scripts/deploy-frontend.sh`。它**只发 `public/`、不碰 `src/`** ——
镜像是构建期 `COPY public ./public`，所以前端改动必须重建镜像；而重建会把 `src/`
一起编译，因此这个脚本刻意让服务端 `src/` 保持它自己的版本，
使「前端改版」与「后端在制品」两件事不被强迫一起上线。

---

## 2. 本地开发

```bash
npm install
cp .env.example .env        # 填好数据库连接与管理员凭据（CORS_ORIGINS 留空即可）
npm run dev                 # ts-node 启动，默认 http://127.0.0.1:3000
```

页面入口：`http://127.0.0.1:3000/`（博客主页；首次用 `.env` 里的 `ADMIN_USERNAME/ADMIN_PASSWORD` 登录）。

---

## 2.1 git 平台托管前端（GitHub Pages）

前端是纯静态文件，托管到 GitHub Pages，后端继续跑在自己的服务器上。

> ⚠️ Gitee Pages 服务已于 2025 年下线（官方确认，新用户无法开通），仅把 Gitee 当代码镜像与 `pages` 分支存档。

**一键发布脚本**（在仓库根目录执行，把前端推送到 `pages` 分支并注入 API_BASE，自动推送到 origin 与 github 两个远程）：

```bash
API_BASE=https://api.your-domain.com bash deploy/publish-pages.sh pages
```

**GitHub Pages 开启（仅首次）**：仓库公开（免费版要求）→ 推送 `pages` 分支 → API 开启（或网页端 Settings → Pages → Branch 选 `pages` / root）：

```bash
curl -X POST https://api.github.com/repos/<owner>/<repo>/pages \
  -H "Authorization: Bearer <token>" -H "Accept: application/vnd.github+json" \
  -d '{"source":{"branch":"pages","path":"/"}}'
```

开启后随每次推送 `pages` 分支自动重新部署，地址：`https://<用户名>.github.io/<仓库名>/`。

**启用前的前置条件**（按顺序完成）：

1. **服务器必须先有 HTTPS**：Pages 页面是 HTTPS，调用 HTTP 接口会被浏览器拦截（混合内容）。域名经 Cloudflare 代理时边缘证书自带，源站用 Caddy 提供回源 HTTPS。
2. **后端 `.env` 追加**：
   ```ini
   CORS_ORIGINS=https://<用户名>.github.io
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
| `FEED_*` | 每日内容抓取，见第 6 节 | `FEED_ENABLED=false` |

---

## 6. 每日内容抓取（RSS → 待审草稿）

从指定 RSS/Atom 来源每日定时抓取，整理为「署名 + 摘录 + 原文链接」的文章入库，
**默认存为 `draft`**，你在控制台确认后才发布。

### 6.1 数据流

```
08:30（Asia/Shanghai）调度触发
  → 并发抓取各源 RSS/Atom（超时 15s，失败重试 2 次）
  → 解析 title / link / guid / description / pubDate
  → 新鲜度过滤（pubDate 早于 FEED_MAX_AGE_DAYS 的条目丢弃）
  → 摘要规范化（HTML→Markdown、去样板词、截断；低质时回退原文 og:description）
  → 两级去重 → 写入 posts（status=draft）
  → 写 feed_fetch_log 留痕 → 推送管理员（企业微信等）
  → 你在 /console?tab=feed 查看，逐条「发布」后出现在主页「今日更新」区块
```

### 6.2 去重与更新判断（三层）

| 层级 | 机制 | 效果 |
|---|---|---|
| 硬去重 | 唯一键 `uk_source_guid(source, source_guid)` | 同源同条目永不重复入库 |
| 更新判断 | `content_hash`（正文指纹） | 指纹未变则不写库、不刷新 `updated_at`；原文摘要变更才更新 |
| 软去重 | 标题归一化比对（`FEED_DEDUP_TITLE`） | 同一新闻多源报道时只留一条，默认 7 天内生效 |

`posts.source` / `source_guid` 可为 `NULL`（手工文章），唯一索引允许多行 `NULL`，故不影响存量文章。

### 6.3 内置来源

| id | 名称 | 分类 | 默认启用 | 实测状态（2026-09-15） |
|---|---|---|---|---|
| `sspai` | 少数派 | 资讯 | ✅ | RSS 2.0 正常 |
| `ithome` | IT之家 | 资讯 | ✅ | RSS 2.0 正常 |
| `oschina` | 开源中国 | 技术 | ✅ | RSS 2.0 正常 |
| `infoq` | InfoQ 中文 | 技术 | ❌ | 可访问但条目停留在 2019 年，已停更 |
| `36kr` | 36氪 | 资讯 | ❌ | 返回 HTML 而非 RSS |

新增来源：编辑 `src/services/daily-feed/sources.ts` 追加一项，再用 `FEED_SOURCES=id1,id2` 控制启用集合。

### 6.4 启用步骤

```bash
# 1) 配置（.env）
FEED_ENABLED=true
FEED_TIME=08:30            # 触发时间
FEED_TZ=Asia/Shanghai      # 必须显式指定，容器默认 UTC 会偏移 8 小时
FEED_PUBLISH_STATUS=draft  # draft=待审；published=直接上线
NOTIFY_ENABLED=true        # 如需抓取结果推送（复用既有推送渠道）

# 2) 上线前先干跑验证（不写库、不推送）
npm run feed:daily -- --dry-run
npm run feed:daily -- --dry-run --source=sspai     # 只验某个源

# 3) 正式抓一次 / 交给调度器
npm run feed:daily
# 生产镜像内用编译产物：node dist/services/daily-feed/cli.js
```

> 调度器在工作日 08:30 触发；`FEED_CATCH_UP=true` 时，进程在 08:30 之后启动会补跑当日一次，
> 且已从 `feed_fetch_log` 恢复「当日是否已执行」——重启（部署/崩溃）不会重复抓取。

### 6.5 主页展示

- 主页顶部「今日更新」区块：列出**当日已发布**的抓取条目（附抓取时间与原文外链）；无条目则整块隐藏。
- 文章卡片与详情页显示来源徽标（如「开源中国 ↗」），点击直达原文。
- 抓取条目正文首部固定附署名与原文链接，尾部附版权声明——只摘录导语，不全文转载。
- 待审草稿**不会**出现在任何公开页面。

### 6.6 控制台

`/console` → 「抓取任务」标签页（仅管理员）：

- 状态卡：触发时间/时区、待审草稿数、已发布条数、本进程最近执行日
- 可用来源清单、最近一次运行结果、执行留痕（最近 20 条，含失败原因与耗时）
- 「干跑（不写库）」「立即抓取」按钮用于手动触发

文章管理页新增来源列、`只看草稿` 筛选，以及每条的「发布 / 撤回」按钮。

### 6.7 浏览器级实测

```bash
npm run dev                       # 另开一个终端
ADMIN_PASSWORD=xxx node scripts/verify-feed-ui.mjs
# 只读模式验证线上（不点写接口）：
TARGET_URL=https://blog.jiangfulin.com node scripts/verify-feed-ui.mjs
```

覆盖 17 项断言：今日更新区块可见性与内容、来源徽标外链、`.hidden` 层叠兜底、
登录、抓取面板渲染、**留痕时区不得差 8 小时**、干跑按钮真实点击、发布/撤回点击链路、
只看草稿筛选、主页与后端状态一致性。退出码 0 通过 / 1 断言失败 / 2 执行中断 / 3 环境缺失。

---

## 6.8 主题与身份门禁（改样式 / 改品牌后必跑）

```bash
npm run check:css                 # 1) 类名覆盖率对账（秒级，零依赖）
npm run check:cover               # 2) 封面地址规则（14 项：该放行/该拒绝）
npm run check:assets              # 3) 资源版本注入（14 项：注入/幂等/不误伤）
node scripts/verify-ui.mjs        # 4) 浏览器级视觉与脱敏验收（自带静态服务）
TARGET_URL=https://blog.jiangfulin.com node scripts/verify-ui.mjs   # 只读验线上
```

**为什么这两道都需要。** 全部重写 `style.css`（274 → 736 行）时，风险不在语法而在**静默漏项**：
漏写一个还在用的类名，元素就退化成无样式 —— 不报错、构建全绿、`curl` 看不出。
而「文件里有暗色令牌」也不等于「页面真的是暗色」，中间隔着内联 `style` / 内嵌 `<style>` /
外部样式表三级层叠，`grep` 样式表看不见前面两级。

`check:css` 做三件事：在用类名是否全部有定义（必须为 0 漏项）、定义了却没人用的类名（仅提示）、
HTML 内联样式里有没有写死浅色。它还能与 `git show HEAD:public/assets/style.css` 对比出
「旧有新无」的类名差集 —— 0 个才说明重写没丢规则。

`verify-ui.mjs` 覆盖 97 项断言（指向线上时自动降级为 42 项：公开页跑完整检查，
需登录页只断言「被正确拦到 `/login`」），用本机 Chrome 走 DevTools 协议（零额外依赖）：

- **暗色真的生效**：body 亮度、正文对比度 ≥ 4.5、`color-scheme: dark`
- **逐元素文本对比度**：抓「暗底暗字 / 亮底亮字」。整体 body 对比度再健康也盖不住局部的
  表格 `td`、引用块、代码块；折叠以下（视口外）的元素一样扫得到
- **玻璃拟态**：`.card` 的 `backdrop-filter` 与非透明半透明底
- **字体真加载**：`document.fonts.status === 'loaded'` 且含 Public Sans（声明 ≠ 加载）
- **内容真渲染**：文章卡片数、正文长度、控制台表格行数与页签数（「没报错」≠「有内容」）
- **`.hidden` 专项**：控制台六个面板中**恰好**一个可见，且默认为文章管理
  （只查那几个带 `.hidden` 的，会退化成「零个可见也通过」的空断言）
- **三层脱敏**：运行时文本 / DOM 属性 / 响应 HTML 均无身份标识与领域词
- 每页截图留档到 `docs/screenshots/`（**本地产物，不入库** —— 内容每跑一次就变，已在 `.gitignore`）

退出码 0 通过 / 1 断言失败 / 3 环境缺浏览器。**依赖本机浏览器，故不接入 CI** ——
进了 CI 只会在没有 Chrome 的机器上静默跳过，等于没有门禁。

**门禁有效性验证（勿省）。** 写完断言必须做一次反例：临时往 `style.css` 追加
`.post-html table td { background:#fff; color:#f2f2f2 }`，跑 `verify-ui.mjs` 必须**失败**
并打印出 `td[1.12] fg=rgb(242,242,242) bg=rgb(255,255,255)`；还原后必须重新全绿。
注意反例要选对形态 —— `#333` 在白底上是**高**对比，用它会得出「对比度门禁不生效」的错误结论。

---

## 6.9 静态资源缓存与版本指纹（改 JS/CSS 后必读）

**症状**：部署新版本后页面报 `HUB.xxx is not a function`。

**根因（2026-09-15 实测）**：站点前面有两层缓存，其中 **Cloudflare 的 Browser Cache TTL
（默认 4 小时）会按静态扩展名把 `.js` / `.css` / `.woff2` 的 `max-age` 重写成 `14400`，
源站发什么都不管用**；而 HTML 不被 CF 缓存（`cf-cache-status: DYNAMIC`）所以立刻就是新的。
两者叠加即「新 HTML 调用新 API + JS 还卡在旧缓存」——
本地验证、构建门禁、`curl` 首页 200 全都正常，只有处在缓存命中窗口内的真浏览器才炸。

**修法**：把内容指纹拼进资源 URL。**URL 一变，浏览器 / CF / 任何中间层都必然回源** ——
这是唯一不依赖对方配置的确定性手段（调 `max-age` 没用，CF 会重写）。

- `src/utils/asset-version.ts`：`computeAssetVersion()` 由 `assets/` 全量文件 +
  `config.js`/`favicon.svg` 的 **mtime+size** 推导指纹，容器重建即变化 ⇒
  **不需要任何人记得手工 bump 版本号**（手工版本号一定会被忘掉）
- `injectAssetVersion()` 幂等（已带 query 的不二次拼接），且只认「属性值开头」的路径，
  不误伤外部 CDN 的 `/assets/...`
- `app.ts` 用 `sendPage()` 统一注入；**直连 `*.html` 也走注入**（否则 `express.static`
  会吐出未注入的原件，形成一条绕过路径）；静态资源响应头统一 `no-cache`

**改 JS/CSS 后要做什么**：什么都不用做 —— 指纹自动变。但**不要手工往 HTML 里写 `?v=常量`**，
那会退化回「手工 bump」，且与门禁冲突。

**门禁**：`npm run check:assets`（14 项：6 种注入形态 + 幂等 + 图床/字体/外部 CDN 三种不误伤）。

**已知残留（本轮无法通过改站点消除）**：

| 残留 | 说明 |
| --- | --- |
| 域名 `jiangfulin.com` | 含真名拼音。用户已决定「先改内容，域名后续再议」，故验收脚本把它列进白名单而非删断言 —— 迁域名时记得摘掉 |
| GitHub 账号 `forest-jfl` | 含姓名缩写。链接必须指向真账号（否则是坏链），故只锁「页面不印账号名」这一层；彻底消除需重命名账号 |
| 仓库历史邮箱 | `git log` 里的旧提交仍含真实邮箱，需 filter-repo / BFG 等外部动作 |
| **数据库里的用户名** | `users` 表有 `username=jiangfulin`（真名拼音）与 `username=411425200801191218`（18 位身份证号）两条账号。**公开页面不展示 username**（列表只显示 `display_name`），所以它们不构成对外泄漏；但改 username 会影响登录，属数据决策，未擅自变更 |
| **内容里的旧品牌** | 2026-09-15 已把文章 `id=1` 的标题/slug/正文与管理员 `display_name` 从 `Personal Hub` / `Administrator` 改为「半山日志」/「半山」，备份在服务器 `/home/jfl/backups/brand-rename-*.json`。**今后写内容时不要再用旧品牌名** —— 门禁扫的是页面，扫不出库里还没发布的草稿 |

**缓存：发布后必须让边缘重验。** `express.static` 对**非 HTML** 资源带 `max-age=14400`（4 小时），
而 HTML 页面是 `no-cache`。两者叠加的后果是「新页面 + 旧 CSS/JS」——对一个以改版为目的的发布，
这等于改造没生效，而且**只对真实用户复现**（本机全新浏览器 profile 也躲不过 CF 边缘缓存，
本次就因此把旧 `api.js` 里的旧品牌名渲染了出来）。`scripts/deploy-frontend.sh` 已内置
`do_purge`：用 `Cache-Control: no-cache` 的请求逐个戳 `style.css` / `api.js` / `favicon.svg`，
逼 CF 回源重验，把窗口从 4 小时压到秒级。彻底的做法是给资源加内容版本号（`?v=<hash>`），
但那要在「零构建」的项目里引入构建步骤，属另一个决策，暂不做。

---

## 7. API 一览

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/health` | 否 | 健康检查 |
| POST | `/api/auth/login` | 否 | 登录 `{username,password}` |
| POST | `/api/auth/logout` | 是 | 登出 |
| GET | `/api/auth/me` | 是 | 当前用户 |
| GET | `/api/users` | 管理员 | 用户列表 |
| POST | `/api/users` | 管理员 | 创建用户 |
| DELETE | `/api/users/:id` | 管理员 | 删除用户 |
| GET | `/api/posts` | 是 | 文章列表（管理员看全部，普通用户看自己，含来源字段） |
| POST | `/api/posts` | 是 | 新建文章 |
| PUT | `/api/posts/:id` | 是(作者/管理员) | 更新（控制台用它切换 `status` 完成发布/撤回） |
| DELETE | `/api/posts/:id` | 是(作者/管理员) | 删除 |
| GET | `/api/files` | 是 | 文件列表 |
| POST | `/api/files` | 是 | 上传（`multipart/form-data`，字段名 `file`） |
| GET | `/api/files/:id/download` | 是 | 下载 |
| DELETE | `/api/files/:id` | 是(拥有者/管理员) | 删除 |
| GET | `/api/feed/status` | 管理员 | 调度状态 / 可用来源 / 最近运行 / 执行留痕 / 计数 |
| GET | `/api/feed/pending` | 管理员 | 待审抓取条目 |
| POST | `/api/feed/run` | 管理员 | 手动触发抓取 `{dryRun?, sources?}` |
| GET | `/api/public/posts` | 否 | 已发布文章（分页 `page/pageSize`、`category`、`q` 标题搜索，含摘要与来源字段） |
| GET | `/api/public/daily` | 否 | 当日已发布的抓取条目（`date=YYYY-MM-DD` 可选，缺省为 `FEED_TZ` 的今天） |
| GET | `/api/public/meta` | 否 | 侧边栏元数据（分类统计 / 按月归档 / 热门文章） |
| GET | `/api/public/posts/:slug` | 否 | 单篇已发布文章（含渲染 HTML，自增阅读量） |

页面：`/`（博客主页）、`/post?slug=`（详情）、`/login`、`/editor`（需登录）、`/gallery`（需登录）、`/console`（需登录，隐藏入口）。
旧链接 `/blog`、`/app` 等自动重定向到主页。

---

## 8. 安全说明

- 密码使用 bcrypt（cost=12）哈希存储；会话 Cookie 设 `httpOnly` + `sameSite`，启用 HTTPS 后建议 `SESSION_SECURE=true`。
- 所有数据库访问均使用参数化查询，避免 SQL 注入。
- 反向代理后已设置 `trust proxy`，可正确获取客户端真实 IP。
- 博客正文由可信用户撰写并以 Markdown 渲染为 HTML（服务端 `marked` 渲染），**未做 HTML 消毒**——请仅发布可信内容，避免粘贴外部不可信 HTML。
- 生产环境务必修改 `.env` 中的 `SESSION_SECRET` 与 `ADMIN_PASSWORD`，并启用 HTTPS。
