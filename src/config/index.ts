import dotenv from 'dotenv';

// 在读取任何 process.env 之前加载 .env
dotenv.config();

function strOr(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function intOr(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}

function boolOr(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1';
}

/**
 * 业务时区（单一事实来源）。
 *
 * 库里时间列全是 DATETIME（原样存墙上时间、不做换算），所以「我们约定的墙上时间口径」
 * 必须显式声明在一处、到处引用；而不是各自 `new Date().getHours()` 取进程本地时区 ——
 * 容器里那是 UTC，会静默偏 8 小时。展示、写库、调度一律从这里取值。
 */
const BUSINESS_TZ = strOr('BUSINESS_TZ', 'Asia/Shanghai');

export const config = {
  env: strOr('NODE_ENV', 'development'),

  /** 业务时区（IANA 名）。展示与写库的唯一口径来源。 */
  businessTz: BUSINESS_TZ,
  port: intOr('PORT', 3000),
  host: strOr('HOST', '127.0.0.1'),
  publicBaseUrl: strOr('PUBLIC_BASE_URL', 'http://localhost:3000'),

  // CORS 白名单：逗号分隔的来源列表（git 平台托管前端时填 Pages 域名），留空表示仅同源
  corsOrigins: strOr('CORS_ORIGINS', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  db: {
    host: strOr('DB_HOST', '127.0.0.1'),
    port: intOr('DB_PORT', 3306),
    user: strOr('DB_USER', 'personal_hub'),
    password: strOr('DB_PASSWORD', 'change_me'),
    name: strOr('DB_NAME', 'personal_hub'),
    connectionLimit: intOr('DB_CONNECTION_LIMIT', 10),
    /**
     * 库内 DATETIME 的时区偏移，交给 mysql2 的 `timezone` 选项。
     * 必须与 db 容器的 TZ、以及 businessTz 指向同一口径 —— `npm run check:tz` 会对账。
     */
    timezoneOffset: strOr('DB_TZ_OFFSET', '+08:00'),
  },

  session: {
    secret: strOr('SESSION_SECRET', 'dev_insecure_secret_change_me'),
    maxAge: intOr('SESSION_MAX_AGE', 86400000),
    secure: boolOr('SESSION_SECURE', false),
    // 前端托管在 git 平台（跨站调用 API）时设 true：Cookie 以 SameSite=None 下发（须配合 HTTPS）
    crossSite: boolOr('SESSION_CROSS_SITE', false),
  },

  upload: {
    dir: strOr('UPLOAD_DIR', './uploads'),
    maxFileSize: intOr('MAX_FILE_SIZE', 50 * 1024 * 1024),
    // 每个账号的文件空间总配额（MB）
    quotaPerUserMB: intOr('FILE_QUOTA_MB', 100),
  },

  admin: {
    username: strOr('ADMIN_USERNAME', 'admin'),
    password: strOr('ADMIN_PASSWORD', 'change_me_admin_password'),
    displayName: strOr('ADMIN_DISPLAY_NAME', 'Administrator'),
  },

  auth: {
    // 是否开放自主注册（暴露公网时可设 REGISTER_ENABLED=false 关闭）
    allowRegister: boolOr('REGISTER_ENABLED', true),
    // 同一 IP 最多可注册的账号数（防批量刷号；管理员在控制台创建的账号不受限）
    maxAccountsPerIp: intOr('MAX_ACCOUNTS_PER_IP', 10),
  },

  remote: {
    // 远程控制（WebSocket 运维通道）总开关，公网不需要时可设 REMOTE_CONTROL_ENABLED=false
    enabled: boolOr('REMOTE_CONTROL_ENABLED', true),
    // 一次性连接票据有效期（秒）
    ticketTtlSec: intOr('REMOTE_TICKET_TTL', 60),
    // 单条命令输出上限（字节），超出部分截断
    maxOutputBytes: intOr('REMOTE_MAX_OUTPUT_BYTES', 64 * 1024),
    // 单条命令执行超时（毫秒）
    commandTimeoutMs: intOr('REMOTE_COMMAND_TIMEOUT_MS', 15 * 1000),
  },

  notify: {
    // 登录通知总开关
    enabled: boolOr('NOTIFY_ENABLED', false),
    // 推送渠道：wecom(企业微信自建应用) | serverchan(Server酱) | pushplus | webhook(钉钉/飞书自定义机器人等)
    channel: strOr('NOTIFY_CHANNEL', 'wecom'),
    // 仅关注特定账号的登录事件（逗号分隔用户名）；留空表示推送所有账号的登录事件
    watchUsers: strOr('NOTIFY_WATCH_USERS', '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    wecom: {
      corpid: strOr('NOTIFY_WECOM_CORPID', ''),
      secret: strOr('NOTIFY_WECOM_SECRET', ''),
      agentid: intOr('NOTIFY_WECOM_AGENTID', 0),
      // 接收人（企业微信成员账号），@all 表示该应用可见范围内的全部成员
      touser: strOr('NOTIFY_WECOM_TOUSER', '@all'),
      // 「接收消息服务器URL」回调验签参数（后台要求配置可信IP时需要）
      callbackToken: strOr('NOTIFY_WECOM_TOKEN', ''),
      callbackAeskey: strOr('NOTIFY_WECOM_AESKEY', ''),
    },
    serverchan: {
      sendkey: strOr('NOTIFY_SERVERCHAN_SENDKEY', ''),
    },
    pushplus: {
      token: strOr('NOTIFY_PUSHPLUS_TOKEN', ''),
    },
    webhook: {
      url: strOr('NOTIFY_WEBHOOK_URL', ''),
    },
  },

  /**
   * 每日内容抓取（RSS → 待审草稿）。
   * 时区：FEED_TZ 显式指定（默认 Asia/Shanghai），不依赖容器 TZ，避免 8 小时偏移。
   */
  feed: {
    // 总开关（默认关：未配置好来源时不应误抓）
    enabled: boolOr('FEED_ENABLED', false),
    // 每日触发时间 HH:MM（FEED_TZ 时区下的墙上时间）
    time: strOr('FEED_TIME', '08:30'),
    tz: strOr('FEED_TZ', BUSINESS_TZ),
    // 启动时立即跑一次（便于部署后验证，生产建议 false）
    runOnStart: boolOr('FEED_RUN_ON_START', false),
    // 错过触发时间后的补跑：进程在 08:30 之后才启动时，当日仍执行一次（每天至多一次）
    catchUp: boolOr('FEED_CATCH_UP', true),
    // 启用的来源 id（逗号分隔），留空 = 内置默认启用集合
    // （即 sources.ts 中 defaultEnabled=true 的三项：sspai / ithome / oschina；
    //   infoq 已停更、36kr 返回 HTML，两者 defaultEnabled=false 仅留档）
    sources: strOr('FEED_SOURCES', ''),
    // 单源单次最多入库条数（覆盖源定义的默认值）
    maxItems: intOr('FEED_MAX_ITEMS', 6),
    // 新鲜度阈值（天）：pubDate 早于该天数的条目直接丢弃。
    // 存在的意义：部分源站的 RSS 长期不更新（如 InfoQ 返回数年前的存档），
    // 若不按时间过滤会把历史内容当作「今日更新」灌进待审列表。
    maxAgeDays: intOr('FEED_MAX_AGE_DAYS', 7),
    // 摘录最大字符数（合规：只摘导语，不全文转载）
    excerptChars: intOr('FEED_EXCERPT_CHARS', 420),
    // RSS 摘要被判定为低质（推广文案/过短）时，回退抓取原文页 og:description 补导语
    fetchOg: boolOr('FEED_FETCH_OG', true),
    // 每个来源单次最多尝试几次原文页回退（原文页通常较慢，需封顶以免拖长任务）
    maxOgPerSource: intOr('FEED_MAX_OG_PER_SOURCE', 3),
    // 入库初始状态：draft = 待人工审核后发布；published = 直接上线
    publishStatus: strOr('FEED_PUBLISH_STATUS', 'draft') as 'draft' | 'published',
    // 兜底分类（源定义未指定 category 时使用）
    category: strOr('FEED_CATEGORY', '资讯'),
    // 跨源同题软去重（标题归一化后相同则跳过）
    dedupTitle: boolOr('FEED_DEDUP_TITLE', true),
    dedupTitleDays: intOr('FEED_DEDUP_TITLE_DAYS', 7),
    // 抓取超时与重试
    timeoutMs: intOr('FEED_TIMEOUT_MS', 15000),
    retries: intOr('FEED_RETRIES', 2),
    // 抓取时的 User-Agent —— 这个字符串会被**每个被抓取的站点**记录到访问日志里，
    // 属于对外可见的身份，所以与站名保持一致（旧值 PersonalHubFeedBot 已随改名替换）。
    userAgent: strOr(
      'FEED_USER_AGENT',
      `BanshanLogFeedBot/1.0 (+${strOr('PUBLIC_BASE_URL', 'http://localhost:3000')})`
    ),
    // 运行结果推送管理员（复用 NOTIFY_* 渠道）
    notify: boolOr('FEED_NOTIFY', true),
    // 公开主页「今日更新」区块最多展示条数
    dailyLimit: intOr('FEED_DAILY_LIMIT', 8),
  },
};

// 生产环境使用默认会话密钥属于高危配置，启动时告警
if (config.env === 'production' && config.session.secret.startsWith('dev_insecure')) {
  // eslint-disable-next-line no-console
  console.error('[SECURITY][FATAL] 生产环境正在使用默认 SESSION_SECRET，请立即在 .env 设置强随机密钥！');
}

export type AppConfig = typeof config;
