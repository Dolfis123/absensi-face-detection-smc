import path from 'path';
import { Router } from 'express';
import { Op } from 'sequelize';
import { z } from 'zod';
import { currentUser, requireRole } from '../middleware/auth';
import { leaveUploadDir } from '../middleware/upload';
import { AttendanceIssue, Holiday, LeaveRequest, Shift, ShiftSlot, User } from '../models';
import { sendCsv } from '../services/csv';
import { buildRecap } from '../services/recapService';
import { getLateTolerance } from '../services/settings';
import { ah, HttpError } from '../utils/http';
import { DATE_RE, MONTH_RE, monthRange, witNow } from '../utils/time';

/** Fitur bersama Koordinator Lapangan & Super Admin. */
const router = Router();
const reviewers = requireRole('KOORDINATOR', 'SUPER_ADMIN');

const userBrief = ['id', 'fullName', 'nik'];

// ─── Data referensi (semua role yang login) ───
router.get(
  '/shifts',
  ah(async (_req, res) => {
    res.json(
      await Shift.findAll({
        include: [{ model: ShiftSlot, as: 'slots' }],
        order: [
          ['id', 'ASC'],
          [{ model: ShiftSlot, as: 'slots' }, 'sortOrder', 'ASC'],
        ],
      }),
    );
  }),
);

router.get('/settings', (_req, res) => {
  res.json({ lateToleranceMinutes: getLateTolerance() });
});

router.get(
  '/holidays',
  ah(async (req, res) => {
    const year = z.string().regex(/^\d{4}$/).default(witNow().date.slice(0, 4)).parse(req.query.year);
    res.json(
      await Holiday.findAll({
        where: { date: { [Op.between]: [`${year}-01-01`, `${year}-12-31`] } },
        order: [['date', 'ASC']],
      }),
    );
  }),
);

// Lampiran izin: pemilik pengajuan atau peninjau
router.get(
  '/leaves/:id/attachment',
  ah(async (req, res) => {
    const leave = await LeaveRequest.findByPk(Number(req.params.id));
    const user = currentUser(req);
    if (!leave || !leave.attachmentPath) throw new HttpError(404, 'Lampiran tidak ditemukan');
    if (leave.userId !== user.id && user.role === 'KARYAWAN') throw new HttpError(403, 'Akses ditolak');
    res.sendFile(path.join(leaveUploadDir, path.basename(leave.attachmentPath)));
  }),
);

// ─── Monitoring real-time ───
router.get(
  '/monitor/today',
  reviewers,
  ah(async (_req, res) => {
    const now = witNow();
    const recap = await buildRecap(now.date, now.date);
    res.json({
      serverTime: now,
      rows: recap.map((r) => ({ user: r.user, ...r.days[0] })),
    });
  }),
);

const rangeQuery = z.object({ from: z.string().regex(DATE_RE), to: z.string().regex(DATE_RE) }).refine(
  (v) => v.from <= v.to,
  { message: 'Rentang tanggal tidak valid' },
);

router.get(
  '/monitor/recap',
  reviewers,
  ah(async (req, res) => {
    const { from, to } = rangeQuery.parse(req.query);
    res.json(await buildRecap(from, to));
  }),
);

// ─── Laporan CSV ───
const STATUS_LABEL: Record<string, string> = {
  TEPAT_WAKTU: 'Tepat Waktu',
  TERLAMBAT: 'Terlambat',
  ALFA: 'Alfa',
  IZIN: 'Izin',
  SAKIT: 'Sakit',
  CUTI: 'Cuti',
  LIBUR: 'Libur',
  OFF: 'Tidak Dijadwalkan',
  BELUM: 'Belum Absen',
};

