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
    // Paling awal juga: migrasi lama membaca tabel shifts lewat model, jadi kolom barunya harus ada lebih dulu.
    // Toleransi terlambat per shift: Shift 1 & Shift Penuh sampai 09.00 (60 menit), Shift Siang sampai 14.30
    // dan Shift 2 sampai 16.30 (30 menit). Tidak menyentuh tabel users / data wajah.
    id: '2026-11-16-toleransi-terlambat-per-shift',
    async up() {
      const cols = await sequelize.query<{ COLUMN_NAME: string }>(
        "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shifts'",
        { type: QueryTypes.SELECT },
      );
      if (!cols.some((c) => c.COLUMN_NAME === 'late_tolerance_min')) {
        await sequelize.query('ALTER TABLE `shifts` ADD COLUMN `late_tolerance_min` SMALLINT UNSIGNED NULL');
      }
      for (const [code, minutes] of [['SHIFT_1', 60], ['SHIFT_PENUH', 60], ['SHIFT_SIANG', 30], ['SHIFT_2', 30]] as const) {
        await sequelize.query('UPDATE `shifts` SET `late_tolerance_min` = ? WHERE `code` = ?', { replacements: [minutes, code] });
      }
    },
  },
  {
    // Paling awal: migrasi lain (mis. aturan roster SMC) membaca tabel roster_rules lewat model,
    // jadi kolom barunya harus sudah ada lebih dulu — juga untuk database yang dipulihkan dari backup lama.
    id: '2026-11-15-roster-rules-kolom-siang',
    async up() {
      // Kolom aturan baru di roster_rules (tidak menyentuh tabel users / data wajah)
      const cols = await sequelize.query<{ COLUMN_NAME: string }>(
        "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'roster_rules'",
        { type: QueryTypes.SELECT },
      );
      const has = new Set(cols.map((c) => c.COLUMN_NAME));
      if (!has.has('no_siang_days')) await sequelize.query("ALTER TABLE `roster_rules` ADD COLUMN `no_siang_days` JSON NULL");
      await sequelize.query("UPDATE `roster_rules` SET `no_siang_days` = '[]' WHERE `no_siang_days` IS NULL");
      if (!has.has('female')) await sequelize.query('ALTER TABLE `roster_rules` ADD COLUMN `female` TINYINT(1) NOT NULL DEFAULT 0');
    },
  },
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
    id: '2026-11-02-app-settings-text',
    async up() {
      // Daftar pos penempatan & pengaturan parkir disimpan sebagai JSON yang bisa > 255 karakter
      const rows = await sequelize.query<{ DATA_TYPE: string }>(
        "SELECT DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'app_settings' AND COLUMN_NAME = 'value'",
        { type: QueryTypes.SELECT },
      );
      if (rows[0] && rows[0].DATA_TYPE !== 'text') await sequelize.query('ALTER TABLE `app_settings` MODIFY `value` TEXT NOT NULL');
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
  {
    id: '2026-11-15-shift-siang-aturan',
    async up() {
      // Aturan yang disepakati: Putri perempuan (tidak Shift Siang, tidak di area parkiran) dan
      // hari Minggu wajib Shift 1 (tidak Shift 2); Apriando Senin/Selasa/Rabu/Jumat hanya Shift 1
      const ALL = [0, 1, 2, 3, 4, 5, 6];
      const days = (v: unknown) => (typeof v === 'string' ? (JSON.parse(v) as number[]) : ((v as number[]) ?? []));
      const presets: { name: string; set: { female?: boolean; noSiangDays?: number[] }; addNoShift2?: number[] }[] = [
        { name: 'Putri%', set: { female: true, noSiangDays: ALL }, addNoShift2: [0] },
        { name: 'Apriando%', set: { noSiangDays: [1, 2, 3, 5] } },
      ];
      for (const p of presets) {
        const users = await User.findAll({ where: { fullName: { [Op.like]: p.name }, role: ['KARYAWAN', 'KOORDINATOR'] } });
        if (users.length !== 1) continue; // nama tidak ditemukan / ganda → diatur manual
        const existing = await RosterRule.findByPk(users[0].id);
        // Hari "tidak Shift 2" ditambahkan ke isian yang sudah ada, tidak menimpanya
        const noShift2Days = [...new Set([...days(existing?.noShift2Days), ...(p.addNoShift2 ?? [])])].sort();
        if (existing) await existing.update({ ...p.set, noShift2Days });
        else await RosterRule.create({ userId: users[0].id, fixedShiftId: null, offDays: ALL, noShift1Days: [], noShift2Days, noSiangDays: [], female: false, active: true, ...p.set });
      }
    },
  },
  {
    id: '2026-11-16-apriando-off-jumat',
    async up() {
      // Apriando libur (Off) hanya hari Jumat
      const users = await User.findAll({ where: { fullName: { [Op.like]: 'Apriando%' }, role: ['KARYAWAN', 'KOORDINATOR'] } });
      if (users.length !== 1) return; // nama tidak ditemukan / ganda → diatur manual di Aturan Karyawan
      const existing = await RosterRule.findByPk(users[0].id);
      if (existing) await existing.update({ offDays: [5] });
      else
        await RosterRule.create({ userId: users[0].id, fixedShiftId: null, offDays: [5], noShift1Days: [], noShift2Days: [1, 2, 3, 5], noSiangDays: [1, 2, 3, 5], female: false, active: true });
    },
  },
  {
    id: '2026-11-16-apriando-sabtu-minggu-shift2',
    async up() {
      // Apriando: Sabtu & Minggu wajib Shift 2 (tidak Shift 1, tidak Shift Siang); Sen/Sel/Rab Shift 1; Jumat Off; Kamis bebas
      const users = await User.findAll({ where: { fullName: { [Op.like]: 'Apriando%' }, role: ['KARYAWAN', 'KOORDINATOR'] } });
      if (users.length !== 1) return; // nama tidak ditemukan / ganda → diatur manual di Aturan Karyawan
      const rule = { offDays: [5], noShift1Days: [0, 6], noShift2Days: [1, 2, 3, 5], noSiangDays: [0, 1, 2, 3, 5, 6] };
      const existing = await RosterRule.findByPk(users[0].id);
      if (existing) await existing.update(rule);
      else await RosterRule.create({ userId: users[0].id, fixedShiftId: null, female: false, active: true, ...rule });
    },
  },
  {
    id: '2026-11-16-putri-tidak-off-minggu',
    async up() {
      // Putri: hari Minggu selalu masuk Shift 1 — tidak boleh Off di hari Minggu
      const users = await User.findAll({ where: { fullName: { [Op.like]: 'Putri%' }, role: ['KARYAWAN', 'KOORDINATOR'] } });
      if (users.length !== 1) return; // nama tidak ditemukan / ganda → diatur manual di Aturan Karyawan
      const ALL = [0, 1, 2, 3, 4, 5, 6];
      const existing = await RosterRule.findByPk(users[0].id);
      const days = (v: unknown) => (typeof v === 'string' ? (JSON.parse(v) as number[]) : ((v as number[]) ?? ALL));
      const offDays = (existing ? days(existing.offDays) : ALL).filter((d) => d !== 0);
      if (existing) await existing.update({ offDays });
      else await RosterRule.create({ userId: users[0].id, fixedShiftId: null, offDays, noShift1Days: [], noShift2Days: [0], noSiangDays: ALL, female: true, active: true });
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
