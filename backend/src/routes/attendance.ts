import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { Op } from 'sequelize';
import { z } from 'zod';
import {
  Attendance,
  EmployeeSchedule,
  GeofenceSetting,
  Holiday,
  LeaveRequest,
  ATTENDEE_ROLES,
  isFaceOutdated,
  takesBreak,
  parseEmbeddings,
  User,
} from '../models';
import { env } from '../config/env';
import { rankFaces } from '../services/faceClient';
import { decideIdentity, matchPin } from '../services/identity';
import { label, loadShifts, resolveActiveSlot } from '../services/shiftService';
import { haversineMeters } from '../utils/geo';
import { ah, HttpError } from '../utils/http';
import { witNow } from '../utils/time';

/** Endpoint publik untuk tombol "Absen Sekarang" (tanpa login). */
const router = Router();

router.get(
  '/geofence',
  ah(async (_req, res) => {
    const geo = await GeofenceSetting.findByPk(1);
    if (!geo) throw new HttpError(503, 'Titik geofence belum diatur');
    res.json({
      name: geo.name,
      latitude: geo.latitude,
      longitude: geo.longitude,
      radiusMeters: geo.radiusMeters,
      maxAccuracyMeters: geo.maxAccuracyMeters,
    });
  }),
);

router.get('/time', (_req, res) => res.json(witNow()));

const checkSchema = z.object({
  image: z
    .string()
    .startsWith('data:image/', 'Format foto tidak valid')
    .max(4_000_000, 'Ukuran foto terlalu besar'),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().nonnegative(),
  pin: z.string().regex(/^\d{4,6}$/, 'PIN harus 4–6 angka').optional(),
});

const checkLimiter = rateLimit({ windowMs: 60 * 1000, limit: 15, standardHeaders: true, legacyHeaders: false });

