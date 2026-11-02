import fs from 'fs';
import path from 'path';
import { Request, Router } from 'express';
import { Op } from 'sequelize';
import { z } from 'zod';
import { currentUser, requireRole } from '../middleware/auth';
import { parkingPhotoUpload, parkingUploadDir } from '../middleware/upload';
import {
  ATTENDEE_ROLES,
  Deposit,
  EmployeeSchedule,
  Handover,
  HourlyReport,
  Incident,
  INCIDENT_STATUSES,
  INCIDENT_TYPES,
  isAttendee,
  Shift,
  TICKET_TYPES,
  TicketBatch,
  TicketVoid,
  User,
  VOID_REASONS,
} from '../models';
import { getParkingSettings, mismatchOf, ParkingSettings, revenueOf, saveParkingSettings, summarizeDay, expectedHours } from '../services/parking';
import { getPosts, postLabel } from '../services/placement';
import { ah, HttpError } from '../utils/http';
import { DATE_RE, eachDate, witNow } from '../utils/time';

/**
 * Operasional parkir: laporan per jam, stok karcis, setoran, serah terima shift, dan laporan kejadian.
 * Semua fitur tersembunyi sampai diaktifkan di Pengaturan Parkir; Super Admin tetap bisa mencobanya.
 */
const router = Router();
const reviewers = requireRole('SUPER_ADMIN', 'KOORDINATOR');
const isReviewer = (req: Request) => ['SUPER_ADMIN', 'KOORDINATOR'].includes(currentUser(req).role);

async function needModule(req: Request, which: 'karcis' | 'kejadian'): Promise<ParkingSettings> {
  const s = await getParkingSettings();
  const on = which === 'karcis' ? s.karcisEnabled : s.kejadianEnabled;
  if (!on && currentUser(req).role !== 'SUPER_ADMIN') {
    throw new HttpError(403, which === 'karcis' ? 'Modul karcis & setoran belum diaktifkan' : 'Modul laporan kejadian belum diaktifkan');
  }
  return s;
}
function needAttendee(req: Request) {
  if (!isAttendee(currentUser(req).role)) throw new HttpError(403, 'Hanya untuk petugas dan Koordinator');
}
async function namesOf(ids: number[]) {
  const users = await User.findAll({ where: { id: [...new Set(ids)] }, attributes: ['id', 'fullName'] });
  return new Map(users.map((u) => [u.id, u.fullName]));
}
const num = (max: number) => z.coerce.number().int().min(0).max(max);
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : null));
const rangeQuery = z
  .object({ from: z.string().regex(DATE_RE), to: z.string().regex(DATE_RE) })
  .refine((v) => v.from <= v.to && eachDate(v.from, v.to).length <= 62, { message: 'Rentang maksimal 62 hari' });
const notFuture = (d: string) => d <= witNow().date;

// ─────────────── Pengaturan ───────────────
router.get(
  '/settings',
  ah(async (_req, res) => {
    res.json(await getParkingSettings());
  }),
);

router.put(
  '/settings',
  requireRole('SUPER_ADMIN'),
  ah(async (req, res) => {
    const body = z
      .object({
        karcisEnabled: z.boolean(),
        kejadianEnabled: z.boolean(),
        rateCar: z.number().int().min(0).max(1_000_000),
        rateMotor: z.number().int().min(0).max(1_000_000),
        ticketAt: z.enum(['MASUK', 'KELUAR']),
        carLots: z.number().int().min(0).max(10_000),
        motorLots: z.number().int().min(0).max(10_000),
      })
      .parse(req.body);
    if (body.karcisEnabled && (body.rateCar === 0 || body.rateMotor === 0)) {
      throw new HttpError(400, 'Isi tarif mobil dan motor sebelum mengaktifkan modul karcis');
    }
    await saveParkingSettings(body, currentUser(req).id);
    res.json(body);
  }),
);

