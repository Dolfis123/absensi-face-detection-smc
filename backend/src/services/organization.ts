/**
 * Identitas perusahaan pengelola, kop surat, penomoran surat, dan penandatangan.
 * Semua dokumen (surat disiplin, rekap upah, piagam, laporan bulanan, roster) membaca dari sini,
 * sehingga bila pengelola parkir berganti cukup diubah Super Admin tanpa mengubah kode.
 *
 * Disimpan di app_settings dengan kunci lama 'disciplineSettings' supaya isian yang sudah ada tetap terpakai.
 */
import fs from 'fs';
import path from 'path';
import { env } from '../config/env';
import { AppSetting, sequelize, ShiftChangeLog } from '../models';
import { HttpError } from '../utils/http';

export interface OrgSettings {
  // ── Kop surat / perusahaan pengelola ──
  companyName: string;
  companyAddress: string;
  /** Telepon / email / NPWP — baris kecil di kop; boleh kosong */
  companyContact: string;
  // ── Lokasi yang dikelola ──
  /** Nama tempat, mis. "Mall Sorong Modern City" */
  placeName: string;
  /** Singkatan tempat, mis. "SMC" (judul aplikasi & laporan) */
  placeShort: string;
  /** Kota & provinsi, mis. "Kota Sorong, Papua Barat Daya" */
  cityRegion: string;
  /** Kota di depan tanggal tanda tangan, mis. "Sorong" */
  signCity: string;
  // ── Penandatangan ──
  hrdName: string;
  hrdTitle: string;
  coordinatorName: string;
  coordinatorTitle: string;
  /** Pihak "mengetahui" dari pemilik tempat (mis. manajemen mall) */
  managementName: string;
  managementTitle: string;
  showManagementSign: boolean;
  /** Pengesah laporan bulanan resmi */
  reportApproverName: string;
  reportApproverTitle: string;
  // ── Penomoran surat ──
  /** Pola nomor; token: {no} {jenis} {kode} {bulan} {bulanAngka} {tahun} */
  numberFormat: string;
  numberCode: string;
  warningCode: string;
  callCode: string;
  /** Tempat menghadap untuk surat panggilan */
  defaultReportPlace: string;
}

export const DEFAULT_ORG: OrgSettings = {
  companyName: 'CV. DEVA JAYA',
  companyAddress: 'Jln. Bolhok Rt.1/Rw.01 Kelurahan Klabinain, Kab. Sorong',
  companyContact: '',
  placeName: 'Mall Sorong Modern City',
  placeShort: 'SMC',
  cityRegion: 'Kota Sorong, Papua Barat Daya',
  signCity: 'Sorong',
  hrdName: '',
  hrdTitle: 'HRD/Admin Manager',
  coordinatorName: '',
  coordinatorTitle: 'Koordinator Lapangan',
  managementName: '',
  managementTitle: 'Manajemen Mall Sorong Modern City',
  showManagementSign: true,
  reportApproverName: '',
  reportApproverTitle: 'Manager Mal SMC',
  numberFormat: '{no}/{jenis}/{kode}/{bulan}/{tahun}',
  numberCode: 'DPM-SMC',
  warningCode: 'SP',
  callCode: 'SPG',
  defaultReportPlace: 'Kantor Pengelola Parkir Mall Sorong Modern City',
};

const KEY = 'disciplineSettings';

export async function getOrgSettings(): Promise<OrgSettings> {
  const row = await AppSetting.findByPk(KEY);
  if (!row) return DEFAULT_ORG;
  try {
    return { ...DEFAULT_ORG, ...(JSON.parse(row.value) as Partial<OrgSettings>) };
  } catch {
    return DEFAULT_ORG;
  }
}

export async function saveOrgSettings(next: OrgSettings, actorId: number) {
  const before = await getOrgSettings();
  await sequelize.transaction(async (transaction) => {
    await AppSetting.upsert({ key: KEY, value: JSON.stringify(next) }, { transaction });
    await ShiftChangeLog.create({ actorId, target: 'Identitas & kop surat', before, after: next }, { transaction });
  });
}

// ── Teks turunan yang dipakai banyak dokumen ──
export const areaText = (s: OrgSettings) => `Area Parkir ${s.placeName}`;
export const postText = (s: OrgSettings) => `Pos Parkir ${s.placeName}${s.placeShort ? ` (${s.placeShort})` : ''}`;
export const signDate = (s: OrgSettings, longDate: string) => (s.signCity ? `${s.signCity}, ${longDate}` : longDate);

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
/** Nomor surat menurut pola, mis. 001/SP/DPM-SMC/XI/2026 */
export function formatLetterNumber(s: Pick<OrgSettings, 'numberFormat' | 'numberCode' | 'warningCode' | 'callCode'>, seq: number, isCall: boolean, letterDate: string) {
  const month = Number(letterDate.slice(5, 7));
  const tokens: Record<string, string> = {
    no: String(seq).padStart(3, '0'),
    jenis: isCall ? s.callCode : s.warningCode,
    kode: s.numberCode,
    bulan: ROMAN[month - 1],
    bulanAngka: String(month).padStart(2, '0'),
    tahun: letterDate.slice(0, 4),
  };
  return s.numberFormat.replace(/\{(\w+)\}/g, (m, k: string) => tokens[k] ?? m).replace(/\/{2,}/g, '/').replace(/^\/|\/$/g, '');
}

// ── Logo kop surat (berkas di folder upload) ──
const logoDir = () => path.resolve(env.uploadDir, 'org');
const LOGO_NAMES = ['logo.png', 'logo.jpg'];

/** Path logo bila ada, untuk digambar di PDF */
export function logoPath(): string | null {
  for (const n of LOGO_NAMES) {
    const p = path.join(logoDir(), n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function saveLogo(dataUrl: string) {
  const m = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new HttpError(400, 'Logo harus berupa gambar PNG atau JPG');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 1_000_000) throw new HttpError(400, 'Ukuran logo maksimal 1 MB');
  fs.mkdirSync(logoDir(), { recursive: true });
  removeLogo();
  fs.writeFileSync(path.join(logoDir(), m[1] === 'png' ? 'logo.png' : 'logo.jpg'), buf);
}

export function removeLogo() {
  for (const n of LOGO_NAMES) fs.rmSync(path.join(logoDir(), n), { force: true });
}

/** Gambar logo (bila ada) di dalam kotak; mengembalikan lebar yang terpakai (0 bila tanpa logo). */
export function drawLogo(doc: PDFKit.PDFDocument, x: number, y: number, size: number): number {
  const p = logoPath();
  if (!p) return 0;
  try {
    doc.image(p, x, y, { fit: [size, size], align: 'center', valign: 'center' });
    return size;
  } catch {
    return 0; // berkas rusak: dokumen tetap tercetak tanpa logo
  }
}