router.post(
  '/check',
  checkLimiter,
  ah(async (req, res) => {
    const body = checkSchema.parse(req.body);
    // Jam server — satu-satunya acuan waktu absensi.
    const now = witNow();

    // 1) Geofencing (Haversine, dihitung di server)
    const geo = await GeofenceSetting.findByPk(1);
    if (!geo) throw new HttpError(503, 'Titik geofence belum diatur oleh Super Admin');
    if (body.accuracy > geo.maxAccuracyMeters) {
      throw new HttpError(
        422,
        `Sinyal GPS kurang akurat (±${Math.round(body.accuracy)} m, maks ±${geo.maxAccuracyMeters} m). Tunggu sebentar di area terbuka lalu coba lagi.`,
      );
    }
    const distance = haversineMeters(geo.latitude, geo.longitude, body.latitude, body.longitude);
    if (distance > geo.radiusMeters) {
      throw new HttpError(
        403,
        `Anda berada ${distance.toFixed(1)} m dari titik pos parkir (maks ${geo.radiusMeters} m). Absensi ditolak.`,
      );
    }

    // 2) Hari libur
    const holiday = await Holiday.findOne({ where: { date: now.date } });
    if (holiday) throw new HttpError(409, `Hari ini libur (${holiday.name}). Absensi tidak diperlukan.`);

    // 3) Pencocokan wajah terhadap seluruh karyawan aktif yang sudah terdaftar wajahnya
    const employees = await User.findAll({ where: { role: [...ATTENDEE_ROLES], isActive: true } });
    const candidates = employees
      .map((u) => ({ id: u.id, embeddings: parseEmbeddings(u.faceEmbedding) }))
      .filter((c): c is { id: number; embeddings: number[][] } => c.embeddings !== null);
    // Karyawan dengan data wajah model lama (dlib) belum bisa dikenali sampai daftar ulang
    const needReenroll = employees.some((u) => isFaceOutdated(u.faceEmbedding));
    const reenrollHint = needReenroll ? ' Bila wajah Anda belum didaftarkan ulang setelah pembaruan sistem, hubungi Super Admin.' : '';
    if (candidates.length === 0) throw new HttpError(503, `Belum ada data wajah karyawan yang terdaftar.${reenrollHint}`);

    const ranked = await rankFaces(body.image, candidates);
    const pinUserIds = new Set(employees.filter((u) => u.pinHash).map((u) => u.id));
    const decision = decideIdentity(ranked, pinUserIds, env.faceTolerance);
    let match: { id: number; distance: number };
    if (decision.kind === 'match') {
      match = decision;
    } else if (decision.kind === 'pin') {
      // Wajah mirip karyawan lain (mis. saudara): PIN yang memastikan siapa orangnya
      if (!body.pin) throw new HttpError(428, 'Masukkan PIN absen Anda untuk memastikan identitas.', { needPin: true });
      const pool = decision.pool.map((r) => employees.find((u) => u.id === r.id)!);
      const byPin = await matchPin(body.pin, pool);
      if (!byPin) throw new HttpError(401, 'PIN salah atau wajah tidak sesuai dengan pemilik PIN.', { needPin: true });
      match = decision.pool.find((r) => r.id === byPin.id)!;
    } else if (decision.kind === 'ambiguous') {
      throw new HttpError(401, 'Wajah mirip dengan lebih dari satu karyawan. Hubungi Super Admin untuk mengatur PIN absen.');
    } else {
      throw new HttpError(401, `Wajah tidak dikenali. Pastikan wajah terlihat jelas dan coba lagi.${reenrollHint}`);
    }
    const user = employees.find((u) => u.id === match.id)!;

    // 4) Izin/sakit/cuti yang sudah disetujui mengunci status hari ini
    const leave = await LeaveRequest.findOne({
      where: {
        userId: user.id,
        status: 'APPROVED',
        startDate: { [Op.lte]: now.date },
        endDate: { [Op.gte]: now.date },
      },
    });
    if (leave) throw new HttpError(409, `${user.fullName}, hari ini Anda tercatat ${leave.type}.`);

    // 5) Roster harian → slot aktif
    const schedule = await EmployeeSchedule.findOne({ where: { userId: user.id, date: now.date } });
    if (!schedule) throw new HttpError(409, `${user.fullName}, Anda tidak memiliki jadwal shift hari ini.`);
    const shift = (await loadShifts()).get(schedule.shiftId);
    if (!shift) throw new HttpError(500, 'Data shift tidak ditemukan');

    const existing = await Attendance.findAll({ where: { userId: user.id, date: now.date, active: true } });
    const resolution = resolveActiveSlot(shift, now.minutes, new Map(existing.map((a) => [a.slotType, a])), {
      allowBreak: takesBreak(user.role),
    });
    if (!resolution.ok) throw new HttpError(409, `${user.fullName}: ${resolution.reason}`);

    const record = await Attendance.create({
      userId: user.id,
      shiftId: shift.id,
      date: now.date,
      slotType: resolution.slotType,
      status: resolution.status,
      recordedAt: now.instant,
      localTime: now.time,
      latitude: body.latitude,
      longitude: body.longitude,
      gpsAccuracy: body.accuracy,
      distanceMeters: Number(distance.toFixed(2)),
      faceDistance: Number(match.distance.toFixed(4)),
      source: 'FACE',
    });

    res.status(201).json({
      message: `Absen ${label(record.slotType)} berhasil`,
      employee: { fullName: user.fullName, nik: user.nik },
      shift: shift.name,
      slotType: record.slotType,
      status: record.status,
      date: record.date,
      time: record.localTime,
      distanceMeters: record.distanceMeters,
      // Hanya untuk Selesai Istirahat: lama istirahat & batas yang berlaku
      breakMinutes: resolution.breakMinutes ?? null,
      breakLimitMinutes:
        resolution.slotType === 'KEMBALI' && shift.breakConfig
          ? shift.breakConfig.maxMinutes + shift.breakConfig.toleranceMinutes
          : null,
    });
  }),
);

export default router;
