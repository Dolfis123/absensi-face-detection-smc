import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../middleware/auth';
import { SystemAlert } from '../models';
import { dailySummaryText, discoverChats, getChats, lastResult, runChecks, saveChats, sendTelegram, telegramConfigured } from '../services/systemMonitor';
import { ah, HttpError } from '../utils/http';

/** Kesehatan sistem & peringatan otomatis — khusus Super Admin. */
const router = Router();
router.use(requireRole('SUPER_ADMIN'));

const status = async () => ({
  checks: lastResult() ?? (await runChecks()),
  telegram: { configured: telegramConfigured(), chats: await getChats() },
  active: await SystemAlert.findAll({ where: { active: true }, order: [['level', 'ASC'], ['firstAt', 'DESC']] }),
  history: await SystemAlert.findAll({ order: [['firstAt', 'DESC']], limit: 50 }),
});

router.get('/status', ah(async (_req, res) => res.json(await status())));

router.get(
  '/alerts/active',
  ah(async (_req, res) => {
    res.json(await SystemAlert.findAll({ where: { active: true }, attributes: ['id', 'key', 'level', 'title'] }));
  }),
);

router.post(
  '/check-now',
  ah(async (_req, res) => {
    await runChecks();
    res.json(await status());
  }),
);

router.get(
  '/telegram/discover',
  ah(async (_req, res) => {
    try {
      res.json(await discoverChats());
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  }),
);

router.put(
  '/telegram/chats',
  ah(async (req, res) => {
    const chats = z.array(z.object({ id: z.string().regex(/^-?\d{1,20}$/), name: z.string().trim().min(1).max(100) })).max(10).parse(req.body);
    await saveChats(chats);
    res.json(chats);
  }),
);

router.post(
  '/telegram/test',
  ah(async (req, res) => {
    if (!telegramConfigured()) throw new HttpError(400, 'TELEGRAM_BOT_TOKEN belum diisi di backend/.env');
    const kind = z.object({ kind: z.enum(['test', 'summary']).default('test') }).parse(req.body ?? {}).kind;
    const text = kind === 'summary' ? await dailySummaryText() : '✅ <b>Uji peringatan SMC-FaceAttend</b>\nPesan ini menandakan peringatan otomatis sudah tersambung.';
    const sent = await sendTelegram(text);
    if (!sent) throw new HttpError(400, 'Belum ada penerima, atau pengiriman gagal. Pilih penerima dulu.');
    res.json({ sent });
  }),
);

export default router;
