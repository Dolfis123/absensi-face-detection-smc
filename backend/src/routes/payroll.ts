import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireRole } from '../middleware/auth';
import { ATTENDEE_ROLES, EmployeeWage, PayrollPublication, User } from '../models';
import { getDisciplineSettings } from '../services/discipline';
import { computePayroll, getPayrollSettings, PayrollSettings, savePayrollSettings } from '../services/payroll';
import { PayrollMeta, sendCertificatePdf, sendPayrollPdf } from '../services/payrollPdf';
import { fmtMonth } from '../services/pdfReport';
import { receiptsFor } from '../services/receipts';
import { buildRecap } from '../services/recapService';
import { loadShifts } from '../services/shiftService';
import { ah, HttpError } from '../utils/http';
import { MONTH_RE, monthRange, witNow } from '../utils/time';

/** Rekap upah berdasarkan kehadiran — khusus Super Admin. */
const router = Router();
router.use(requireRole('SUPER_ADMIN'));

const defaultWage = (role: string, s: PayrollSettings) => (role === 'KOORDINATOR' ? s.defaultWageKoordinator : s.defaultWageKaryawan);

/** Hitung satu bulan: karyawan aktif + yang punya jadwal di bulan itu (mis. sudah keluar di tengah bulan). */
async function monthData(month: string) {
  const { from, to } = monthRange(month);
  const today = witNow().date;
  const until = to > today ? today : to;
  if (from > today) throw new HttpError(400, 'Bulan tersebut belum berjalan');
  const [s, wages, recap, shifts, kop] = await Promise.all([getPayrollSettings(), EmployeeWage.findAll(), buildRecap(from, until), loadShifts(), getDisciplineSettings()]);
  const active = new Set((await User.findAll({ where: { isActive: true }, attributes: ['id'] })).map((u) => u.id));
  const wageOf = new Map(wages.map((w) => [w.userId, w.baseWage]));
  const inputs = recap
    .filter((r) => active.has(r.user.id) || r.summary.hariKerja > 0)
    .map((r) => ({ user: { id: r.user.id, fullName: r.user.fullName, nik: r.user.nik, role: r.user.role }, baseWage: wageOf.get(r.user.id) ?? defaultWage(r.user.role, s), summary: r.summary, days: r.days }));
  const rows = computePayroll(inputs, s, new Map([...shifts.values()].map((sh) => [sh.id, sh.startTime])));
  const meta = (printedBy: string): PayrollMeta => ({ monthLabel: fmtMonth(month), until: to > today ? today : null, settings: s, kop, printedBy, printedAt: today });
  return { rows, settings: s, meta, until, partial: to > today };
}

const monthParam = (v: unknown) => z.string().regex(MONTH_RE, 'Format bulan YYYY-MM').parse(v);

/** Status terbitan slip bulan ini + siapa saja yang sudah menerima (versi terbaru). */
async function publicationInfo(month: string) {
  const pub = await PayrollPublication.findOne({ where: { month } });
  if (!pub) return null;
  const rec = await receiptsFor('SLIP', [pub.id], pub.version);
  const received: Record<number, string> = {};
  for (const r of rec.values()) if (r.receivedAt) received[r.userId] = r.receivedAt.toISOString();
  return { id: pub.id, version: pub.version, publishedAt: pub.publishedAt, withdrawnAt: pub.withdrawnAt, total: pub.rows.length, received };
}

router.get(
  '/months/:month',
  ah(async (req, res) => {
    const month = monthParam(req.params.month);
    const { rows, settings, until, partial } = await monthData(month);
    res.json({ rows, settings, until, partial, publication: await publicationInfo(month) });
  }),
);

/**
 * Terbitkan slip ke akun petugas. Yang terlihat petugas adalah salinan saat diterbitkan.
 * Terbit ulang (mis. setelah koreksi absensi) menaikkan versi; petugas diminta konfirmasi lagi.
 */
router.post(
  '/months/:month/publish',
  ah(async (req, res) => {
    const month = monthParam(req.params.month);
    const { rows, meta, partial } = await monthData(month);
    if (partial) throw new HttpError(400, 'Slip hanya bisa diterbitkan setelah bulan selesai');
    if (!rows.length) throw new HttpError(400, 'Tidak ada data upah di bulan ini');
    const snapshot = { rows: rows as unknown[], meta: meta(currentUser(req).fullName) as unknown as Record<string, unknown> };
    const existing = await PayrollPublication.findOne({ where: { month } });
    if (existing) {
      await existing.update({ ...snapshot, version: existing.version + 1, publishedById: currentUser(req).id, publishedAt: new Date(), withdrawnAt: null });
    } else {
      await PayrollPublication.create({ month, version: 1, ...snapshot, publishedById: currentUser(req).id, publishedAt: new Date(), withdrawnAt: null });
    }
    res.json(await publicationInfo(month));
  }),
);

