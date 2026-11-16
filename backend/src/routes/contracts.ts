import { Response, Router } from 'express';
import { Op } from 'sequelize';
import { z } from 'zod';
import { currentUser, requireRole } from '../middleware/auth';
import { ATTENDEE_ROLES, DocumentReceipt, EmployeeProfile, EmployeeWage, EmploymentContract, sequelize, User } from '../models';
import {
  addMonths,
  buildContract,
  contractFileName,
  contractStatus,
  contractsNeedingAction,
  currentEmployer,
  daysBetween,
  formatContractNumber,
  getContractSettings,
  loadForPrint,
  nextSeq,
  saveContractSettings,
} from '../services/contract';
import { contractsDocx } from '../services/contractDocx';
import { contractsPdf } from '../services/contractPdf';
import { getOrgSettings } from '../services/organization';
import { witDateTime } from '../services/receipts';
import { ah, HttpError } from '../utils/http';
import { addDays, DATE_RE, witNow } from '../utils/time';

/** Data pribadi karyawan & kontrak PKWT — khusus Super Admin. */
const router = Router();
router.use(requireRole('SUPER_ADMIN'));

const date = z.string().regex(DATE_RE, 'Format tanggal YYYY-MM-DD');
const opt = (max: number) => z.string().trim().max(max).nullable().transform((v) => v || null);

// ───────────── Pengaturan ─────────────
const settingsSchema = z.object({
  signerName: z.string().trim().max(120),
  signerTitle: z.string().trim().max(80),
  numberFormat: z.string().trim().max(80),
  recordedPlace: z.string().trim().max(80),
  defaultWage: z.number().int().min(0).max(1_000_000_000),
  defaultMonths: z.number().int().min(1).max(60),
  workHoursText: z.string().trim().min(10).max(500),
});
router.get('/settings', ah(async (_req, res) => res.json(await getContractSettings())));
router.put(
  '/settings',
  ah(async (req, res) => {
    const next = settingsSchema.parse(req.body);
    await saveContractSettings(next, currentUser(req).id);
    res.json(next);
  }),
);

// ───────────── Data pribadi ─────────────
const profileOut = (p: EmployeeProfile | null) => ({
  ktpNumber: p?.ktpNumber ?? null,
  birthPlace: p?.birthPlace ?? null,
  birthDate: p?.birthDate ?? null,
  address: p?.address ?? null,
  bankName: p?.bankName ?? null,
  bankAccount: p?.bankAccount ?? null,
});
const missingOf = (p: ReturnType<typeof profileOut>, phone: string) =>
  [!p.ktpNumber && 'NIK KTP', !(p.birthPlace && p.birthDate) && 'tempat/tanggal lahir', !p.address && 'alamat', !phone && 'No. HP'].filter(Boolean) as string[];

/** Karyawan aktif + data pribadi + kontrak terakhir (untuk daftar & formulir buat kontrak). */
router.get(
  '/employees',
  ah(async (_req, res) => {
    const today = witNow().date;
    const users = await User.findAll({ where: { role: [...ATTENDEE_ROLES], isActive: true }, order: [['fullName', 'ASC']] });
    const ids = users.map((u) => u.id).concat(0);
    const [profiles, contracts] = await Promise.all([
      EmployeeProfile.findAll({ where: { userId: ids } }),
      EmploymentContract.findAll({ where: { userId: ids, voidedAt: null }, order: [['endDate', 'DESC']] }),
    ]);
    res.json(
      users.map((u) => {
        const p = profileOut(profiles.find((x) => x.userId === u.id) ?? null);
        const last = contracts.find((c) => c.userId === u.id);
        return {
          userId: u.id,
          fullName: u.fullName,
          nik: u.nik,
          role: u.role,
          phone: u.phone,
          profile: p,
          missing: missingOf(p, u.phone),
          lastContract: last ? { id: last.id, number: last.number, startDate: last.startDate, endDate: last.endDate, status: contractStatus(last, today), daysLeft: daysBetween(today, last.endDate) } : null,
        };
      }),
    );
  }),
);

