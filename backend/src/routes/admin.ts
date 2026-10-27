import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { Op, Transaction } from 'sequelize';
import { z } from 'zod';
import { currentUser, requireRole } from '../middleware/auth';
import {
  Attendance,
  AuditLog,
  EmployeeSchedule,
  FaceOverrideLog,
  GeofenceSetting,
  Holiday,
  SLOT_TYPES,
  Shift,
  ShiftBreak,
  ShiftChangeLog,
  User,
  sequelize,
} from '../models';
import { applyCorrection } from '../services/correctionService';
import { getLateTolerance, saveLateTolerance } from '../services/settings';
import { BreakInput, loadShifts, SlotInput, validateShiftTimes } from '../services/shiftService';
import { enrollWithDuplicateCheck, SimilarFace } from '../services/faceEnrollment';
import { assertPinAvailable, hashPin, PIN_RE } from '../services/identity';
import { ah, HttpError } from '../utils/http';
import { DATE_RE, eachDate, witNow } from '../utils/time';

/** Panel Super Admin. */
const router = Router();
router.use(requireRole('SUPER_ADMIN'));

// ─────────────── Data master pengguna ───────────────
const phone = z.string().trim().regex(/^(\+62|62|0)8\d{7,12}$/, 'Nomor HP/WhatsApp tidak valid');
const faceImages = z
  .array(z.string().startsWith('data:image/', 'Format foto wajah tidak valid').max(4_000_000))
  .min(3, 'Ambil minimal 3 foto wajah')
  .max(5, 'Maksimal 5 foto wajah');
// Super Admin tidak bisa dipilih: role ini hanya dibuat sekali oleh bootstrap.
const assignableRole = z.enum(['KARYAWAN', 'KOORDINATOR']);

const createUserSchema = z.object({
  fullName: z.string().trim().min(3).max(120),
  nik: z.string().trim().min(3).max(40),
  username: z.string().trim().min(4).max(50).regex(/^[a-zA-Z0-9._]+$/, 'Username hanya huruf, angka, titik, underscore'),
  password: z.string().min(8, 'Password minimal 8 karakter').max(100),
  role: assignableRole,
  phone,
  defaultShiftId: z.number().int().positive(),
  faceImages: faceImages.optional(),
  similarOverride: z
    .object({
      reason: z.string().trim().min(10, 'Alasan minimal 10 karakter').max(500),
      pin: z.string().regex(PIN_RE, 'PIN harus 4–6 angka'),
      // PIN untuk karyawan mirip yang belum punya PIN, dikunci dengan id karyawan
      otherPins: z.record(z.string(), z.string().regex(PIN_RE, 'PIN harus 4–6 angka')).default({}),
    })
    .optional(),
});
type SimilarOverride = NonNullable<z.infer<typeof createUserSchema>['similarOverride']>;

/**
 * Wajah mirip yang disetujui Super Admin: semua pihak wajib punya PIN unik,
 * dan persetujuan dicatat di face_override_logs.
 */
async function prepareSimilarOverride(similar: SimilarFace[], override: SimilarOverride | undefined, targetId: number | null) {
  if (similar.length === 0 || !override) return null;
  const toSet = new Map<number, string>();
  for (const s of similar) {
    if (s.user.pinHash) continue;
    const pin = override.otherPins[String(s.user.id)];
    if (!pin) throw new HttpError(400, `PIN absen untuk ${s.user.fullName} wajib diisi, karena wajahnya mirip`);
    toSet.set(s.user.id, pin);
  }
  const allNew = [override.pin, ...toSet.values()];
  if (new Set(allNew).size !== allNew.length) throw new HttpError(400, 'PIN tiap karyawan harus berbeda');
  const exclude = [...toSet.keys(), ...(targetId ? [targetId] : [])];
  for (const pin of allNew) await assertPinAvailable(pin, exclude);
  return {
    pinHash: await hashPin(override.pin),
    others: await Promise.all([...toSet].map(async ([id, pin]) => ({ id, pinHash: await hashPin(pin) }))),
  };
}

async function applySimilarOverride(
  prepared: NonNullable<Awaited<ReturnType<typeof prepareSimilarOverride>>>,
  similar: SimilarFace[],
  reason: string,
  actorId: number,
  userId: number,
  transaction: Transaction,
) {
  for (const o of prepared.others) await User.update({ pinHash: o.pinHash }, { where: { id: o.id }, transaction });
  for (const s of similar) {
    await FaceOverrideLog.create({ actorId, userId, similarUserId: s.user.id, distance: s.distance, reason }, { transaction });
  }
}

