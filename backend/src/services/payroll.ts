/**
 * Rekap upah berdasarkan kehadiran (khusus Super Admin).
 *
 *  - PKWT Pasal 8: no work no pay (Pasal 93 UU 13/2003 jo. UU 6/2023) — upah hari mangkir tidak dibayar.
 *    PKWT terbaru tidak menetapkan angka pembagi, jadi upah per hari bawaan = Upah Pokok ÷ jumlah hari kerja
 *    terjadwal karyawan itu dalam bulan tersebut (roster; termasuk hari izin/sakit/cuti, tanpa Off & libur).
 *    Bisa diganti ke pembagi tetap (mis. 25) di Pengaturan.
 *  - Mangkir (Alfa) dipotong 1 × upah per hari per hari mangkir.
 *  - Terlambat: setiap N kali dalam sebulan → dipotong M × upah per hari. MATI secara bawaan karena
 *    PKWT belum mengaturnya; selama mati hanya ditampilkan sebagai simulasi, tidak mengurangi upah.
 *  - Bonus kehadiran sempurna & Petugas Terbaik Bulan Ini (penambah, nominal diatur Super Admin).
 * BPJS dan PPh tidak dihitung di sini (urusan HRD).
 */
import { AppSetting, Role, sequelize, ShiftChangeLog } from '../models';
import type { DayRecord, Summary } from './recapService';

/** JADWAL = ÷ hari kerja terjadwal bulan itu (per karyawan); TETAP = ÷ angka `divisor` */
export type DailyBasis = 'JADWAL' | 'TETAP';

export interface PayrollSettings {
  dailyBasis: DailyBasis;
  divisor: number;
  defaultWageKaryawan: number;
  defaultWageKoordinator: number;
  lateDeduction: { enabled: boolean; perCount: number; days: number };
  perfectBonus: { enabled: boolean; amount: number; allowLeave: boolean };
  bestEmployee: { enabled: boolean; count: number; amounts: number[] };
}

export const DEFAULT_PAYROLL: PayrollSettings = {
  dailyBasis: 'JADWAL',
  divisor: 25,
  defaultWageKaryawan: 2_500_000,
  defaultWageKoordinator: 4_000_000,
  lateDeduction: { enabled: false, perCount: 5, days: 1 },
  perfectBonus: { enabled: true, amount: 0, allowLeave: false },
  bestEmployee: { enabled: true, count: 3, amounts: [0, 0, 0] },
};

const KEY = 'payrollSettings';

export async function getPayrollSettings(): Promise<PayrollSettings> {
  const row = await AppSetting.findByPk(KEY);
  if (!row) return DEFAULT_PAYROLL;
  try {
    const v = JSON.parse(row.value) as Partial<PayrollSettings>;
    return {
      ...DEFAULT_PAYROLL,
      ...v,
      lateDeduction: { ...DEFAULT_PAYROLL.lateDeduction, ...v.lateDeduction },
      perfectBonus: { ...DEFAULT_PAYROLL.perfectBonus, ...v.perfectBonus },
      bestEmployee: { ...DEFAULT_PAYROLL.bestEmployee, ...v.bestEmployee },
    };
  } catch {
    return DEFAULT_PAYROLL;
  }
}

export async function savePayrollSettings(next: PayrollSettings, actorId: number) {
  const before = await getPayrollSettings();
  await sequelize.transaction(async (transaction) => {
    await AppSetting.upsert({ key: KEY, value: JSON.stringify(next) }, { transaction });
    await ShiftChangeLog.create({ actorId, target: 'Pengaturan upah kehadiran', before, after: next }, { transaction });
  });
}

export interface PayInput {
  user: { id: number; fullName: string; nik: string; role: Role };
  baseWage: number;
  summary: Summary;
  days: DayRecord[];
  /** Hari kerja terjadwal sebulan penuh menurut roster (dasar upah per hari bila dailyBasis = JADWAL) */
  scheduledDays?: number;
}

/** Angka pembagi upah per hari untuk satu karyawan (0 = tidak ada jadwal → tidak ada potongan). */
export function wageDivisor(s: Pick<PayrollSettings, 'dailyBasis' | 'divisor'>, scheduledDays: number) {
  return (s.dailyBasis ?? 'TETAP') === 'JADWAL' ? scheduledDays : s.divisor;
}

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

export interface PayRow {
  user: PayInput['user'];
  baseWage: number;
  dailyWage: number;
  /** Pembagi yang dipakai untuk upah per hari */
  divisor: number;
  workDays: number;
  present: number;
  onTime: number;
  lateCount: number;
  absenSekali: number;
  alfa: number;
  leave: { izin: number; sakit: number; cuti: number };
  offDays: number;
  breakIssues: number;
  /** Rata-rata menit absen Masuk sebelum jam mulai shift (positif = datang lebih awal); penentu bila nilai lain sama */
  avgEarlyMinutes: number | null;
  alfaDates: string[];
  lateDates: string[];
  absenSekaliDates: string[];
  deductMangkir: number;
  /** Potongan terlambat menurut aturan (selalu dihitung); hanya mengurangi upah bila diaktifkan */
  lateUnits: number;
  lateSimulated: number;
  deductLate: number;
  perfect: boolean;
  bonusPerfect: number;
  rank: number | null;
  bonusRank: number;
  totalDeduction: number;
  totalBonus: number;
  takeHome: number;
  /** Potongan melebihi separuh upah pokok — perlu diperiksa HRD */
  heavyDeduction: boolean;
}