/** Jumlah yang menunggu tindakan Koordinator / Super Admin (untuk lonceng). */
router.get(
  '/pending',
  reviewers,
  ah(async (_req, res) => {
    const [deposits, handovers, incidents] = await Promise.all([
      Deposit.count({ where: { status: 'MENUNGGU' } }),
      Handover.count({ where: { status: 'DITERIMA' } }),
      Incident.count({ where: { status: 'BARU' } }),
    ]);
    res.json({ deposits, handovers, incidents });
  }),
);

// ─────────────── Laporan per jam ───────────────
async function todaySchedule(userId: number, date: string) {
  const schedule = await EmployeeSchedule.findOne({ where: { userId, date }, include: [{ model: Shift, as: 'shift' }] });
  if (!schedule || schedule.shiftId === null || !schedule.shift) return null;
  return schedule;
}

router.get(
  '/reports/mine',
  ah(async (req, res) => {
    needAttendee(req);
    const s = await needModule(req, 'karcis');
    const me = currentUser(req);
    const now = witNow();
    const [schedule, reports, posts] = await Promise.all([
      todaySchedule(me.id, now.date),
      HourlyReport.findAll({ where: { userId: me.id, date: now.date }, order: [['hour', 'ASC']] }),
      getPosts(),
    ]);
    const due = schedule ? expectedHours(schedule.shift!.startTime, schedule.shift!.endTime, now.minutes) : [];
    const done = new Set(reports.map((r) => r.hour));
    const startHour = schedule ? Number(schedule.shift!.startTime.slice(0, 2)) : null;
    const endHour = schedule ? Number(schedule.shift!.endTime.slice(0, 2)) + (schedule.shift!.endTime.slice(3, 5) !== '00' ? 1 : 0) : null;
    res.json({
      settings: s,
      date: now.date,
      currentHour: Math.floor(now.minutes / 60),
      shift: schedule && { name: schedule.shift!.name, startTime: schedule.shift!.startTime, endTime: schedule.shift!.endTime },
      post: schedule ? postLabel(posts, schedule.post) : null,
      // Jam yang boleh dilaporkan: sejak jam mulai shift sampai jam sekarang
      hours: startHour === null || endHour === null ? [] : Array.from({ length: endHour - startHour }, (_, i) => startHour + i).filter((h) => h * 60 <= now.minutes),
      missing: due.filter((h) => !done.has(h)),
      reports: reports.map((r) => ({ ...r.toJSON(), mismatch: mismatchOf(r, s.ticketAt), revenue: revenueOf(r.ticketCar, r.ticketMotor, r.rateCar, r.rateMotor) })),
    });
  }),
);

router.post(
  '/reports',
  ah(async (req, res) => {
    needAttendee(req);
    const s = await needModule(req, 'karcis');
    const me = currentUser(req);
    const body = z
      .object({
        hour: z.number().int().min(0).max(23),
        carIn: num(5000),
        motorIn: num(5000),
        carOut: num(5000),
        motorOut: num(5000),
        ticketCar: num(5000),
        ticketMotor: num(5000),
        note: optText(500),
      })
      .parse(req.body);
    const now = witNow();
    const schedule = await todaySchedule(me.id, now.date);
    if (!schedule) throw new HttpError(409, 'Anda tidak punya jadwal shift hari ini, laporan tidak bisa dibuat');
    const start = Number(schedule.shift!.startTime.slice(0, 2));
    const end = Number(schedule.shift!.endTime.slice(0, 2)) + (schedule.shift!.endTime.slice(3, 5) !== '00' ? 1 : 0);
    if (body.hour < start || body.hour >= end) throw new HttpError(400, `Jam laporan harus di dalam jam shift Anda (${schedule.shift!.startTime}–${schedule.shift!.endTime})`);
    if (body.hour * 60 > now.minutes) throw new HttpError(400, 'Jam laporan belum dimulai');
    const values = { ...body, post: schedule.post, rateCar: s.rateCar, rateMotor: s.rateMotor };
    const existing = await HourlyReport.findOne({ where: { userId: me.id, date: now.date, hour: body.hour } });
    if (existing) await existing.update(values);
    else await HourlyReport.create({ userId: me.id, date: now.date, ...values });
    res.status(existing ? 200 : 201).json({ updated: !!existing, mismatch: mismatchOf({ ...values, hour: body.hour }, s.ticketAt) });
  }),
);

