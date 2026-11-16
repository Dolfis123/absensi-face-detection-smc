/**
 * Kontrak PKWT: pengaturan, isi pasal, status masa berlaku, dan penomoran.
 * Isi kontrak disusun sekali (daftar blok) lalu dicetak ke Word (contractDocx.ts) dan PDF (contractPdf.ts),
 * sehingga kedua berkas selalu sama isinya.
 */
import { AppSetting, ContractEmployer, EmployeeProfile, EmploymentContract, sequelize, ShiftChangeLog, User } from '../models';
import { getOrgSettings } from './organization';
import { fmtLongDate } from './pdfReport';
import { witNow } from '../utils/time';

// ───────────── Pengaturan kontrak (Super Admin) ─────────────
export interface ContractSettings {
  /** Penandatangan pihak pertama, mis. Direktur */
  signerName: string;
  signerTitle: string;
  /** Pola nomor; token: {no} {kode} {bulan} {bulanAngka} {tahun}. Kosong = nomor diisi tangan (titik-titik) */
  numberFormat: string;
  /** Tempat pencatatan di bagian bawah kontrak */
  recordedPlace: string;
  defaultWage: number;
  defaultMonths: number;
  /** Pasal 4 ayat 1 untuk Petugas Parkir */
  workHoursText: string;
}
export const DEFAULT_CONTRACT: ContractSettings = {
  signerName: 'NAOMI NOVITA KALIELE',
  signerTitle: 'Direktur',
  numberFormat: '{no}/PKWT/{kode}/{tahun}',
  recordedPlace: 'Di Sorong',
  defaultWage: 2_500_000,
  defaultMonths: 2,
  workHoursText: 'Waktu kerja PIHAK KEDUA mengikuti roster, yaitu Shift 1 pukul 08.00–16.00 WIT atau Shift 2 pukul 16.00–23.00 WIT.',
};
const KEY = 'contractSettings';

