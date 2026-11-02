import {
  CreationOptional,
  DataTypes,
  ForeignKey,
  InferAttributes,
  InferCreationAttributes,
  Model,
  NonAttribute,
} from 'sequelize';
import { sequelize } from '../config/database';
import { AUDIT_TOKEN, AuditOptions } from '../utils/audit';
import { HttpError } from '../utils/http';

export const ROLES = ['SUPER_ADMIN', 'KOORDINATOR', 'KARYAWAN'] as const;
export type Role = (typeof ROLES)[number];
/** Role yang wajib absen dengan wajah (Super Admin tidak absen). */
export const ATTENDEE_ROLES = ['KARYAWAN', 'KOORDINATOR'] as const;
export const isAttendee = (role: Role) => (ATTENDEE_ROLES as readonly Role[]).includes(role);
/** Hanya Karyawan Parkir yang absen istirahat; Koordinator cukup Masuk & Pulang. */
export const takesBreak = (role: Role) => role === 'KARYAWAN';
// ISTIRAHAT = mulai istirahat, KEMBALI = selesai istirahat. KEMBALI ditaruh di akhir agar
// ALTER ENUM pada database lama cukup menambah nilai baru (lihat migrations.ts).
export const SLOT_TYPES = ['MASUK', 'ISTIRAHAT', 'PULANG', 'KEMBALI'] as const;
export type SlotType = (typeof SLOT_TYPES)[number];
/** Slot dengan jendela tetap (shift_slots). Istirahat diatur terpisah lewat ShiftBreak. */
export type FixedSlotType = 'MASUK' | 'PULANG';
export const LEAVE_TYPES = ['IZIN', 'SAKIT', 'CUTI'] as const;
export type LeaveType = (typeof LEAVE_TYPES)[number];
export const ISSUE_STATUSES = ['OPEN', 'REVIEWED', 'ESCALATED', 'RESOLVED', 'REJECTED'] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

// ───────────────────────────── Shift & slot absensi ─────────────────────────────
export class Shift extends Model<InferAttributes<Shift>, InferCreationAttributes<Shift>> {
  declare id: CreationOptional<number>;
  declare code: string;
  declare name: string;
  declare startTime: string; // HH:MM WIT
  declare endTime: string;
  declare slots?: NonAttribute<ShiftSlot[]>;
  declare breakConfig?: NonAttribute<ShiftBreak | null>;
}
Shift.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    code: { type: DataTypes.STRING(20), allowNull: false, unique: true },
    name: { type: DataTypes.STRING(50), allowNull: false },
    startTime: { type: DataTypes.STRING(5), allowNull: false },
    endTime: { type: DataTypes.STRING(5), allowNull: false },
  },
  { sequelize, tableName: 'shifts' },
);

export class ShiftSlot extends Model<InferAttributes<ShiftSlot>, InferCreationAttributes<ShiftSlot>> {
  declare id: CreationOptional<number>;
  declare shiftId: ForeignKey<number>;
  declare type: SlotType;
  declare windowStart: string;
  declare windowEnd: string;
  declare sortOrder: number;
}
ShiftSlot.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    type: { type: DataTypes.ENUM(...SLOT_TYPES), allowNull: false },
    windowStart: { type: DataTypes.STRING(5), allowNull: false },
    windowEnd: { type: DataTypes.STRING(5), allowNull: false },
    sortOrder: { type: DataTypes.TINYINT, allowNull: false },
  },
  { sequelize, tableName: 'shift_slots', indexes: [{ unique: true, fields: ['shift_id', 'type'] }] },
);

/**
 * Istirahat bergantian per shift: karyawan tap "Mulai Istirahat" kapan saja di dalam
 * rentang [windowStart, windowEnd], lalu tap "Selesai Istirahat" saat kembali ke pos.
 * Durasi > maxMinutes + toleranceMinutes ditandai "Istirahat lebih".
 */
