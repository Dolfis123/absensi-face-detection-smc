import { Op, QueryTypes } from 'sequelize';
import { AppSetting, RosterRule, Shift, ShiftBreak, ShiftSlot, User, sequelize } from './models';
import { rebalancePlacements } from './services/placement';
import { addDays, hhmmToMinutes, minutesToHhmm, witNow } from './utils/time';

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
  {
    id: '2026-10-28-pin-wajah-mirip',
    async up() {
      // Kolom PIN absen untuk karyawan berwajah mirip. ALTER tidak memicu trigger Super Admin.
      const rows = await sequelize.query(
        "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'pin_hash'",
        { type: QueryTypes.SELECT },
      );
      if (rows.length === 0) {
        await sequelize.query('ALTER TABLE `users` ADD COLUMN `pin_hash` VARCHAR(100) NULL AFTER `face_embedding`');
      }
    },
  },
  {
    id: '2026-10-29-hari-off',
    async up() {
      // Hari Off di roster disimpan sebagai baris dengan shift_id NULL. Pastikan kolomnya boleh NULL.
      const rows = await sequelize.query<{ IS_NULLABLE: string; COLUMN_TYPE: string }>(
        "SELECT IS_NULLABLE, COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_schedules' AND COLUMN_NAME = 'shift_id'",
        { type: QueryTypes.SELECT },
      );
      if (rows[0] && rows[0].IS_NULLABLE === 'NO') {
        await sequelize.query(`ALTER TABLE \`employee_schedules\` MODIFY \`shift_id\` ${rows[0].COLUMN_TYPE} NULL`);
      }
    },
  },  {
    id: '2026-10-30-penempatan-pos',
    async up() {
      // Kolom pos penempatan (plotting) pada roster
      const rows = await sequelize.query(
        "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_schedules' AND COLUMN_NAME = 'post'",
        { type: QueryTypes.SELECT },
      );
      if (rows.length === 0) await sequelize.query('ALTER TABLE `employee_schedules` ADD COLUMN `post` VARCHAR(20) NULL DEFAULT NULL');
      // Roster yang sudah tersimpan langsung mendapat penempatan, mulai hari ini
      const today = witNow().date;
      await rebalancePlacements(today, addDays(today, 120));
    },
  },
  {
    id: '2026-10-30-aturan-roster-smc',
    async up() {
      // Aturan roster yang sudah disepakati untuk Pos Parkir Mal SMC. Hanya diisi bila aturan orang itu
      // belum pernah diubah (masih bawaan), supaya isian manual dari layar Aturan Karyawan tidak tertimpa.
      const full = await Shift.findOne({ where: { code: 'SHIFT_PENUH' } });
      const ALL = [0, 1, 2, 3, 4, 5, 6];
      const presets: { name: string; rule: { fixedShiftId: number | null; offDays: number[]; noShift1Days: number[]; noShift2Days: number[] } }[] = [
        { name: 'Nikson%', rule: { fixedShiftId: full?.id ?? null, offDays: [1], noShift1Days: [], noShift2Days: [] } },
        { name: 'Apriando%', rule: { fixedShiftId: null, offDays: ALL, noShift1Days: [], noShift2Days: [1, 2, 3, 5] } },
        { name: 'Mesak%', rule: { fixedShiftId: null, offDays: ALL, noShift1Days: [0], noShift2Days: [] } },
        { name: 'Luis%', rule: { fixedShiftId: null, offDays: ALL, noShift1Days: [0], noShift2Days: [] } },
      ];
      const days = (v: unknown) => (typeof v === 'string' ? (JSON.parse(v) as number[]) : ((v as number[]) ?? []));
      for (const p of presets) {
        const users = await User.findAll({ where: { fullName: { [Op.like]: p.name }, role: ['KARYAWAN', 'KOORDINATOR'] } });
        if (users.length !== 1) continue; // nama tidak ditemukan / ganda → biarkan diatur manual
        const existing = await RosterRule.findByPk(users[0].id);
        const untouched =
          !existing ||
          (days(existing.offDays).length === 7 && days(existing.noShift1Days).length === 0 && days(existing.noShift2Days).length === 0);
        if (untouched) await RosterRule.upsert({ userId: users[0].id, ...p.rule, active: existing?.active ?? true });
      }
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