router.put(
  '/employees/:userId/profile',
  ah(async (req, res) => {
    const body = z
      .object({
        ktpNumber: z.string().trim().regex(/^\d{16}$/, 'NIK KTP harus 16 angka').nullable().or(z.literal('').transform(() => null)),
        birthPlace: opt(80),
        birthDate: date.nullable().or(z.literal('').transform(() => null)),
        address: opt(300),
        bankName: opt(60),
        bankAccount: opt(40),
      })
      .parse(req.body);
    const user = await User.findByPk(Number(req.params.userId));
    if (!user || !(ATTENDEE_ROLES as readonly string[]).includes(user.role)) throw new HttpError(404, 'Karyawan tidak ditemukan');
    // Hanya tabel employee_profiles yang diubah — akun & data wajah tidak tersentuh
    await EmployeeProfile.upsert({ userId: user.id, ...body });
    res.json(profileOut(await EmployeeProfile.findByPk(user.id)));
  }),
);

// ───────────── Kontrak ─────────────
async function listOut(contracts: EmploymentContract[]) {
  const today = witNow().date;
  const ids = contracts.map((c) => c.id).concat(0);
  const [users, receipts] = await Promise.all([
    User.findAll({ where: { id: contracts.map((c) => c.userId).concat(0) }, attributes: ['id', 'fullName', 'nik', 'role', 'isActive'] }),
    DocumentReceipt.findAll({ where: { kind: 'CONTRACT', refId: ids } }),
  ]);
  return contracts.map((c) => {
    const u = users.find((x) => x.id === c.userId);
    const r = receipts.find((x) => x.refId === c.id && x.userId === c.userId);
    return {
      id: c.id,
      userId: c.userId,
      fullName: u?.fullName ?? '?',
      nik: u?.nik ?? '',
      isActive: u?.isActive ?? false,
      number: c.number,
      position: c.position,
      signDate: c.signDate,
      startDate: c.startDate,
      endDate: c.endDate,
      baseWage: c.baseWage,
      allowance: c.allowance,
      companyName: c.employer.companyName,
      previousId: c.previousId,
      status: contractStatus(c, today),
      daysLeft: daysBetween(today, c.endDate),
      openedAt: r?.openedAt ?? null,
      receivedAt: r?.receivedAt ?? null,
      voidReason: c.voidReason,
      voidedAt: c.voidedAt,
      createdAt: c.createdAt,
    };
  });
}

router.get(
  '/',
  ah(async (_req, res) => {
    const contracts = await EmploymentContract.findAll({ order: [['startDate', 'DESC'], ['seq', 'DESC']] });
    const action = await contractsNeedingAction();
    res.json({
      contracts: await listOut(contracts),
      expiring: action.expiring.map((x) => ({ userId: x.userId, fullName: x.fullName, contractId: x.contract.id, endDate: x.contract.endDate, daysLeft: x.daysLeft })),
      expired: action.expired.map((x) => ({ userId: x.userId, fullName: x.fullName, contractId: x.contract.id, endDate: x.contract.endDate, daysAgo: x.daysAgo })),
    });
  }),
);

const termsSchema = z
  .object({
    signDate: date,
    startDate: date,
    endDate: date,
    baseWage: z.number().int().min(0).max(1_000_000_000),
    allowance: z.number().int().min(0).max(1_000_000_000).nullable(),
  })
  .refine((v) => v.endDate > v.startDate, { message: 'Tanggal berakhir harus setelah tanggal mulai', path: ['endDate'] })
  .refine((v) => daysBetween(v.startDate, v.endDate) <= 5 * 366, { message: 'PKWT paling lama 5 tahun', path: ['endDate'] });

