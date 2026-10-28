import { Router } from 'express';
import { Op } from 'sequelize';
import { z } from 'zod';
import { currentUser, requireRole } from '../middleware/auth';
import { ATTENDEE_ROLES, EmployeeSchedule, Holiday, SLOT_TYPES, ShiftBreak, ShiftChangeLog, User, sequelize } from '../models';
import { getLateTolerance, saveLateTolerance } from '../services/settings';
import { BreakInput, loadShifts, SlotInput, validateShiftTimes } from '../services/shiftService';
import { ah, HttpError } from '../utils/http';
import { DATE_RE, eachDate, witNow } from '../utils/time';

/**
 * Perencanaan shift: roster harian & pengaturan jam shift.
 * Dipakai Super Admin dan Koordinator Lapangan; setiap perubahan jam shift tercatat
 * di riwayat beserta nama pengubahnya. Dipasang di /api/admin sebelum router admin,
 * path lain diteruskan ke router admin (khusus Super Admin).
 */
const router = Router();
router.use(requireRole('SUPER_ADMIN', 'KOORDINATOR'));

// ─────────────── Roster shift dinamis ───────────────
const rangeQuery = z
  .object({ from: z.string().regex(DATE_RE), to: z.string().regex(DATE_RE) })
  .refine((v) => v.from <= v.to && eachDate(v.from, v.to).length <= 62, { message: 'Rentang maksimal 62 hari' });

router.get(
  '/schedules',
  ah(async (req, res) => {
    const { from, to } = rangeQuery.parse(req.query);
    const [employees, schedules] = await Promise.all([
      User.findAll({ where: { role: [...ATTENDEE_ROLES], isActive: true }, order: [['fullName', 'ASC']] }),
      EmployeeSchedule.findAll({ where: { date: { [Op.between]: [from, to] } } }),
    ]);
    res.json({
      employees: employees.map((u) => ({ id: u.id, fullName: u.fullName, nik: u.nik, role: u.role, defaultShiftId: u.defaultShiftId })),
      schedules: schedules.map((s) => ({ userId: s.userId, date: s.date, shiftId: s.shiftId })),
    });
  }),
);

router.put(
  '/schedules',
  ah(async (req, res) => {
    const { entries } = z
      .object({
        entries: z
          .array(
            z.object({
              userId: z.number().int().positive(),
              date: z.string().regex(DATE_RE),
              shiftId: z.number().int().positive().nullable(),
              // true = hari Off (libur pribadi). shiftId null tanpa off = kosongkan jadwal.
              off: z.boolean().default(false),
            }),
          )
          .max(2000),
      })
      .parse(req.body);
    const today = witNow().date;
    if (entries.some((e) => e.date < today)) {
      throw new HttpError(400, 'Roster tanggal yang sudah lewat tidak dapat diubah (menjaga integritas riwayat)');
    }
    await sequelize.transaction(async (transaction) => {
      for (const e of entries) {
        if (e.off) {
          await EmployeeSchedule.upsert({ userId: e.userId, date: e.date, shiftId: null }, { transaction });
        } else if (e.shiftId === null) {
          await EmployeeSchedule.destroy({ where: { userId: e.userId, date: e.date }, transaction });
        } else {
          await EmployeeSchedule.upsert({ userId: e.userId, date: e.date, shiftId: e.shiftId }, { transaction });
        }
      }
    });
    res.json({ updated: entries.length });
  }),
);

/** Mengisi hari yang masih kosong dengan shift default masing-masing karyawan. */
router.post(
  '/schedules/fill-default',
  ah(async (req, res) => {
    const { from, to } = rangeQuery.parse(req.body);
    const today = witNow().date;
    const dates = eachDate(from < today ? today : from, to);
    const [employees, existing, holidays] = await Promise.all([
      User.findAll({ where: { role: [...ATTENDEE_ROLES], isActive: true } }),
      EmployeeSchedule.findAll({ where: { date: { [Op.between]: [from, to] } } }),
      Holiday.findAll({ where: { date: { [Op.between]: [from, to] } } }),
    ]);
    const taken = new Set(existing.map((s) => `${s.userId}|${s.date}`));
    const holidaySet = new Set(holidays.map((h) => h.date));
    const rows = employees.flatMap((u) =>
      u.defaultShiftId
        ? dates
            .filter((d) => !holidaySet.has(d) && !taken.has(`${u.id}|${d}`))
            .map((date) => ({ userId: u.id, date, shiftId: u.defaultShiftId! }))
        : [],
    );
    await EmployeeSchedule.bulkCreate(rows);
    res.json({ created: rows.length });
  }),
);