export class ShiftBreak extends Model<InferAttributes<ShiftBreak>, InferCreationAttributes<ShiftBreak>> {
  declare shiftId: number;
  declare enabled: boolean;
  declare windowStart: string;
  declare windowEnd: string;
  declare maxMinutes: number;
  declare toleranceMinutes: number;
  declare updatedAt: CreationOptional<Date>;
}
ShiftBreak.init(
  {
    shiftId: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    windowStart: { type: DataTypes.STRING(5), allowNull: false },
    windowEnd: { type: DataTypes.STRING(5), allowNull: false },
    maxMinutes: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false },
    toleranceMinutes: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false },
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'shift_breaks', createdAt: false },
);

// ───────────────────────────── Pengguna ─────────────────────────────
export class User extends Model<InferAttributes<User>, InferCreationAttributes<User>> {
  declare id: CreationOptional<number>;
  declare fullName: string;
  declare nik: string;
  declare username: string;
  declare passwordHash: string;
  declare role: Role;
  declare phone: string;
  declare defaultShiftId: ForeignKey<number> | null;
  // { model, vectors } — lihat StoredFace. Data dlib lama (array polos) perlu daftar ulang.
  declare faceEmbedding: CreationOptional<StoredFace | number[][] | number[] | null>;
  // PIN absen (bcrypt) — wajib untuk karyawan yang wajahnya mirip karyawan lain (mis. saudara)
  declare pinHash: CreationOptional<string | null>;
  declare isActive: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare defaultShift?: NonAttribute<Shift>;

  toPublic() {
    return {
      id: this.id,
      fullName: this.fullName,
      nik: this.nik,
      username: this.username,
      role: this.role,
      phone: this.phone,
      defaultShiftId: this.defaultShiftId,
      isActive: this.isActive,
      hasFace: parseEmbeddings(this.faceEmbedding) !== null,
      faceCount: parseEmbeddings(this.faceEmbedding)?.length ?? 0,
      faceOutdated: isFaceOutdated(this.faceEmbedding),
      hasPin: !!this.pinHash,
      immutable: this.role === 'SUPER_ADMIN',
    };
  }
}
User.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    fullName: { type: DataTypes.STRING(120), allowNull: false },
    nik: { type: DataTypes.STRING(40), allowNull: false, unique: true },
    username: { type: DataTypes.STRING(50), allowNull: false, unique: true },
    passwordHash: { type: DataTypes.STRING(100), allowNull: false },
    role: { type: DataTypes.ENUM(...ROLES), allowNull: false },
    phone: { type: DataTypes.STRING(20), allowNull: false },
    faceEmbedding: { type: DataTypes.JSON, allowNull: true },
    pinHash: { type: DataTypes.STRING(100), allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'users',
    hooks: {
      // Aturan mutlak: Super Admin hanya satu dan tidak bisa diedit/dihapus.
      // (Diperkuat juga oleh trigger MySQL di bootstrap.ts.)
      async beforeCreate(user) {
        if (user.role === 'SUPER_ADMIN') {
          const exists = await User.count({ where: { role: 'SUPER_ADMIN' } });
          if (exists > 0) throw new HttpError(403, 'Akun Super Admin hanya boleh ada satu');
        }
      },
      beforeUpdate(user) {
        if (user.previous('role') === 'SUPER_ADMIN' || user.role === 'SUPER_ADMIN') {
          throw new HttpError(403, 'Akun Super Admin bersifat permanen dan tidak dapat diubah');
        }
      },
      beforeDestroy(user) {
        if (user.role === 'SUPER_ADMIN') {
          throw new HttpError(403, 'Akun Super Admin bersifat permanen dan tidak dapat dihapus');
        }
      },
      beforeBulkUpdate(options) {
        (options as { individualHooks?: boolean }).individualHooks = true;
      },
      beforeBulkDestroy(options) {
        (options as { individualHooks?: boolean }).individualHooks = true;
      },
    },
  },
);

/** Model pengenal wajah yang dipakai face-service sekarang (lihat face-service/app.py). */
export const FACE_MODEL = 'sface-2021dec';

/** Format simpanan data wajah: { model, vectors }. Data dlib lama berupa array polos. */
export interface StoredFace {
  model: string;
  vectors: number[][];
}

const readFace = (raw: unknown): unknown => (typeof raw === 'string' ? JSON.parse(raw) : raw);

/**
 * Embedding wajah yang COCOK dengan model sekarang, atau null.
 * Data dari model lama (dlib) tidak bisa dibandingkan dengan model baru → dianggap belum terdaftar.
 */
