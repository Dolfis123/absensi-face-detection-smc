import fs from 'fs';
import { Router } from 'express';
import { Op } from 'sequelize';
import { z } from 'zod';
import { currentUser, requireRole } from '../middleware/auth';
import { leaveAttachmentUpload } from '../middleware/upload';
import { AttendanceIssue, EmployeeSchedule, Holiday, LEAVE_TYPES, LeaveRequest, Shift } from '../models';
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
    const [schedules, holidays] = await Promise.all([
      EmployeeSchedule.findAll({
        where: { userId: currentUser(req).id, date: { [Op.between]: [from, to] } },
        include: [{ model: Shift, as: 'shift' }],
        order: [['date', 'ASC']],
      }),
      Holiday.findAll({ where: { date: { [Op.between]: [from, to] } } }),
    ]);
    res.json({
      from,
      to,
      schedules: schedules.map((s) => ({
        date: s.date,
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

export default router;