export async function getContractSettings(): Promise<ContractSettings> {
  const row = await AppSetting.findByPk(KEY);
  try {
    return row ? { ...DEFAULT_CONTRACT, ...(JSON.parse(row.value) as Partial<ContractSettings>) } : DEFAULT_CONTRACT;
  } catch {
    return DEFAULT_CONTRACT;
  }
}
export async function saveContractSettings(next: ContractSettings, actorId: number) {
  const before = await getContractSettings();
  await sequelize.transaction(async (transaction) => {
    await AppSetting.upsert({ key: KEY, value: JSON.stringify(next) }, { transaction });
    await ShiftChangeLog.create({ actorId, target: 'Pengaturan kontrak PKWT', before, after: next }, { transaction });
  });
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
export function formatContractNumber(format: string, code: string, seq: number, date: string) {
  if (!format.trim()) return '';
  const month = Number(date.slice(5, 7));
  const tokens: Record<string, string> = { no: String(seq).padStart(3, '0'), kode: code, bulan: ROMAN[month - 1], bulanAngka: String(month).padStart(2, '0'), tahun: date.slice(0, 4) };
  return format.replace(/\{(\w+)\}/g, (m, k: string) => tokens[k] ?? m).replace(/\/{2,}/g, '/').replace(/^\/|\/$/g, '');
}

/** Pihak pertama dari Identitas & Kop Surat + pengaturan kontrak (disalin ke kontrak saat dibuat). */
export async function currentEmployer(): Promise<{ employer: ContractEmployer; settings: ContractSettings; numberCode: string }> {
  const [org, settings] = await Promise.all([getOrgSettings(), getContractSettings()]);
  return {
    employer: { companyName: org.companyName, companyAddress: org.companyAddress, signerName: settings.signerName, signerTitle: settings.signerTitle, recordedPlace: settings.recordedPlace },
    settings,
    numberCode: org.numberCode,
  };
}

/** Nomor urut berikutnya untuk tahun tertentu (dipanggil di dalam transaksi). */
export async function nextSeq(year: number, transaction: import('sequelize').Transaction) {
  const max = (await EmploymentContract.max('seq', { where: { year }, transaction })) as number | null;
  return (max ?? 0) + 1;
}

// ───────────── Status masa berlaku ─────────────
export type ContractStatus = 'AKAN_BERLAKU' | 'AKTIF' | 'BERAKHIR' | 'DIBATALKAN';
export const EXPIRY_WARN_DAYS = 14;
export const EXPIRY_URGENT_DAYS = 7;
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export function contractStatus(c: Pick<EmploymentContract, 'voidedAt' | 'startDate' | 'endDate'>, today = witNow().date): ContractStatus {
  if (c.voidedAt) return 'DIBATALKAN';
  if (today < c.startDate) return 'AKAN_BERLAKU';
  if (today > c.endDate) return 'BERAKHIR';
  return 'AKTIF';
}

/**
 * Kontrak yang perlu tindakan untuk karyawan aktif: akan habis ≤ 14 hari tanpa kontrak lanjutan,
 * atau sudah habis dan karyawan masih bekerja tanpa kontrak baru.
 */
export async function contractsNeedingAction(today = witNow().date) {
  const users = await User.findAll({ where: { role: ['KARYAWAN', 'KOORDINATOR'], isActive: true }, attributes: ['id', 'fullName'] });
  const all = await EmploymentContract.findAll({ where: { userId: users.map((u) => u.id).concat(0), voidedAt: null }, order: [['endDate', 'DESC']] });
  const expiring: { userId: number; fullName: string; contract: EmploymentContract; daysLeft: number }[] = [];
  const expired: { userId: number; fullName: string; contract: EmploymentContract; daysAgo: number }[] = [];
  for (const u of users) {
    const latest = all.find((c) => c.userId === u.id); // kontrak dengan tanggal berakhir paling akhir
    if (!latest) continue;
    const left = daysBetween(today, latest.endDate);
    if (left < 0) expired.push({ userId: u.id, fullName: u.fullName, contract: latest, daysAgo: -left });
    else if (left <= EXPIRY_WARN_DAYS && latest.startDate <= today) expiring.push({ userId: u.id, fullName: u.fullName, contract: latest, daysLeft: left });
  }
  expiring.sort((a, b) => a.daysLeft - b.daysLeft);
  return { expiring, expired, activeUsers: users.length };
}

// ───────────── Angka & tanggal dalam kata ─────────────
const ONES = ['', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'delapan', 'sembilan', 'sepuluh', 'sebelas'];
export function terbilang(n: number): string {
  n = Math.floor(Math.abs(n));
  if (n < 12) return ONES[n];
  if (n < 20) return `${terbilang(n - 10)} belas`;
  if (n < 100) return `${terbilang(Math.floor(n / 10))} puluh${n % 10 ? ` ${terbilang(n % 10)}` : ''}`;
  if (n < 200) return `seratus${n - 100 ? ` ${terbilang(n - 100)}` : ''}`;
  if (n < 1000) return `${terbilang(Math.floor(n / 100))} ratus${n % 100 ? ` ${terbilang(n % 100)}` : ''}`;
  if (n < 2000) return `seribu${n - 1000 ? ` ${terbilang(n - 1000)}` : ''}`;
  if (n < 1e6) return `${terbilang(Math.floor(n / 1000))} ribu${n % 1000 ? ` ${terbilang(n % 1000)}` : ''}`;
  if (n < 1e9) return `${terbilang(Math.floor(n / 1e6))} juta${n % 1e6 ? ` ${terbilang(n % 1e6)}` : ''}`;
  return `${terbilang(Math.floor(n / 1e9))} miliar${n % 1e9 ? ` ${terbilang(n % 1e9)}` : ''}`;
}
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const rupiah = (n: number) => `Rp ${n.toLocaleString('id-ID')},-`;
const DAY = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
export const dayDate = (iso: string) => `${DAY[new Date(`${iso}T00:00:00Z`).getUTCDay()]}, ${fmtLongDate(iso)}`;

/** Tanggal yang sama N bulan kemudian (23 Okt + 2 bulan = 23 Des); akhir bulan disesuaikan. */
export function addMonths(iso: string, months: number) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}
/** "2 (dua) bulan" bila tepat sekian bulan, selain itu "45 (empat puluh lima) hari". */
export function durationText(start: string, end: string) {
  for (let m = 1; m <= 60; m++) if (addMonths(start, m) === end) return `${m} (${terbilang(m)}) bulan`;
  const d = daysBetween(start, end) + 1;
  return `${d} (${terbilang(d)}) hari`;
}

