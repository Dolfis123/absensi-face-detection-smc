import type { Response } from 'express';
import PDFDocument from 'pdfkit';
import { witNow } from '../utils/time';
import type { DayRecord, DayStatus, EmployeeRecap, Summary } from './recapService';

const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const DAYS = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];

export const fmtLongDate = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
export const fmtMonth = (month: string) => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
const fmtDay = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}`;
};
const hhmm = (t?: string | null) => (t ? t.slice(0, 5) : '–');
const pct = (s: Summary) => (s.hariKerja ? Math.round((s.hadir / s.hariKerja) * 100) : null);

const STATUS: Record<DayStatus, { label: string; color: string }> = {
  TEPAT_WAKTU: { label: 'Tepat Waktu', color: '#047857' },
  TERLAMBAT: { label: 'Terlambat', color: '#b45309' },
  ALFA: { label: 'Alfa', color: '#be123c' },
  IZIN: { label: 'Izin', color: '#0369a1' },
  SAKIT: { label: 'Sakit', color: '#6d28d9' },
  CUTI: { label: 'Cuti', color: '#4338ca' },
  LIBUR: { label: 'Libur', color: '#475569' },
  OFF: { label: 'Tidak dijadwalkan', color: '#94a3b8' },
  DAY_OFF: { label: 'Off', color: '#64748b' },
  BELUM: { label: 'Belum absen', color: '#475569' },
  ABSEN_SEKALI: { label: 'Absen sekali', color: '#c2410c' },
};

/** Catatan per hari untuk kolom Keterangan (dipakai PDF & CSV). */
export function dayNotes(d: DayRecord): string[] {
  const notes: string[] = [];
  if (d.note) notes.push(d.note);
  if (d.break?.over) notes.push(`Istirahat lebih${d.break.minutes !== null ? ` (${d.break.minutes} mnt)` : ''}`);
  if (d.break?.missingReturn) notes.push('Lupa absen selesai istirahat');
  if (Object.values(d.slots).some((s) => s?.source === 'CORRECTION')) notes.push('Ada koreksi admin');
  return notes;
}

const C = {
  brand: '#124a91',
  brandDark: '#0c2b52',
  ink: '#0f172a',
  muted: '#64748b',
  grid: '#e2e8f0',
  headFill: '#f1f5f9',
  zebra: '#f8fafc',
  red: '#be123c',
  amber: '#b45309',
};

type Cell = string | { text: string; color?: string; bold?: boolean };
interface Col {
  label: string;
  width: number;
  align?: 'left' | 'center' | 'right';
}

const MARGIN = 36;

/** Tabel sederhana dengan header berulang di setiap halaman baru. */
function drawTable(doc: PDFKit.PDFDocument, cols: Col[], rows: Cell[][]) {
  const x0 = MARGIN;
  // Ukuran dirapatkan agar rincian satu bulan (±26 hari kerja) muat di satu halaman A4 landscape
  const bottom = () => doc.page.height - MARGIN - 14;
  const pad = 3;
  const fontSize = 7.5;

  const header = () => {
    const h = 20;
    let x = x0;
    doc.rect(x0, doc.y, cols.reduce((s, c) => s + c.width, 0), h).fill(C.headFill);
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.muted);
    const y = doc.y;
    for (const c of cols) {
      doc.text(c.label.toUpperCase(), x + pad, y + 6.5, { width: c.width - pad * 2, align: c.align ?? 'left', lineBreak: false });
      x += c.width;
    }
    doc.y = y + h;
  };

  header();
  rows.forEach((row, ri) => {
    doc.font('Helvetica').fontSize(fontSize);
    const heights = row.map((cell, i) => {
      const t = typeof cell === 'string' ? cell : cell.text;
      return doc.heightOfString(t || ' ', { width: cols[i].width - pad * 2 });
    });
    const h = Math.max(...heights) + pad * 2 + 1;
    if (doc.y + h > bottom()) {
      doc.addPage();
      header();
    }
    const y = doc.y;
    const width = cols.reduce((s, c) => s + c.width, 0);
    if (ri % 2 === 1) doc.rect(x0, y, width, h).fill(C.zebra);
    doc.moveTo(x0, y + h).lineTo(x0 + width, y + h).lineWidth(0.5).strokeColor(C.grid).stroke();
    let x = x0;
    row.forEach((cell, i) => {
      const t = typeof cell === 'string' ? cell : cell.text;
      const color = typeof cell === 'string' ? C.ink : (cell.color ?? C.ink);
      const bold = typeof cell !== 'string' && cell.bold;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize).fillColor(color);
      doc.text(t, x + pad, y + pad + 1, { width: cols[i].width - pad * 2, align: cols[i].align ?? 'left' });
      x += cols[i].width;
    });
    doc.y = y + h;
  });
  doc.x = MARGIN;
}

function kpiRow(doc: PDFKit.PDFDocument, items: { label: string; value: string; color?: string }[]) {
  const gap = 8;
  const full = doc.page.width - MARGIN * 2;
  const w = (full - gap * (items.length - 1)) / items.length;
  const y = doc.y;
  items.forEach((it, i) => {
    const x = MARGIN + i * (w + gap);
    doc.roundedRect(x, y, w, 50, 6).lineWidth(0.8).strokeColor(C.grid).stroke();
    doc.font('Helvetica').fontSize(7.5).fillColor(C.muted).text(it.label, x + 8, y + 9, { width: w - 16, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(16).fillColor(it.color ?? C.ink).text(it.value, x + 8, y + 23, { width: w - 16, lineBreak: false });
  });
  doc.y = y + 64;
  doc.x = MARGIN;
}

function sectionTitle(doc: PDFKit.PDFDocument, text: string, sub?: string) {
  doc.font('Helvetica-Bold').fontSize(12).fillColor(C.ink).text(text, MARGIN, doc.y);
  if (sub) doc.font('Helvetica').fontSize(8.5).fillColor(C.muted).text(sub);
  doc.moveDown(0.5);
}

export interface PdfMeta {
  title: string;
  period: string;
  filename: string;
  generatedBy: string;
  signature: boolean;
}

/** Laporan kehadiran PDF: ringkasan semua karyawan + rincian harian per karyawan. */
export function sendAttendancePdf(res: Response, recap: EmployeeRecap[], meta: PdfMeta) {
  const now = witNow();
  const printedAt = `${fmtLongDate(now.date)} ${now.time.slice(0, 5)} WIT`;
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: MARGIN, bufferPages: true, info: { Title: `${meta.title} — ${meta.period}`, Author: 'SMC-FaceAttend' } });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${meta.filename}"`);
  doc.pipe(res);

  const pageW = doc.page.width;

  // ── Kop laporan ──
  doc.rect(0, 0, pageW, 78).fill(C.brandDark);
  doc.font('Helvetica-Bold').fontSize(18).fillColor('#ffffff').text(meta.title, MARGIN, 20);
  doc.font('Helvetica').fontSize(9.5).fillColor('#bcdaff').text('Pos Parkir Mall Sorong Modern City (SMC) · Kota Sorong, Papua Barat Daya', MARGIN, 44);
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#ffffff').text(meta.period, MARGIN, 24, { width: pageW - MARGIN * 2, align: 'right' });
  doc.font('Helvetica').fontSize(8).fillColor('#bcdaff').text(`Dicetak ${printedAt} oleh ${meta.generatedBy}`, MARGIN, 44, { width: pageW - MARGIN * 2, align: 'right' });
  doc.y = 96;
  doc.x = MARGIN;

  // ── Angka utama ──
  const total = recap.reduce(
    (acc, r) => {
      for (const k of Object.keys(acc) as (keyof Summary)[]) acc[k] += r.summary[k];
      return acc;
    },
    { hadir: 0, tepatWaktu: 0, terlambat: 0, absenSekali: 0, izin: 0, sakit: 0, cuti: 0, alfa: 0, libur: 0, hariOff: 0, hariKerja: 0, istirahatLebih: 0, lupaKembali: 0 } as Summary,
  );
  const overall = pct(total);
  kpiRow(doc, [
    { label: 'Karyawan', value: String(recap.length) },
    { label: 'Tingkat kehadiran', value: overall === null ? '–' : `${overall}%`, color: overall !== null && overall < 90 ? C.amber : '#047857' },
    { label: 'Hadir / hari kerja', value: `${total.hadir} / ${total.hariKerja}` },
    { label: 'Absen sekali', value: String(total.absenSekali), color: total.absenSekali ? C.amber : C.ink },
    { label: 'Terlambat', value: String(total.terlambat), color: total.terlambat ? C.amber : C.ink },
    { label: 'Alfa', value: String(total.alfa), color: total.alfa ? C.red : C.ink },
    { label: 'Izin / Sakit / Cuti', value: `${total.izin} / ${total.sakit} / ${total.cuti}` },
    { label: 'Istirahat lebih', value: String(total.istirahatLebih), color: total.istirahatLebih ? C.amber : C.ink },
    { label: 'Lupa absen kembali', value: String(total.lupaKembali), color: total.lupaKembali ? C.amber : C.ink },
  ]);

  // ── Ringkasan per karyawan ──
  sectionTitle(doc, 'Ringkasan per Karyawan', 'Kehadiran = hadir (tepat waktu + terlambat) dibagi hari kerja terjadwal. Diurutkan dari tingkat kehadiran terendah.');
  const sorted = [...recap].sort((a, b) => (pct(a.summary) ?? 101) - (pct(b.summary) ?? 101) || a.user.fullName.localeCompare(b.user.fullName));
  const num = (n: number, warn?: string): Cell => (n && warn ? { text: String(n), color: warn, bold: true } : String(n));
  drawTable(
    doc,
    [
      { label: 'No', width: 24, align: 'center' },
      { label: 'Nama', width: 130 },
      { label: 'NIK', width: 80 },
      { label: 'Hari kerja', width: 55, align: 'center' },
      { label: 'Hadir', width: 45, align: 'center' },
      { label: 'Tepat', width: 45, align: 'center' },
      { label: 'Terlambat', width: 55, align: 'center' },
      { label: 'Sekali', width: 40, align: 'center' },
      { label: 'Izin', width: 35, align: 'center' },
      { label: 'Sakit', width: 35, align: 'center' },
      { label: 'Cuti', width: 35, align: 'center' },
      { label: 'Alfa', width: 35, align: 'center' },
      { label: 'Ist. lebih', width: 55, align: 'center' },
      { label: 'Lupa kmbl', width: 50, align: 'center' },
      { label: 'Kehadiran', width: 51, align: 'center' },
    ],
    sorted.map((r, i) => {
      const s = r.summary;
      const p = pct(s);
      return [
        String(i + 1),
        { text: r.user.fullName, bold: true },
        r.user.nik,
        String(s.hariKerja),
        String(s.hadir),
        String(s.tepatWaktu),
        num(s.terlambat, C.amber),
        num(s.absenSekali, C.amber),
        String(s.izin),
        String(s.sakit),
        String(s.cuti),
        num(s.alfa, C.red),
        num(s.istirahatLebih, C.amber),
        num(s.lupaKembali, C.amber),
        p === null ? '–' : { text: `${p}%`, bold: true, color: p < 80 ? C.red : p < 90 ? C.amber : '#047857' },
      ];
    }),
  );

  // ── Tanda tangan (laporan resmi bulanan) ──
  if (meta.signature) {
    if (doc.y + 120 > doc.page.height - MARGIN) doc.addPage();
    const y = doc.y + 24;
    const colW = 220;
    const left = MARGIN + 40;
    const right = pageW - MARGIN - 40 - colW;
    doc.font('Helvetica').fontSize(9).fillColor(C.ink);
    doc.text('Mengetahui,', left, y, { width: colW, align: 'center' });
    doc.text('Manager Mal SMC', left, y + 13, { width: colW, align: 'center' });
    doc.text('(................................................)', left, y + 75, { width: colW, align: 'center' });
    doc.text(`Sorong, ${fmtLongDate(now.date)}`, right, y, { width: colW, align: 'center' });
    doc.text('Dibuat oleh, Super Admin', right, y + 13, { width: colW, align: 'center' });
    doc.font('Helvetica-Bold').text(meta.generatedBy, right, y + 75, { width: colW, align: 'center', underline: true });
    doc.y = y + 100;
    doc.x = MARGIN;
  }

  // ── Rincian harian per karyawan ──
  for (const r of recap) {
    const days = r.days.filter((d) => d.status !== 'OFF');
    doc.addPage();
    const s = r.summary;
    const p = pct(s);
    sectionTitle(
      doc,
      `Rincian Harian · ${r.user.fullName}`,
      `NIK ${r.user.nik} · Hari kerja ${s.hariKerja} · Hadir ${s.hadir} (tepat ${s.tepatWaktu}, terlambat ${s.terlambat}, absen sekali ${s.absenSekali}) · Alfa ${s.alfa} · Izin/Sakit/Cuti ${s.izin}/${s.sakit}/${s.cuti} · Istirahat lebih ${s.istirahatLebih} · Kehadiran ${p === null ? '–' : `${p}%`}`,
    );
    if (days.length === 0) {
      doc.font('Helvetica').fontSize(9).fillColor(C.muted).text('Tidak ada jadwal kerja pada periode ini.');
      continue;
    }
    drawTable(
      doc,
      [
        { label: 'Tanggal', width: 80 },
        { label: 'Shift', width: 55 },
        { label: 'Status', width: 85 },
        { label: 'Masuk', width: 55, align: 'center' },
        { label: 'Mulai ist.', width: 60, align: 'center' },
        { label: 'Selesai ist.', width: 60, align: 'center' },
        { label: 'Durasi ist.', width: 60, align: 'center' },
        { label: 'Pulang', width: 55, align: 'center' },
        { label: 'Keterangan', width: 260 },
      ],
      days.map((d) => {
        const st = STATUS[d.status];
        const notes = dayNotes(d);
        return [
          fmtDay(d.date),
          d.shiftName ?? '–',
          { text: st.label, color: st.color, bold: true },
          hhmm(d.slots.MASUK?.time),
          hhmm(d.slots.ISTIRAHAT?.time),
          d.break?.missingReturn ? { text: 'tidak ada', color: C.amber } : hhmm(d.slots.KEMBALI?.time),
          d.break?.minutes != null ? { text: `${d.break.minutes} mnt`, color: d.break.over ? C.amber : C.ink, bold: d.break.over } : '–',
          hhmm(d.slots.PULANG?.time),
          { text: notes.join(' · '), color: C.muted },
        ];
      }),
    );
  }

  // ── Nomor halaman ──
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor(C.muted)
      .text(`SMC-FaceAttend · ${meta.title} · ${meta.period}`, MARGIN, doc.page.height - 24, { lineBreak: false })
      .text(`Halaman ${i + 1} dari ${range.count}`, MARGIN, doc.page.height - 24, { width: doc.page.width - MARGIN * 2, align: 'right', lineBreak: false });
    doc.page.margins.bottom = bottomMargin;
  }
  doc.end();
}
