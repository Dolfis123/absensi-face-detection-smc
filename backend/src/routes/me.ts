import fs from 'fs';
import { Request, Router } from 'express';
import { Op } from 'sequelize';
import { z } from 'zod';
import { currentUser, requireRole } from '../middleware/auth';
import { leaveAttachmentUpload } from '../middleware/upload';
import { AttendanceIssue, DisciplineLetter, DocumentReceipt, EmployeeSchedule, Holiday, LEAVE_TYPES, LeaveRequest, PayrollPublication, Shift } from '../models';
import { LETTER_TITLE } from '../services/discipline';
import type { PayRow } from '../services/payroll';
import { PayrollMeta, sendPayrollPdf } from '../services/payrollPdf';
import { fmtMonth } from '../services/pdfReport';
import { markOpened, markReceived, sendLetterPdf } from '../services/receipts';
import { getPosts, postLabel } from '../services/placement';
import { buildRecap } from '../services/recapService';
import { ah, HttpError } from '../utils/http';
import { addDays, DATE_RE, MONTH_RE, monthRange, witNow } from '../utils/time';

/** Menu pribadi karyawan parkir (setelah login). */
const router = Router();
// Koordinator juga absen, jadi ikut punya menu pribadi (rekap, jadwal, izin, kendala)
router.use(requireRole('KARYAWAN', 'KOORDINATOR'));

router.get(
  '/recap',
  ah(async (req, res) => {
    const month = z.string().regex(MONTH_RE).default(witNow().date.slice(0, 7)).parse(req.query.month);
    const { from, to } = monthRange(month);
    const [recap] = await buildRecap(from, to, [currentUser(req).id]);
    res.json({ month, ...recap });
  }),
);

router.get(
  '/schedule',
  ah(async (req, res) => {
    const today = witNow().date;
    const from = z.string().regex(DATE_RE).default(today).parse(req.query.from);
    const to = z.string().regex(DATE_RE).default(addDays(today, 13)).parse(req.query.to);
    const [schedules, holidays, posts] = await Promise.all([
      EmployeeSchedule.findAll({
        where: { userId: currentUser(req).id, date: { [Op.between]: [from, to] } },
        include: [{ model: Shift, as: 'shift' }],
        order: [['date', 'ASC']],
      }),
      Holiday.findAll({ where: { date: { [Op.between]: [from, to] } } }),
      getPosts(),
    ]);
    res.json({
      from,
      to,
      schedules: schedules.map((s) => ({
        date: s.date,
        off: s.shiftId === null,
        post: postLabel(posts, s.post),
        shift: s.shift && { id: s.shift.id, name: s.shift.name, startTime: s.shift.startTime, endTime: s.shift.endTime },
      })),
      holidays,
    });
  }),
);

router.get(
  '/leaves',
  ah(async (req, res) => {
    const leaves = await LeaveRequest.findAll({
      where: { userId: currentUser(req).id },
      order: [['createdAt', 'DESC']],
    });
    res.json(leaves);
  }),
);

const leaveSchema = z
  .object({
    type: z.enum(LEAVE_TYPES),
    startDate: z.string().regex(DATE_RE),
    endDate: z.string().regex(DATE_RE),
    reason: z.string().trim().min(5, 'Alasan minimal 5 karakter').max(1000),
  })
  .refine((v) => v.endDate >= v.startDate, { message: 'Tanggal selesai harus setelah tanggal mulai', path: ['endDate'] });

router.post(
  '/leaves',
  leaveAttachmentUpload.single('attachment'),
  ah(async (req, res) => {
    const cleanup = () => req.file && fs.promises.unlink(req.file.path).catch(() => undefined);
    try {
      const body = leaveSchema.parse(req.body);
      const user = currentUser(req);
      if (body.type === 'SAKIT' && !req.file) throw new HttpError(400, 'Pengajuan sakit wajib melampirkan surat dokter');
      const overlap = await LeaveRequest.count({
        where: {
          userId: user.id,
          status: { [Op.in]: ['PENDING', 'APPROVED'] },
          startDate: { [Op.lte]: body.endDate },
          endDate: { [Op.gte]: body.startDate },
        },
      });
      if (overlap) throw new HttpError(409, 'Sudah ada pengajuan lain pada rentang tanggal tersebut');
      const leave = await LeaveRequest.create({
        ...body,
        userId: user.id,
        attachmentPath: req.file?.filename ?? null,
        reviewedById: null,
        reviewedAt: null,
        reviewNote: null,
      });
      res.status(201).json(leave);
    } catch (err) {
      await cleanup();
      throw err;
    }
  }),
);

router.get(
  '/issues',
  ah(async (req, res) => {
    res.json(
      await AttendanceIssue.findAll({ where: { userId: currentUser(req).id }, order: [['createdAt', 'DESC']] }),
    );
  }),
);

