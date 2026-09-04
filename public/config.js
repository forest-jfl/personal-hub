/**
 * 前端运行配置（零构建，直接被各页面 <script src> 引入）。
 *
 * - 本地运行（Express 同源托管）：保持 API_BASE 为空字符串即可，无需修改。
 * - git 平台托管（GitHub Pages / Gitee Pages）：把本文件中 API_BASE 改为
 *   后端 API 的完整地址，例如 'https://api.example.com'，
 *   并确保后端 .env 的 CORS_ORIGINS 包含 Pages 域名、SESSION_CROSS_SITE=true。
 */
window.HUB_CONFIG = {
  API_BASE: '',
};