export function parseEmbeddings(raw: unknown): number[][] | null {
  const value = readFace(raw) as Partial<StoredFace> | null;
  if (!value || Array.isArray(value) || value.model !== FACE_MODEL || !value.vectors?.length) return null;
  return value.vectors;
}

/** Ada data wajah, tapi dari model lama → karyawan perlu daftar ulang wajah. */
export function isFaceOutdated(raw: unknown): boolean {
  return readFace(raw) != null && parseEmbeddings(raw) === null;
}

// ───────────────────────────── Roster harian (shift dinamis) ─────────────────────────────
export class EmployeeSchedule extends Model<
  InferAttributes<EmployeeSchedule>,
  InferCreationAttributes<EmployeeSchedule>
> {
  declare id: CreationOptional<number>;
  declare userId: ForeignKey<number>;
  // null = hari Off (libur pribadi) yang ditetapkan di roster; berbeda dengan tanggal tanpa baris (belum dijadwalkan)
  declare shiftId: ForeignKey<number | null>;
  declare date: string;
  /** Kode pos penempatan (plotting), mis. "CK"; diisi otomatis secara bergilir. null = tanpa penempatan. */
  declare post: CreationOptional<string | null>;
  declare shift?: NonAttribute<Shift>;
}
EmployeeSchedule.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    date: { type: DataTypes.DATEONLY, allowNull: false },
    post: { type: DataTypes.STRING(20), allowNull: true, defaultValue: null },
  },
  {
    sequelize,
    tableName: 'employee_schedules',
    indexes: [{ unique: true, fields: ['user_id', 'date'] }],
  },
);

// ───────────────────────────── Absensi (immutable) ─────────────────────────────
export class Attendance extends Model<InferAttributes<Attendance>, InferCreationAttributes<Attendance>> {
  declare id: CreationOptional<number>;
  declare userId: ForeignKey<number>;
  declare shiftId: ForeignKey<number>;
  declare date: string;
  declare slotType: SlotType;
  declare status: 'TEPAT_WAKTU' | 'TERLAMBAT';
  declare recordedAt: Date; // jam server (UTC)
  declare localTime: string; // HH:MM:SS WIT
  declare latitude: number | null;
  declare longitude: number | null;
  declare gpsAccuracy: number | null;
  declare distanceMeters: number | null;
  declare faceDistance: number | null;
  declare source: 'FACE' | 'CORRECTION';
  // 1 = aktif, NULL = dibatalkan lewat koreksi audit. NULL tidak ikut unique index,
  // sehingga koreksi bisa menambahkan catatan pengganti tanpa menghapus jejak lama.
  declare active: CreationOptional<boolean | null>;
  declare createdAt: CreationOptional<Date>;
}
const blockUnaudited = (options: AuditOptions) => {
  if (options.auditToken !== AUDIT_TOKEN) {
    throw new HttpError(403, 'Data absensi terkunci. Koreksi hanya lewat audit trail Super Admin.');
  }
};
Attendance.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, autoIncrement: true, primaryKey: true },
    date: { type: DataTypes.DATEONLY, allowNull: false },
    slotType: { type: DataTypes.ENUM(...SLOT_TYPES), allowNull: false },
    status: { type: DataTypes.ENUM('TEPAT_WAKTU', 'TERLAMBAT'), allowNull: false },
    recordedAt: { type: DataTypes.DATE, allowNull: false },
    localTime: { type: DataTypes.STRING(8), allowNull: false },
    latitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    longitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    gpsAccuracy: { type: DataTypes.FLOAT, allowNull: true },
    distanceMeters: { type: DataTypes.FLOAT, allowNull: true },
    faceDistance: { type: DataTypes.FLOAT, allowNull: true },
    source: { type: DataTypes.ENUM('FACE', 'CORRECTION'), allowNull: false, defaultValue: 'FACE' },
    active: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: true },
    createdAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'attendances',
    updatedAt: false,
    indexes: [{ unique: true, fields: ['user_id', 'date', 'slot_type', 'active'] }],
    hooks: {
      beforeUpdate: (_i, o) => blockUnaudited(o as AuditOptions),
      beforeDestroy: (_i, o) => blockUnaudited(o as AuditOptions),
      beforeBulkUpdate: (o) => blockUnaudited(o as AuditOptions),
      beforeBulkDestroy: (o) => blockUnaudited(o as AuditOptions),
    },
  },
);

