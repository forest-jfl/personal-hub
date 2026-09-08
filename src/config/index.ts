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

export const config = {
  env: strOr('NODE_ENV', 'development'),
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
};

// 生产环境使用默认会话密钥属于高危配置，启动时告警
if (config.env === 'production' && config.session.secret.startsWith('dev_insecure')) {
  // eslint-disable-next-line no-console
  console.error('[SECURITY][FATAL] 生产环境正在使用默认 SESSION_SECRET，请立即在 .env 设置强随机密钥！');
}

export type AppConfig = typeof config;