/** Ringkasan satu hari untuk Koordinator & Super Admin: total, blok 3 jam, per pos, selisih, dan yang belum lapor. */
router.get(
  '/reports',
  reviewers,
  ah(async (req, res) => {
    const s = await needModule(req, 'karcis');
    const date = z.string().regex(DATE_RE).parse(req.query.date ?? witNow().date);
    const [reports, schedules, posts] = await Promise.all([
      HourlyReport.findAll({ where: { date }, order: [['hour', 'ASC']] }),
      EmployeeSchedule.findAll({ where: { date, shiftId: { [Op.ne]: null } }, include: [{ model: Shift, as: 'shift' }] }),
      getPosts(),
    ]);
    const workers = await User.findAll({ where: { id: schedules.map((x) => x.userId), role: 'KARYAWAN', isActive: true }, attributes: ['id', 'fullName'] });
    const names = await namesOf([...reports.map((r) => r.userId), ...workers.map((w) => w.id)]);
    const now = witNow();
    const nowMin = date < now.date ? 24 * 60 : date > now.date ? 0 : now.minutes;
    const missing = workers
      .map((w) => {
        const sc = schedules.find((x) => x.userId === w.id)!;
        const due = expectedHours(sc.shift!.startTime, sc.shift!.endTime, nowMin);
        const done = new Set(reports.filter((r) => r.userId === w.id).map((r) => r.hour));
        return { userId: w.id, fullName: w.fullName, post: postLabel(posts, sc.post), missing: due.filter((h) => !done.has(h)) };
      })
      .filter((m) => m.missing.length > 0);
    res.json({
      date,
      settings: s,
      summary: summarizeDay(reports, s),
      rows: reports.map((r) => ({
        ...r.toJSON(),
        fullName: names.get(r.userId) ?? '?',
        postLabel: postLabel(posts, r.post),
        mismatch: mismatchOf(r, s.ticketAt),
        revenue: revenueOf(r.ticketCar, r.ticketMotor, r.rateCar, r.rateMotor),
      })),
      missing,
    });
  }),
);

/** Total per hari dalam rentang tanggal (rekap pendapatan). */
router.get(
  '/reports/daily',
  reviewers,
  ah(async (req, res) => {
    const s = await needModule(req, 'karcis');
    const { from, to } = rangeQuery.parse(req.query);
    const reports = await HourlyReport.findAll({ where: { date: { [Op.between]: [from, to] } } });
    res.json(
      eachDate(from, to).map((date) => {
        const sum = summarizeDay(reports.filter((r) => r.date === date), s);
        return { date, ...sum.totals, mismatch: sum.mismatch };
      }),
    );
  }),
);

// ─────────────── Stok karcis ───────────────
router.get(
  '/tickets',
  reviewers,
  ah(async (req, res) => {
    await needModule(req, 'karcis');
    const [batches, voids, used] = await Promise.all([
      TicketBatch.findAll({ order: [['receivedDate', 'DESC'], ['id', 'DESC']] }),
      TicketVoid.findAll({ order: [['date', 'DESC'], ['id', 'DESC']], limit: 200 }),
      HourlyReport.findAll({ attributes: ['ticketCar', 'ticketMotor'] }),
    ]);
    const allVoids = await TicketVoid.findAll({ attributes: ['type'] });
    const names = await namesOf([...batches.map((b) => b.recordedById), ...voids.map((v) => v.userId)]);
    const stock = TICKET_TYPES.map((type) => {
      const received = batches.filter((b) => b.type === type).reduce((a, b) => a + (b.serialTo - b.serialFrom + 1), 0);
      const usedCount = used.reduce((a, r) => a + (type === 'MOBIL' ? r.ticketCar : r.ticketMotor), 0);
      const voided = allVoids.filter((v) => v.type === type).length;
      return { type, received, used: usedCount, voided, remaining: received - usedCount - voided };
    });
    res.json({
      stock,
      batches: batches.map((b) => ({ ...b.toJSON(), count: b.serialTo - b.serialFrom + 1, recordedBy: names.get(b.recordedById) ?? '?' })),
      voids: voids.map((v) => ({ ...v.toJSON(), reportedBy: names.get(v.userId) ?? '?' })),
    });
  }),
);