export class AuditLog extends Model<InferAttributes<AuditLog>, InferCreationAttributes<AuditLog>> {
  declare id: CreationOptional<number>;
  declare actorId: ForeignKey<number>;
  declare targetUserId: ForeignKey<number>;
  declare action: 'ADD_ATTENDANCE' | 'VOID_ATTENDANCE';
  declare date: string;
  declare slotType: SlotType;
  declare before: object | null;
  declare after: object | null;
  declare reason: string;
  declare createdAt: CreationOptional<Date>;
  declare actor?: NonAttribute<User>;
  declare targetUser?: NonAttribute<User>;
}
AuditLog.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, autoIncrement: true, primaryKey: true },
    action: { type: DataTypes.ENUM('ADD_ATTENDANCE', 'VOID_ATTENDANCE'), allowNull: false },
    date: { type: DataTypes.DATEONLY, allowNull: false },
    slotType: { type: DataTypes.ENUM(...SLOT_TYPES), allowNull: false },
    before: { type: DataTypes.JSON, allowNull: true },
    after: { type: DataTypes.JSON, allowNull: true },
    reason: { type: DataTypes.TEXT, allowNull: false },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'audit_logs', updatedAt: false },
);

// ───────────────────────────── Izin / Sakit / Cuti ─────────────────────────────
export class LeaveRequest extends Model<InferAttributes<LeaveRequest>, InferCreationAttributes<LeaveRequest>> {
  declare id: CreationOptional<number>;
  declare userId: ForeignKey<number>;
  declare type: LeaveType;
  declare startDate: string;
  declare endDate: string;
  declare reason: string;
  declare attachmentPath: string | null;
  declare status: CreationOptional<'PENDING' | 'APPROVED' | 'REJECTED'>;
  declare reviewedById: ForeignKey<number> | null;
  declare reviewedAt: Date | null;
  declare reviewNote: string | null;
  declare createdAt: CreationOptional<Date>;
  declare user?: NonAttribute<User>;
  declare reviewedBy?: NonAttribute<User>;
}
LeaveRequest.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    type: { type: DataTypes.ENUM(...LEAVE_TYPES), allowNull: false },
    startDate: { type: DataTypes.DATEONLY, allowNull: false },
    endDate: { type: DataTypes.DATEONLY, allowNull: false },
    reason: { type: DataTypes.TEXT, allowNull: false },
    attachmentPath: { type: DataTypes.STRING(255), allowNull: true },
    status: {
      type: DataTypes.ENUM('PENDING', 'APPROVED', 'REJECTED'),
      allowNull: false,
      defaultValue: 'PENDING',
    },
    reviewedAt: { type: DataTypes.DATE, allowNull: true },
    reviewNote: { type: DataTypes.TEXT, allowNull: true },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'leave_requests' },
);

// ───────────────────────────── Laporan kendala absensi ─────────────────────────────
export class AttendanceIssue extends Model<
  InferAttributes<AttendanceIssue>,
  InferCreationAttributes<AttendanceIssue>
> {
  declare id: CreationOptional<number>;
  declare userId: ForeignKey<number>;
  declare date: string;
  declare description: string;
  declare status: CreationOptional<IssueStatus>;
  declare reviewedById: ForeignKey<number> | null;
  declare reviewNote: string | null;
  declare createdAt: CreationOptional<Date>;
  declare user?: NonAttribute<User>;
  declare reviewedBy?: NonAttribute<User>;
}
AttendanceIssue.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    date: { type: DataTypes.DATEONLY, allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: false },
    status: { type: DataTypes.ENUM(...ISSUE_STATUSES), allowNull: false, defaultValue: 'OPEN' },
    reviewNote: { type: DataTypes.TEXT, allowNull: true },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'attendance_issues' },
);