async function loadEditableUser(id: number) {
  const user = await User.findByPk(id);
  if (!user) throw new HttpError(404, 'Pengguna tidak ditemukan');
  if (user.role === 'SUPER_ADMIN') throw new HttpError(403, 'Akun Super Admin bersifat permanen dan tidak dapat diubah');
  return user;
}

async function assertShift(id: number) {
  if (!(await Shift.findByPk(id))) throw new HttpError(400, 'Shift default tidak ditemukan');
}

router.get(
  '/users',
  ah(async (_req, res) => {
    const users = await User.findAll({ order: [['role', 'ASC'], ['fullName', 'ASC']] });
    res.json(users.map((u) => u.toPublic()));
  }),
);

router.post(
  '/users',
  ah(async (req, res) => {
    const body = createUserSchema.parse(req.body);
    await assertShift(body.defaultShiftId);
    if (body.role === 'KARYAWAN' && !body.faceImages) {
      throw new HttpError(400, 'Data wajah wajib diambil untuk Karyawan Parkir');
    }
    const enrollment =
      body.role === 'KARYAWAN' && body.faceImages
        ? await enrollWithDuplicateCheck(body.faceImages, undefined, !!body.similarOverride)
        : null;
    const prepared = enrollment ? await prepareSimilarOverride(enrollment.similar, body.similarOverride, null) : null;
    const passwordHash = await bcrypt.hash(body.password, 12);
    const user = await sequelize.transaction(async (transaction) => {
      const created = await User.create(
        {
          fullName: body.fullName,
          nik: body.nik,
          username: body.username,
          passwordHash,
          role: body.role,
          phone: body.phone,
          defaultShiftId: body.defaultShiftId,
          faceEmbedding: enrollment?.embeddings ?? null,
          pinHash: prepared?.pinHash ?? null,
        },
        { transaction },
      );
      if (prepared && enrollment) {
        await applySimilarOverride(prepared, enrollment.similar, body.similarOverride!.reason, currentUser(req).id, created.id, transaction);
      }
      return created;
    });
    res.status(201).json({ ...user.toPublic(), warning: enrollment?.warning ?? null });
  }),
);

router.put(
  '/users/:id',
  ah(async (req, res) => {
    const body = createUserSchema
      .omit({ faceImages: true, similarOverride: true })
      .extend({ password: z.string().min(8).max(100).optional().or(z.literal('')), isActive: z.boolean() })
      .parse(req.body);
    const user = await loadEditableUser(Number(req.params.id));
    await assertShift(body.defaultShiftId);
    if (body.role === 'KARYAWAN' && !user.faceEmbedding) {
      throw new HttpError(400, 'Daftarkan data wajah terlebih dahulu sebelum menjadikan Karyawan Parkir');
    }
    await user.update({
      fullName: body.fullName,
      nik: body.nik,
      username: body.username,
      role: body.role,
      phone: body.phone,
      defaultShiftId: body.defaultShiftId,
      isActive: body.isActive,
      ...(body.password ? { passwordHash: await bcrypt.hash(body.password, 12) } : {}),
    });
    res.json(user.toPublic());
  }),
);

router.put(
  '/users/:id/face',
  ah(async (req, res) => {
    const { faceImages: images, similarOverride } = createUserSchema
      .pick({ similarOverride: true })
      .extend({ faceImages })
      .parse(req.body);
    const user = await loadEditableUser(Number(req.params.id));
    if (user.role !== 'KARYAWAN') throw new HttpError(400, 'Data wajah hanya untuk Karyawan Parkir');
    const enrollment = await enrollWithDuplicateCheck(images, user.id, !!similarOverride);
    const prepared = await prepareSimilarOverride(enrollment.similar, similarOverride, user.id);
    await sequelize.transaction(async (transaction) => {
      await user.update({ faceEmbedding: enrollment.embeddings, ...(prepared ? { pinHash: prepared.pinHash } : {}) }, { transaction });
      if (prepared) {
        await applySimilarOverride(prepared, enrollment.similar, similarOverride!.reason, currentUser(req).id, user.id, transaction);
      }
    });
    res.json({ ...user.toPublic(), warning: enrollment.warning });
  }),
);

/** Pasang / ganti / hapus PIN absen karyawan (pin: null = hapus). */
router.put(
  '/users/:id/pin',
  ah(async (req, res) => {
    const { pin } = z.object({ pin: z.string().regex(PIN_RE, 'PIN harus 4–6 angka').nullable() }).parse(req.body);
    const user = await loadEditableUser(Number(req.params.id));
    if (user.role !== 'KARYAWAN') throw new HttpError(400, 'PIN absen hanya untuk Karyawan Parkir');
    if (pin) await assertPinAvailable(pin, [user.id]);
    await user.update({ pinHash: pin ? await hashPin(pin) : null });
    res.json(user.toPublic());
  }),
);