router.post(
  '/tickets/batches',
  reviewers,
  ah(async (req, res) => {
    await needModule(req, 'karcis');
    const body = z
      .object({
        type: z.enum(TICKET_TYPES),
        serialFrom: z.number().int().min(0).max(99_999_999),
        serialTo: z.number().int().min(0).max(99_999_999),
        receivedDate: z.string().regex(DATE_RE).refine(notFuture, 'Tanggal terima tidak boleh di masa depan'),
        note: optText(300),
      })
      .parse(req.body);
    if (body.serialTo < body.serialFrom) throw new HttpError(400, 'Nomor seri akhir harus ≥ nomor seri awal');
    if (body.serialTo - body.serialFrom >= 100_000) throw new HttpError(400, 'Satu penerimaan maksimal 100.000 lembar');
    const overlap = await TicketBatch.findOne({
      where: { type: body.type, serialFrom: { [Op.lte]: body.serialTo }, serialTo: { [Op.gte]: body.serialFrom } },
    });
    if (overlap) throw new HttpError(409, `Nomor seri bertumpuk dengan penerimaan ${overlap.serialFrom}–${overlap.serialTo}`);
    const batch = await TicketBatch.create({ ...body, recordedById: currentUser(req).id });
    res.status(201).json(batch);
  }),
);

router.post(
  '/tickets/voids',
  ah(async (req, res) => {
    await needModule(req, 'karcis');
    const body = z
      .object({
        type: z.enum(TICKET_TYPES),
        serial: z.string().trim().min(1, 'Nomor seri wajib diisi').max(40),
        reason: z.enum(VOID_REASONS),
        date: z.string().regex(DATE_RE).refine(notFuture, 'Tanggal tidak boleh di masa depan'),
        note: optText(300),
      })
      .parse(req.body);
    const dup = await TicketVoid.findOne({ where: { type: body.type, serial: body.serial } });
    if (dup) throw new HttpError(409, `Karcis ${body.type.toLowerCase()} nomor ${body.serial} sudah dicatat ${dup.reason.toLowerCase()}`);
    const v = await TicketVoid.create({ ...body, userId: currentUser(req).id });
    res.status(201).json(v);
  }),
);

router.get(
  '/tickets/voids/mine',
  ah(async (req, res) => {
    await needModule(req, 'karcis');
    res.json(await TicketVoid.findAll({ where: { userId: currentUser(req).id }, order: [['id', 'DESC']], limit: 50 }));
  }),
);

// ─────────────── Setoran ───────────────
const depositJson = (d: Deposit, names: Map<number, string>) => ({
  ...d.toJSON(),
  photoPath: undefined,
  hasPhoto: !!d.photoPath,
  fullName: names.get(d.userId) ?? '?',
  reviewedBy: d.reviewedById ? (names.get(d.reviewedById) ?? '?') : null,
  diff: d.amount - d.expected,
});

router.post(
  '/deposits',
  parkingPhotoUpload.single('photo'),
  ah(async (req, res) => {
    needAttendee(req);
    const s = await needModule(req, 'karcis');
    const body = z
      .object({
        date: z.string().regex(DATE_RE).refine(notFuture, 'Tanggal setoran tidak boleh di masa depan'),
        amount: z.coerce.number().int().min(0).max(1_000_000_000),
        ticketCar: num(100_000),
        ticketMotor: num(100_000),
        note: optText(500),
      })
      .parse(req.body);
    const d = await Deposit.create({
      ...body,
      userId: currentUser(req).id,
      expected: revenueOf(body.ticketCar, body.ticketMotor, s.rateCar, s.rateMotor),
      photoPath: req.file?.filename ?? null,
      reviewNote: null,
      reviewedById: null,
      reviewedAt: null,
    });
    res.status(201).json(depositJson(d, await namesOf([d.userId])));
  }),
);

