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
  declare shiftId: ForeignKey<number>;
  declare date: string;
  declare shift?: NonAttribute<Shift>;
}
EmployeeSchedule.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    date: { type: DataTypes.DATEONLY, allowNull: false },
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
    value: { type: DataTypes.STRING(255), allowNull: false },
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

export { sequelize };
