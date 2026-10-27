import { env } from '../config/env';
import { AppSetting, sequelize, ShiftChangeLog } from '../models';

const LATE_KEY = 'lateToleranceMinutes';

// Disimpan di memori agar perhitungan slot (dipanggil sangat sering) tetap cepat.
// Satu proses backend, jadi cache ini selalu sama dengan isi database.
let lateToleranceMin = env.lateToleranceMin;

export const getLateTolerance = () => lateToleranceMin;

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
