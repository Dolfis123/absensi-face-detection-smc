/**
 * Disiplin kehadiran (mangkir) sesuai PKWT Pasal 8:
 *  - mangkir 1–2 hari kerja → Peringatan Pertama (teguran)
 *  - mangkir 3–4 hari kerja → Peringatan Kedua secara tertulis
 *  - mangkir ≥ 5 hari kerja berturut-turut → dipanggil 2 kali secara tertulis; bila tetap tanpa
 *    alasan yang sah, dikualifikasikan mengundurkan diri (keputusan Manajemen, di luar sistem)
 * Hitungan memakai hari kerja terjadwal: hari Off, hari libur, dan hari tanpa jadwal dilewati.
 */
import { AppSetting, LetterType, sequelize, ShiftChangeLog } from '../models';
import type { DayStatus } from './recapService';

export interface DisciplineSettings {
  companyName: string;
  companyAddress: string;
  hrdName: string;
  hrdTitle: string;
  coordinatorName: string;
  managementName: string;
  managementTitle: string;
  /** Bagian tengah nomor surat, mis. 001/SP/DPM-SMC/XI/2026 */
  numberCode: string;
  /** Tempat menghadap untuk surat panggilan */
  defaultReportPlace: string;
}

export const DEFAULT_DISCIPLINE: DisciplineSettings = {
  companyName: 'CV. DEVA JAYA',
  companyAddress: 'Jln. Bolhok Rt.1/Rw.01 Kelurahan Klabinain, Kab. Sorong',
  hrdName: '',
  hrdTitle: 'HRD/Admin Manager',
  coordinatorName: '',
  managementName: '',
  managementTitle: 'Manajemen Mall Sorong Modern City',
  numberCode: 'DPM-SMC',
  defaultReportPlace: 'Kantor Pengelola Parkir Mall Sorong Modern City',
};

const KEY = 'disciplineSettings';

export async function getDisciplineSettings(): Promise<DisciplineSettings> {
  const row = await AppSetting.findByPk(KEY);
  if (!row) return DEFAULT_DISCIPLINE;
  try {
    return { ...DEFAULT_DISCIPLINE, ...(JSON.parse(row.value) as Partial<DisciplineSettings>) };
  } catch {
    return DEFAULT_DISCIPLINE;
  }
}

export async function saveDisciplineSettings(next: DisciplineSettings, actorId: number) {
  const before = await getDisciplineSettings();
  await sequelize.transaction(async (transaction) => {
    await AppSetting.upsert({ key: KEY, value: JSON.stringify(next) }, { transaction });
    await ShiftChangeLog.create({ actorId, target: 'Pengaturan surat disiplin', before, after: next }, { transaction });
  });
}

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

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
/** Mis. 001/SP/DPM-SMC/XI/2026 (SP = peringatan, SPG = panggilan) */
export const letterNumber = (seq: number, type: LetterType, code: string, letterDate: string) =>
  `${String(seq).padStart(3, '0')}/${type.startsWith('PANGGILAN') ? 'SPG' : 'SP'}/${code}/${ROMAN[Number(letterDate.slice(5, 7)) - 1]}/${letterDate.slice(0, 4)}`;
