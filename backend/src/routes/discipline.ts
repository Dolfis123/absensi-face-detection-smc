import { Router } from 'express';
import { Op } from 'sequelize';
import { z } from 'zod';
import { currentUser, requireRole } from '../middleware/auth';
import { DisciplineLetter, LETTER_TYPES, sequelize, User } from '../models';
import {
  analyzeAlfa,
  DisciplineSettings,
  getDisciplineSettings,
  LETTER_TITLE,
  letterNumber,
  recommend,
  WARNING_AT,
  WarningType,
} from '../services/discipline';
import { receiptsFor, sendLetterPdf } from '../services/receipts';
import { buildRecap } from '../services/recapService';
import { ah, HttpError } from '../utils/http';
import { addDays, DATE_RE, witNow } from '../utils/time';

/**
 * Disiplin kehadiran (mangkir) — PKWT Pasal 8. Untuk Koordinator & Super Admin:
 * daftar karyawan yang Alfa beserta saran tindakan, serta penerbitan surat peringatan/panggilan.
 */
const router = Router();
router.use(requireRole('SUPER_ADMIN', 'KOORDINATOR'));

const POSITION: Record<string, string> = { KARYAWAN: 'Petugas Parkir', KOORDINATOR: 'Koordinator Lapangan' };
const LOOKBACK_DAYS = 45;

/** Analisis Alfa semua karyawan aktif + saran tindakan; dipakai daftar & lonceng. */
export async function overview() {
  const now = witNow();
  const month = now.date.slice(0, 7);
  const [recap, letters] = await Promise.all([
    buildRecap(addDays(now.date, -LOOKBACK_DAYS), now.date),
    DisciplineLetter.findAll({ where: { voidedAt: null }, order: [['letterDate', 'ASC'], ['id', 'ASC']] }),
  ]);
  const active = new Set((await User.findAll({ where: { isActive: true }, attributes: ['id'] })).map((u) => u.id));
  return recap
    .filter((r) => active.has(r.user.id))
    .map((r) => {
      const a = analyzeAlfa(r.days, month);
      const mine = letters.filter((l) => l.userId === r.user.id);
      return {
        user: { id: r.user.id, fullName: r.user.fullName, nik: r.user.nik, role: r.user.role, phone: r.user.phone },
        ...a,
        recommendation: recommend(a, mine, month, now.date),
        letters: mine.filter((l) => l.letterDate >= addDays(now.date, -LOOKBACK_DAYS)).map((l) => ({ id: l.id, type: l.type, number: l.number, letterDate: l.letterDate })),
      };
    })
    .filter((r) => r.monthCount > 0 || r.streak > 0)
    .sort((x, y) => y.streak - x.streak || y.monthCount - x.monthCount);
}

router.get(
  '/overview',
  ah(async (_req, res) => {
    const rows = await overview();
    res.json({ rows, needAction: rows.filter((r) => r.recommendation).length });
  }),
);

router.get(
  '/letters',
  ah(async (_req, res) => {
    const letters = await DisciplineLetter.findAll({ order: [['letterDate', 'DESC'], ['id', 'DESC']], limit: 300 });
    const users = await User.findAll({ where: { id: [...new Set(letters.flatMap((l) => [l.userId, l.createdById]))] }, attributes: ['id', 'fullName', 'nik'] });
    const name = new Map(users.map((u) => [u.id, u]));
    const receipts = await receiptsFor('LETTER', letters.map((l) => l.id), 1);
    res.json(
      letters.map((l) => ({
        ...l.toJSON(),
        openedAt: receipts.get(`${l.id}|${l.userId}|1`)?.openedAt ?? null,
        receivedAt: receipts.get(`${l.id}|${l.userId}|1`)?.receivedAt ?? null,
        title: LETTER_TITLE[l.type],
        employee: name.get(l.userId)?.fullName ?? '?',
        nik: name.get(l.userId)?.nik ?? '',
        createdBy: name.get(l.createdById)?.fullName ?? '?',
      })),
    );
  }),
);

/** Nomor urut berikutnya: setelah nomor tertinggi dari surat yang masih berlaku (surat dibatalkan tidak dihitung). */
async function nextSeq(year: number) {
  const max = (await DisciplineLetter.max<number, DisciplineLetter>('seq', { where: { year, voidedAt: null } })) ?? 0;
  return max + 1;
}

/** Usulan nomor surat untuk formulir (bisa diubah sebelum diterbitkan). */
router.get(
  '/next-number',
  ah(async (req, res) => {
    const q = z.object({ date: z.string().regex(DATE_RE), type: z.enum(LETTER_TYPES), seq: z.coerce.number().int().min(1).max(9999).optional() }).parse(req.query);
    const year = Number(q.date.slice(0, 4));
    const seq = q.seq ?? (await nextSeq(year));
    const used = await DisciplineLetter.findOne({ where: { year, seq, voidedAt: null }, attributes: ['number'] });
    res.json({ seq, number: letterNumber(seq, q.type, await getDisciplineSettings(), q.date), usedBy: used?.number ?? null });
  }),
);

