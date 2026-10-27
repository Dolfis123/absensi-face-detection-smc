import { Op } from 'sequelize';
import {
  Attendance,
  EmployeeSchedule,
  Holiday,
  LeaveRequest,
  LeaveType,
  SlotType,
  User,
} from '../models';
import { eachDate, witNow } from '../utils/time';
import { getBreakTrackingSince } from './settings';
import { activeBreak, breakReturnDeadline, loadShifts, slotDeadline } from './shiftService';

export type DayStatus =
  | 'TEPAT_WAKTU'
  | 'TERLAMBAT'
  | 'ALFA'
  | 'IZIN'
  | 'SAKIT'
  | 'CUTI'
  | 'LIBUR'
  | 'OFF' // tidak dijadwalkan
  | 'BELUM'; // jendela masuk belum lewat

export interface DayRecord {
  date: string;
  shiftId: number | null;
  shiftName: string | null;
  status: DayStatus;
  note: string | null;
  slots: Partial<Record<SlotType, { time: string; status: string; source: string }>>;
  /** Ringkasan istirahat bergantian hari itu; null bila tidak ada istirahat. */
  break: BreakInfo | null;
}

export interface BreakInfo {
  start: string | null; // HH:MM:SS
  end: string | null;
  minutes: number | null;
  over: boolean; // melewati durasi maksimal + toleransi
  missingReturn: boolean; // mulai istirahat tapi tidak absen kembali sampai batas
  onBreak: boolean; // hari ini, sedang istirahat
}

export interface Summary {
  hadir: number;
  tepatWaktu: number;
  terlambat: number;
  izin: number;
  sakit: number;
  cuti: number;
  alfa: number;
  libur: number;
  hariKerja: number;
  istirahatLebih: number;
  lupaKembali: number;
}

export interface EmployeeRecap {
  user: { id: number; fullName: string; nik: string; phone: string };
  summary: Summary;
  days: DayRecord[];
}

const emptySummary = (): Summary => ({
  hadir: 0,
  tepatWaktu: 0,
  terlambat: 0,
  izin: 0,
  sakit: 0,
  cuti: 0,
  alfa: 0,
  libur: 0,
  hariKerja: 0,
  istirahatLebih: 0,
  lupaKembali: 0,
});

const toMinutes = (hhmmss: string) => Number(hhmmss.slice(0, 2)) * 60 + Number(hhmmss.slice(3, 5));

/**
 * Menyusun status kehadiran per hari. Prioritas: Libur → Izin/Sakit/Cuti (disetujui)
 * → tidak dijadwalkan → catatan Absen Masuk → Alfa / Belum.
 */
export async function buildRecap(from: string, to: string, userIds?: number[]): Promise<EmployeeRecap[]> {
  const users = await User.findAll({
    where: { role: 'KARYAWAN', ...(userIds ? { id: userIds } : {}) },
    order: [['fullName', 'ASC']],
  });
  const ids = users.map((u) => u.id);
  if (ids.length === 0) return [];

  const [shifts, schedules, attendances, leaves, holidays] = await Promise.all([
    loadShifts(),
    EmployeeSchedule.findAll({ where: { userId: ids, date: { [Op.between]: [from, to] } } }),
    Attendance.findAll({ where: { userId: ids, date: { [Op.between]: [from, to] }, active: true } }),
    LeaveRequest.findAll({
      where: {
        userId: ids,
        status: 'APPROVED',
        startDate: { [Op.lte]: to },
        endDate: { [Op.gte]: from },
      },
    }),
    Holiday.findAll({ where: { date: { [Op.between]: [from, to] } } }),
  ]);

  const holidayByDate = new Map(holidays.map((h) => [h.date, h.name]));
  const scheduleKey = (u: number, d: string) => `${u}|${d}`;
  const scheduleMap = new Map(schedules.map((s) => [scheduleKey(s.userId, s.date), s.shiftId]));
  const attMap = new Map<string, Attendance[]>();
  for (const a of attendances) {
    const key = scheduleKey(a.userId, a.date);
    attMap.set(key, [...(attMap.get(key) ?? []), a]);
  }
  const now = witNow();
  const dates = eachDate(from, to);
  const trackingSince = getBreakTrackingSince();

  return users.map((user) => {
    const summary = emptySummary();
    const days: DayRecord[] = dates.map((date) => {
      const shiftId = scheduleMap.get(scheduleKey(user.id, date)) ?? null;
      const shift = shiftId ? shifts.get(shiftId) : undefined;
      const atts = attMap.get(scheduleKey(user.id, date)) ?? [];
      const slots: DayRecord['slots'] = {};
      for (const a of atts) slots[a.slotType] = { time: a.localTime, status: a.status, source: a.source };

      const leave = leaves.find((l) => l.userId === user.id && l.startDate <= date && l.endDate >= date);
      const base = { date, shiftId, shiftName: shift?.name ?? null, slots, break: null as BreakInfo | null };

      if (holidayByDate.has(date)) {
        summary.libur++;
        return { ...base, status: 'LIBUR', note: holidayByDate.get(date)! };
      }
      if (leave) {
        const key = leave.type.toLowerCase() as Lowercase<LeaveType>;
        summary[key]++;
        return { ...base, status: leave.type, note: leave.reason };
      }
      if (!shift) return { ...base, status: 'OFF', note: null };

      summary.hariKerja++;
      const start = slots.ISTIRAHAT?.time ?? null;
      const end = slots.KEMBALI?.time ?? null;
      const b = activeBreak(shift);
      if (start || end || b) {
        const returnBy = b ? breakReturnDeadline(b) : null;
        const pastReturn = date < now.date || (date === now.date && returnBy !== null && now.minutes > returnBy);
        base.break = {
          start,
          end,
          minutes: start && end ? Math.max(0, toMinutes(end) - toMinutes(start)) : null,
          over: slots.KEMBALI?.status === 'TERLAMBAT',
          missingReturn: !!start && !end && date >= trackingSince && pastReturn,
          onBreak: date === now.date && !!start && !end && !pastReturn,
        };
        if (base.break.over) summary.istirahatLebih++;
        if (base.break.missingReturn) summary.lupaKembali++;
      }
      const masuk = atts.find((a) => a.slotType === 'MASUK');
      if (masuk) {
        summary.hadir++;
        if (masuk.status === 'TERLAMBAT') summary.terlambat++;
        else summary.tepatWaktu++;
        return { ...base, status: masuk.status, note: null };
      }
      const masukSlot = shift.slots.find((s) => s.type === 'MASUK');
      const closed = date < now.date || (date === now.date && masukSlot && now.minutes > slotDeadline(masukSlot));
      if (closed) {
        summary.alfa++;
        return { ...base, status: 'ALFA', note: null };
      }
      return { ...base, status: 'BELUM', note: null };
    });

    return {
      user: { id: user.id, fullName: user.fullName, nik: user.nik, phone: user.phone },
      summary,
      days,
    };
  });
}