router.post(
  '/months/:month/withdraw',
  ah(async (req, res) => {
    const month = monthParam(req.params.month);
    const pub = await PayrollPublication.findOne({ where: { month } });
    if (!pub || pub.withdrawnAt) throw new HttpError(404, 'Slip bulan ini belum diterbitkan');
    await pub.update({ withdrawnAt: new Date() });
    res.json(await publicationInfo(month));
  }),
);

router.get(
  '/months/:month/pdf',
  ah(async (req, res) => {
    const month = monthParam(req.params.month);
    const { rows, meta } = await monthData(month);
    sendPayrollPdf(res, rows, meta(currentUser(req).fullName), `rekap-upah-kehadiran_${month}.pdf`, 'all');
  }),
);

router.get(
  '/months/:month/slip/:userId',
  ah(async (req, res) => {
    const month = monthParam(req.params.month);
    const { rows, meta } = await monthData(month);
    const row = rows.find((r) => r.user.id === Number(req.params.userId));
    if (!row) throw new HttpError(404, 'Karyawan tidak ditemukan di bulan ini');
    sendPayrollPdf(res, [row], meta(currentUser(req).fullName), `slip-upah_${month}_${row.user.fullName.replace(/[^\w]+/g, '-')}.pdf`, 'single');
  }),
);

router.get(
  '/months/:month/certificate/:userId',
  ah(async (req, res) => {
    const month = monthParam(req.params.month);
    const { rows, meta } = await monthData(month);
    const row = rows.find((r) => r.user.id === Number(req.params.userId));
    if (!row?.rank) throw new HttpError(404, 'Karyawan ini bukan Petugas Terbaik di bulan tersebut');
    sendCertificatePdf(res, row, meta(currentUser(req).fullName), `piagam_${month}_${row.user.fullName.replace(/[^\w]+/g, '-')}.pdf`);
  }),
);

// ── Upah pokok per karyawan ──
router.get(
  '/wages',
  ah(async (_req, res) => {
    const [s, users, wages] = await Promise.all([
      getPayrollSettings(),
      User.findAll({ where: { role: [...ATTENDEE_ROLES], isActive: true }, order: [['fullName', 'ASC']] }),
      EmployeeWage.findAll(),
    ]);
    const wageOf = new Map(wages.map((w) => [w.userId, w.baseWage]));
    res.json(
      users.map((u) => ({
        userId: u.id,
        fullName: u.fullName,
        nik: u.nik,
        role: u.role,
        baseWage: wageOf.get(u.id) ?? defaultWage(u.role, s),
        custom: wageOf.has(u.id),
      })),
    );
  }),
);

router.put(
  '/wages/:userId',
  ah(async (req, res) => {
    const { baseWage } = z.object({ baseWage: z.number().int().min(0).max(1_000_000_000) }).parse(req.body);
    const user = await User.findByPk(Number(req.params.userId));
    if (!user || !(ATTENDEE_ROLES as readonly string[]).includes(user.role)) throw new HttpError(404, 'Karyawan tidak ditemukan');
    await EmployeeWage.upsert({ userId: user.id, baseWage });
    res.json({ ok: true });
  }),
);

// ── Pengaturan ──
router.get(
  '/settings',
  ah(async (_req, res) => {
    res.json(await getPayrollSettings());
  }),
);

router.put(
  '/settings',
  ah(async (req, res) => {
    const money = z.number().int().min(0).max(100_000_000);
    const body: PayrollSettings = z
      .object({
        divisor: z.number().int().min(1).max(31),
        defaultWageKaryawan: money,
        defaultWageKoordinator: money,
        lateDeduction: z.object({ enabled: z.boolean(), perCount: z.number().int().min(1).max(31), days: z.number().int().min(1).max(5) }),
        perfectBonus: z.object({ enabled: z.boolean(), amount: money, allowLeave: z.boolean() }),
        bestEmployee: z.object({ enabled: z.boolean(), count: z.number().int().min(0).max(5), amounts: z.array(money).max(5) }),
      })
      .parse(req.body);
    await savePayrollSettings(body, currentUser(req).id);
    res.json(body);
  }),
);

export default router;
