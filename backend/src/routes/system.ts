import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../middleware/auth';
import { ATTENDEE_ROLES, SystemAlert, TelegramLink, User } from '../models';
import { getNotifySettings, reminderText, runGroupSchedule, saveNotifySettings } from '../services/autoNotify';
import { seenChats, sendTo } from '../services/telegramBot';
import { getTestAccountIds } from '../services/testAccounts';
import { addDays, witNow } from '../utils/time';
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

// ───────────── Pengingat petugas & jadwal grup (Telegram) ─────────────
const notifySchema = z.object({
  reminders: z.object({ enabled: z.boolean(), beforeMinutes: z.number().int().min(5).max(180), lateWarnMinutes: z.number().int().min(1).max(60) }),
  group: z.object({ enabled: z.boolean(), chatId: z.string().regex(/^(-?\d{1,20})?$/), chatName: z.string().trim().max(120), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }),
});

router.get(
  '/notify',
  ah(async (_req, res) => {
    const [settings, links, users, testIds, seen] = await Promise.all([
      getNotifySettings(),
      TelegramLink.findAll(),
      User.findAll({ where: { role: [...ATTENDEE_ROLES], isActive: true }, attributes: ['id', 'fullName', 'role'], order: [['fullName', 'ASC']] }),
      getTestAccountIds(),
      seenChats(),
    ]);
    res.json({
      configured: telegramConfigured(),
      settings,
      employees: users
        .filter((u) => !testIds.has(u.id))
        .map((u) => {
          const l = links.find((x) => x.userId === u.id);
          return { userId: u.id, fullName: u.fullName, role: u.role, linked: !!l, chatName: l?.chatName ?? null, linkedAt: l?.linkedAt ?? null };
        }),
      groups: seen.filter((c) => c.type === 'group' || c.type === 'supergroup').map(({ id, name }) => ({ id, name })),
    });
  }),
);

router.put(
  '/notify',
  ah(async (req, res) => {
    const s = notifySchema.parse(req.body);
    if (s.group.enabled && !s.group.chatId) throw new HttpError(400, 'Pilih grup Telegram tujuan jadwal dulu');
    await saveNotifySettings(s);
    res.json(s);
  }),
);

/** Kirim jadwal besok ke grup sekarang juga (uji / kirim ulang). */
router.post(
  '/notify/group-now',
  ah(async (_req, res) => {
    if (!telegramConfigured()) throw new HttpError(400, 'TELEGRAM_BOT_TOKEN belum diisi di backend/.env');
    const r = await runGroupSchedule(witNow(), true);
    if (r === 'empty') throw new HttpError(400, `Roster ${addDays(witNow().date, 1)} masih kosong, belum ada yang dikirim`);
    if (r !== 'sent') throw new HttpError(400, 'Gagal mengirim. Pastikan grup sudah dipilih dan bot masih menjadi anggota grup.');
    res.json({ sent: true });
  }),
);

/** Kirim contoh pengingat ke satu petugas yang sudah tersambung. */
router.post(
  '/notify/test/:userId',
  ah(async (req, res) => {
    const link = await TelegramLink.findByPk(Number(req.params.userId));
    if (!link) throw new HttpError(404, 'Petugas ini belum menyambungkan Telegram');
    const now = witNow();
    let date = now.date;
    let text = await reminderText(link.userId, date, 'before');
    for (let i = 1; !text && i <= 7; i++) text = await reminderText(link.userId, (date = addDays(now.date, i)), 'before');
    const body = text ? `🧪 <i>Contoh pengingat${date !== now.date ? ` (jadwal ${date})` : ''}</i>\n\n${text}` : '🧪 <i>Contoh pengingat</i>\nTelegram Anda tersambung. Belum ada jadwal kerja dalam 7 hari ke depan.';
    if (!(await sendTo(link.chatId, body))) throw new HttpError(400, 'Gagal mengirim ke Telegram petugas');
    res.json({ sent: true });
  }),
);

router.delete(
  '/notify/link/:userId',
  ah(async (req, res) => {
    await TelegramLink.destroy({ where: { userId: Number(req.params.userId) } });
    res.status(204).end();
  }),
);

export default router;