router.get(
  '/deposits/mine',
  ah(async (req, res) => {
    await needModule(req, 'karcis');
    const list = await Deposit.findAll({ where: { userId: currentUser(req).id }, order: [['id', 'DESC']], limit: 60 });
    const names = await namesOf(list.flatMap((d) => [d.userId, ...(d.reviewedById ? [d.reviewedById] : [])]));
    res.json(list.map((d) => depositJson(d, names)));
  }),
);

router.get(
  '/deposits',
  reviewers,
  ah(async (req, res) => {
    await needModule(req, 'karcis');
    const { from, to } = rangeQuery.parse(req.query);
    const [list, reports] = await Promise.all([
      Deposit.findAll({ where: { date: { [Op.between]: [from, to] } }, order: [['date', 'DESC'], ['id', 'DESC']] }),
      HourlyReport.findAll({ where: { date: { [Op.between]: [from, to] } } }),
    ]);
    const names = await namesOf(list.flatMap((d) => [d.userId, ...(d.reviewedById ? [d.reviewedById] : [])]));
    res.json(
      list.map((d) => ({
        ...depositJson(d, names),
        // Pembanding: pendapatan menurut laporan per jam petugas yang sama di tanggal yang sama
        reportedRevenue: reports
          .filter((r) => r.userId === d.userId && r.date === d.date)
          .reduce((a, r) => a + revenueOf(r.ticketCar, r.ticketMotor, r.rateCar, r.rateMotor), 0),
      })),
    );
  }),
);

router.patch(
  '/deposits/:id/review',
  reviewers,
  ah(async (req, res) => {
    await needModule(req, 'karcis');
    const body = z
      .object({ status: z.enum(['DITERIMA', 'SELISIH']), note: optText(500) })
      .refine((v) => v.status !== 'SELISIH' || !!v.note, { message: 'Tulis catatan selisihnya', path: ['note'] })
      .parse(req.body);
    const d = await Deposit.findByPk(Number(req.params.id));
    if (!d) throw new HttpError(404, 'Setoran tidak ditemukan');
    if (d.status !== 'MENUNGGU') throw new HttpError(409, 'Setoran ini sudah diperiksa');
    if (d.userId === currentUser(req).id) throw new HttpError(403, 'Setoran milik sendiri diperiksa oleh orang lain');
    await d.update({ status: body.status, reviewNote: body.note, reviewedById: currentUser(req).id, reviewedAt: new Date() });
    res.json({ ok: true });
  }),
);

router.get(
  '/deposits/:id/photo',
  ah(async (req, res) => {
    const d = await Deposit.findByPk(Number(req.params.id));
    if (!d || !d.photoPath) throw new HttpError(404, 'Foto tidak ditemukan');
    if (d.userId !== currentUser(req).id && !isReviewer(req)) throw new HttpError(403, 'Tidak berhak melihat foto ini');
    res.sendFile(path.join(parkingUploadDir, path.basename(d.photoPath)));
  }),
);

// ─────────────── Serah terima shift ───────────────
const handoverJson = (h: Handover, names: Map<number, string>, posts: Awaited<ReturnType<typeof getPosts>>) => ({
  ...h.toJSON(),
  fromName: names.get(h.fromUserId) ?? '?',
  toName: names.get(h.toUserId) ?? '?',
  acknowledgedBy: h.acknowledgedById ? (names.get(h.acknowledgedById) ?? '?') : null,
  postLabel: postLabel(posts, h.post),
});

router.get(
  '/handovers/candidates',
  ah(async (req, res) => {
    await needModule(req, 'karcis');
    const today = witNow().date;
    const [users, schedules] = await Promise.all([
      User.findAll({ where: { role: [...ATTENDEE_ROLES], isActive: true, id: { [Op.ne]: currentUser(req).id } }, order: [['fullName', 'ASC']] }),
      EmployeeSchedule.findAll({ where: { date: today, shiftId: { [Op.ne]: null } }, include: [{ model: Shift, as: 'shift' }] }),
    ]);
    const shiftOf = new Map(schedules.map((s) => [s.userId, s.shift?.name ?? null]));
    // Yang masuk hari ini ditaruh paling atas
    res.json(
      users
        .map((u) => ({ id: u.id, fullName: u.fullName, role: u.role, shiftToday: shiftOf.get(u.id) ?? null }))
        .sort((a, b) => Number(!!b.shiftToday) - Number(!!a.shiftToday)),
    );
  }),
);