// ───────────── Isi kontrak ─────────────
export type Block =
  | { t: 'title'; text: string }
  | { t: 'subtitle'; text: string }
  | { t: 'field'; label: string; value: string; bold?: boolean; indent?: boolean }
  | { t: 'para'; text: string }
  | { t: 'gap' }
  | { t: 'heading'; text: string }
  | { t: 'list'; items: (string | { text: string; sub: string[] })[] }
  | { t: 'sign'; left: [string, string, string]; right: [string, string, string] }
  | { t: 'note'; text: string };

export interface ContractDoc {
  fileTitle: string;
  footer: string;
  blocks: Block[];
}

const DOTS = '................................';
const nameCase = (n: string) => n.replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());

export function buildContract(
  c: Pick<EmploymentContract, 'number' | 'position' | 'signDate' | 'startDate' | 'endDate' | 'baseWage' | 'allowance' | 'employer' | 'workHoursText' | 'voidedAt'>,
  user: { fullName: string; phone: string },
  profile: EmployeeProfile | null,
  receivedText?: string | null,
  numberCode = '…',
): ContractDoc {
  const e = c.employer;
  const coord = c.position === 'KOORDINATOR';
  const pos = coord ? 'Koordinator Lapangan' : 'Petugas Parkir';
  const name = user.fullName.toUpperCase();
  const year = c.signDate.slice(0, 4);
  const number = c.number || `…../PKWT/${numberCode}/${year}`;
  const birth = profile?.birthPlace || profile?.birthDate ? `${profile?.birthPlace || '…'}, ${profile?.birthDate ? `${profile.birthDate.slice(8, 10)}-${profile.birthDate.slice(5, 7)}-${profile.birthDate.slice(0, 4)}` : '…'}` : DOTS;
  const B: Block[] = [
    { t: 'title', text: 'SURAT PERJANJIAN KERJA WAKTU TERTENTU (PKWT)' },
    { t: 'subtitle', text: `Nomor: ${number}` },
    { t: 'field', label: 'Posisi', value: pos },
    { t: 'field', label: 'Lokasi Penugasan', value: 'Area Parkir Mall Sorong Modern City, Kota Sorong' },
    { t: 'gap' },
    { t: 'para', text: `Pada hari ini, ${dayDate(c.signDate)} kami yang bertanda tangan di bawah ini:` },
    { t: 'field', label: 'Nama Perusahaan', value: e.companyName, bold: true, indent: true },
    { t: 'field', label: 'Alamat Kantor', value: e.companyAddress || DOTS, indent: true },
    { t: 'field', label: 'Diwakili oleh', value: e.signerName || DOTS, bold: true, indent: true },
    { t: 'field', label: 'Jabatan', value: e.signerTitle || DOTS, indent: true },
    { t: 'para', text: `Dalam hal ini bertindak untuk dan atas nama ${e.companyName}, selanjutnya disebut sebagai PIHAK PERTAMA.` },
    { t: 'field', label: 'Nama Lengkap', value: name, bold: true, indent: true },
    { t: 'field', label: 'No. KTP / NIK', value: profile?.ktpNumber || DOTS, indent: true },
    { t: 'field', label: 'Tempat, Tanggal Lahir', value: birth, indent: true },
    { t: 'field', label: 'Alamat', value: profile?.address || DOTS, indent: true },
    { t: 'field', label: 'No. HP/WhatsApp', value: user.phone || DOTS, indent: true },
    { t: 'para', text: 'Dalam hal ini bertindak untuk dan atas nama DIRI SENDIRI, selanjutnya disebut sebagai PIHAK KEDUA.' },
    { t: 'para', text: 'PIHAK PERTAMA dan PIHAK KEDUA secara bersama-sama disebut PARA PIHAK.' },
    { t: 'heading', text: 'DASAR HUKUM PERJANJIAN' },
    { t: 'para', text: 'Perjanjian Kerja ini dibuat berlandaskan peraturan perundang-undangan di bidang ketenagakerjaan yang berlaku di Republik Indonesia, antara lain:' },
    {
      t: 'list',
      items: [
        'Undang-Undang Nomor 13 Tahun 2003 tentang Ketenagakerjaan beserta perubahan-perubahannya.',
        'Undang-Undang Nomor 6 Tahun 2023 tentang Penetapan Peraturan Pemerintah Pengganti Undang-Undang Nomor 2 Tahun 2022 tentang Cipta Kerja menjadi Undang-Undang.',
        'Peraturan Pemerintah Nomor 35 Tahun 2021 tentang Perjanjian Kerja Waktu Tertentu, Alih Daya, Waktu Kerja dan Waktu Istirahat, dan Pemutusan Hubungan Kerja.',
        'Peraturan Pemerintah Nomor 36 Tahun 2021 tentang Pengupahan beserta perubahannya.',
      ],
    },
    { t: 'para', text: 'Atas dasar hukum di atas, PARA PIHAK sepakat mengikatkan diri dalam Perjanjian Kerja Waktu Tertentu (PKWT) dengan syarat dan ketentuan berikut:' },
    { t: 'heading', text: 'PASAL 1: JABATAN DAN LOKASI PENUGASAN' },
    {
      t: 'list',
      items: [
        `PIHAK PERTAMA mempekerjakan PIHAK KEDUA sebagai ${pos}.`,
        'PIHAK KEDUA ditugaskan di area parkir Mall Sorong Modern City, Kota Sorong, Provinsi Papua Barat Daya.',
        coord
          ? 'PIHAK KEDUA mengawasi seluruh pos parkir di area tersebut sesuai arahan PIHAK PERTAMA dan SOP Parkiran Mall Sorong Modern City (selanjutnya disebut SOP).'
          : 'Pos penempatan ditetapkan dalam roster dan dapat digilir di dalam area parkir sesuai SOP Parkiran Mall Sorong Modern City (selanjutnya disebut SOP).',
      ],
    },
    { t: 'heading', text: 'PASAL 2: JANGKA WAKTU PERJANJIAN' },
    {
      t: 'list',
      items: [
        `Perjanjian Kerja ini berlaku untuk jangka waktu ${durationText(c.startDate, c.endDate)}, terhitung mulai tanggal ${fmtLongDate(c.startDate)} sampai dengan tanggal ${fmtLongDate(c.endDate)}`,
        'Perjanjian ini tidak mensyaratkan masa percobaan kerja.',
        'Perjanjian dapat diperpanjang secara tertulis atas kesepakatan PARA PIHAK dan tidak diperpanjang secara otomatis. PIHAK PERTAMA memberi tahu keputusan perpanjangan paling lambat 7 (tujuh) hari sebelum perjanjian berakhir.',
        'Seluruh jangka waktu perjanjian beserta perpanjangannya tidak lebih dari 5 (lima) tahun.',
        'Evaluasi kinerja dilakukan oleh Manajemen sebagai pertimbangan perpanjangan.',
      ],
    },
    { t: 'heading', text: 'PASAL 3: TUGAS DAN TANGGUNG JAWAB' },
    ...(coord
      ? ([
          { t: 'para', text: 'PIHAK KEDUA berkewajiban melaksanakan tugas sesuai SOP yang merupakan bagian dari perjanjian ini, khususnya BAB VIII, yang meliputi:' },
          {
            t: 'list',
            items: [
              'Memastikan petugas hadir, berada di pos, dan melakukan absensi online.',
              'Mengatur istirahat, tukar shift, dan pengganti petugas agar pos tetap terisi.',
              'Mengumpulkan dan meneruskan laporan parkir kepada Manajemen.',
              'Meninjau pengajuan izin dan laporan kendala, serta mengirim jadwal hari esok kepada petugas.',
              'Memastikan serah terima shift, karcis, dan setoran berjalan sesuai SOP.',
              'Memimpin penanganan awal kejadian khusus dan melaporkannya kepada Manajemen.',
            ],
          },
        ] as Block[])
      : ([
          { t: 'para', text: 'PIHAK KEDUA berkewajiban melaksanakan tugas sesuai SOP yang merupakan bagian dari perjanjian ini, yang meliputi:' },
          {
            t: 'list',
            items: [
              'Menyambut, mengarahkan, dan mengatur kendaraan masuk serta keluar dengan aman dan tertib.',
              'Menerbitkan karcis resmi dari Manajemen untuk setiap kendaraan yang parkir.',
              'Memantau keamanan kendaraan dan melaporkan aktivitas mencurigakan kepada Koordinator atau Security.',
              'Mencatat kendaraan dan menyampaikan laporan parkir, karcis, serta pendapatan sesuai SOP.',
              'Menjaga kebersihan dan kerapihan area parkir serta memberikan pelayanan yang ramah dan sopan.',
              'Melakukan serah terima shift dan menangani keluhan atau kejadian khusus sesuai SOP.',
            ],
          },
        ] as Block[])),
    { t: 'heading', text: 'PASAL 4: WAKTU KERJA DAN SHIFT' },
    {
      t: 'list',
      items: [
        coord ? 'Waktu kerja PIHAK KEDUA diatur sesuai roster yang ditetapkan PIHAK PERTAMA.' : c.workHoursText,
        'PIHAK KEDUA mendapat 1 (satu) hari Off per minggu dan waktu istirahat sesuai SOP.',
        'Kehadiran dicatat melalui absensi online. Izin, sakit, dan cuti diajukan sesuai BAB V SOP.',
        'Kerja lembur dilakukan atas perintah PIHAK PERTAMA dan persetujuan PIHAK KEDUA.',
      ],
    },
    { t: 'heading', text: 'PASAL 5: UPAH, TUNJANGAN, PEMOTONGAN, DAN FASILITAS' },
    {
      t: 'list',
      items: [
        {
          text: 'Upah dan Tunjangan Tetap:',
          sub: [
            `Upah Pokok: ${rupiah(c.baseWage)} (${cap(terbilang(c.baseWage))} rupiah) per bulan.`,
            c.allowance ? `Tunjangan Jabatan: ${rupiah(c.allowance)} (${cap(terbilang(c.allowance))} rupiah) per bulan.` : coord ? 'Tunjangan Jabatan: Rp ................ per bulan.' : 'Tunjangan Jabatan: -',
          ],
        },
        'Fasilitas dan BPJS: PIHAK PERTAMA wajib mendaftarkan PIHAK KEDUA dalam program BPJS Ketenagakerjaan dan BPJS Kesehatan, serta menyediakan seragam dan perlengkapan kerja.',
        'Pajak Penghasilan dan iuran BPJS dipotong sesuai persentase dan ketentuan perundang-undangan yang berlaku.',
        'Upah dibayarkan setiap tanggal 10 (sepuluh) bulan berikutnya melalui transfer ke rekening bank PIHAK KEDUA.',
      ],
    },
    { t: 'heading', text: 'PASAL 6: TATA TERTIB DAN SANKSI DISIPLIN' },
    {
      t: 'list',
      items: [
        `PIHAK KEDUA wajib mematuhi Peraturan Perusahaan ${e.companyName}, SOP, dan Tata Tertib Kawasan Mall Sorong Modern City.`,
        {
          text: 'PIHAK KEDUA dilarang keras:',
          sub: [
            'Melakukan pungutan liar, atau menerima pembayaran tanpa karcis resmi.',
            'Membuat, memakai ulang, atau memanipulasi karcis, serta memakai uang hasil parkir.',
            'Titip absen, memakai foto wajah orang lain, atau memalsukan lokasi.',
            'Meninggalkan pos tanpa izin, atau tidur dan bermain handphone untuk keperluan pribadi saat bertugas.',
            'Mengonsumsi minuman beralkohol, narkoba, berjudi, atau melanggar hukum di lingkungan mall.',
            'Bertindak kasar, tidak sopan, atau memicu perselisihan dengan pengunjung, tenant, maupun pengelola mall.',
          ],
        },
        'Pelanggaran dikenakan sanksi sesuai BAB IX SOP dan Peraturan Perusahaan, setelah PIHAK KEDUA diberi kesempatan menyampaikan penjelasan.',
      ],
    },
    { t: 'heading', text: 'PASAL 7: KARCIS DAN PENDAPATAN PARKIR' },
    {
      t: 'list',
      items: [
        'PIHAK KEDUA wajib mengelola karcis dan menyetorkan seluruh pendapatan parkir sesuai BAB VI SOP.',
        'Setiap selisih diperiksa oleh Manajemen. Penggantian kerugian hanya dilakukan apabila kesalahan PIHAK KEDUA terbukti dan sesuai Peraturan Perusahaan.',
      ],
    },
    { t: 'heading', text: 'PASAL 8: KETIDAKHADIRAN TANPA KETERANGAN (MANGKIR) DAN PEMOTONGAN UPAH' },
    {
      t: 'list',
      items: [
        'Prinsip No Work No Pay: apabila PIHAK KEDUA tidak masuk kerja tanpa alasan yang sah (mangkir), PIHAK KEDUA tidak berhak atas upah untuk hari tersebut, sesuai Pasal 93 UU No. 13 Tahun 2003 jo. UU No. 6 Tahun 2023.',
        'Pemotongan upah dihitung proporsional berdasarkan 25 (dua puluh lima) hari kerja per bulan, dengan rumus: Upah Pokok ÷ 25 × jumlah hari mangkir.',
        {
          text: 'Selain pemotongan upah, mangkir dikenakan sanksi berikut:',
          sub: [
            'Mangkir 1 (satu) sampai 2 (dua) hari kerja: Teguran Lisan / Peringatan Pertama.',
            'Mangkir 3 (tiga) sampai 4 (empat) hari kerja: Peringatan Kedua secara tertulis.',
            'Mangkir 5 (lima) hari kerja berturut-turut atau lebih: setelah dipanggil 2 (dua) kali secara patut dan tertulis namun tidak dapat memberikan alasan yang sah, PIHAK KEDUA dikualifikasikan mengundurkan diri dan dapat dikenakan Pemutusan Hubungan Kerja (PHK).',
          ],
        },
      ],
    },
    { t: 'heading', text: 'PASAL 9: PROSEDUR PENGUNDURAN DIRI' },
    {
      t: 'list',
      items: [
        'PIHAK KEDUA yang ingin mengundurkan diri sebelum perjanjian berakhir wajib mengajukan surat tertulis paling lambat 14 (empat belas) hari sebelum tanggal efektif.',
        'PIHAK KEDUA wajib menyelesaikan serah terima tugas, karcis, uang, dan perlengkapan sebelum tanggal efektif.',
        'Pengakhiran sebelum waktunya tunduk pada Pasal 62 UU No. 13 Tahun 2003: pihak yang mengakhiri perjanjian di luar ketentuan Pasal 11 ayat (1) dan (2) wajib membayar ganti rugi sebesar upah sampai batas waktu berakhirnya perjanjian.',
        'Uang Kompensasi tetap dihitung untuk masa kerja yang telah dijalani, sesuai Peraturan Pemerintah Nomor 35 Tahun 2021.',
      ],
    },
    { t: 'heading', text: 'PASAL 10: BERAKHIRNYA PERJANJIAN DAN INVENTARIS' },
    {
      t: 'list',
      items: [
        'Perjanjian berakhir demi hukum apabila jangka waktu dalam Pasal 2 telah selesai, atau PIHAK KEDUA meninggal dunia.',
        'Perjanjian dapat diakhiri PIHAK PERTAMA apabila PIHAK KEDUA terbukti melakukan pelanggaran berat menurut BAB IX SOP atau Peraturan Perusahaan, dengan mengikuti tata cara peraturan perundang-undangan.',
        'PIHAK KEDUA yang tidak mencapai standar kinerja mendapat pembinaan, dan hasilnya menjadi pertimbangan perpanjangan perjanjian.',
        'Saat perjanjian berakhir, PIHAK KEDUA wajib mengembalikan seluruh inventaris (seragam, tanda pengenal, perlengkapan tugas, karcis, dll.) dalam keadaan baik.',
      ],
    },
    { t: 'heading', text: 'PASAL 11: DATA PRIBADI' },
    { t: 'para', text: 'PIHAK KEDUA menyetujui foto wajah dan data lokasinya diproses untuk absensi online sesuai BAB IV SOP dan UU No. 27 Tahun 2022 tentang Pelindungan Data Pribadi.' },
    { t: 'heading', text: 'PASAL 12: PENYELESAIAN PERSELISIHAN' },
    {
      t: 'list',
      items: [
        'Apabila timbul perselisihan, PARA PIHAK sepakat menyelesaikannya secara musyawarah untuk mufakat.',
        'Apabila musyawarah tidak mencapai mufakat, perselisihan diselesaikan melalui mekanisme peraturan perundang-undangan ketenagakerjaan yang berlaku di Republik Indonesia.',
      ],
    },
    { t: 'heading', text: 'PASAL 13: PENUTUP' },
    { t: 'para', text: 'Demikian Surat Perjanjian Kerja Waktu Tertentu ini dibuat dan ditandatangani dalam rangkap 2 (dua) yang berkedudukan hukum sama, dibubuhi meterai secukupnya, serta berlaku sejak tanggal ditetapkan.' },
    { t: 'gap' },
    { t: 'para', text: 'Kota Sorong, ................................' },
    { t: 'sign', left: ['PIHAK PERTAMA', e.companyName, e.signerName || DOTS], right: ['PIHAK KEDUA', 'PEKERJA', name] },
    { t: 'gap' },
    { t: 'field', label: 'Dicatatkan', value: e.recordedPlace || DOTS },
    { t: 'field', label: 'Pada', value: fmtLongDate(c.signDate) },
    { t: 'field', label: 'No. PKWT', value: number },
  ];
  if (receivedText) B.push({ t: 'gap' }, { t: 'note', text: receivedText });
  if (c.voidedAt) B.splice(2, 0, { t: 'note', text: 'KONTRAK INI TELAH DIBATALKAN DAN TIDAK BERLAKU.' });
  const short = nameCase(user.fullName);
  return { fileTitle: `PKWT ${short}`, footer: `PKWT ${short}`, blocks: B };
}

/** Nama berkas yang aman, mis. "PKWT_001-PKWT-DPM-SMC-2026_Putri-Bugis" */
export const contractFileName = (c: { number: string; id: number }, fullName: string) =>
  `PKWT_${(c.number || `kontrak-${c.id}`).replace(/[\\/]+/g, '-')}_${fullName.replace(/[^\w]+/g, '-')}`;

/** Muat data lengkap untuk mencetak beberapa kontrak sekaligus. */
export async function loadForPrint(ids: number[]) {
  const contracts = await EmploymentContract.findAll({ where: { id: ids }, order: [['seq', 'ASC']] });
  const userIds = contracts.map((c) => c.userId);
  const [users, profiles] = await Promise.all([User.findAll({ where: { id: userIds.concat(0) } }), EmployeeProfile.findAll({ where: { userId: userIds.concat(0) } })]);
  // urutkan sesuai permintaan
  const byId = new Map(contracts.map((c) => [c.id, c]));
  return ids
    .map((id) => byId.get(id))
    .filter((c): c is EmploymentContract => !!c)
    .map((c) => ({ c, user: users.find((u) => u.id === c.userId)!, profile: profiles.find((p) => p.userId === c.userId) ?? null }));
}

