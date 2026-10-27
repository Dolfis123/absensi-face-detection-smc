import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { env } from '../config/env';
import { HttpError } from '../utils/http';

export const leaveUploadDir = path.resolve(env.uploadDir, 'leaves');
fs.mkdirSync(leaveUploadDir, { recursive: true });

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};

export const leaveAttachmentUpload = multer({
  storage: multer.diskStorage({
    destination: leaveUploadDir,
    filename: (_req, file, cb) => cb(null, `${randomUUID()}${EXT[file.mimetype]}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED.has(file.mimetype)) return cb(new HttpError(400, 'Lampiran harus JPG, PNG, WEBP, atau PDF'));
    cb(null, true);
  },
});
