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
  },

  admin: {
    username: strOr('ADMIN_USERNAME', 'admin'),
    password: strOr('ADMIN_PASSWORD', 'change_me_admin_password'),
    displayName: strOr('ADMIN_DISPLAY_NAME', 'Administrator'),
  },
};

export type AppConfig = typeof config;
