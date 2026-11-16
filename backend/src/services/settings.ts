import { env } from '../config/env';
import { AppSetting, sequelize, Shift, ShiftChangeLog } from '../models';

const LATE_KEY = 'lateToleranceMinutes';

// Disimpan di memori agar perhitungan slot (dipanggil sangat sering) tetap cepat.
// Satu proses backend, jadi cache ini selalu sama dengan isi database.
let lateToleranceMin = env.lateToleranceMin;

/** Toleransi khusus per shift (id shift → menit); shift yang tidak ada di sini memakai toleransi umum. */
const shiftLate = new Map<number, number>();

/** Toleransi terlambat Absen Masuk: khusus shift bila diatur, selain itu toleransi umum. */
export const getLateTolerance = (shiftId?: number | null) => (shiftId != null ? shiftLate.get(shiftId) : undefined) ?? lateToleranceMin;
export const getGlobalLateTolerance = () => lateToleranceMin;
export function setShiftLateTolerance(shiftId: number, minutes: number | null) {
  if (minutes === null) shiftLate.delete(shiftId);
  else shiftLate.set(shiftId, minutes);
}
/** Semua toleransi per shift, mis. { 1: 60, 2: 30 } (untuk aplikasi karyawan) */
export const shiftLateTolerances = () => Object.fromEntries(shiftLate);

// Tanggal mulai fitur Mulai/Selesai Istirahat. Absen istirahat sebelum tanggal ini
// (format lama, satu tap) tidak dihitung "lupa absen kembali".
let breakTrackingSince = '';
export const getBreakTrackingSince = () => breakTrackingSince;

/** Dipanggil saat startup. Nilai awal diambil dari .env bila belum pernah diatur di dashboard. */
export async function loadSettings() {
  const [row] = await AppSetting.findOrCreate({
    where: { key: LATE_KEY },
    defaults: { key: LATE_KEY, value: String(env.lateToleranceMin) },
  });
  lateToleranceMin = Number(row.value);
  shiftLate.clear();
  for (const sh of await Shift.findAll({ attributes: ['id', 'lateToleranceMin'] })) if (sh.lateToleranceMin != null) shiftLate.set(sh.id, sh.lateToleranceMin);
  breakTrackingSince = (await AppSetting.findByPk('breakTrackingSince'))?.value ?? '';
}

/** Simpan toleransi terlambat + catat di riwayat; cache diperbarui setelah commit berhasil. */
export async function saveLateTolerance(minutes: number, actorId: number) {
  const before = lateToleranceMin;
  await sequelize.transaction(async (transaction) => {
    await AppSetting.upsert({ key: LATE_KEY, value: String(minutes) }, { transaction });
    await ShiftChangeLog.create(
      { actorId, target: 'Toleransi terlambat', before: { minutes: before }, after: { minutes } },
      { transaction },
    );
  });
  lateToleranceMin = minutes;
}
