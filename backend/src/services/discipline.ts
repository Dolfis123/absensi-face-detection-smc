/**
 * Disiplin kehadiran (mangkir) sesuai PKWT Pasal 8:
 *  - mangkir 1–2 hari kerja → Peringatan Pertama (teguran)
 *  - mangkir 3–4 hari kerja → Peringatan Kedua secara tertulis
 *  - mangkir ≥ 5 hari kerja berturut-turut → dipanggil 2 kali secara tertulis; bila tetap tanpa
 *    alasan yang sah, dikualifikasikan mengundurkan diri (keputusan Manajemen, di luar sistem)
 * Hitungan memakai hari kerja terjadwal: hari Off, hari libur, dan hari tanpa jadwal dilewati.
 */
import type { LetterType } from '../models';
import { formatLetterNumber, getOrgSettings, OrgSettings } from './organization';
import type { DayStatus } from './recapService';

/** Kop surat, penomoran, dan penandatangan kini diatur di Identitas & Kop Surat (organization.ts). */
export type DisciplineSettings = OrgSettings;
export const getDisciplineSettings = getOrgSettings;

// Status yang bukan hari kerja: tidak menambah dan tidak memutus hitungan berturut-turut
const NOT_WORKDAY = new Set<DayStatus>(['OFF', 'DAY_OFF', 'LIBUR', 'BELUM']);

export interface AlfaAnalysis {
  /** Mangkir berturut-turut yang masih berjalan sampai hari terakhir data */
  streak: number;
  streakDates: string[];
  /** Mangkir di bulan berjalan (bulan dari hari terakhir data) */
  monthCount: number;
  monthDates: string[];
}

/** Hitung mangkir berturut-turut & per bulan dari status harian (urut naik tanggal). */
export function analyzeAlfa(days: { date: string; status: DayStatus }[], month: string): AlfaAnalysis {
  let streakDates: string[] = [];
  for (const d of days) {
    if (NOT_WORKDAY.has(d.status)) continue;
    if (d.status === 'ALFA') streakDates.push(d.date);
    else streakDates = [];
  }
  const monthDates = days.filter((d) => d.status === 'ALFA' && d.date.startsWith(month)).map((d) => d.date);
  return { streak: streakDates.length, streakDates, monthCount: monthDates.length, monthDates };
}

export interface IssuedLetter {
  type: LetterType;
  letterDate: string;
  alfaDates: string[];
  reportDate?: string | null;
}

export type Recommendation = LetterType | 'KEPUTUSAN_MANAJEMEN' | null;

/**
 * Saran tindakan berikutnya. Surat yang sudah terbit untuk kejadian yang sama tidak disarankan lagi:
 * panggilan dikaitkan ke rangkaian mangkir yang sama, peringatan ke bulan yang sama.
 */
export function recommend(a: AlfaAnalysis, letters: IssuedLetter[], month: string, today = `${month}-31`): Recommendation {
  if (a.streak >= 5) {
    const start = a.streakDates[0];
    const p1 = letters.find((l) => l.type === 'PANGGILAN_1' && l.letterDate >= start);
    const p2 = letters.some((l) => l.type === 'PANGGILAN_2' && l.letterDate >= start);
    if (!p1) return 'PANGGILAN_1';
    // Panggilan kedua baru dikirim bila karyawan tidak datang pada tanggal menghadap panggilan pertama
    if (!p2) return p1.reportDate && today < p1.reportDate ? null : 'PANGGILAN_2';
    return 'KEPUTUSAN_MANAJEMEN';
  }
  const thisMonth = letters.filter((l) => l.letterDate.startsWith(month));
  if (a.monthCount >= 3 && !thisMonth.some((l) => l.type === 'PERINGATAN_2' || l.type.startsWith('PANGGILAN'))) return 'PERINGATAN_2';
  if (a.monthCount >= 1 && !thisMonth.length) return 'PERINGATAN_1';
  return null;
}

export const LETTER_TITLE: Record<LetterType, string> = {
  PERINGATAN_1: 'Surat Peringatan Pertama',
  PERINGATAN_2: 'Surat Peringatan Kedua',
  PANGGILAN_1: 'Surat Panggilan Pertama',
  PANGGILAN_2: 'Surat Panggilan Kedua',
};

/** Nomor surat menurut pola di Identitas & Kop Surat, mis. 001/SP/DPM-SMC/XI/2026 */
export const letterNumber = (seq: number, type: LetterType, s: OrgSettings, letterDate: string) => formatLetterNumber(s, seq, type.startsWith('PANGGILAN'), letterDate);
