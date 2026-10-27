import bcrypt from 'bcryptjs';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { currentUser, requireAuth, signToken } from '../middleware/auth';
import { User } from '../models';
import { ah, HttpError } from '../utils/http';

const router = Router();

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

router.post(
  '/login',
  loginLimiter,
  ah(async (req, res) => {
    const { username, password } = z
      .object({ username: z.string().trim().min(1), password: z.string().min(1) })
      .parse(req.body);
    const user = await User.findOne({ where: { username } });
    const valid = user && (await bcrypt.compare(password, user.passwordHash));
    if (!user || !valid) throw new HttpError(401, 'Username atau password salah');
    if (!user.isActive) throw new HttpError(403, 'Akun dinonaktifkan, hubungi Super Admin');
    res.json({ token: signToken(user), user: user.toPublic() });
  }),
);

router.get(
  '/me',
  requireAuth,
  ah(async (req, res) => {
    res.json({ user: currentUser(req).toPublic() });
  }),
);

export default router;
