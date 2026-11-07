/**
 * Tandai Tidak Bekerja — khusus Super Admin.
 * Untuk petugas yang absen tetapi tidak benar-benar bekerja (mis. hanya datang absen lalu pulang).
 *  - Semua absensi aktif hari itu dibatalkan (VOID) lewat audit trail, data lama tidak dihapus.
 *  - Selama tanda aktif hari itu dihitung Alfa (mangkir): ikut Peringatan Disiplin & potongan upah.
 *  - Petugas tidak bisa absen lagi pada tanggal itu.
 *  - Bisa dibatalkan (salah tandai): absensi yang dibatalkan dipulihkan.
 */
import { Op } from 'sequelize';
import { Attendance, AuditLog, EmployeeSchedule, Holiday, isAttendee, LeaveRequest, NotWorkingMark, sequelize, User } from '../models';
import { AUDIT_TOKEN } from '../utils/audit';
import { HttpError } from '../utils/http';
import { witNow } from '../utils/time';

const snapshot = (a: Attendance) => ({ id: a.id, localTime: a.localTime, status: a.status, source: a.source, recordedAt: a.recordedAt });

/** Tanda aktif dalam rentang tanggal, kunci `userId|date`. */
export async function activeMarks(from: string, to: string, userIds?: number[]) {
  const marks = await NotWorkingMark.findAll({
    where: { date: { [Op.between]: [from, to] }, cancelledAt: null, ...(userIds ? { userId: userIds } : {}) },
  });
  return new Map(marks.map((m) => [`${m.userId}|${m.date}`, m]));
}

export async function findActiveMark(userId: number, date: string) {
  return NotWorkingMark.findOne({ where: { userId, date, cancelledAt: null } });
}

export async function markNotWorking(input: { actor: User; userId: number; date: string; reason: string }) {
  const { actor, userId, date, reason } = input;
  const target = await User.findByPk(userId);
  if (!target || !isAttendee(target.role)) throw new HttpError(404, 'Karyawan tidak ditemukan');
  if (date > witNow().date) throw new HttpError(400, 'Tidak dapat menandai tanggal di masa depan');

  const [schedule, holiday, leave] = await Promise.all([
    EmployeeSchedule.findOne({ where: { userId, date } }),
    Holiday.findOne({ where: { date } }),
    LeaveRequest.findOne({ where: { userId, status: 'APPROVED', startDate: { [Op.lte]: date }, endDate: { [Op.gte]: date } } }),
  ]);
  if (!schedule || schedule.shiftId === null) throw new HttpError(409, `${target.fullName} tidak dijadwalkan bekerja pada tanggal tersebut (tanpa jadwal / Off).`);
  if (holiday) throw new HttpError(409, `Tanggal tersebut hari libur (${holiday.name}).`);
  if (leave) throw new HttpError(409, `${target.fullName} tercatat ${leave.type} yang sudah disetujui pada tanggal tersebut.`);
  if (await findActiveMark(userId, date)) throw new HttpError(409, `${target.fullName} sudah ditandai tidak bekerja pada tanggal tersebut.`);

  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET @smc_audit = 1', { transaction });
    try {
      const atts = await Attendance.findAll({ where: { userId, date, active: true }, transaction, lock: transaction.LOCK.UPDATE });
      for (const a of atts) {
        const before = snapshot(a);
        await a.update({ active: null }, { transaction, auditToken: AUDIT_TOKEN } as object);
        await AuditLog.create(
          { actorId: actor.id, targetUserId: userId, action: 'VOID_ATTENDANCE', date, slotType: a.slotType, before, after: null, reason: `Tandai Tidak Bekerja: ${reason}` },
          { transaction },
        );
      }
      return NotWorkingMark.create({ userId, date, reason, voidedIds: atts.map((a) => a.id), createdById: actor.id }, { transaction });
    } finally {
      await sequelize.query('SET @smc_audit = NULL', { transaction });
    }
  });
}

/** Batalkan tanda (salah tandai): absensi yang dibatalkan saat penandaan dipulihkan. */
export async function cancelMark(input: { actor: User; id: number; reason: string }) {
  const mark = await NotWorkingMark.findByPk(input.id);
  if (!mark) throw new HttpError(404, 'Tanda tidak ditemukan');
  if (mark.cancelledAt) throw new HttpError(409, 'Tanda ini sudah dibatalkan');

  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET @smc_audit = 1', { transaction });
    try {
      let restored = 0;
      const atts = mark.voidedIds.length ? await Attendance.findAll({ where: { id: mark.voidedIds }, transaction, lock: transaction.LOCK.UPDATE }) : [];
      for (const a of atts) {
        if (a.active) continue;
        // Bila sudah ada catatan pengganti aktif untuk slot yang sama (koreksi lain), jangan ditimpa
        const clash = await Attendance.findOne({ where: { userId: a.userId, date: a.date, slotType: a.slotType, active: true }, transaction });
        if (clash) continue;
        await a.update({ active: true }, { transaction, auditToken: AUDIT_TOKEN } as object);
        await AuditLog.create(
          {
            actorId: input.actor.id,
            targetUserId: a.userId,
            action: 'ADD_ATTENDANCE',
            date: a.date,
            slotType: a.slotType,
            before: null,
            after: snapshot(a),
            reason: `Batal tandai tidak bekerja: ${input.reason}`,
          },
          { transaction },
        );
        restored++;
      }
      await mark.update({ cancelledAt: new Date(), cancelledById: input.actor.id, cancelReason: input.reason }, { transaction });
      return { mark, restored };
    } finally {
      await sequelize.query('SET @smc_audit = NULL', { transaction });
    }
  });
}
