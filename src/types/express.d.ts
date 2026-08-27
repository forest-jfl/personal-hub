import 'express-session';
import { Role } from '../models/types';

declare module 'express-session' {
  interface SessionData {
    userId?: number;
    username?: string;
    role?: Role;
  }
}