// ───────────────────────────── Hari libur & geofence ─────────────────────────────
export class Holiday extends Model<InferAttributes<Holiday>, InferCreationAttributes<Holiday>> {
  declare id: CreationOptional<number>;
  declare date: string;
  declare name: string;
}
Holiday.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    date: { type: DataTypes.DATEONLY, allowNull: false, unique: true },
    name: { type: DataTypes.STRING(120), allowNull: false },
  },
  { sequelize, tableName: 'holidays', timestamps: false },
);

export class GeofenceSetting extends Model<
  InferAttributes<GeofenceSetting>,
  InferCreationAttributes<GeofenceSetting>
> {
  declare id: number;
  declare name: string;
  declare latitude: number;
  declare longitude: number;
  declare radiusMeters: number;
  declare maxAccuracyMeters: number;
  declare updatedAt: CreationOptional<Date>;
}
GeofenceSetting.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true },
    name: { type: DataTypes.STRING(120), allowNull: false },
    latitude: { type: DataTypes.DOUBLE, allowNull: false },
    longitude: { type: DataTypes.DOUBLE, allowNull: false },
    radiusMeters: { type: DataTypes.FLOAT, allowNull: false },
    maxAccuracyMeters: { type: DataTypes.FLOAT, allowNull: false },
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'geofence_settings', createdAt: false },
);

// ───────────────────────────── Pengaturan sistem & riwayat perubahan shift ─────────────────────────────
/** Pengaturan key-value yang bisa diubah Super Admin dari dashboard (mis. toleransi terlambat). */
export class AppSetting extends Model<InferAttributes<AppSetting>, InferCreationAttributes<AppSetting>> {
  declare key: string;
  declare value: string;
  declare updatedAt: CreationOptional<Date>;
}
AppSetting.init(
  {
    key: { type: DataTypes.STRING(60), primaryKey: true },
    value: { type: DataTypes.TEXT, allowNull: false },
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'app_settings', createdAt: false },
);

export class ShiftChangeLog extends Model<InferAttributes<ShiftChangeLog>, InferCreationAttributes<ShiftChangeLog>> {
  declare id: CreationOptional<number>;
  declare actorId: ForeignKey<number>;
  declare target: string; // nama shift, atau "Toleransi terlambat"
  declare before: object;
  declare after: object;
  declare createdAt: CreationOptional<Date>;
  declare actor?: NonAttribute<User>;
}
ShiftChangeLog.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    target: { type: DataTypes.STRING(60), allowNull: false },
    before: { type: DataTypes.JSON, allowNull: false },
    after: { type: DataTypes.JSON, allowNull: false },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'shift_change_logs', updatedAt: false },
);

/**
 * Aturan penjadwalan per karyawan untuk Roster Otomatis. Hari memakai angka
 * 0 = Minggu … 6 = Sabtu. Tabel baru → dibuat otomatis oleh sync() di database lama.
 */
export class RosterRule extends Model<InferAttributes<RosterRule>, InferCreationAttributes<RosterRule>> {
  declare userId: number;
  /** Selalu memakai shift ini (mis. Koordinator → Shift Penuh); null = digilir Shift 1/2. */
  declare fixedShiftId: number | null;
  /** Hari yang BOLEH jadi hari Off. */
  declare offDays: number[];
  /** Hari yang tidak boleh Shift 1 / Shift 2. */
  declare noShift1Days: number[];
  declare noShift2Days: number[];
  /** Ikut dibuatkan roster otomatis. */
  declare active: boolean;
  declare updatedAt: CreationOptional<Date>;
}
RosterRule.init(
  {
    userId: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true },
    fixedShiftId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    offDays: { type: DataTypes.JSON, allowNull: false },
    noShift1Days: { type: DataTypes.JSON, allowNull: false },
    noShift2Days: { type: DataTypes.JSON, allowNull: false },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'roster_rules', createdAt: false },
);

/** Catatan saat Super Admin tetap mendaftarkan wajah yang mirip karyawan lain. */
export class FaceOverrideLog extends Model<InferAttributes<FaceOverrideLog>, InferCreationAttributes<FaceOverrideLog>> {
  declare id: CreationOptional<number>;
  declare actorId: ForeignKey<number>;
  declare userId: ForeignKey<number>;
  declare similarUserId: ForeignKey<number>;
  declare distance: number;
  declare reason: string;
  declare createdAt: CreationOptional<Date>;
}
FaceOverrideLog.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    distance: { type: DataTypes.FLOAT, allowNull: false },
    reason: { type: DataTypes.TEXT, allowNull: false },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'face_override_logs', updatedAt: false },
);

