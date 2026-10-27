import bcrypt from 'bcryptjs';
import { env } from './config/env';
import { GeofenceSetting, Shift, ShiftSlot, User, sequelize } from './models';

const SHIFTS = [
  {
    code: 'SHIFT_1',
    name: 'Shift 1',
    startTime: '08:00',
    endTime: '16:00',
    slots: [
      { type: 'MASUK', windowStart: '07:30', windowEnd: '08:00', sortOrder: 1 },
      { type: 'ISTIRAHAT', windowStart: '12:00', windowEnd: '13:00', sortOrder: 2 },
      { type: 'PULANG', windowStart: '16:00', windowEnd: '16:30', sortOrder: 3 },
    ],
  },
  {
    code: 'SHIFT_2',
    name: 'Shift 2',
    startTime: '16:00',
    endTime: '23:00',
    slots: [
      { type: 'MASUK', windowStart: '15:30', windowEnd: '16:00', sortOrder: 1 },
      { type: 'PULANG', windowStart: '23:00', windowEnd: '23:30', sortOrder: 2 },
    ],
  },
] as const;

/**
 * Trigger MySQL sebagai lapisan kedua (selain hook Sequelize), supaya aturan tetap
 * berlaku walaupun ada yang mengubah database langsung lewat SQL client.
 */
const TRIGGERS: Record<string, string> = {
  attendances_lock_update: `CREATE TRIGGER attendances_lock_update BEFORE UPDATE ON attendances FOR EACH ROW
    BEGIN IF COALESCE(@smc_audit, 0) <> 1 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Data absensi terkunci. Koreksi hanya lewat audit trail Super Admin.';
    END IF; END`,
  attendances_lock_delete: `CREATE TRIGGER attendances_lock_delete BEFORE DELETE ON attendances FOR EACH ROW
    BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Data absensi tidak boleh dihapus.'; END`,
  audit_logs_lock_update: `CREATE TRIGGER audit_logs_lock_update BEFORE UPDATE ON audit_logs FOR EACH ROW
    BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Audit log tidak boleh diubah.'; END`,
  audit_logs_lock_delete: `CREATE TRIGGER audit_logs_lock_delete BEFORE DELETE ON audit_logs FOR EACH ROW
    BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Audit log tidak boleh dihapus.'; END`,
  users_single_superadmin: `CREATE TRIGGER users_single_superadmin BEFORE INSERT ON users FOR EACH ROW
    BEGIN IF NEW.role = 'SUPER_ADMIN' AND (SELECT COUNT(*) FROM users WHERE role = 'SUPER_ADMIN') > 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Akun Super Admin hanya boleh ada satu.';
    END IF; END`,
  users_superadmin_immutable: `CREATE TRIGGER users_superadmin_immutable BEFORE UPDATE ON users FOR EACH ROW
    BEGIN IF OLD.role = 'SUPER_ADMIN' OR NEW.role = 'SUPER_ADMIN' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Akun Super Admin bersifat permanen dan tidak dapat diubah.';
    END IF; END`,
  users_superadmin_undeletable: `CREATE TRIGGER users_superadmin_undeletable BEFORE DELETE ON users FOR EACH ROW
    BEGIN IF OLD.role = 'SUPER_ADMIN' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Akun Super Admin bersifat permanen dan tidak dapat dihapus.';
    END IF; END`,
};

async function installTriggers() {
  for (const [name, sql] of Object.entries(TRIGGERS)) {
    try {
      await sequelize.query(`DROP TRIGGER IF EXISTS ${name}`);
      await sequelize.query(sql);
    } catch (err) {
      console.warn(`⚠️  Gagal memasang trigger ${name} (butuh hak TRIGGER di MySQL):`, (err as Error).message);
    }
  }
}

async function seedShifts() {
  for (const { slots, ...shift } of SHIFTS) {
    const [row] = await Shift.findOrCreate({ where: { code: shift.code }, defaults: shift });
    for (const slot of slots) {
      await ShiftSlot.findOrCreate({ where: { shiftId: row.id, type: slot.type }, defaults: { ...slot, shiftId: row.id } });
    }
  }
}

async function seedSuperAdmin() {
  if ((await User.count({ where: { role: 'SUPER_ADMIN' } })) > 0) return;
  const { password, ...sa } = env.superAdmin;
  if (password.length < 10) {
    throw new Error('SUPER_ADMIN_PASSWORD wajib diisi (min. 10 karakter) sebelum database pertama kali disiapkan');
  }
  await User.create({
    ...sa,
    passwordHash: await bcrypt.hash(password, 12),
    role: 'SUPER_ADMIN',
    defaultShiftId: null,
  });
  console.log(`✅ Super Admin "${sa.username}" dibuat (permanen, tidak dapat diubah).`);
}

async function seedGeofence() {
  if (await GeofenceSetting.findByPk(1)) return;
  await GeofenceSetting.create({ id: 1, name: 'Pos Parkir Mal SMC Sorong', ...env.geofenceDefault });
  console.warn('⚠️  Koordinat geofence masih PLACEHOLDER. Atur titik sebenarnya lewat menu Geofence Super Admin.');
}

export async function bootstrap() {
  await sequelize.authenticate();
  // Untuk produksi disarankan memakai migrasi (sequelize-cli); sync() hanya membuat tabel yang belum ada.
  await sequelize.sync();
  await installTriggers();
  await seedShifts();
  await seedSuperAdmin();
  await seedGeofence();
}
