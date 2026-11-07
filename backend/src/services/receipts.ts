/**
 * Tanda terima digital: bukti petugas sudah membuka dan menerima surat disiplin atau slip upah.
 * Tanda terima tidak bisa diubah atau dihapus setelah dicatat.
 */
import type { Response } from 'express';
import { Op } from 'sequelize';
import { DisciplineLetter, DocumentReceipt, ReceiptKind, User } from '../models';
import { getDisciplineSettings } from './discipline';
import { sendDisciplinePdf } from './disciplinePdf';

const POSITION: Record<string, string> = { KARYAWAN: 'Petugas Parkir' };

/** Tanggal & jam WIT yang mudah dibaca, mis. "8 November 2026 pukul 07.45 WIT" */
export function witDateTime(d: Date) {
  const s = d.toLocaleString('id-ID', { timeZone: 'Asia/Jayapura', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  return `${s.replace(/\s*(pukul\s*)?(\d{2})[.:](\d{2})$/, ' pukul $2.$3')} WIT`;
}

export async function receiptsFor(kind: ReceiptKind, refIds: number[], version?: number) {
  if (!refIds.length) return new Map<string, DocumentReceipt>();
  const rows = await DocumentReceipt.findAll({ where: { kind, refId: refIds, ...(version !== undefined ? { version } : {}) } });
  return new Map(rows.map((r) => [`${r.refId}|${r.userId}|${r.version}`, r]));
}

/** Catat pertama kali dokumen dibuka (tidak menimpa catatan lama). */
export async function markOpened(kind: ReceiptKind, refId: number, userId: number, version: number, userAgent?: string) {
  const [row] = await DocumentReceipt.findOrCreate({
    where: { kind, refId, userId, version },
    defaults: { kind, refId, userId, version, openedAt: new Date(), receivedAt: null, userAgent: userAgent?.slice(0, 255) ?? null },
  });
  if (!row.openedAt) await row.update({ openedAt: new Date() });
  return row;
}

/** Konfirmasi "Saya sudah menerima" — sekali saja; konfirmasi ulang mengembalikan waktu yang pertama. */
export async function markReceived(kind: ReceiptKind, refId: number, userId: number, version: number, userAgent?: string) {
  const row = await markOpened(kind, refId, userId, version, userAgent);
  if (!row.receivedAt) {
    await row.update({ receivedAt: new Date(), userAgent: userAgent?.slice(0, 255) ?? row.userAgent });
    await row.reload(); // nilai persis seperti tersimpan (tanpa milidetik)
  }
  return row;
}

/** PDF surat disiplin, dengan baris tanda terima digital bila petugas sudah mengonfirmasi. */
export async function sendLetterPdf(res: Response, l: DisciplineLetter) {
  const [user, settings, receipt] = await Promise.all([
    User.findByPk(l.userId),
    getDisciplineSettings(),
    DocumentReceipt.findOne({ where: { kind: 'LETTER', refId: l.id, userId: l.userId, receivedAt: { [Op.ne]: null } } }),
  ]);
  // Surat yang dirujuk: Peringatan Pertama untuk SP-2, Panggilan Pertama untuk Panggilan Kedua
  const prevType = l.type === 'PERINGATAN_2' ? 'PERINGATAN_1' : l.type === 'PANGGILAN_2' ? 'PANGGILAN_1' : null;
  const prev = prevType
    ? await DisciplineLetter.findOne({
        where: { userId: l.userId, type: prevType, voidedAt: null, letterDate: { [Op.lte]: l.letterDate }, id: { [Op.ne]: l.id } },
        order: [['letterDate', 'DESC']],
      })
    : null;
  const position = user?.role === 'KOORDINATOR' ? settings.coordinatorTitle : (POSITION[user?.role ?? ''] ?? '-');
  sendDisciplinePdf(
    res,
    {
      type: l.type,
      number: l.number,
      letterDate: l.letterDate,
      alfaDates: l.alfaDates,
      reportDate: l.reportDate,
      reportTime: l.reportTime,
      reportPlace: l.reportPlace,
      note: l.note,
      employee: { fullName: user?.fullName ?? '?', nik: user?.nik ?? '', position },
      previous: prev && { number: prev.number, letterDate: prev.letterDate },
      voided: !!l.voidedAt,
      receivedText: receipt?.receivedAt ? `Diterima secara digital oleh ${user?.fullName ?? '-'} pada ${witDateTime(receipt.receivedAt)} melalui aplikasi SMC-FaceAttend.` : null,
    },
    settings,
    `${l.number.replace(/\//g, '-')}_${(user?.fullName ?? 'karyawan').replace(/[^\w]+/g, '-')}.pdf`,
  );
}