// ───────────────────────────── Relasi ─────────────────────────────
FaceOverrideLog.belongsTo(User, { foreignKey: 'actorId', as: 'actor' });
FaceOverrideLog.belongsTo(User, { foreignKey: 'userId', as: 'user' });
FaceOverrideLog.belongsTo(User, { foreignKey: 'similarUserId', as: 'similarUser' });
ShiftChangeLog.belongsTo(User, { foreignKey: 'actorId', as: 'actor' });
Shift.hasMany(ShiftSlot, { foreignKey: 'shiftId', as: 'slots' });
Shift.hasOne(ShiftBreak, { foreignKey: 'shiftId', as: 'breakConfig' });
ShiftSlot.belongsTo(Shift, { foreignKey: 'shiftId' });
User.belongsTo(Shift, { foreignKey: 'defaultShiftId', as: 'defaultShift' });

User.hasMany(EmployeeSchedule, { foreignKey: 'userId' });
EmployeeSchedule.belongsTo(User, { foreignKey: 'userId' });
EmployeeSchedule.belongsTo(Shift, { foreignKey: 'shiftId', as: 'shift' });

Attendance.belongsTo(User, { foreignKey: 'userId' });
Attendance.belongsTo(Shift, { foreignKey: 'shiftId' });

AuditLog.belongsTo(User, { foreignKey: 'actorId', as: 'actor' });
AuditLog.belongsTo(User, { foreignKey: 'targetUserId', as: 'targetUser' });

LeaveRequest.belongsTo(User, { foreignKey: 'userId', as: 'user' });
LeaveRequest.belongsTo(User, { foreignKey: 'reviewedById', as: 'reviewedBy' });

AttendanceIssue.belongsTo(User, { foreignKey: 'userId', as: 'user' });
AttendanceIssue.belongsTo(User, { foreignKey: 'reviewedById', as: 'reviewedBy' });

// ───────────────────────────── Operasional parkir (karcis, setoran, serah terima, kejadian) ─────────────────────────────
// Modul ini disembunyikan sampai diaktifkan Super Admin di Pengaturan Parkir.
// Fungsi (bukan objek bersama): Sequelize mengubah objek definisi kolom, jadi tiap kolom perlu salinannya sendiri
const userRef = () => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull: false, references: { model: 'users', key: 'id' } });
const count = () => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 });

export const TICKET_TYPES = ['MOBIL', 'MOTOR'] as const;
export type TicketType = (typeof TICKET_TYPES)[number];

/** Laporan per jam dari petugas: kendaraan masuk/keluar dan karcis terpakai (SOP 6.3). */
export class HourlyReport extends Model<InferAttributes<HourlyReport>, InferCreationAttributes<HourlyReport>> {
  declare id: CreationOptional<number>;
  declare userId: number;
  declare date: string;
  declare hour: number; // jam awal, 0–23 (mis. 9 = laporan 09.00–10.00)
  declare post: string | null;
  declare carIn: number;
  declare motorIn: number;
  declare carOut: number;
  declare motorOut: number;
  declare ticketCar: number;
  declare ticketMotor: number;
  declare rateCar: number; // tarif saat laporan dibuat
  declare rateMotor: number;
  declare note: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}
HourlyReport.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    userId: userRef(),
    date: { type: DataTypes.DATEONLY, allowNull: false },
    hour: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false },
    post: { type: DataTypes.STRING(20), allowNull: true },
    carIn: count(),
    motorIn: count(),
    carOut: count(),
    motorOut: count(),
    ticketCar: count(),
    ticketMotor: count(),
    rateCar: count(),
    rateMotor: count(),
    note: { type: DataTypes.STRING(500), allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'parking_hourly_reports', indexes: [{ unique: true, fields: ['user_id', 'date', 'hour'] }, { fields: ['date'] }] },
);