/** Buat kontrak untuk satu atau beberapa karyawan sekaligus (nomor urut otomatis). */
router.post(
  '/',
  ah(async (req, res) => {
    const body = z
      .object({ userIds: z.array(z.number().int().positive()).min(1).max(200), syncWage: z.boolean().default(true) })
      .and(termsSchema)
      .parse(req.body);
    const users = await User.findAll({ where: { id: body.userIds, role: [...ATTENDEE_ROLES], isActive: true }, order: [['fullName', 'ASC']] });
    if (users.length !== new Set(body.userIds).size) throw new HttpError(400, 'Ada karyawan yang tidak ditemukan atau tidak aktif');
    // Tolak bila masa kontrak bertabrakan dengan kontrak lain yang belum dibatalkan
    const overlap = await EmploymentContract.findAll({
      where: { userId: body.userIds, voidedAt: null, startDate: { [Op.lte]: body.endDate }, endDate: { [Op.gte]: body.startDate } },
    });
    if (overlap.length) {
      const names = [...new Set(overlap.map((o) => users.find((u) => u.id === o.userId)?.fullName))].join(', ');
      throw new HttpError(409, `Masa kontrak bertabrakan dengan kontrak yang sudah ada: ${names}. Batalkan kontrak lama atau pilih tanggal mulai setelah kontrak lama berakhir.`);
    }
    const { employer, settings, numberCode } = await currentEmployer();
    const actor = currentUser(req).id;
    const year = Number(body.signDate.slice(0, 4));
    const created = await sequelize.transaction(async (transaction) => {
      let seq = await nextSeq(year, transaction);
      const out: EmploymentContract[] = [];
      for (const u of users) {
        const prev = await EmploymentContract.findOne({ where: { userId: u.id, voidedAt: null, endDate: { [Op.lt]: body.startDate } }, order: [['endDate', 'DESC']], transaction });
        out.push(
          await EmploymentContract.create(
            {
              userId: u.id,
              year,
              seq,
              number: formatContractNumber(settings.numberFormat, numberCode, seq, body.signDate),
              position: u.role === 'KOORDINATOR' ? 'KOORDINATOR' : 'PETUGAS',
              signDate: body.signDate,
              startDate: body.startDate,
              endDate: body.endDate,
              baseWage: body.baseWage,
              allowance: body.allowance,
              employer,
              workHoursText: settings.workHoursText,
              previousId: prev?.id ?? null,
              createdById: actor,
            },
            { transaction },
          ),
        );
        seq++;
        // Upah pokok di Rekap Upah disamakan dengan kontrak
        if (body.syncWage) await EmployeeWage.upsert({ userId: u.id, baseWage: body.baseWage }, { transaction });
      }
      return out;
    });
    res.status(201).json(await listOut(created));
  }),
);

async function editable(id: number) {
  const c = await EmploymentContract.findByPk(id);
  if (!c) throw new HttpError(404, 'Kontrak tidak ditemukan');
  if (c.voidedAt) throw new HttpError(400, 'Kontrak sudah dibatalkan');
  return c;
}

/** Ubah isi kontrak — hanya selama petugas belum mengonfirmasi tanda terima. */
router.patch(
  '/:id',
  ah(async (req, res) => {
    const c = await editable(Number(req.params.id));
    const received = await DocumentReceipt.findOne({ where: { kind: 'CONTRACT', refId: c.id, userId: c.userId, receivedAt: { [Op.ne]: null } } });
    if (received) throw new HttpError(400, 'Kontrak sudah diterima petugas sehingga tidak bisa diubah. Batalkan lalu buat kontrak baru.');
    const body = z.object({ number: z.string().trim().max(80), syncWage: z.boolean().default(true) }).and(termsSchema).parse(req.body);
    const overlap = await EmploymentContract.count({
      where: { id: { [Op.ne]: c.id }, userId: c.userId, voidedAt: null, startDate: { [Op.lte]: body.endDate }, endDate: { [Op.gte]: body.startDate } },
    });
    if (overlap) throw new HttpError(409, 'Masa kontrak bertabrakan dengan kontrak lain milik karyawan ini');
    await sequelize.transaction(async (transaction) => {
      await c.update({ number: body.number, signDate: body.signDate, startDate: body.startDate, endDate: body.endDate, baseWage: body.baseWage, allowance: body.allowance }, { transaction });
      if (body.syncWage) await EmployeeWage.upsert({ userId: c.userId, baseWage: body.baseWage }, { transaction });
    });
    res.json((await listOut([c]))[0]);
  }),
);

