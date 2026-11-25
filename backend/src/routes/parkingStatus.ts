/**
 * Laporan update parkiran untuk pimpinan (biasanya tiap ±2 jam) — dibuat Koordinator / Super Admin.
 * Petugas mengisi jumlah kendaraan yang sedang terisi dan yang sudah keluar (kumulatif sejak buka);
 * sistem menghitung lot kosong, persentase keterisian, kendaraan masuk, perubahan sejak laporan
 * sebelumnya, lalu menyusun teks siap tempel ke WhatsApp.
 */
import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireRole } from '../middleware/auth';
import { AppSetting, ParkingStatusReport, User } from '../models';
import { getOrgSettings } from '../services/organization';
import { fmtLongDate } from '../services/pdfReport';
import { ah, HttpError } from '../utils/http';
import { DATE_RE, witNow } from '../utils/time';

const router = Router();
router.use(requireRole('KOORDINATOR', 'SUPER_ADMIN'));

interface Settings {
  capacityCar: number;
  capacityMotor: number;
}
const DEFAULT: Settings = { capacityCar: 345, capacityMotor: 200 };
const KEY = 'parkingStatusSettings';
async function getSettings(): Promise<Settings> {
  const row = await AppSetting.findByPk(KEY);
  try {
    return row ? { ...DEFAULT, ...(JSON.parse(row.value) as Partial<Settings>) } : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

const DAY = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const pct = (n: number, cap: number) => (cap ? Math.round((n / cap) * 100) : 0);
const num = (n: number) => n.toLocaleString('id-ID');
const signed = (n: number) => (n > 0 ? `+${num(n)}` : n < 0 ? `−${num(-n)}` : '0');
function status(p: number) {
  if (p >= 100) return '🔴 PENUH';
  if (p >= 85) return '🔴 Hampir penuh';
  if (p >= 50) return '🟡 Ramai';
  return '🟢 Longgar';
}
function greeting(time: string) {
  const h = Number(time.slice(0, 2));
  return h < 11 ? 'pagi' : h < 15 ? 'siang' : h < 18 ? 'sore' : 'malam';
}

type R = ParkingStatusReport;
/** Teks laporan siap tempel ke WhatsApp. */
async function reportText(r: R, prev: R | null, order: number, reporter: string, reporterRole: string) {
  const org = await getOrgSettings();
  const place = org.placeShort ? `MALL ${org.placeShort.toUpperCase()}` : org.placeName.toUpperCase();
  const d = r.date;
  const section = (label: string, icon: string, parked: number, out: number, cap: number, prevParked: number | null, prevOut: number | null) => {
    const lines = [
      `${icon} *${label}*`,
      `• Terisi: *${num(parked)}* dari ${num(cap)} lot (${pct(parked, cap)}%)`,
      `• Lot kosong: *${num(Math.max(0, cap - parked))}* lot`,
      `• Keluar hari ini: ${num(out)} unit`,
      `• Masuk hari ini: ${num(parked + out)} unit`,
    ];
    if (prevParked !== null && prevOut !== null) {
      lines.push(`• Sejak pukul ${prev!.time.replace(':', '.')}: terisi ${signed(parked - prevParked)}, keluar ${signed(out - prevOut)}`);
    }
    return lines;
  };
  const totalParked = r.carParked + r.motorParked;
  const totalCap = r.capacityCar + r.capacityMotor;
  const out = [
    `🅿️ *LAPORAN UPDATE PARKIRAN — ${place}*`,
    '',
    `Selamat ${greeting(r.time)}, Pimpinan. Izin melaporkan 🙏`,
    '',
    `📅 ${DAY[new Date(`${d}T00:00:00Z`).getUTCDay()]}, ${fmtLongDate(d)}`,
    `⏰ Pukul ${r.time.replace(':', '.')} WIT · laporan ke-${order} hari ini`,
    '',
    ...section('MOBIL', '🚗', r.carParked, r.carOut, r.capacityCar, prev?.carParked ?? null, prev?.carOut ?? null),
    `• Kondisi: ${status(pct(r.carParked, r.capacityCar))}`,
    '',
    ...section('MOTOR', '🏍️', r.motorParked, r.motorOut, r.capacityMotor, prev?.motorParked ?? null, prev?.motorOut ?? null),
    `• Kondisi: ${status(pct(r.motorParked, r.capacityMotor))}`,
    '',
    '📊 *RINGKASAN*',
    `• Kendaraan di area parkir: ${num(totalParked)} unit (${pct(totalParked, totalCap)}% dari ${num(totalCap)} lot)`,
    `• Total masuk hari ini: ${num(totalParked + r.carOut + r.motorOut)} unit`,
    `• Total keluar hari ini: ${num(r.carOut + r.motorOut)} unit`,
  ];
  if (r.note) out.push('', `📝 Catatan: ${r.note}`);
  out.push('', 'Demikian laporan dari Tim Parkir. Terima kasih 🙏', '', 'TTD,', `${reporterRole},`, '', `*${reporter}*`);
  return out.join('\n');
}

async function dayReports(date: string) {
  const rows = await ParkingStatusReport.findAll({ where: { date }, order: [['time', 'ASC'], ['id', 'ASC']] });
  const users = await User.findAll({ where: { id: [...new Set(rows.map((r) => r.createdById))].concat(0) }, attributes: ['id', 'fullName', 'role'] });
  const org = await getOrgSettings();
  // Laporan selalu ditandatangani Koordinator Lapangan; bila dibuat Super Admin, nama Koordinator yang aktif dipakai
  const coordinator = await User.findOne({ where: { role: 'KOORDINATOR', isActive: true }, attributes: ['fullName'], order: [['id', 'ASC']] });
  const title = org.coordinatorTitle || 'Koordinator Lapangan';
  return Promise.all(
    rows.map(async (r, i) => {
      const u = users.find((x) => x.id === r.createdById);
      const signer = u?.role === 'KOORDINATOR' ? u.fullName : (coordinator?.fullName ?? u?.fullName ?? '-');
      return {
        id: r.id,
        date: r.date,
        time: r.time,
        carParked: r.carParked,
        motorParked: r.motorParked,
        carOut: r.carOut,
        motorOut: r.motorOut,
        capacityCar: r.capacityCar,
        capacityMotor: r.capacityMotor,
        note: r.note,
        createdBy: u?.fullName ?? '?',
        createdById: r.createdById,
        text: await reportText(r, rows[i - 1] ?? null, i + 1, signer, title),
      };
    }),
  );
}

router.get(
  '/',
  ah(async (req, res) => {
    const date = z.string().regex(DATE_RE).default(witNow().date).parse(req.query.date);
    res.json({ date, settings: await getSettings(), reports: await dayReports(date) });
  }),
);

router.post(
  '/',
  ah(async (req, res) => {
    const n = z.number().int().min(0).max(100_000);
    const body = z
      .object({
        time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Format jam HH:MM').optional(),
        carParked: n,
        motorParked: n,
        carOut: n,
        motorOut: n,
        note: z.string().trim().max(300).optional(),
      })
      .parse(req.body);
    const now = witNow();
    const s = await getSettings();
    if (body.carParked > s.capacityCar) throw new HttpError(400, `Mobil terisi (${body.carParked}) melebihi kapasitas ${s.capacityCar} lot`);
    if (body.motorParked > s.capacityMotor) throw new HttpError(400, `Motor terisi (${body.motorParked}) melebihi kapasitas ${s.capacityMotor} lot`);
    const r = await ParkingStatusReport.create({
      date: now.date,
      time: body.time ?? now.time.slice(0, 5),
      carParked: body.carParked,
      motorParked: body.motorParked,
      carOut: body.carOut,
      motorOut: body.motorOut,
      capacityCar: s.capacityCar,
      capacityMotor: s.capacityMotor,
      note: body.note || null,
      createdById: currentUser(req).id,
    });
    const reports = await dayReports(now.date);
    res.status(201).json(reports.find((x) => x.id === r.id));
  }),
);

router.delete(
  '/:id',
  ah(async (req, res) => {
    const r = await ParkingStatusReport.findByPk(Number(req.params.id));
    if (!r) throw new HttpError(404, 'Laporan tidak ditemukan');
    const me = currentUser(req);
    if (me.role !== 'SUPER_ADMIN' && (r.createdById !== me.id || r.date !== witNow().date)) throw new HttpError(403, 'Hanya laporan Anda hari ini yang bisa dihapus');
    await r.destroy();
    res.status(204).end();
  }),
);

router.put(
  '/settings',
  requireRole('SUPER_ADMIN'),
  ah(async (req, res) => {
    const s = z.object({ capacityCar: z.number().int().min(1).max(100_000), capacityMotor: z.number().int().min(1).max(100_000) }).parse(req.body);
    await AppSetting.upsert({ key: KEY, value: JSON.stringify(s) });
    res.json(s);
  }),
);

export default router;