router.post(
  '/letters',
  ah(async (req, res) => {
    const body = z
      .object({
        userId: z.number().int().positive(),
        type: z.enum(LETTER_TYPES),
        letterDate: z.string().regex(DATE_RE).optional(),
        reportDate: z.string().regex(DATE_RE).optional(),
        reportTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Format jam HH:MM').optional(),
        reportPlace: z.string().trim().max(150).optional(),
        note: z.string().trim().max(500).optional(),
        // Nomor urut pilihan sendiri (mis. mengisi nomor surat yang salah cetak lalu dibatalkan)
        seq: z.number().int().min(1).max(9999).optional(),
      })
      .parse(req.body);
    const now = witNow();
    const letterDate = body.letterDate ?? now.date;
    if (letterDate > now.date) throw new HttpError(400, 'Tanggal surat tidak boleh di masa depan');
    const isCall = body.type.startsWith('PANGGILAN');
    if (isCall && !body.reportDate) throw new HttpError(400, 'Surat panggilan wajib berisi tanggal menghadap');
    if (isCall && body.reportDate! < letterDate) throw new HttpError(400, 'Tanggal menghadap tidak boleh sebelum tanggal surat');

    const user = await User.findByPk(body.userId);
    if (!user || !POSITION[user.role]) throw new HttpError(404, 'Karyawan tidak ditemukan');
    // Tanggal mangkir diambil dari catatan absensi, bukan diketik manual
    const recap = await buildRecap(addDays(letterDate, -LOOKBACK_DAYS), letterDate, [user.id]);
    const a = analyzeAlfa(recap[0]?.days ?? [], letterDate.slice(0, 7));
    const alfaDates = isCall ? a.streakDates : a.monthDates;
    if (alfaDates.length === 0) throw new HttpError(409, `${user.fullName} tidak tercatat mangkir${isCall ? ' berturut-turut' : ' bulan ini'} sampai ${letterDate}`);
    if (isCall && a.streak < 5) throw new HttpError(409, `Surat panggilan untuk mangkir ≥ 5 hari kerja berturut-turut (sekarang ${a.streak} hari)`);
    // Surat peringatan baru boleh terbit setelah Alfa mencapai batasnya dalam bulan itu (3× / 5× / 8×)
    if (!isCall) {
      const need = WARNING_AT[body.type as WarningType];
      if (a.monthCount < need) throw new HttpError(409, `${LETTER_TITLE[body.type]} diterbitkan setelah Alfa ${need}× dalam sebulan (${user.fullName} baru ${a.monthCount}× bulan ini)`);
    }
    if (body.type === 'PANGGILAN_2') {
      const p1 = await DisciplineLetter.findOne({ where: { userId: user.id, type: 'PANGGILAN_1', voidedAt: null, letterDate: { [Op.gte]: a.streakDates[0] } } });
      if (!p1) throw new HttpError(409, 'Terbitkan Surat Panggilan Pertama lebih dulu untuk rangkaian mangkir ini');
      if (p1.reportDate && letterDate < p1.reportDate) {
        throw new HttpError(409, `Surat Panggilan Kedua diterbitkan setelah tanggal menghadap Panggilan Pertama (${p1.reportDate}) lewat`);
      }
    }

    const settings = await getDisciplineSettings();
    const letter = await sequelize.transaction(async (transaction) => {
      const year = Number(letterDate.slice(0, 4));
      const seq = body.seq ?? (await nextSeq(year));
      const taken = await DisciplineLetter.findOne({ where: { year, seq, voidedAt: null }, transaction });
      if (taken) throw new HttpError(409, `Nomor urut ${String(seq).padStart(3, '0')} tahun ${year} sudah dipakai surat ${taken.number}`);
      return DisciplineLetter.create(
        {
          userId: user.id,
          type: body.type,
          year,
          seq,
          number: letterNumber(seq, body.type, settings, letterDate),
          letterDate,
          alfaDates,
          reportDate: isCall ? body.reportDate! : null,
          reportTime: isCall ? (body.reportTime ?? null) : null,
          reportPlace: isCall ? body.reportPlace || settings.defaultReportPlace : null,
          note: body.note || null,
          createdById: currentUser(req).id,
          voidReason: null,
          voidedById: null,
          voidedAt: null,
        },
        { transaction },
      );
    });
    res.status(201).json(letter);
  }),
);

router.get(
  '/letters/:id/pdf',
  ah(async (req, res) => {
    const l = await DisciplineLetter.findByPk(Number(req.params.id));
    if (!l) throw new HttpError(404, 'Surat tidak ditemukan');
    await sendLetterPdf(res, l);
  }),
);

router.patch(
  '/letters/:id/void',
  requireRole('SUPER_ADMIN'),
  ah(async (req, res) => {
    const { reason } = z.object({ reason: z.string().trim().min(5, 'Tulis alasan pembatalan').max(300) }).parse(req.body);
    const l = await DisciplineLetter.findByPk(Number(req.params.id));
    if (!l) throw new HttpError(404, 'Surat tidak ditemukan');
    if (l.voidedAt) throw new HttpError(409, 'Surat ini sudah dibatalkan');
    await l.update({ voidReason: reason, voidedById: currentUser(req).id, voidedAt: new Date() });
    res.json({ ok: true });
  }),
);

router.get(
  '/settings',
  ah(async (_req, res) => {
    res.json(await getDisciplineSettings());
  }),
);

export default router;
