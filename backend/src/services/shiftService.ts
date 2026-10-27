import { Shift, ShiftSlot, SlotType } from '../models';
import { hhmmToMinutes } from '../utils/time';
import { getLateTolerance } from './settings';

export type ShiftWithSlots = Shift & { slots: ShiftSlot[] };

export async function loadShifts(): Promise<Map<number, ShiftWithSlots>> {
  const shifts = (await Shift.findAll({
    include: [{ model: ShiftSlot, as: 'slots' }],
    order: [
      ['id', 'ASC'],
      [{ model: ShiftSlot, as: 'slots' }, 'sortOrder', 'ASC'],
    ],
  })) as ShiftWithSlots[];
  return new Map(shifts.map((s) => [s.id, s]));
}

/** Batas akhir slot. Absen Masuk masih diterima (status TERLAMBAT) sampai toleransi habis. */
export function slotDeadline(slot: Pick<ShiftSlot, 'type' | 'windowEnd'>, lateToleranceMin = getLateTolerance()): number {
  const end = hhmmToMinutes(slot.windowEnd);
  return slot.type === 'MASUK' ? end + lateToleranceMin : end;
}

export interface SlotInput {
  type: SlotType;
  windowStart: string;
  windowEnd: string;
}

/**
 * Validasi aturan jam shift. Mengembalikan pesan kesalahan pertama, atau null bila valid.
 * Semua jam berada di hari yang sama (shift tidak melewati tengah malam).
 */
export function validateShiftTimes(
  shiftName: string,
  startTime: string,
  endTime: string,
  slots: SlotInput[],
  lateToleranceMin: number,
): string | null {
  const m = hhmmToMinutes;
  if (m(startTime) >= m(endTime)) return `${shiftName}: jam selesai kerja harus setelah jam mulai`;
  for (const s of slots) {
    if (m(s.windowStart) >= m(s.windowEnd)) return `${shiftName}: jendela Absen ${label(s.type)} harus berakhir setelah dibuka`;
  }
  for (let i = 1; i < slots.length; i++) {
    const prev = slots[i - 1];
    const cur = slots[i];
    const prevDeadline = slotDeadline(prev, lateToleranceMin);
    if (m(cur.windowStart) <= prevDeadline) {
      const extra = prev.type === 'MASUK' ? ` (termasuk toleransi terlambat ${lateToleranceMin} menit)` : '';
      return `${shiftName}: jendela Absen ${label(cur.type)} (${cur.windowStart}) harus dibuka setelah batas Absen ${label(prev.type)}${extra}`;
    }
  }
  if (slotDeadline(slots[0], lateToleranceMin) >= 24 * 60) {
    return `${shiftName}: batas terlambat Absen Masuk melewati tengah malam`;
  }
  return null;
}

export type SlotResolution =
  | { ok: true; slot: ShiftSlot; status: 'TEPAT_WAKTU' | 'TERLAMBAT' }
  | { ok: false; reason: string };

/**
 * Menentukan slot absen yang sedang aktif untuk shift karyawan hari ini,
 * berdasarkan menit WIT saat ini (jam server) dan slot yang sudah tercatat.
 */
export function resolveActiveSlot(
  shift: ShiftWithSlots,
  nowMinutes: number,
  recorded: Set<SlotType>,
): SlotResolution {
  for (const slot of shift.slots) {
    const start = hhmmToMinutes(slot.windowStart);
    if (nowMinutes < start || nowMinutes > slotDeadline(slot)) continue;
    if (recorded.has(slot.type)) {
      return { ok: false, reason: `Absen ${label(slot.type)} sudah tercatat sebelumnya` };
    }
    const late = nowMinutes > hhmmToMinutes(slot.windowEnd);
    return { ok: true, slot, status: late ? 'TERLAMBAT' : 'TEPAT_WAKTU' };
  }

  const next = shift.slots.find((s) => hhmmToMinutes(s.windowStart) > nowMinutes);
  if (next) {
    return {
      ok: false,
      reason: `Belum waktunya absen. Absen ${label(next.type)} ${shift.name} dibuka ${next.windowStart}–${next.windowEnd} WIT`,
    };
  }
  return { ok: false, reason: `Seluruh jendela absensi ${shift.name} hari ini sudah ditutup` };
}

export const label = (t: SlotType) =>
  ({ MASUK: 'Masuk', ISTIRAHAT: 'Istirahat', PULANG: 'Pulang' })[t];