/** Karcis yang diterima dari Manajemen, per rentang nomor seri (SOP 6.6). */
export class TicketBatch extends Model<InferAttributes<TicketBatch>, InferCreationAttributes<TicketBatch>> {
  declare id: CreationOptional<number>;
  declare type: TicketType;
  declare serialFrom: number;
  declare serialTo: number;
  declare receivedDate: string;
  declare note: string | null;
  declare recordedById: number;
  declare createdAt: CreationOptional<Date>;
}
TicketBatch.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    type: { type: DataTypes.ENUM(...TICKET_TYPES), allowNull: false },
    serialFrom: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    serialTo: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    receivedDate: { type: DataTypes.DATEONLY, allowNull: false },
    note: { type: DataTypes.STRING(300), allowNull: true },
    recordedById: userRef(),
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'parking_ticket_batches', updatedAt: false },
);

export const VOID_REASONS = ['BATAL', 'HILANG'] as const;
/** Karcis rusak/salah cetak (BATAL) atau hilang, dicatat per nomor seri (SOP 6.6.3–4). */
export class TicketVoid extends Model<InferAttributes<TicketVoid>, InferCreationAttributes<TicketVoid>> {
  declare id: CreationOptional<number>;
  declare type: TicketType;
  declare serial: string;
  declare reason: (typeof VOID_REASONS)[number];
  declare date: string;
  declare note: string | null;
  declare userId: number;
  declare createdAt: CreationOptional<Date>;
}
TicketVoid.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    type: { type: DataTypes.ENUM(...TICKET_TYPES), allowNull: false },
    serial: { type: DataTypes.STRING(40), allowNull: false },
    reason: { type: DataTypes.ENUM(...VOID_REASONS), allowNull: false },
    date: { type: DataTypes.DATEONLY, allowNull: false },
    note: { type: DataTypes.STRING(300), allowNull: true },
    userId: userRef(),
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'parking_ticket_voids', updatedAt: false },
);

export const DEPOSIT_STATUSES = ['MENUNGGU', 'DITERIMA', 'SELISIH'] as const;
/** Setoran hasil parkir dari petugas (SOP 6.7). */
export class Deposit extends Model<InferAttributes<Deposit>, InferCreationAttributes<Deposit>> {
  declare id: CreationOptional<number>;
  declare userId: number;
  declare date: string;
  declare amount: number;
  declare ticketCar: number;
  declare ticketMotor: number;
  declare expected: number; // karcis × tarif saat setoran dibuat
  declare photoPath: string | null;
  declare note: string | null;
  declare status: CreationOptional<(typeof DEPOSIT_STATUSES)[number]>;
  declare reviewNote: string | null;
  declare reviewedById: number | null;
  declare reviewedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
}
Deposit.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    userId: userRef(),
    date: { type: DataTypes.DATEONLY, allowNull: false },
    amount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    ticketCar: count(),
    ticketMotor: count(),
    expected: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    photoPath: { type: DataTypes.STRING(255), allowNull: true },
    note: { type: DataTypes.STRING(500), allowNull: true },
    status: { type: DataTypes.ENUM(...DEPOSIT_STATUSES), allowNull: false, defaultValue: 'MENUNGGU' },
    reviewNote: { type: DataTypes.STRING(500), allowNull: true },
    reviewedById: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    reviewedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'parking_deposits', updatedAt: false, indexes: [{ fields: ['date'] }] },
);

