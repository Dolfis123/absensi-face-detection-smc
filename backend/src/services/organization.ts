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

// ── Gambar dokumen (berkas di folder upload): logo kop & cap/stempel tanda tangan ──
export type OrgImage = 'logo' | 'stamp';
const imgDir = () => path.resolve(env.uploadDir, 'org');
const names = (kind: OrgImage) => [`${kind}.png`, `${kind}.jpg`];

/** Path gambar bila ada, untuk digambar di PDF */
export function imagePath(kind: OrgImage): string | null {
  for (const n of names(kind)) {
    const p = path.join(imgDir(), n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
export const logoPath = () => imagePath('logo');

export function saveImage(kind: OrgImage, dataUrl: string) {
  const m = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new HttpError(400, 'Gambar harus berupa PNG atau JPG');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 1_000_000) throw new HttpError(400, 'Ukuran gambar maksimal 1 MB');
  fs.mkdirSync(imgDir(), { recursive: true });
  removeImage(kind);
  fs.writeFileSync(path.join(imgDir(), `${kind}.${m[1] === 'png' ? 'png' : 'jpg'}`), buf);
}

export function removeImage(kind: OrgImage) {
  for (const n of names(kind)) fs.rmSync(path.join(imgDir(), n), { force: true });
}

/** Gambar logo (bila ada) di dalam kotak; mengembalikan lebar yang terpakai (0 bila tanpa logo). */
export function drawLogo(doc: PDFKit.PDFDocument, x: number, y: number, size: number): number {
  return drawImage(doc, 'logo', x, y, size, size) ? size : 0;
}

/** Gambar dalam kotak w×h (dipusatkan); false bila tidak ada / berkas rusak (dokumen tetap tercetak). */
export function drawImage(doc: PDFKit.PDFDocument, kind: OrgImage, x: number, y: number, w: number, h: number): boolean {
  const p = imagePath(kind);
  if (!p) return false;
  try {
    doc.image(p, x, y, { fit: [w, h], align: 'center', valign: 'center' });
    return true;
  } catch {
    return false;
  }
}
