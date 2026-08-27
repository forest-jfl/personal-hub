import { Request, Response, NextFunction } from 'express';
import { ZodSchema } from 'zod';

/** zod 校验请求体；失败返回 400 与字段级错误。 */
export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        details: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    (req as any).body = result.data;
    next();
  };
}
