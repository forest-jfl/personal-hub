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

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = path.resolve(config.upload.dir);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = crypto.randomBytes(16).toString('hex') + ext;
    cb(null, name);
  },
});

const upload = multer({ storage, limits: { fileSize: config.upload.maxFileSize } });

router.get('/', async (_req, res, next) => {
  try {
    res.json({ files: await filesRepo.listFiles() });
  } catch (e) {
    next(e);
  }
});

router.post('/', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) throw new HttpError(400, 'NO_FILE');
    const meta = await filesRepo.createFile({
      original_name: req.file.originalname,
      stored_name: req.file.filename,
      mime: req.file.mimetype,
      size: req.file.size,
      owner_id: req.session!.userId!,
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