router.post(
  '/handovers',
  ah(async (req, res) => {
    needAttendee(req);
    await needModule(req, 'karcis');
    const me = currentUser(req);
    const body = z
      .object({
        toUserId: z.number().int().positive(),
        remainingCar: num(1_000_000),
        remainingMotor: num(1_000_000),
        lastSerialCar: optText(40),
        lastSerialMotor: optText(40),
        voidNote: optText(300),
        cashAmount: num(1_000_000_000),
        cashNote: optText(300),
        equipment: optText(300),
        pendingIssues: optText(500),
      })
      .parse(req.body);
    if (body.toUserId === me.id) throw new HttpError(400, 'Penerima harus petugas lain');
    const receiver = await User.findByPk(body.toUserId);
    if (!receiver || !receiver.isActive || !isAttendee(receiver.role)) throw new HttpError(400, 'Penerima tidak ditemukan');
    const today = witNow().date;
    const schedule = await EmployeeSchedule.findOne({ where: { userId: me.id, date: today } });
    const h = await Handover.create({
      ...body,
      date: today,
      fromUserId: me.id,
      post: schedule?.post ?? null,
      acceptedAt: null,
      acknowledgedById: null,
      acknowledgedAt: null,
    });
    res.status(201).json(h);
  }),
);

router.get(
  '/handovers/mine',
  ah(async (req, res) => {
    await needModule(req, 'karcis');
    const me = currentUser(req).id;
    const list = await Handover.findAll({ where: { [Op.or]: [{ fromUserId: me }, { toUserId: me }] }, order: [['id', 'DESC']], limit: 50 });
    const [names, posts] = await Promise.all([namesOf(list.flatMap((h) => [h.fromUserId, h.toUserId, ...(h.acknowledgedById ? [h.acknowledgedById] : [])])), getPosts()]);
    res.json(list.map((h) => handoverJson(h, names, posts)));
  }),
);

router.patch(
  '/handovers/:id/accept',
  ah(async (req, res) => {
    await needModule(req, 'karcis');
    const h = await Handover.findByPk(Number(req.params.id));
    if (!h) throw new HttpError(404, 'Serah terima tidak ditemukan');
    if (h.toUserId !== currentUser(req).id) throw new HttpError(403, 'Hanya penerima yang bisa mengonfirmasi');
    if (h.status !== 'MENUNGGU') throw new HttpError(409, 'Serah terima ini sudah dikonfirmasi');
    await h.update({ status: 'DITERIMA', acceptedAt: new Date() });
    res.json({ ok: true });
  }),
);

router.get(
  '/handovers',
  reviewers,
  ah(async (req, res) => {
    await needModule(req, 'karcis');
    const { from, to } = rangeQuery.parse(req.query);
    const list = await Handover.findAll({ where: { date: { [Op.between]: [from, to] } }, order: [['date', 'DESC'], ['id', 'DESC']] });
    const [names, posts] = await Promise.all([namesOf(list.flatMap((h) => [h.fromUserId, h.toUserId, ...(h.acknowledgedById ? [h.acknowledgedById] : [])])), getPosts()]);
    res.json(list.map((h) => handoverJson(h, names, posts)));
  }),
);

router.patch(
  '/handovers/:id/acknowledge',
  reviewers,
  ah(async (req, res) => {
    await needModule(req, 'karcis');
    const h = await Handover.findByPk(Number(req.params.id));
    if (!h) throw new HttpError(404, 'Serah terima tidak ditemukan');
    if (h.status !== 'DITERIMA') throw new HttpError(409, h.status === 'MENUNGGU' ? 'Penerima belum mengonfirmasi' : 'Sudah diketahui');
    await h.update({ status: 'DIKETAHUI', acknowledgedById: currentUser(req).id, acknowledgedAt: new Date() });
    res.json({ ok: true });
  }),
);

