import { Attendance, AttendanceIssue, AuditLog, EmployeeSchedule, isAttendee, SlotType, User, sequelize } from '../models';
import { AUDIT_TOKEN } from '../utils/audit';
import { HttpError } from '../utils/http';

export interface CorrectionInput {
  actor: User;
  userId: number;
  date: string;
  slotType: SlotType;
  action: 'ADD' | 'VOID';
  time?: string; // HH:MM WIT, wajib untuk ADD
  status?: 'TEPAT_WAKTU' | 'TERLAMBAT';
  reason: string;
  issueId?: number;
}

const snapshot = (a: Attendance) => ({
  id: a.id,
  localTime: a.localTime,
  status: a.status,
  source: a.source,
  recordedAt: a.recordedAt,
});

/**
 * Satu-satunya jalur yang boleh mengubah data absensi: koreksi darurat Super Admin.
 * Setiap koreksi tercatat di audit_logs beserta alasan, dan data lama tidak pernah
 * dihapus (hanya dinonaktifkan).
 */
export async function applyCorrection(input: CorrectionInput) {
  const target = await User.findByPk(input.userId);
  if (!target || !isAttendee(target.role)) throw new HttpError(404, 'Karyawan tidak ditemukan');

  return sequelize.transaction(async (transaction) => {
    // Izin sesi untuk trigger MySQL `attendances_lock_*`
    await sequelize.query('SET @smc_audit = 1', { transaction });
    try {
      const existing = await Attendance.findOne({
        where: { userId: input.userId, date: input.date, slotType: input.slotType, active: true },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });

      let log: AuditLog;
      if (input.action === 'VOID') {
        if (!existing) throw new HttpError(404, 'Tidak ada catatan absensi aktif untuk dibatalkan');
        const before = snapshot(existing);
        await existing.update({ active: null }, { transaction, auditToken: AUDIT_TOKEN } as object);
        log = await AuditLog.create(
          {
            actorId: input.actor.id,
            targetUserId: input.userId,
            action: 'VOID_ATTENDANCE',
            date: input.date,
            slotType: input.slotType,
            before,
            after: null,
            reason: input.reason,
          },
          { transaction },
        );
      } else {
        if (existing) {
          throw new HttpError(409, 'Sudah ada catatan aktif. Batalkan (VOID) dulu sebelum menambahkan pengganti.');
        }
        if (!input.time) throw new HttpError(400, 'Jam absensi koreksi wajib diisi');
        const schedule = await EmployeeSchedule.findOne({
          where: { userId: input.userId, date: input.date },
          transaction,
        });
        if (!schedule) throw new HttpError(400, 'Karyawan tidak memiliki jadwal pada tanggal tersebut');
        const localTime = `${input.time}:00`;
        const created = await Attendance.create(
          {
            userId: input.userId,
            shiftId: schedule.shiftId,
            date: input.date,
            slotType: input.slotType,
            status: input.status ?? 'TEPAT_WAKTU',
            recordedAt: new Date(`${input.date}T${localTime}+09:00`),
            localTime,
            latitude: null,
            longitude: null,
            gpsAccuracy: null,
            distanceMeters: null,
            faceDistance: null,
            source: 'CORRECTION',
          },
          { transaction },
        );
        log = await AuditLog.create(
          {
            actorId: input.actor.id,
            targetUserId: input.userId,
            action: 'ADD_ATTENDANCE',
            date: input.date,
            slotType: input.slotType,
            before: null,
            after: snapshot(created),
            reason: input.reason,
          },
          { transaction },
        );
      }

      if (input.issueId) {
        await AttendanceIssue.update(
          { status: 'RESOLVED', reviewedById: input.actor.id, reviewNote: `Dikoreksi: ${input.reason}` },
          { where: { id: input.issueId }, transaction },
        );
      }
      return log;
    } finally {
      await sequelize.query('SET @smc_audit = NULL', { transaction });
    }
  });
}
