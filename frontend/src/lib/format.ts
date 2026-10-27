import { DayStatus, Role, SlotType } from './api';

export const ROLE_LABEL: Record<Role, string> = {
  SUPER_ADMIN: 'Super Admin',
  KOORDINATOR: 'Koordinator Lapangan',
  KARYAWAN: 'Karyawan Parkir',
};

export const SLOT_LABEL: Record<SlotType, string> = {
  MASUK: 'Masuk',
  ISTIRAHAT: 'Mulai Istirahat',
  KEMBALI: 'Selesai Istirahat',
  PULANG: 'Pulang',
};

/** Urutan tampilan absen dalam sehari. */
export const SLOT_ORDER: SlotType[] = ['MASUK', 'ISTIRAHAT', 'KEMBALI', 'PULANG'];

export const fmtMinutes = (m: number) => {
  if (m < 60) return `${m} menit`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} jam ${m % 60} menit` : `${h} jam`;
};

export interface StatusStyle {
  label: string;
  cls: string;
  dot: string;
}

export const STATUS_STYLE: Record<DayStatus, StatusStyle> = {
  TEPAT_WAKTU: { label: 'Tepat Waktu', cls: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/15', dot: 'bg-emerald-500' },
  TERLAMBAT: { label: 'Terlambat', cls: 'bg-amber-50 text-amber-800 ring-1 ring-amber-600/20', dot: 'bg-amber-500' },
  ALFA: { label: 'Alfa', cls: 'bg-rose-50 text-rose-700 ring-1 ring-rose-600/15', dot: 'bg-rose-500' },
  IZIN: { label: 'Izin', cls: 'bg-sky-50 text-sky-700 ring-1 ring-sky-600/15', dot: 'bg-sky-500' },
  SAKIT: { label: 'Sakit', cls: 'bg-violet-50 text-violet-700 ring-1 ring-violet-600/15', dot: 'bg-violet-500' },
  CUTI: { label: 'Cuti', cls: 'bg-indigo-50 text-indigo-700 ring-1 ring-indigo-600/15', dot: 'bg-indigo-500' },
  LIBUR: { label: 'Libur', cls: 'bg-slate-100 text-slate-700 ring-1 ring-slate-500/15', dot: 'bg-slate-500' },
  OFF: { label: 'Tidak Dijadwalkan', cls: 'bg-slate-50 text-slate-500 ring-1 ring-slate-500/10', dot: 'bg-slate-300' },
  BELUM: { label: 'Belum Absen', cls: 'bg-slate-100 text-slate-600 ring-1 ring-slate-500/15', dot: 'bg-slate-400' },
};

export const REQUEST_STATUS: Record<string, StatusStyle> = {
  PENDING: { label: 'Menunggu', cls: 'bg-amber-50 text-amber-800 ring-1 ring-amber-600/20', dot: 'bg-amber-500' },
  APPROVED: { label: 'Disetujui', cls: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/15', dot: 'bg-emerald-500' },
  REJECTED: { label: 'Ditolak', cls: 'bg-rose-50 text-rose-700 ring-1 ring-rose-600/15', dot: 'bg-rose-500' },
  OPEN: { label: 'Baru', cls: 'bg-amber-50 text-amber-800 ring-1 ring-amber-600/20', dot: 'bg-amber-500' },
  REVIEWED: { label: 'Ditinjau', cls: 'bg-sky-50 text-sky-700 ring-1 ring-sky-600/15', dot: 'bg-sky-500' },
  ESCALATED: { label: 'Diteruskan ke Admin', cls: 'bg-violet-50 text-violet-700 ring-1 ring-violet-600/15', dot: 'bg-violet-500' },
  RESOLVED: { label: 'Selesai', cls: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/15', dot: 'bg-emerald-500' },
};

/** Sapaan sesuai jam WIT. */
export function greeting(minutes: number) {
  if (minutes < 11 * 60) return 'Selamat pagi';
  if (minutes < 15 * 60) return 'Selamat siang';
  if (minutes < 18 * 60) return 'Selamat sore';
  return 'Selamat malam';
}

const DAYS = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

export function fmtDate(iso: string, withDay = true) {
  const d = new Date(`${iso}T00:00:00`);
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  return withDay ? `${DAYS[d.getDay()]}, ${base}` : base;
}

export const shortDay = (iso: string) => {
  const d = new Date(`${iso}T00:00:00`);
  return { day: DAYS[d.getDay()], num: d.getDate(), weekend: d.getDay() === 0 };
};

/** Tanggal hari ini menurut WIT (UTC+9), independen dari zona waktu perangkat. */
export function todayWIT() {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

export function addDays(iso: string, n: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Senin pada minggu yang sama. */
export function mondayOf(iso: string) {
  const d = new Date(`${iso}T00:00:00Z`);
  const shift = (d.getUTCDay() + 6) % 7;
  return addDays(iso, -shift);
}

export function haversine(lat1: number, lon1: number, lat2: number, lon2: number) {
  const r = (x: number) => (x * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(a));
}
