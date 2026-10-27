import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { UniqueConstraintError, ValidationError } from 'sequelize';
import { ZodError } from 'zod';
import { HttpError } from '../utils/http';

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ message: err.message, details: err.details });
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    return res.status(400).json({
      message: first ? `${first.path.join('.') || 'input'}: ${first.message}` : 'Input tidak valid',
      details: err.issues,
    });
  }
  if (err instanceof UniqueConstraintError) {
    const field = Object.keys(err.fields ?? {})[0] ?? 'data';
    return res.status(409).json({ message: `Data duplikat (${field}) sudah terdaftar` });
  }
  if (err instanceof ValidationError) {
    return res.status(400).json({ message: err.errors[0]?.message ?? 'Data tidak valid' });
  }
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ message: `Upload gagal: ${err.message}` });
  }
  // Pesan dari trigger MySQL (SIGNAL SQLSTATE '45000')
  const sqlState = (err as { parent?: { sqlState?: string; sqlMessage?: string } })?.parent;
  if (sqlState?.sqlState === '45000') {
    return res.status(403).json({ message: sqlState.sqlMessage });
  }
  console.error(err);
  res.status(500).json({ message: 'Terjadi kesalahan pada server' });
}