router.get(
  '/reports/detail.csv',
  reviewers,
  ah(async (req, res) => {
    const { from, to } = rangeQuery.parse(req.query);
    const recap = await buildRecap(from, to);
    const rows = recap.flatMap((r) =>
      r.days
        .filter((d) => d.status !== 'OFF')
        .map((d) => [
          d.date,
          r.user.nik,
          r.user.fullName,
          d.shiftName ?? '-',
          STATUS_LABEL[d.status],
          d.slots.MASUK?.time ?? '',
          d.slots.ISTIRAHAT?.time ?? '',
          d.slots.PULANG?.time ?? '',
          d.note ?? '',
        ]),
    );
    sendCsv(
      res,
      `absensi-detail_${from}_${to}.csv`,
      ['Tanggal', 'NIK', 'Nama', 'Shift', 'Status', 'Masuk', 'Istirahat', 'Pulang', 'Keterangan'],
      rows,
    );
  }),
);

/** Rekap bulanan resmi untuk Manager Mal SMC (khusus Super Admin). */
router.get(
  '/reports/monthly.csv',
  requireRole('SUPER_ADMIN'),
  ah(async (req, res) => {
    const month = z.string().regex(MONTH_RE).parse(req.query.month);
    const { from, to } = monthRange(month);
    const recap = await buildRecap(from, to);
    sendCsv(
      res,
      `rekap-bulanan-SMC_${month}.csv`,
      ['NIK', 'Nama', 'Hari Kerja', 'Hadir', 'Tepat Waktu', 'Terlambat', 'Izin', 'Sakit', 'Cuti', 'Alfa', 'Libur'],
      recap.map(({ user, summary: s }) => [
        user.nik,
        user.fullName,
        s.hariKerja,
        s.hadir,
        s.tepatWaktu,
        s.terlambat,
        s.izin,
        s.sakit,
        s.cuti,
        s.alfa,
        s.libur,
      ]),
    );
  }),
);

// ─── Peninjauan izin / sakit / cuti ───
router.get(
  '/leaves',
  reviewers,
  ah(async (req, res) => {
    const status = z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional().parse(req.query.status);
    res.json(
      await LeaveRequest.findAll({
        where: status ? { status } : {},
        include: [
          { model: User, as: 'user', attributes: userBrief },
          { model: User, as: 'reviewedBy', attributes: userBrief },
        ],
        order: [['createdAt', 'DESC']],
        limit: 200,
      }),
    );
  }),
);

router.patch(
  '/leaves/:id',
  reviewers,
  ah(async (req, res) => {
    const body = z
      .object({ decision: z.enum(['APPROVED', 'REJECTED']), note: z.string().trim().max(500).optional() })
      .parse(req.body);
    const leave = await LeaveRequest.findByPk(Number(req.params.id));
    if (!leave) throw new HttpError(404, 'Pengajuan tidak ditemukan');
    if (leave.status !== 'PENDING') throw new HttpError(409, 'Pengajuan ini sudah diputuskan');
    if (body.decision === 'REJECTED' && !body.note) throw new HttpError(400, 'Alasan penolakan wajib diisi');
    await leave.update({
      status: body.decision,
      reviewNote: body.note ?? null,
      reviewedById: currentUser(req).id,
      reviewedAt: new Date(),
    });
    res.json(leave);
  }),
);

// ─── Laporan kendala absensi ───
router.get(
  '/issues',
  reviewers,
  ah(async (_req, res) => {
    res.json(
      await AttendanceIssue.findAll({
        include: [
          { model: User, as: 'user', attributes: userBrief },
          { model: User, as: 'reviewedBy', attributes: userBrief },
        ],
        order: [['createdAt', 'DESC']],
        limit: 200,
      }),
    );
  }),
);

router.patch(
  '/issues/:id',
  reviewers,
  ah(async (req, res) => {
    const body = z
      .object({
        status: z.enum(['REVIEWED', 'ESCALATED', 'RESOLVED', 'REJECTED']),
        note: z.string().trim().min(3).max(1000),
      })
      .parse(req.body);
    const issue = await AttendanceIssue.findByPk(Number(req.params.id));
    if (!issue) throw new HttpError(404, 'Laporan tidak ditemukan');
    await issue.update({ status: body.status, reviewNote: body.note, reviewedById: currentUser(req).id });
    res.json(issue);
  }),
);

export default router;
