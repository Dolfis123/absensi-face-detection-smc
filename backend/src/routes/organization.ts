import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireAuth, requireRole } from '../middleware/auth';
import { formatLetterNumber, getOrgSettings, imagePath, logoPath, OrgImage, OrgSettings, removeImage, saveImage, saveOrgSettings } from '../services/organization';
import { ah, HttpError } from '../utils/http';
import { witNow } from '../utils/time';

/** Identitas perusahaan pengelola & kop surat. Diubah hanya oleh Super Admin. */
const router = Router();

/** Publik (halaman login/absen): nama tempat & pengelola untuk judul aplikasi. */
router.get(
  '/public',
  ah(async (_req, res) => {
    const s = await getOrgSettings();
    res.json({ companyName: s.companyName, placeName: s.placeName, placeShort: s.placeShort, cityRegion: s.cityRegion, hasLogo: !!logoPath() });
  }),
);

const KINDS: OrgImage[] = ['logo', 'stamp'];
const kindOf = (v: string): OrgImage => {
  if (!KINDS.includes(v as OrgImage)) throw new HttpError(404, 'Endpoint tidak ditemukan');
  return v as OrgImage;
};

/** Logo kop (publik, untuk halaman login) dan cap tanda tangan. */
router.get('/image/:kind', (req, res, next) => {
  try {
    const p = imagePath(kindOf(req.params.kind));
    if (!p) return res.status(404).json({ message: 'Gambar belum diunggah' });
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(p);
  } catch (e) {
    next(e);
  }
});

router.get(
  '/',
  requireAuth,
  ah(async (_req, res) => {
    res.json({ ...(await getOrgSettings()), hasLogo: !!logoPath(), hasStamp: !!imagePath('stamp') });
  }),
);

const text = (max: number) => z.string().trim().max(max);
const code = (max: number) => text(max).regex(/^[A-Za-z0-9.-]*$/, 'Kode hanya huruf, angka, titik, dan strip');
const schema = z.object({
  companyName: text(120).min(2, 'Nama perusahaan wajib diisi'),
  companyAddress: text(200),
  companyContact: text(150),
  placeName: text(120).min(2, 'Nama tempat wajib diisi'),
  placeShort: code(20),
  cityRegion: text(120),
  signCity: text(60),
  hrdName: text(120),
  hrdTitle: text(80).min(2, 'Jabatan penandatangan perusahaan wajib diisi'),
  coordinatorName: text(120),
  coordinatorTitle: text(80).min(2, 'Jabatan koordinator wajib diisi'),
  managementName: text(120),
  managementTitle: text(120),
  showManagementSign: z.boolean(),
  reportApproverName: text(120),
  reportApproverTitle: text(120).min(2, 'Jabatan pengesah laporan wajib diisi'),
  numberFormat: text(80).refine((v) => v.includes('{no}'), 'Pola nomor wajib memuat {no}'),
  numberCode: code(30),
  warningCode: code(10).min(1, 'Kode surat peringatan wajib diisi'),
  callCode: code(10).min(1, 'Kode surat panggilan wajib diisi'),
  defaultReportPlace: text(150),
});

router.put(
  '/',
  requireAuth,
  requireRole('SUPER_ADMIN'),
  ah(async (req, res) => {
    const body: OrgSettings = schema.parse(req.body);
    await saveOrgSettings(body, currentUser(req).id);
    res.json({ ...body, hasLogo: !!logoPath(), hasStamp: !!imagePath('stamp') });
  }),
);

/** Contoh nomor surat dengan pola yang sedang diketik (sebelum disimpan). */
router.post(
  '/number-preview',
  requireAuth,
  requireRole('SUPER_ADMIN'),
  ah(async (req, res) => {
    const s = schema.pick({ numberFormat: true, numberCode: true, warningCode: true, callCode: true }).parse(req.body);
    const today = witNow().date;
    res.json({ warning: formatLetterNumber(s, 1, false, today), call: formatLetterNumber(s, 2, true, today) });
  }),
);

router.put(
  '/image/:kind',
  requireAuth,
  requireRole('SUPER_ADMIN'),
  ah(async (req, res) => {
    const kind = kindOf(req.params.kind);
    const { image } = z.object({ image: z.string().max(1_500_000, 'Ukuran gambar maksimal 1 MB') }).parse(req.body);
    saveImage(kind, image);
    res.json({ ok: true });
  }),
);

router.delete(
  '/image/:kind',
  requireAuth,
  requireRole('SUPER_ADMIN'),
  ah(async (req, res) => {
    const kind = kindOf(req.params.kind);
    if (!imagePath(kind)) throw new HttpError(404, 'Gambar belum diunggah');
    removeImage(kind);
    res.json({ ok: true });
  }),
);

export default router;