export const HANDOVER_STATUSES = ['MENUNGGU', 'DITERIMA', 'DIKETAHUI'] as const;
/** Berita acara serah terima shift (SOP 3.9, Lampiran A). */
export class Handover extends Model<InferAttributes<Handover>, InferCreationAttributes<Handover>> {
  declare id: CreationOptional<number>;
  declare date: string;
  declare fromUserId: number;
  declare toUserId: number;
  declare post: string | null;
  declare remainingCar: number;
  declare remainingMotor: number;
  declare lastSerialCar: string | null;
  declare lastSerialMotor: string | null;
  declare voidNote: string | null;
  declare cashAmount: number;
  declare cashNote: string | null;
  declare equipment: string | null;
  declare pendingIssues: string | null;
  declare status: CreationOptional<(typeof HANDOVER_STATUSES)[number]>;
  declare acceptedAt: Date | null;
  declare acknowledgedById: number | null;
  declare acknowledgedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
}
Handover.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    date: { type: DataTypes.DATEONLY, allowNull: false },
    fromUserId: userRef(),
    toUserId: userRef(),
    post: { type: DataTypes.STRING(20), allowNull: true },
    remainingCar: count(),
    remainingMotor: count(),
    lastSerialCar: { type: DataTypes.STRING(40), allowNull: true },
    lastSerialMotor: { type: DataTypes.STRING(40), allowNull: true },
    voidNote: { type: DataTypes.STRING(300), allowNull: true },
    cashAmount: count(),
    cashNote: { type: DataTypes.STRING(300), allowNull: true },
    equipment: { type: DataTypes.STRING(300), allowNull: true },
    pendingIssues: { type: DataTypes.STRING(500), allowNull: true },
    status: { type: DataTypes.ENUM(...HANDOVER_STATUSES), allowNull: false, defaultValue: 'MENUNGGU' },
    acceptedAt: { type: DataTypes.DATE, allowNull: true },
    acknowledgedById: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    acknowledgedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'parking_handovers', updatedAt: false, indexes: [{ fields: ['date'] }] },
);

export const INCIDENT_TYPES = [
  'KEHILANGAN_KENDARAAN',
  'KERUSAKAN_KENDARAAN',
  'TABRAKAN',
  'PENCURIAN',
  'KECELAKAAN_KERJA',
  'PENGUNJUNG_SAKIT',
  'KELUHAN_PENGUNJUNG',
  'KARCIS_HILANG',
  'KENDARAAN_MENGINAP',
  'BENDA_MENCURIGAKAN',
  'GANGGUAN_KEAMANAN',
  'BENCANA_CUACA',
  'LISTRIK_PADAM',
  'LAINNYA',
] as const;
export const INCIDENT_STATUSES = ['BARU', 'DITINDAKLANJUTI', 'SELESAI'] as const;
/** Laporan kejadian lapangan dengan foto (SOP 7.1–7.4, Lampiran B). */
export class Incident extends Model<InferAttributes<Incident>, InferCreationAttributes<Incident>> {
  declare id: CreationOptional<number>;
  declare reporterId: number;
  declare date: string;
  declare time: string; // HH:MM
  declare location: string;
  declare type: (typeof INCIDENT_TYPES)[number];
  declare parties: string | null;
  declare plate: string | null;
  declare vehicle: string | null;
  declare ticketNo: string | null;
  declare chronology: string;
  declare actions: string | null;
  declare contacted: string | null;
  declare photos: string[];
  declare status: CreationOptional<(typeof INCIDENT_STATUSES)[number]>;
  declare reviewNote: string | null;
  declare reviewedById: number | null;
  declare reviewedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
}
Incident.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    reporterId: userRef(),
    date: { type: DataTypes.DATEONLY, allowNull: false },
    time: { type: DataTypes.STRING(5), allowNull: false },
    location: { type: DataTypes.STRING(100), allowNull: false },
    type: { type: DataTypes.ENUM(...INCIDENT_TYPES), allowNull: false },
    parties: { type: DataTypes.STRING(300), allowNull: true },
    plate: { type: DataTypes.STRING(20), allowNull: true },
    vehicle: { type: DataTypes.STRING(20), allowNull: true },
    ticketNo: { type: DataTypes.STRING(40), allowNull: true },
    chronology: { type: DataTypes.TEXT, allowNull: false },
    actions: { type: DataTypes.STRING(1000), allowNull: true },
    contacted: { type: DataTypes.STRING(300), allowNull: true },
    photos: {
      type: DataTypes.JSON,
      allowNull: false,
      // MariaDB menyimpan JSON sebagai teks; pastikan selalu terbaca sebagai array
      get() {
        const v = this.getDataValue('photos') as unknown;
        return typeof v === 'string' ? (JSON.parse(v) as string[]) : ((v as string[] | null) ?? []);
      },
    },
    status: { type: DataTypes.ENUM(...INCIDENT_STATUSES), allowNull: false, defaultValue: 'BARU' },
    reviewNote: { type: DataTypes.STRING(500), allowNull: true },
    reviewedById: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    reviewedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'parking_incidents', updatedAt: false, indexes: [{ fields: ['date'] }] },
);

export { sequelize };
