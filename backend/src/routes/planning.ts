import { Router } from 'express';
import { Op } from 'sequelize';
import { z } from 'zod';
import { currentUser, requireRole } from '../middleware/auth';
import { ATTENDEE_ROLES, EmployeeSchedule, Holiday, RosterRule, SLOT_TYPES, Shift, ShiftBreak, ShiftChangeLog, User, sequelize } from '../models';
import { assignPlacements, DEFAULT_POSTS, getCoordinatorPost, getPosts, groupsOf, loadHistory, placementRules, rebalancePlacements, saveCoordinatorPost, savePosts } from '../services/placement';
import { buildWhatsappText, loadRosterData, sendRosterPdf, sendRosterXlsx } from '../services/rosterExport';
import { GenEmployee, generateBestRoster } from '../services/rosterGenerator';
import { RosterInfeasible, SolverUnavailable, solveRoster } from '../services/rosterSolver';
import { getGlobalLateTolerance, getLateTolerance, saveLateTolerance, setShiftLateTolerance } from '../services/settings';
import { BreakInput, loadShifts, SlotInput, validateShiftTimes } from '../services/shiftService';
import { ah, HttpError } from '../utils/http';
import { addDays, DATE_RE, eachDate, witNow } from '../utils/time';

/**
 * Perencanaan shift: roster harian & pengaturan jam shift.
 * Dipakai Super Admin dan Koordinator Lapangan; setiap perubahan jam shift tercatat
 * di riwayat beserta nama pengubahnya. Dipasang di /api/admin sebelum router admin,
 * path lain diteruskan ke router admin (khusus Super Admin).
 */
const router = Router();
router.use(requireRole('SUPER_ADMIN', 'KOORDINATOR'));
// Pengaturan Shift dan Roster Otomatis khusus Super Admin; Koordinator cukup Roster Shift + unduh/teks WA
const adminOnly = requireRole('SUPER_ADMIN');

// ─────────────── Roster shift dinamis ───────────────
const rangeQuery = z
  .object({ from: z.string().regex(DATE_RE), to: z.string().regex(DATE_RE) })
  .refine((v) => v.from <= v.to && eachDate(v.from, v.to).length <= 62, { message: 'Rentang maksimal 62 hari' });

