import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { Role, User } from '../models';
import { HttpError } from '../utils/http';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

interface TokenPayload {
  sub: number;
  role: Role;
}

export function signToken(user: User): string {
  const payload: TokenPayload = { sub: user.id, role: user.role };
  return jwt.sign(payload, env.jwtSecret, {
    expiresIn: env.jwtExpires as jwt.SignOptions['expiresIn'],
  });
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new HttpError(401, 'Silakan login terlebih dahulu');
    let payload: TokenPayload;
    try {
      payload = jwt.verify(token, env.jwtSecret) as unknown as TokenPayload;
    } catch {
      throw new HttpError(401, 'Sesi berakhir, silakan login ulang');
    }
    const user = await User.findByPk(payload.sub);
    if (!user || !user.isActive) throw new HttpError(401, 'Akun tidak aktif');
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

export const requireRole =
  (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new HttpError(403, 'Anda tidak memiliki akses ke fitur ini'));
    }
    next();
  };

/** Dipakai setelah requireAuth. */
export const currentUser = (req: Request): User => {
  if (!req.user) throw new HttpError(401, 'Silakan login terlebih dahulu');
  return req.user;
};