// ─────────────── Pengaturan shift & jam absensi ───────────────
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Format jam harus HH:MM');
const snapshot = (startTime: string, endTime: string, slots: SlotInput[], b: BreakInput | null) => ({
  startTime,
  endTime,
  slots: slots.map(({ type, windowStart, windowEnd }) => ({ type, windowStart, windowEnd })),
  break: b && {
    enabled: b.enabled,
    windowStart: b.windowStart,
    windowEnd: b.windowEnd,
    maxMinutes: b.maxMinutes,
    toleranceMinutes: b.toleranceMinutes,
  },
});
const breakSchema = z.object({
  enabled: z.boolean(),
  windowStart: hhmm,
  windowEnd: hhmm,
  maxMinutes: z.number().int().min(5, 'Durasi istirahat minimal 5 menit').max(240),
  toleranceMinutes: z.number().int().min(0).max(120),
});

router.get(
  '/shift-settings',
  ah(async (_req, res) => {
    const [shifts, logs] = await Promise.all([
      loadShifts(),
      ShiftChangeLog.findAll({
        include: [{ model: User, as: 'actor', attributes: ['id', 'fullName'] }],
        order: [['createdAt', 'DESC']],
        limit: 50,
      }),
    ]);
    res.json({ shifts: [...shifts.values()], lateToleranceMinutes: getLateTolerance(), logs });
  }),
);

router.put(
  '/shifts/:id',
  ah(async (req, res) => {
    const body = z
      .object({
        startTime: hhmm,
        endTime: hhmm,
        slots: z.array(z.object({ type: z.enum(SLOT_TYPES), windowStart: hhmm, windowEnd: hhmm })).min(1),
        break: breakSchema,
      })
      .parse(req.body);
    const shift = (await loadShifts()).get(Number(req.params.id));
    if (!shift) throw new HttpError(404, 'Shift tidak ditemukan');
    if (body.slots.length !== shift.slots.length || shift.slots.some((s, i) => body.slots[i].type !== s.type)) {
      throw new HttpError(400, 'Jenis dan urutan slot absen tidak boleh diubah, hanya jamnya');
    }
    const problem = validateShiftTimes(shift.name, body.startTime, body.endTime, body.slots, getLateTolerance(), body.break);
    if (problem) throw new HttpError(400, problem);

    const before = snapshot(shift.startTime, shift.endTime, shift.slots, shift.breakConfig);
    const after = snapshot(body.startTime, body.endTime, body.slots, body.break);
    if (JSON.stringify(before) === JSON.stringify(after)) return res.json({ changed: false });

    await sequelize.transaction(async (transaction) => {
      await shift.update({ startTime: body.startTime, endTime: body.endTime }, { transaction });
      for (const [i, slot] of shift.slots.entries()) {
        await slot.update({ windowStart: body.slots[i].windowStart, windowEnd: body.slots[i].windowEnd }, { transaction });
      }
      await ShiftBreak.upsert({ shiftId: shift.id, ...body.break }, { transaction });
      await ShiftChangeLog.create({ actorId: currentUser(req).id, target: shift.name, before, after }, { transaction });
    });
    res.json({ changed: true });
  }),
);

router.put(
  '/settings/late-tolerance',
  ah(async (req, res) => {
    const { minutes } = z.object({ minutes: z.number().int().min(0).max(240) }).parse(req.body);
    // Toleransi baru tidak boleh membuat jendela Masuk bertabrakan dengan slot berikutnya di shift mana pun
    for (const s of (await loadShifts()).values()) {
      const problem = validateShiftTimes(s.name, s.startTime, s.endTime, s.slots, minutes, s.breakConfig);
      if (problem) throw new HttpError(400, problem);
    }
    if (minutes !== getLateTolerance()) await saveLateTolerance(minutes, currentUser(req).id);
    res.json({ lateToleranceMinutes: getLateTolerance() });
  }),
);


export default router;