router.post(
  '/issues',
  ah(async (req, res) => {
    const body = z
      .object({ date: z.string().regex(DATE_RE), description: z.string().trim().min(10).max(1000) })
      .parse(req.body);
    if (body.date > witNow().date) throw new HttpError(400, 'Tanggal kendala tidak boleh di masa depan');
    const issue = await AttendanceIssue.create({
      ...body,
      userId: currentUser(req).id,
      reviewedById: null,
      reviewNote: null,
    });
    res.status(201).json(issue);
  }),
);

// ─────────────── Surat & slip saya (tanda terima digital) ───────────────
router.get(
  '/documents',
  ah(async (req, res) => {
    const me = currentUser(req);
    const [letters, pubs] = await Promise.all([
      DisciplineLetter.findAll({ where: { userId: me.id, voidedAt: null }, order: [['letterDate', 'DESC'], ['id', 'DESC']] }),
      PayrollPublication.findAll({ where: { withdrawnAt: null }, order: [['month', 'DESC']], limit: 24 }),
    ]);
    const mine = pubs
      .map((p) => ({ p, row: (p.rows as PayRow[]).find((r) => r.user.id === me.id) }))
      .filter((x): x is { p: PayrollPublication; row: PayRow } => !!x.row);
    const receipts = await DocumentReceipt.findAll({
      where: {
        userId: me.id,
        [Op.or]: [
          { kind: 'LETTER', refId: letters.map((l) => l.id).concat(0) },
          { kind: 'SLIP', refId: mine.map((x) => x.p.id).concat(0) },
        ],
      },
    });
    const rec = (kind: string, refId: number, version: number) => receipts.find((r) => r.kind === kind && r.refId === refId && r.version === version);
    const out = {
      letters: letters.map((l) => {
        const r = rec('LETTER', l.id, 1);
        return { id: l.id, type: l.type, title: LETTER_TITLE[l.type], number: l.number, letterDate: l.letterDate, openedAt: r?.openedAt ?? null, receivedAt: r?.receivedAt ?? null };
      }),
      slips: mine.map(({ p, row }) => {
        const r = rec('SLIP', p.id, p.version);
        return {
          month: p.month,
          monthLabel: fmtMonth(p.month),
          version: p.version,
          publishedAt: p.publishedAt,
          takeHome: row.takeHome,
          totalDeduction: row.totalDeduction,
          totalBonus: row.totalBonus,
          alfa: row.alfa,
          rank: row.rank,
          openedAt: r?.openedAt ?? null,
          receivedAt: r?.receivedAt ?? null,
        };
      }),
    };
    res.json({ ...out, unread: [...out.letters, ...out.slips].filter((d) => !d.receivedAt).length });
  }),
);

async function ownLetter(req: Request) {
  const l = await DisciplineLetter.findByPk(Number(req.params.id));
  if (!l || l.userId !== currentUser(req).id || l.voidedAt) throw new HttpError(404, 'Surat tidak ditemukan');
  return l;
}

router.get(
  '/letters/:id/pdf',
  ah(async (req, res) => {
    const l = await ownLetter(req);
    await markOpened('LETTER', l.id, l.userId, 1, req.get('user-agent'));
    await sendLetterPdf(res, l);
  }),
);

router.post(
  '/letters/:id/receive',
  ah(async (req, res) => {
    const l = await ownLetter(req);
    const r = await markReceived('LETTER', l.id, l.userId, 1, req.get('user-agent'));
    res.json({ receivedAt: r.receivedAt });
  }),
);

async function ownSlip(req: Request) {
  const month = z.string().regex(MONTH_RE).parse(req.params.month);
  const p = await PayrollPublication.findOne({ where: { month, withdrawnAt: null } });
  const row = p && (p.rows as PayRow[]).find((r) => r.user.id === currentUser(req).id);
  if (!p || !row) throw new HttpError(404, 'Slip bulan ini belum diterbitkan');
  return { p, row };
}

router.get(
  '/slips/:month/pdf',
  ah(async (req, res) => {
    const { p, row } = await ownSlip(req);
    await markOpened('SLIP', p.id, row.user.id, p.version, req.get('user-agent'));
    sendPayrollPdf(res, [row], p.meta as unknown as PayrollMeta, `slip-upah_${p.month}.pdf`, 'single');
  }),
);

router.post(
  '/slips/:month/receive',
  ah(async (req, res) => {
    const { p, row } = await ownSlip(req);
    const r = await markReceived('SLIP', p.id, row.user.id, p.version, req.get('user-agent'));
    res.json({ receivedAt: r.receivedAt });
  }),
);

export default router;