router.get(
  '/face-overrides',
  ah(async (_req, res) => {
    res.json(
      await FaceOverrideLog.findAll({
        include: [
          { model: User, as: 'actor', attributes: ['id', 'fullName'] },
          { model: User, as: 'user', attributes: ['id', 'fullName', 'nik'] },
          { model: User, as: 'similarUser', attributes: ['id', 'fullName', 'nik'] },
        ],
        order: [['createdAt', 'DESC']],
        limit: 100,
      }),
    );
  }),
);

router.delete(
  '/users/:id',
  ah(async (req, res) => {
    const user = await loadEditableUser(Number(req.params.id));
    const history = await Attendance.count({ where: { userId: user.id } });
    if (history > 0) {
      throw new HttpError(409, 'Pengguna memiliki riwayat absensi yang terkunci. Nonaktifkan akun alih-alih menghapus.');
    }
    await sequelize.transaction(async (transaction) => {
      await EmployeeSchedule.destroy({ where: { userId: user.id }, transaction });
      await user.destroy({ transaction });
    });
    res.status(204).end();
  }),
);

// ─────────────── Roster shift dinamis ───────────────
const rangeQuery = z
  .object({ from: z.string().regex(DATE_RE), to: z.string().regex(DATE_RE) })
  .refine((v) => v.from <= v.to && eachDate(v.from, v.to).length <= 62, { message: 'Rentang maksimal 62 hari' });

router.get(
  '/schedules',
  ah(async (req, res) => {
    const { from, to } = rangeQuery.parse(req.query);
    const [employees, schedules] = await Promise.all([
      User.findAll({ where: { role: 'KARYAWAN', isActive: true }, order: [['fullName', 'ASC']] }),
      EmployeeSchedule.findAll({ where: { date: { [Op.between]: [from, to] } } }),
    ]);
    res.json({
      employees: employees.map((u) => ({ id: u.id, fullName: u.fullName, nik: u.nik, defaultShiftId: u.defaultShiftId })),
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
        if (e.shiftId === null) {
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
      User.findAll({ where: { role: 'KARYAWAN', isActive: true } }),
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

// ─────────────── Hari libur ───────────────
router.post(
  '/holidays',
  ah(async (req, res) => {
    const body = z.object({ date: z.string().regex(DATE_RE), name: z.string().trim().min(3).max(120) }).parse(req.body);
    res.status(201).json(await Holiday.create(body));
  }),
);

router.delete(
  '/holidays/:id',
  ah(async (req, res) => {
    const holiday = await Holiday.findByPk(Number(req.params.id));
    if (!holiday) throw new HttpError(404, 'Hari libur tidak ditemukan');
    await holiday.destroy();
    res.status(204).end();
  }),
);

// ─────────────── Geofence pos parkir ───────────────
router.get(
  '/geofence',
  ah(async (_req, res) => {
    res.json(await GeofenceSetting.findByPk(1));
  }),
);

router.put(
  '/geofence',
  ah(async (req, res) => {
    const body = z
      .object({
        name: z.string().trim().min(3).max(120),
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        radiusMeters: z.number().min(1).max(500),
        maxAccuracyMeters: z.number().min(1).max(500),
      })
      .parse(req.body);
    const [geo] = await GeofenceSetting.upsert({ id: 1, ...body });
    res.json(geo);
  }),
);

// ─────────────── Koreksi darurat (audit trail) ───────────────
router.post(
  '/corrections',
  ah(async (req, res) => {
    const body = z
      .object({
        userId: z.number().int().positive(),
        date: z.string().regex(DATE_RE),
        slotType: z.enum(SLOT_TYPES),
        action: z.enum(['ADD', 'VOID']),
        time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        status: z.enum(['TEPAT_WAKTU', 'TERLAMBAT']).optional(),
        reason: z.string().trim().min(10, 'Alasan koreksi minimal 10 karakter').max(1000),
        issueId: z.number().int().positive().optional(),
      })
      .parse(req.body);
    if (body.date > witNow().date) throw new HttpError(400, 'Tidak dapat mengoreksi tanggal di masa depan');
    const log = await applyCorrection({ ...body, actor: currentUser(req) });
    res.status(201).json(log);
  }),
);

router.get(
  '/audit-logs',
  ah(async (_req, res) => {
    res.json(
      await AuditLog.findAll({
        include: [
          { model: User, as: 'actor', attributes: ['id', 'fullName'] },
          { model: User, as: 'targetUser', attributes: ['id', 'fullName', 'nik'] },
        ],
        order: [['createdAt', 'DESC']],
        limit: 300,
      }),
    );
  }),
);

export default router;