router.post(
  '/:id/void',
  ah(async (req, res) => {
    const { reason } = z.object({ reason: z.string().trim().min(5, 'Tulis alasan pembatalan (min. 5 huruf)').max(300) }).parse(req.body);
    const c = await editable(Number(req.params.id));
    await c.update({ voidReason: reason, voidedAt: new Date(), voidedById: currentUser(req).id });
    res.json((await listOut([c]))[0]);
  }),
);

/** Usulan perpanjangan: mulai sehari setelah kontrak lama berakhir, lama sama dengan pengaturan. */
router.get(
  '/renewal-proposal',
  ah(async (req, res) => {
    const ids = z.string().parse(req.query.ids).split(',').map(Number).filter(Boolean);
    const [contracts, s] = await Promise.all([EmploymentContract.findAll({ where: { id: ids, voidedAt: null } }), getContractSettings()]);
    if (!contracts.length) throw new HttpError(404, 'Kontrak tidak ditemukan');
    const lastEnd = contracts.map((c) => c.endDate).sort().pop()!;
    const startDate = addDays(lastEnd, 1);
    res.json({ userIds: contracts.map((c) => c.userId), startDate, endDate: addMonths(startDate, s.defaultMonths), baseWage: contracts[0].baseWage, allowance: contracts[0].allowance });
  }),
);

// ───────────── Unduh Word / PDF ─────────────
async function receivedTextFor(contractId: number, userId: number, fullName: string) {
  const r = await DocumentReceipt.findOne({ where: { kind: 'CONTRACT', refId: contractId, userId, receivedAt: { [Op.ne]: null } } });
  return r?.receivedAt ? `Diterima secara digital oleh ${fullName} pada ${witDateTime(r.receivedAt)} melalui aplikasi SMC-FaceAttend.` : null;
}

/** Kirim satu atau beberapa kontrak sebagai .docx atau .pdf */
export async function sendContracts(res: Response, ids: number[], format: 'docx' | 'pdf', withReceipt = true) {
  const rows = await loadForPrint(ids);
  if (!rows.length) throw new HttpError(404, 'Kontrak tidak ditemukan');
  const { numberCode } = await getOrgSettings();
  const docs = await Promise.all(rows.map(async ({ c, user, profile }) => buildContract(c, user, profile, withReceipt ? await receivedTextFor(c.id, c.userId, user.fullName) : null, numberCode)));
  const base = rows.length === 1 ? contractFileName(rows[0].c, rows[0].user.fullName) : `PKWT_${rows.length}-karyawan_${witNow().date}`;
  const buf = format === 'docx' ? contractsDocx(docs) : await contractsPdf(docs);
  res.setHeader('Content-Type', format === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${base}.${format}"`);
  res.send(buf);
}

const fmtParam = (v: unknown) => z.enum(['docx', 'pdf']).parse(v);
router.get(
  '/download',
  ah(async (req, res) => {
    const ids = z.string().parse(req.query.ids).split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 200);
    await sendContracts(res, ids, fmtParam(req.query.format));
  }),
);
router.get(
  '/:id/:format',
  ah(async (req, res) => {
    await sendContracts(res, [Number(req.params.id)], fmtParam(req.params.format));
  }),
);

export default router;
