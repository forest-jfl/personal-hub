import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import multer from 'multer';
import { requireAuth } from '../middleware/auth';
import { HttpError } from '../middleware/error';
import * as filesRepo from '../repositories/file.repo';
import { config } from '../config';
import { logger } from '../utils/logger';
const router = Router();
router.use(requireAuth);

// 危险扩展名黑名单：即使下载为附件也不允许上传可执行/脚本类文件
const BLOCKED_EXT = new Set([
  '.html', '.htm', '.xhtml', '.svg', '.js', '.mjs', '.cjs', '.css',
  '.exe', '.dll', '.bat', '.cmd', '.com', '.scr', '.msi', '.ps1',
  '.php', '.jsp', '.asp', '.aspx', '.sh', '.py', '.jar', '.vbs', '.wsf',
]);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = path.resolve(config.upload.dir);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const name = crypto.randomBytes(16).toString('hex') + ext;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: config.upload.maxFileSize, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (BLOCKED_EXT.has(ext)) {
      cb(new HttpError(400, `BLOCKED_FILE_TYPE:${ext}`));
      return;
    }
    cb(null, true);
  },
});

router.get('/', async (req, res, next) => {
  try {
    // 管理员可见全部，普通用户仅见自己上传的文件
    const ownerId = req.session!.role === 'admin' ? undefined : req.session!.userId;
    const files = await filesRepo.listFiles(ownerId);
    const quotaBytes = config.upload.quotaPerUserMB * 1024 * 1024;
    // 用量按本人统计（管理员查看全量列表时，用量为全部文件总和）
    const used = files.reduce((sum, f) => sum + Number(f.size || 0), 0);
    res.json({
      files,
      used,
      quota: quotaBytes,
      maxFileSize: config.upload.maxFileSize,
    });
  } catch (e) {
    next(e);
  }
});

// 包装 multer 以便把 multer 错误映射为可读的 HTTP 状态码
function uploadMiddleware(req: any, res: any, next: any) {
  upload.single('file')(req, res, (err: any) => {
    if (!err) return next();
    if (err instanceof HttpError) return next(err);
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(new HttpError(413, 'FILE_TOO_LARGE'));
    }
    logger.warn({ err }, '上传失败');
    next(new HttpError(400, 'UPLOAD_ERROR'));
  });
}

router.post('/', uploadMiddleware, async (req, res, next) => {
  try {
    if (!req.file) throw new HttpError(400, 'NO_FILE');
    // 修复 multer latin1 解码导致的中文名乱码（busboy 默认按 latin1 解码文件名参数）
    const originalName = filesRepo.decodeOriginalName(req.file.originalname);
    // 账号空间配额检查：已用 + 本次文件 ≤ 配额，超出则拒绝并清理临时文件
    const quotaBytes = config.upload.quotaPerUserMB * 1024 * 1024;
    const used = await filesRepo.sumUserUsedBytes(req.session!.userId!);
    if (used + req.file.size > quotaBytes) {
      try {
        fs.unlinkSync(req.file.path);
      } catch { /* 清理失败不影响响应 */ }
      throw new HttpError(403, 'QUOTA_EXCEEDED');
    }
    const meta = await filesRepo.createFile({
      original_name: originalName,
      stored_name: req.file.filename,
      mime: req.file.mimetype,
      size: req.file.size,
      owner_id: req.session!.userId!,
      public_token: crypto.randomBytes(16).toString('hex'),
    });
    res.status(201).json({ file: meta });
  } catch (e) {
    next(e);
  }
});

router.get('/:id/download', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const meta = await filesRepo.getFileById(id);
    if (!meta) throw new HttpError(404, 'FILE_NOT_FOUND');
    const filePath = path.resolve(config.upload.dir, meta.stored_name);
    if (!fs.existsSync(filePath)) throw new HttpError(404, 'FILE_MISSING');
    res.download(filePath, meta.original_name);
  } catch (e) {
    next(e);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const meta = await filesRepo.getFileById(id);
    if (!meta) throw new HttpError(404, 'FILE_NOT_FOUND');
    if (meta.owner_id !== req.session!.userId && req.session!.role !== 'admin')
      throw new HttpError(403, 'FORBIDDEN');
    // 先删数据库记录（事实来源），物理文件尽力删除，失败仅告警不阻断
    await filesRepo.deleteFile(id);
    const filePath = path.resolve(config.upload.dir, meta.stored_name);
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) {
      logger.warn({ err: e, filePath }, '删除物理文件失败（数据库记录已移除）');
    }
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default router;