// ─────────────── Laporan kejadian ───────────────
const incidentJson = (i: Incident, names: Map<number, string>) => ({
  ...i.toJSON(),
  photos: undefined,
  photoCount: (i.photos ?? []).length,
  reporter: names.get(i.reporterId) ?? '?',
  reviewedBy: i.reviewedById ? (names.get(i.reviewedById) ?? '?') : null,
});

router.post(
  '/incidents',
  parkingPhotoUpload.array('photos', 3),
  ah(async (req, res) => {
    await needModule(req, 'kejadian');
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    try {
      const body = z
        .object({
          date: z.string().regex(DATE_RE).refine(notFuture, 'Tanggal kejadian tidak boleh di masa depan'),
          time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Format jam HH:MM'),
          location: z.string().trim().min(2, 'Lokasi wajib diisi').max(100),
          type: z.enum(INCIDENT_TYPES),
          parties: optText(300),
          plate: optText(20),
          vehicle: optText(20),
          ticketNo: optText(40),
          chronology: z.string().trim().min(10, 'Kronologi minimal 10 karakter').max(4000),
          actions: optText(1000),
          contacted: optText(300),
        })
        .parse(req.body);
      const i = await Incident.create({
        ...body,
        reporterId: currentUser(req).id,
        photos: files.map((f) => f.filename),
        reviewNote: null,
        reviewedById: null,
        reviewedAt: null,
      });
      res.status(201).json(incidentJson(i, await namesOf([i.reporterId])));
    } catch (e) {
      // Pengajuan ditolak → foto yang terlanjur terunggah dibuang
      for (const f of files) fs.rm(f.path, { force: true }, () => undefined);
      throw e;
    }
  }),
);

router.get(
  '/incidents/mine',
  ah(async (req, res) => {
    await needModule(req, 'kejadian');
    const list = await Incident.findAll({ where: { reporterId: currentUser(req).id }, order: [['id', 'DESC']], limit: 50 });
    const names = await namesOf(list.flatMap((i) => [i.reporterId, ...(i.reviewedById ? [i.reviewedById] : [])]));
    res.json(list.map((i) => incidentJson(i, names)));
  }),
);

router.get(
  '/incidents',
  reviewers,
  ah(async (req, res) => {
    await needModule(req, 'kejadian');
    const { from, to } = rangeQuery.parse(req.query);
    const list = await Incident.findAll({ where: { date: { [Op.between]: [from, to] } }, order: [['date', 'DESC'], ['time', 'DESC']] });
    const names = await namesOf(list.flatMap((i) => [i.reporterId, ...(i.reviewedById ? [i.reviewedById] : [])]));
    res.json(list.map((i) => incidentJson(i, names)));
  }),
);

router.patch(
  '/incidents/:id/review',
  reviewers,
  ah(async (req, res) => {
    await needModule(req, 'kejadian');
    const body = z.object({ status: z.enum(INCIDENT_STATUSES), note: optText(500) }).parse(req.body);
    const i = await Incident.findByPk(Number(req.params.id));
    if (!i) throw new HttpError(404, 'Laporan kejadian tidak ditemukan');
    await i.update({ status: body.status, reviewNote: body.note, reviewedById: currentUser(req).id, reviewedAt: new Date() });
    res.json({ ok: true });
  }),
);

router.get(
  '/incidents/:id/photos/:idx',
  ah(async (req, res) => {
    const i = await Incident.findByPk(Number(req.params.id));
    const file = i?.photos?.at(Number(req.params.idx));
    if (!i || !file) throw new HttpError(404, 'Foto tidak ditemukan');
    // Foto kejadian bisa memuat data pengunjung (SOP 7.4): hanya pelapor dan peninjau
    if (i.reporterId !== currentUser(req).id && !isReviewer(req)) throw new HttpError(403, 'Tidak berhak melihat foto ini');
    res.sendFile(path.join(parkingUploadDir, path.basename(file)));
  }),
);

export default router;
