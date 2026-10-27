import { QueryTypes } from 'sequelize';
import { AppSetting, Shift, ShiftBreak, ShiftSlot, sequelize } from './models';
import { hhmmToMinutes, minutesToHhmm, witNow } from './utils/time';

/**
 * Migrasi skema untuk database yang SUDAH berjalan (mis. di VPS).
 * sequelize.sync() hanya membuat tabel baru, tidak mengubah tabel lama,
 * jadi perubahan pada tabel lama ditulis di sini. Tiap migrasi dicatat di
 * `schema_migrations` dan hanya dijalankan sekali. Tulis migrasi idempoten.
 */
const MIGRATIONS: { id: string; up: () => Promise<void> }[] = [
  {
    id: '2026-10-28-istirahat-bergantian',
    async up() {
      // 1) Tambah nilai enum KEMBALI (selesai istirahat). ALTER tidak memicu trigger.
      const enumColumns: [string, string][] = [
        ['attendances', 'slot_type'],
        ['audit_logs', 'slot_type'],
        ['shift_slots', 'type'],
      ];
      for (const [table, column] of enumColumns) {
        const rows = await sequelize.query<{ COLUMN_TYPE: string }>(
          'SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
          { replacements: [table, column], type: QueryTypes.SELECT },
        );
        if (rows[0] && !rows[0].COLUMN_TYPE.includes("'KEMBALI'")) {
          await sequelize.query(
            `ALTER TABLE \`${table}\` MODIFY \`${column}\` ENUM('MASUK','ISTIRAHAT','PULANG','KEMBALI') NOT NULL`,
          );
        }
      }

      // 2) Slot ISTIRAHAT lama (jendela tetap) → pengaturan istirahat bergantian per shift.
      //    Rentang diperlebar 1 jam agar cukup untuk dua gelombang.
      for (const shift of await Shift.findAll()) {
        const old = await ShiftSlot.findOne({ where: { shiftId: shift.id, type: 'ISTIRAHAT' } });
        if (!old) continue;
        await ShiftBreak.findOrCreate({
          where: { shiftId: shift.id },
          defaults: {
            shiftId: shift.id,
            enabled: true,
            windowStart: old.windowStart,
            windowEnd: minutesToHhmm(Math.min(hhmmToMinutes(old.windowEnd) + 60, 23 * 60)),
            maxMinutes: 60,
            toleranceMinutes: 15,
          },
        });
        await old.destroy();
      }

      // 3) Absen ISTIRAHAT lama tidak punya pasangan KEMBALI. "Lupa absen kembali" hanya
      //    dihitung mulai tanggal fitur ini aktif, agar riwayat lama tidak ikut ditandai.
      await AppSetting.findOrCreate({
        where: { key: 'breakTrackingSince' },
        defaults: { key: 'breakTrackingSince', value: witNow().date },
      });
    },
  },
];

export async function runMigrations() {
  await sequelize.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (id VARCHAR(100) PRIMARY KEY, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)',
  );
  const done = new Set(
    (await sequelize.query<{ id: string }>('SELECT id FROM schema_migrations', { type: QueryTypes.SELECT })).map((r) => r.id),
  );
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    console.log(`⏳ Migrasi ${m.id}…`);
    await m.up();
    await sequelize.query('INSERT INTO schema_migrations (id) VALUES (?)', { replacements: [m.id] });
    console.log(`✅ Migrasi ${m.id} selesai`);
  }
}
