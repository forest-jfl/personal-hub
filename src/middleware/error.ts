import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { logger } from '../utils/logger';

/** 带 HTTP 状态码的错误。 */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function notFound(_req: Request, res: Response) {
  res.status(404).json({ error: 'NOT_FOUND' });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  const status = err.status ?? err.statusCode ?? 500;
  if (status >= 500) {
    logger.error({ err, path: _req.path }, '未处理的服务端错误');
  }
  const message =
    status >= 500 && config.env === 'production' ? '内部服务器错误' : err.message || '错误';
  res.status(status).json({ error: message });
}
