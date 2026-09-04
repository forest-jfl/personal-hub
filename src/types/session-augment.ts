// express-session 类型扩展（真实模块，由 app.ts 显式 import，
// 确保 ts-node 按需编译时也会加载该增强声明）
import 'express-session';
import { Role } from '../models/types';

declare module 'express-session' {
  interface SessionData {
    userId?: number;
    username?: string;
    role?: Role;
  }
}

export {};