router.get(
  '/schedules',
  ah(async (req, res) => {
    const { from, to } = rangeQuery.parse(req.query);
    const [employees, schedules, posts] = await Promise.all([
      User.findAll({ where: { role: [...ATTENDEE_ROLES], isActive: true }, order: [['fullName', 'ASC']] }),
      EmployeeSchedule.findAll({ where: { date: { [Op.between]: [from, to] } } }),
      getPosts(),
    ]);
    res.json({
      employees: employees.map((u) => ({ id: u.id, fullName: u.fullName, nik: u.nik, role: u.role, defaultShiftId: u.defaultShiftId })),
      schedules: schedules.map((s) => ({ userId: s.userId, date: s.date, shiftId: s.shiftId, post: s.post })),
      posts,
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
    // Penempatan pos dihitung ulang untuk tanggal yang berubah supaya tetap lengkap & merata
    if (entries.length > 0) {
      const dates = entries.map((e) => e.date).sort();
      await rebalancePlacements(dates[0], dates[dates.length - 1]);
    }
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
    if (rows.length > 0) await rebalancePlacements(dates[0], dates[dates.length - 1]);
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
  adminOnly,
  ah(async (_req, res) => {
    const [shifts, logs] = await Promise.all([
      loadShifts(),
      ShiftChangeLog.findAll({
        include: [{ model: User, as: 'actor', attributes: ['id', 'fullName'] }],
        order: [['createdAt', 'DESC']],
        limit: 50,
      }),
    ]);
    res.json({ shifts: [...shifts.values()], lateToleranceMinutes: getGlobalLateTolerance(), logs });
  }),
);

router.put(
  '/shifts/:id',
  adminOnly,
  ah(async (req, res) => {
    const body = z
      .object({
        startTime: hhmm,
        endTime: hhmm,
        slots: z.array(z.object({ type: z.enum(SLOT_TYPES), windowStart: hhmm, windowEnd: hhmm })).min(1),
        break: breakSchema,
        // null = ikuti toleransi umum
        lateToleranceMin: z.number().int().min(0).max(240).nullable().optional(),
      })
      .parse(req.body);
    const shift = (await loadShifts()).get(Number(req.params.id));
    if (!shift) throw new HttpError(404, 'Shift tidak ditemukan');
    if (body.slots.length !== shift.slots.length || shift.slots.some((s, i) => body.slots[i].type !== s.type)) {
      throw new HttpError(400, 'Jenis dan urutan slot absen tidak boleh diubah, hanya jamnya');
    }
    const late = body.lateToleranceMin === undefined ? shift.lateToleranceMin : body.lateToleranceMin;
    const problem = validateShiftTimes(shift.name, body.startTime, body.endTime, body.slots, late ?? getGlobalLateTolerance(), body.break);
    if (problem) throw new HttpError(400, problem);

    const before = { ...snapshot(shift.startTime, shift.endTime, shift.slots, shift.breakConfig), lateToleranceMin: shift.lateToleranceMin };
    const after = { ...snapshot(body.startTime, body.endTime, body.slots, body.break), lateToleranceMin: late };
    if (JSON.stringify(before) === JSON.stringify(after)) return res.json({ changed: false });

    await sequelize.transaction(async (transaction) => {
      await shift.update({ startTime: body.startTime, endTime: body.endTime, lateToleranceMin: late }, { transaction });
      for (const [i, slot] of shift.slots.entries()) {
        await slot.update({ windowStart: body.slots[i].windowStart, windowEnd: body.slots[i].windowEnd }, { transaction });
      }
      await ShiftBreak.upsert({ shiftId: shift.id, ...body.break }, { transaction });
      await ShiftChangeLog.create({ actorId: currentUser(req).id, target: shift.name, before, after }, { transaction });
    });
    setShiftLateTolerance(shift.id, late);
    res.json({ changed: true });
  }),
);

router.put(
  '/settings/late-tolerance',
  adminOnly,
  ah(async (req, res) => {
    const { minutes } = z.object({ minutes: z.number().int().min(0).max(240) }).parse(req.body);
    // Toleransi baru tidak boleh membuat jendela Masuk bertabrakan dengan slot berikutnya di shift yang memakainya
    for (const s of (await loadShifts()).values()) {
      if (s.lateToleranceMin != null) continue; // shift ini punya batas terlambat sendiri
      const problem = validateShiftTimes(s.name, s.startTime, s.endTime, s.slots, minutes, s.breakConfig);
      if (problem) throw new HttpError(400, problem);
    }
    if (minutes !== getGlobalLateTolerance()) await saveLateTolerance(minutes, currentUser(req).id);
    res.json({ lateToleranceMinutes: getGlobalLateTolerance() });
  }),
);

// ─────────────── Roster Otomatis ───────────────
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const dayList = z.array(z.number().int().min(0).max(6)).transform((xs) => [...new Set(xs)].sort());
const asDays = (v: unknown): number[] => {
  const xs = typeof v === 'string' ? JSON.parse(v) : v;
  return Array.isArray(xs) ? xs.map(Number).filter((n) => n >= 0 && n <= 6) : [];
};

async function rotationShifts() {
  const shifts = await Shift.findAll();
  const byCode = new Map(shifts.map((s) => [s.code, s]));
  const s1 = byCode.get('SHIFT_1');
  const s2 = byCode.get('SHIFT_2');
  if (!s1 || !s2) throw new HttpError(500, 'Shift 1 / Shift 2 tidak ditemukan');
  return { shifts, s1, s2, full: byCode.get('SHIFT_PENUH') ?? null, siang: byCode.get('SHIFT_SIANG') ?? null };
}

/** Aturan tiap karyawan; yang belum pernah diatur memakai bawaan (Koordinator → Shift Penuh). */
async function loadRules() {
  const [{ shifts, s1, s2, full, siang }, users, rules] = await Promise.all([
    rotationShifts(),
    User.findAll({ where: { role: [...ATTENDEE_ROLES], isActive: true }, order: [['fullName', 'ASC']] }),
    RosterRule.findAll(),
  ]);
  const byUser = new Map(rules.map((r) => [r.userId, r]));
  const rows = users.map((u) => {
    const r = byUser.get(u.id);
    return {
      userId: u.id,
      fullName: u.fullName,
      nik: u.nik,
      role: u.role,
      saved: !!r,
      fixedShiftId: r ? r.fixedShiftId : u.role === 'KOORDINATOR' ? (full?.id ?? null) : null,
      offDays: r ? asDays(r.offDays) : ALL_DAYS,
      noShift1Days: r ? asDays(r.noShift1Days) : [],
      noShift2Days: r ? asDays(r.noShift2Days) : [],
      noSiangDays: r ? asDays(r.noSiangDays) : [],
      female: r ? !!r.female : false,
      active: r ? r.active : true,
    };
  });
  return { rows, shifts, s1, s2, siang };
}

router.get(
  '/roster/rules',
  adminOnly,
  ah(async (_req, res) => {
    const { rows, shifts, s1, s2, siang } = await loadRules();
    res.json({
      rules: rows,
      shifts: shifts.map((s) => ({ id: s.id, code: s.code, name: s.name, startTime: s.startTime, endTime: s.endTime })),
      shift1Id: s1.id,
      shift2Id: s2.id,
      siangId: siang?.id ?? null,
    });
  }),
);

router.put(
  '/roster/rules/:userId',
  adminOnly,
  ah(async (req, res) => {
    const body = z
      .object({
        fixedShiftId: z.number().int().positive().nullable(),
        offDays: dayList,
        noShift1Days: dayList,
        noShift2Days: dayList,
        noSiangDays: dayList.default([]),
        female: z.boolean().default(false),
        active: z.boolean(),
      })
      .parse(req.body);
    const userId = Number(req.params.userId);
    const user = await User.findByPk(userId);
    if (!user || !(ATTENDEE_ROLES as readonly string[]).includes(user.role)) throw new HttpError(404, 'Karyawan tidak ditemukan');
    if (body.fixedShiftId !== null && !(await Shift.findByPk(body.fixedShiftId))) throw new HttpError(400, 'Shift tidak ditemukan');
    if (body.offDays.length === 0) throw new HttpError(400, 'Pilih minimal satu hari yang boleh Off');
    // Petugas perempuan tidak pernah Shift Siang
    const noSiang = body.female ? ALL_DAYS : body.noSiangDays;
    if (body.fixedShiftId === null && body.noShift1Days.some((d) => body.noShift2Days.includes(d) && noSiang.includes(d) && !body.offDays.includes(d))) {
      throw new HttpError(400, 'Ada hari yang tidak boleh Shift 1, Shift 2, maupun Shift Siang — jadikan hari itu hari Off');
    }
    await RosterRule.upsert({ userId, ...body, noSiangDays: noSiang });
    res.json({ saved: true });
  }),
);

/** Membuat pratinjau roster (belum disimpan). Simpan lewat PUT /schedules. */
router.post(
  '/roster/generate',
  adminOnly,
  ah(async (req, res) => {
    const body = z
      .object({
        start: z.string().regex(DATE_RE),
        weeks: z.number().int().min(3).max(13),
        offPerWeek: z.number().int().min(1).max(2).default(1),
        // Komposisi harian: Shift 1 & Shift Siang jumlahnya tetap, sisanya Shift 2
        shift1Count: z.number().int().min(1).max(15).default(3),
        siangCount: z.number().int().min(0).max(10).default(2),
        // SOLVER = OR-Tools (aturan pulang malam → masuk pagi wajib); LAMA = penyusun hari demi hari
        engine: z.enum(['SOLVER', 'LAMA']).default('SOLVER'),
      })
      .parse(req.body);
    if (body.start < witNow().date) throw new HttpError(400, 'Tanggal mulai tidak boleh sebelum hari ini');
    const end = addDays(body.start, body.weeks * 7 - 1);
    const { rows, s1, s2, siang } = await loadRules();
    const active = rows.filter((r) => r.active);
    if (body.siangCount > 0 && !siang) throw new HttpError(400, 'Shift Siang belum ada di Pengaturan Shift');
    if (active.length === 0) throw new HttpError(400, 'Belum ada karyawan yang ikut roster otomatis');
    const [holidays, prevRows, existing] = await Promise.all([
      Holiday.findAll({ where: { date: { [Op.between]: [body.start, end] } } }),
      EmployeeSchedule.findAll({ where: { date: addDays(body.start, -1) } }),
      EmployeeSchedule.count({ where: { date: { [Op.between]: [body.start, end] }, userId: active.map((r) => r.userId) } }),
    ]);
    const employees: GenEmployee[] = active.map((r) => ({
      id: r.userId,
      name: r.fullName,
      fixedShiftId: r.fixedShiftId,
      offDays: r.offDays,
      noShift1Days: r.noShift1Days,
      noShift2Days: r.noShift2Days,
      noSiangDays: r.female ? ALL_DAYS : r.noSiangDays,
    }));
    const genOpt = {
      start: body.start,
      weeks: body.weeks,
      offPerWeek: body.offPerWeek,
      shift1Count: body.shift1Count,
      siangCount: siang ? body.siangCount : 0,
      shift1Id: s1.id,
      shift2Id: s2.id,
      siangId: siang?.id ?? null,
      holidays: new Set(holidays.map((h) => h.date)),
      prevDay: new Map(prevRows.map((s) => [s.userId, s.shiftId === null ? ('OFF' as const) : s.shiftId])),
    };
    let result: ReturnType<typeof generateBestRoster>;
    let engine = { used: body.engine, status: null as string | null, wallTime: null as number | null, note: null as string | null };
    if (body.engine === 'SOLVER') {
      try {
        const solved = await solveRoster(employees, genOpt);
        result = solved.result;
        engine = { ...engine, status: solved.status, wallTime: solved.wallTime };
      } catch (e) {
        if (e instanceof RosterInfeasible) {
          throw new HttpError(400, `Roster tidak bisa disusun dengan semua aturan wajib. ${e.reasons.join(' ')}`);
        }
        if (!(e instanceof SolverUnavailable)) throw e;
        // Mesin baru belum tersedia di server → tetap jalan dengan mesin lama, beri tahu pengguna
        result = generateBestRoster(employees, genOpt);
        engine = { used: 'LAMA', status: null, wallTime: null, note: `${e.message}; memakai mesin lama.` };
      }
    } else {
      result = generateBestRoster(employees, genOpt);
    }
    // Pratinjau penempatan pos, dihitung dengan cara yang sama seperti saat roster disimpan
    const [posts, { plotted, rules: placeRules, coordinatorPostOf }, start] = await Promise.all([getPosts(), placementRules(), loadHistory(body.start)]);
    const placement = assignPlacements(
      result.dates.map((date) => {
        const entries: { userId: number; shiftId: number }[] = [];
        for (const r of active) {
          const c = result.cells.get(r.userId)!.get(date);
          if (typeof c === 'number' && plotted(r.userId)) entries.push({ userId: r.userId, shiftId: c });
        }
        return { date, groups: groupsOf(entries) };
      }),
      posts,
      start.history,
      start.last,
      placeRules,
    );
    if (result.violations.length > 0) {
      throw new HttpError(400, `Aturan karyawan tidak bisa dipenuhi semua: ${result.violations.slice(0, 5).join('; ')}`);
    }
    res.json({
      start: body.start,
      end,
      dates: result.dates,
      holidays: holidays.map((h) => ({ date: h.date, name: h.name })),
      rows: active.map((r) => ({
        userId: r.userId,
        fullName: r.fullName,
        role: r.role,
        cells: result.dates.map((d) => result.cells.get(r.userId)!.get(d) ?? null),
        posts: result.dates.map((d) => {
          const c = result.cells.get(r.userId)!.get(d);
          return plotted(r.userId) ? (placement.get(`${r.userId}|${d}`) ?? null) : coordinatorPostOf(typeof c === 'number' ? c : null);
        }),
      })),
      posts,
      stats: result.stats,
      daily: result.daily,
      warnings: result.warnings,
      existingSchedules: existing,
      engine,
    });
  }),
);

// ─────────────── Pos penempatan (plotting) ───────────────
router.get(
  '/roster/posts',
  adminOnly,
  ah(async (_req, res) => {
    const posts = await getPosts();
    res.json({ posts, defaults: DEFAULT_POSTS, coordinatorPost: await getCoordinatorPost(posts) });
  }),
);

router.put(
  '/roster/posts',
  adminOnly,
  ah(async (req, res) => {
    const { posts, coordinatorPost } = z
      .object({
        // Pos pintu yang dijaga Koordinator di pagi hari (Shift 1); null = tidak ada
        coordinatorPost: z.string().trim().toUpperCase().nullable().default(null),
        posts: z
          .array(
            z.object({
              code: z
                .string()
                .trim()
                .toUpperCase()
                .regex(/^[A-Z0-9]{1,6}$/, 'Kode pos 1–6 huruf/angka tanpa spasi')
                .refine((c) => c !== 'CAD', 'Kode CAD dipakai untuk Cadangan'),
              area: z.string().trim().min(2, 'Nama area wajib diisi').max(60),
              name: z.string().trim().min(2, 'Nama pos wajib diisi').max(60),
              lot: z.boolean().default(false),
            }),
          )
          .min(1, 'Minimal satu pos')
          .max(10),
      })
      .parse(req.body);
    if (new Set(posts.map((p) => p.code)).size !== posts.length) throw new HttpError(400, 'Kode pos tidak boleh kembar');
    if (coordinatorPost && !posts.some((p) => p.code === coordinatorPost && !p.lot)) {
      throw new HttpError(400, 'Pos Koordinator harus salah satu pos pintu (bukan area parkiran)');
    }
    await savePosts(posts, currentUser(req).id);
    await saveCoordinatorPost(coordinatorPost);
    // Roster ke depan langsung memakai daftar pos yang baru
    const today = witNow().date;
    await rebalancePlacements(today, addDays(today, 120));
    res.json({ posts, coordinatorPost });
  }),
);

/** Teks jadwal harian siap tempel ke grup WhatsApp (format seperti jadwal manual manajemen). */
router.get(
  '/roster/whatsapp',
  ah(async (req, res) => {
    const date = z.string().regex(DATE_RE).parse(req.query.date);
    res.json({ text: await buildWhatsappText(date) });
  }),
);

/** Unduh roster yang sudah tersimpan (PDF / Excel) untuk dibagikan ke grup WhatsApp. */
const exportQuery = z
  .object({ from: z.string().regex(DATE_RE), to: z.string().regex(DATE_RE) })
  .refine((v) => v.from <= v.to && eachDate(v.from, v.to).length <= 98, { message: 'Rentang unduhan maksimal 14 minggu' });

router.get(
  '/roster/export.pdf',
  ah(async (req, res) => {
    const { from, to } = exportQuery.parse(req.query);
    sendRosterPdf(res, await loadRosterData(from, to), currentUser(req).fullName, `roster-shift-SMC_${from}_${to}.pdf`);
  }),
);

router.get(
  '/roster/export.xlsx',
  ah(async (req, res) => {
    const { from, to } = exportQuery.parse(req.query);
    await sendRosterXlsx(res, await loadRosterData(from, to), currentUser(req).fullName, `roster-shift-SMC_${from}_${to}.xlsx`);
  }),
);

export default router;
