import { Shift, ShiftBreak, ShiftSlot, SlotType } from '../models';
import { hhmmToMinutes } from '../utils/time';
import { getLateTolerance } from './settings';

export type ShiftWithSlots = Shift & { slots: ShiftSlot[]; breakConfig: ShiftBreak | null };

export async function loadShifts(): Promise<Map<number, ShiftWithSlots>> {
  const shifts = (await Shift.findAll({
    include: [
      { model: ShiftSlot, as: 'slots' },
      { model: ShiftBreak, as: 'breakConfig' },
    ],
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

export interface BreakInput {
  enabled: boolean;
  windowStart: string;
  windowEnd: string;
  maxMinutes: number;
  toleranceMinutes: number;
}

/** Istirahat yang aktif untuk shift ini, atau null. */
export const activeBreak = (shift: ShiftWithSlots): BreakInput | null => (shift.breakConfig?.enabled ? shift.breakConfig : null);

/** Batas terakhir tap "Selesai Istirahat": gelombang terakhir mulai di windowEnd, ditambah durasi + toleransi. */
export const breakReturnDeadline = (b: BreakInput) => hhmmToMinutes(b.windowEnd) + b.maxMinutes + b.toleranceMinutes;

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
  breakCfg?: BreakInput | null,
): string | null {
  const m = hhmmToMinutes;
  if (m(startTime) >= m(endTime)) return `${shiftName}: jam selesai kerja harus setelah jam mulai`;
  for (const s of slots) {
    if (m(s.windowStart) >= m(s.windowEnd)) return `${shiftName}: jendela Absen ${label(s.type)} harus berakhir setelah dibuka`;
  }
  for (let i = 1; i < slots.length; i++) {
    const prev = slots[i - 1];
    const cur = slots[i];
    if (m(cur.windowStart) <= slotDeadline(prev, lateToleranceMin)) {
      const extra = prev.type === 'MASUK' ? ` (termasuk toleransi terlambat ${lateToleranceMin} menit)` : '';
      return `${shiftName}: jendela Absen ${label(cur.type)} (${cur.windowStart}) harus dibuka setelah batas Absen ${label(prev.type)}${extra}`;
    }
  }
  const masuk = slots.find((s) => s.type === 'MASUK');
  if (masuk && slotDeadline(masuk, lateToleranceMin) >= 24 * 60) {
    return `${shiftName}: batas terlambat Absen Masuk melewati tengah malam`;
  }

  if (breakCfg?.enabled) {
    const ws = m(breakCfg.windowStart);
    const we = m(breakCfg.windowEnd);
    const returnBy = breakReturnDeadline(breakCfg);
    if (ws >= we) return `${shiftName}: rentang mulai istirahat harus berakhir setelah dibuka`;
    if (masuk && ws <= slotDeadline(masuk, lateToleranceMin)) {
      return `${shiftName}: istirahat (${breakCfg.windowStart}) harus dimulai setelah batas Absen Masuk (termasuk toleransi terlambat ${lateToleranceMin} menit)`;
    }
    const pulang = slots.find((s) => s.type === 'PULANG');
    if (pulang && returnBy >= m(pulang.windowStart)) {
      return `${shiftName}: batas terakhir Selesai Istirahat (${fmt(returnBy)}, yaitu ${breakCfg.windowEnd} + ${breakCfg.maxMinutes} menit + toleransi ${breakCfg.toleranceMinutes} menit) harus sebelum Absen Pulang dibuka (${pulang.windowStart})`;
    }
    if (returnBy >= 24 * 60) return `${shiftName}: batas Selesai Istirahat melewati tengah malam`;
  }
  return null;
}

const fmt = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

export type SlotResolution =
  | { ok: true; slotType: SlotType; status: 'TEPAT_WAKTU' | 'TERLAMBAT'; breakMinutes?: number }
  | { ok: false; reason: string };

/**
 * Menentukan absen yang sedang aktif untuk shift karyawan hari ini, berdasarkan menit WIT
 * saat ini (jam server) dan absen yang sudah tercatat (beserta jamnya).
 * Untuk istirahat: tap pertama = Mulai Istirahat, tap berikutnya = Selesai Istirahat.
 */
export function resolveActiveSlot(
  shift: ShiftWithSlots,
  nowMinutes: number,
  recorded: Map<SlotType, { localTime: string }>,
  // Koordinator Lapangan hanya absen Masuk & Pulang (tanpa istirahat)
  opts: { allowBreak: boolean } = { allowBreak: true },
): SlotResolution {
  for (const slot of shift.slots) {
    const start = hhmmToMinutes(slot.windowStart);
    if (nowMinutes < start || nowMinutes > slotDeadline(slot)) continue;
    if (recorded.has(slot.type)) {
      return { ok: false, reason: `Absen ${label(slot.type)} sudah tercatat sebelumnya` };
    }
    const late = nowMinutes > hhmmToMinutes(slot.windowEnd);
    return { ok: true, slotType: slot.type, status: late ? 'TERLAMBAT' : 'TEPAT_WAKTU' };
  }

  const b = opts.allowBreak ? activeBreak(shift) : null;
  const started = recorded.get('ISTIRAHAT');
  const back = recorded.get('KEMBALI');
  if (b) {
    const ws = hhmmToMinutes(b.windowStart);
    const we = hhmmToMinutes(b.windowEnd);
    const returnBy = breakReturnDeadline(b);
    if (started && !back && nowMinutes <= returnBy) {
      const minutes = Math.max(0, nowMinutes - hhmmToMinutes(started.localTime));
      const over = minutes > b.maxMinutes + b.toleranceMinutes;
      return { ok: true, slotType: 'KEMBALI', status: over ? 'TERLAMBAT' : 'TEPAT_WAKTU', breakMinutes: minutes };
    }
    if (!started && nowMinutes >= ws && nowMinutes <= we) {
      return { ok: true, slotType: 'ISTIRAHAT', status: 'TEPAT_WAKTU' };
    }
    if (started && back && nowMinutes >= ws && nowMinutes <= returnBy) {
      return {
        ok: false,
        reason: `Absen istirahat hari ini sudah lengkap (mulai ${started.localTime.slice(0, 5)}, selesai ${back.localTime.slice(0, 5)})`,
      };
    }
    if (started && !back && nowMinutes > returnBy) {
      return {
        ok: false,
        reason: `Batas absen Selesai Istirahat (${fmt(returnBy)}) sudah lewat. Laporkan ke Koordinator agar dikoreksi.`,
      };
    }
  }

  const upcoming = [
    ...shift.slots.map((s) => ({ name: label(s.type), start: s.windowStart, end: s.windowEnd })),
    ...(b && !started ? [{ name: label('ISTIRAHAT'), start: b.windowStart, end: b.windowEnd }] : []),
  ]
    .filter((x) => hhmmToMinutes(x.start) > nowMinutes)
    .sort((x, y) => hhmmToMinutes(x.start) - hhmmToMinutes(y.start));
  if (upcoming[0]) {
    const n = upcoming[0];
    return { ok: false, reason: `Belum waktunya absen. Absen ${n.name} ${shift.name} dibuka ${n.start}–${n.end} WIT` };
  }
  return { ok: false, reason: `Seluruh jendela absensi ${shift.name} hari ini sudah ditutup` };
}

export const label = (t: SlotType) =>
  ({ MASUK: 'Masuk', ISTIRAHAT: 'Mulai Istirahat', KEMBALI: 'Selesai Istirahat', PULANG: 'Pulang' })[t];