/** Hitung rekap upah satu bulan dari data kehadiran. Fungsi murni (tanpa database). */
export function computePayroll(inputs: PayInput[], s: PayrollSettings, shiftStart: Map<number, string> = new Map()): PayRow[] {
  const rows: PayRow[] = inputs.map(({ user, baseWage, summary, days, scheduledDays }) => {
    const early = days
      .filter((d) => d.slots.MASUK && d.shiftId !== null && shiftStart.has(d.shiftId))
      .map((d) => toMin(shiftStart.get(d.shiftId!)!) - toMin(d.slots.MASUK!.time));
    // Tanpa data roster sebulan, pakai hari kerja yang tercatat di rekap
    const divisor = wageDivisor(s, scheduledDays ?? summary.hariKerja + summary.izin + summary.sakit + summary.cuti);
    const dailyWage = divisor > 0 ? Math.round(baseWage / divisor) : 0;
    // Terlambat = absen Masuk berstatus Terlambat, termasuk hari "Absen Sekali" yang masuknya terlambat
    const lateDates = days.filter((d) => d.slots.MASUK?.status === 'TERLAMBAT').map((d) => d.date);
    const alfaDates = days.filter((d) => d.status === 'ALFA').map((d) => d.date);
    const absenSekaliDates = days.filter((d) => d.status === 'ABSEN_SEKALI').map((d) => d.date);
    const lateUnits = s.lateDeduction.perCount > 0 ? Math.floor(lateDates.length / s.lateDeduction.perCount) * s.lateDeduction.days : 0;
    // Dihitung dari upah pokok langsung supaya tidak ada selisih pembulatan (mis. 7 × 166.667)
    const perDays = (n: number) => (divisor > 0 ? Math.round((baseWage * n) / divisor) : 0);
    const lateSimulated = perDays(lateUnits);
    const deductMangkir = perDays(alfaDates.length);
    const deductLate = s.lateDeduction.enabled ? lateSimulated : 0;
    const leaveDays = summary.izin + summary.sakit + summary.cuti;
    const perfect = summary.hariKerja > 0 && alfaDates.length === 0 && lateDates.length === 0 && absenSekaliDates.length === 0 && (s.perfectBonus.allowLeave || leaveDays === 0);
    return {
      user,
      baseWage,
      dailyWage,
      divisor,
      workDays: summary.hariKerja,
      present: summary.hadir,
      onTime: summary.tepatWaktu,
      lateCount: lateDates.length,
      absenSekali: absenSekaliDates.length,
      alfa: alfaDates.length,
      leave: { izin: summary.izin, sakit: summary.sakit, cuti: summary.cuti },
      offDays: summary.hariOff,
      breakIssues: summary.istirahatLebih + summary.lupaKembali,
      avgEarlyMinutes: early.length ? Math.round((early.reduce((a, b) => a + b, 0) / early.length) * 10) / 10 : null,
      alfaDates,
      lateDates,
      absenSekaliDates,
      deductMangkir,
      lateUnits,
      lateSimulated,
      deductLate,
      perfect,
      bonusPerfect: s.perfectBonus.enabled && perfect ? s.perfectBonus.amount : 0,
      rank: null,
      bonusRank: 0,
      totalDeduction: 0,
      totalBonus: 0,
      takeHome: 0,
      heavyDeduction: false,
    };
  });

  // Petugas Terbaik: tidak pernah mangkir dan terlambatnya belum mencapai batas potongan; urut dari yang paling disiplin
  if (s.bestEmployee.enabled && s.bestEmployee.count > 0) {
    const lateLimit = s.lateDeduction.perCount > 0 ? s.lateDeduction.perCount : Infinity;
    const ranked = rows
      .filter((r) => r.workDays > 0 && r.alfa === 0 && r.lateCount < lateLimit)
      .sort(
        (a, b) =>
          Number(b.perfect) - Number(a.perfect) ||
          a.lateCount - b.lateCount ||
          a.absenSekali - b.absenSekali ||
          a.leave.izin + a.leave.cuti - (b.leave.izin + b.leave.cuti) ||
          a.breakIssues - b.breakIssues ||
          b.onTime / b.workDays - a.onTime / a.workDays ||
          // Bila semua sama: yang rata-rata datang paling awal sebelum jam mulai shift
          (b.avgEarlyMinutes ?? -999) - (a.avgEarlyMinutes ?? -999) ||
          a.user.fullName.localeCompare(b.user.fullName),
      );
    ranked.slice(0, s.bestEmployee.count).forEach((r, i) => {
      r.rank = i + 1;
      r.bonusRank = s.bestEmployee.amounts[i] ?? 0;
    });
  }

  for (const r of rows) {
    r.totalDeduction = Math.min(r.baseWage, r.deductMangkir + r.deductLate);
    r.totalBonus = r.bonusPerfect + r.bonusRank;
    r.takeHome = r.baseWage - r.totalDeduction + r.totalBonus;
    r.heavyDeduction = r.totalDeduction > r.baseWage / 2;
  }
  return rows.sort((a, b) => a.user.fullName.localeCompare(b.user.fullName));
}

export const rupiah = (n: number) => `Rp ${Math.round(n).toLocaleString('id-ID')}`;
