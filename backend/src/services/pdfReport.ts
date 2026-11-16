import type { Response } from 'express';
import PDFDocument from 'pdfkit';
import { OrgSettings, postText, signDate } from './organization';
import { witNow } from '../utils/time';
import type { DayRecord, DayStatus, EmployeeRecap, Summary } from './recapService';

const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const DAYS = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];

export const fmtLongDate = (iso: string, padDay = false) => `${padDay ? iso.slice(8, 10) : Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
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
function drawTable(doc: PDFKit.PDFDocument, cols: Col[], rows: Cell[][], x0 = MARGIN) {
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

export interface PdfMeta {
  title: string;
  period: string;
  filename: string;
  generatedBy: string;
  signature: boolean;
  org: OrgSettings;
}

/**
 * Rekap kehadiran PDF untuk kantor / manajemen (A4 mendatar):
 *  1. Tabel rekap: satu baris per karyawan, satu kotak berkode per hari (H/T/1x/A/I/S/C/OFF), jumlah & % hadir.
 *  2. Catatan per karyawan: hanya kejadian yang perlu diperhatikan (terlambat, absen sekali, alfa, izin/sakit/cuti),
 *     ringkasan, dan tanda tangan.
 *  3. Lampiran jam absensi wajah (masuk – pulang) per minggu.
 */
export function sendAttendancePdf(res: Response, recap: EmployeeRecap[], meta: PdfMeta) {
  const now = witNow();
  const printedAt = `${fmtLongDate(now.date)} ${now.time.slice(0, 5)} WIT`;
  const M = 28;
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: M, bufferPages: true, info: { Title: `${meta.title} — ${meta.period}`, Author: meta.org.companyName } });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${meta.filename}"`);
  doc.pipe(res);
  const pageW = doc.page.width;
  const usable = pageW - M * 2;
  const bottomLimit = doc.page.height - M - 16;

  // Koordinator di atas, lalu urut abjad
  const rows = [...recap].sort((a, b) => Number(b.user.role === 'KOORDINATOR') - Number(a.user.role === 'KOORDINATOR') || a.user.fullName.localeCompare(b.user.fullName));
  const dates = rows[0]?.days.map((d) => d.date) ?? [];
  const nameOf = (r: EmployeeRecap) => `${r.user.fullName}${r.user.role === 'KOORDINATOR' ? ' (Koordinator)' : ''}`;

  const header = (right: string) => {
    doc.rect(0, 0, pageW, 58).fill(C.brandDark);
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#ffffff').text(meta.title.toUpperCase(), M, 14, { width: usable * 0.6, lineBreak: false });
    doc.font('Helvetica').fontSize(8.5).fillColor('#bcdaff').text([postText(meta.org), meta.org.cityRegion].filter(Boolean).join(' · '), M, 34, { lineBreak: false });
    doc.text(`Pengelola: ${meta.org.companyName}`, M, 45, { lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#ffffff').text(right, M, 14, { width: usable, align: 'right', lineBreak: false });
    doc.font('Helvetica').fontSize(8.5).fillColor('#bcdaff').text(`Periode ${meta.period}`, M, 34, { width: usable, align: 'right', lineBreak: false });
    doc.y = 72;
    doc.x = M;
  };

  if (!rows.length) {
    header('Rekap Kehadiran');
    doc.font('Helvetica').fontSize(11).fillColor(C.ink).text('Tidak ada data karyawan pada periode ini.', M, 90);
    doc.end();
    return;
  }

  // ── Angka utama ──
  const total = rows.reduce(
    (acc, r) => {
      for (const k of Object.keys(acc) as (keyof Summary)[]) acc[k] += r.summary[k];
      return acc;
    },
    { hadir: 0, tepatWaktu: 0, terlambat: 0, absenSekali: 0, izin: 0, sakit: 0, cuti: 0, alfa: 0, libur: 0, hariOff: 0, hariKerja: 0, istirahatLebih: 0, lupaKembali: 0 } as Summary,
  );
  const overall = pct(total);
  const pctColor = (p: number | null) => (p === null ? C.muted : p >= 95 ? '#15803d' : p >= 85 ? '#b45309' : C.red);

  // ════════ 1. Tabel rekap (dipecah per ±16 hari bila periode panjang) ════════
  const chunkSize = dates.length <= 16 ? dates.length : Math.ceil(dates.length / Math.ceil(dates.length / 16));
  const chunks: string[][] = [];
  for (let i = 0; i < dates.length; i += chunkSize) chunks.push(dates.slice(i, i + chunkSize));
  const TOT = [
    { key: 'hadir', label: 'HADIR', w: 34 },
    { key: 'terlambat', label: 'TLAMBT', w: 34 },
    { key: 'absenSekali', label: 'ABSEN 1X', w: 36 },
    { key: 'alfa', label: 'ALFA', w: 28 },
    { key: 'izin', label: 'IZIN', w: 26 },
    { key: 'sakit', label: 'SAKIT', w: 28 },
    { key: 'cuti', label: 'CUTI', w: 26 },
    { key: 'hariOff', label: 'OFF', w: 26 },
    { key: 'hariKerja', label: 'HARI KERJA', w: 38 },
  ] as const;
  const totW = TOT.reduce((s, t) => s + t.w, 0) + 40; // + kolom % hadir

  chunks.forEach((chunk, ci) => {
    if (ci > 0) doc.addPage();
    header(chunks.length > 1 ? `Rekap Kehadiran (${ci + 1}/${chunks.length})` : 'Rekap Kehadiran');
    if (ci === 0) {
      kpiCards(doc, M, usable, [
        { label: 'Karyawan', value: String(rows.length) },
        { label: 'Tingkat kehadiran', value: overall === null ? '–' : `${overall}%`, color: pctColor(overall) },
        { label: 'Hadir / hari kerja', value: `${total.hadir} / ${total.hariKerja}` },
        { label: 'Tepat waktu', value: String(total.tepatWaktu), color: '#15803d' },
        { label: 'Terlambat', value: String(total.terlambat), color: total.terlambat ? '#b45309' : C.ink },
        { label: 'Absen sekali', value: String(total.absenSekali), color: total.absenSekali ? '#6d28d9' : C.ink },
        { label: 'Alfa', value: String(total.alfa), color: total.alfa ? C.red : C.ink },
        { label: 'Izin / Sakit / Cuti', value: `${total.izin} / ${total.sakit} / ${total.cuti}` },
      ]);
    }
    const noW = 20;
    const nameW = 150;
    const dayW = Math.min(30, (usable - noW - nameW - totW) / chunk.length);
    const tableW = noW + nameW + dayW * chunk.length + totW;
    const x0 = M + (usable - tableW) / 2;
    const rowH = Math.max(14, Math.min(19, (bottomLimit - doc.y - 30 - 22 - 30) / (rows.length + 1)));
    let y = doc.y;

    // kepala tabel
    doc.rect(x0, y, tableW, 26).fill(C.headFill);
    doc.font('Helvetica-Bold').fontSize(7).fillColor(C.muted);
    doc.text('NO', x0, y + 10, { width: noW, align: 'center' });
    doc.text('NAMA KARYAWAN', x0 + noW + 4, y + 10);
    chunk.forEach((d, i) => {
      const x = x0 + noW + nameW + i * dayW;
      const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
      const red = wd === 0 || rows[0].days.find((x) => x.date === d)?.status === 'LIBUR';
      doc.font('Helvetica-Bold').fontSize(8).fillColor(red ? C.red : C.ink).text(String(Number(d.slice(8, 10))), x, y + 5, { width: dayW, align: 'center' });
      doc.font('Helvetica').fontSize(6.5).fillColor(red ? C.red : C.muted).text(DAYS[wd], x, y + 15, { width: dayW, align: 'center' });
    });
    let tx = x0 + noW + nameW + dayW * chunk.length;
    for (const t of TOT) {
      doc.font('Helvetica-Bold').fontSize(6).fillColor(C.muted).text(t.label, tx, y + 7, { width: t.w, align: 'center' });
      tx += t.w;
    }
    doc.text('% HADIR', tx, y + 10, { width: 40, align: 'center' });
    y += 26;

    const start = dates.indexOf(chunk[0]);
    rows.forEach((r, ri) => {
      if (ri % 2 === 1) doc.rect(x0, y, tableW, rowH).fill(C.zebra);
      const coord = r.user.role === 'KOORDINATOR';
      doc.font('Helvetica').fontSize(8).fillColor(C.ink).text(String(ri + 1), x0, y + rowH / 2 - 4, { width: noW, align: 'center' });
      doc.font(coord ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor(C.ink).text(nameOf(r), x0 + noW + 4, y + rowH / 2 - 4, { width: nameW - 8, lineBreak: false, ellipsis: true });
      chunk.forEach((_, i) => codeBadge(doc, r.days[start + i], x0 + noW + nameW + i * dayW, y, dayW, rowH));
      let x = x0 + noW + nameW + dayW * chunk.length;
      for (const t of TOT) {
        const v = r.summary[t.key];
        const warn = t.key === 'alfa' ? C.red : t.key === 'terlambat' ? '#b45309' : t.key === 'absenSekali' ? '#6d28d9' : null;
        doc.font(t.key === 'hariKerja' || (v && warn) ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor(v && warn ? warn : v ? C.ink : '#cbd5e1');
        doc.text(v ? String(v) : '–', x, y + rowH / 2 - 4, { width: t.w, align: 'center' });
        x += t.w;
      }
      const p = pct(r.summary);
      if (p === null) doc.font('Helvetica').fontSize(8).fillColor(C.muted).text('–', x, y + rowH / 2 - 4, { width: 40, align: 'center' });
      else {
        doc.roundedRect(x + 4, y + 2.5, 32, rowH - 5, 5).fill(pctColor(p));
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#ffffff').text(`${p}%`, x + 4, y + rowH / 2 - 3.5, { width: 32, align: 'center' });
      }
      doc.moveTo(x0, y + rowH).lineTo(x0 + tableW, y + rowH).lineWidth(0.4).strokeColor(C.grid).stroke();
      y += rowH;
    });

    // baris jumlah hadir per hari
    doc.rect(x0, y, tableW, rowH + 2).fill('#e2e8f0');
    doc.font('Helvetica-Bold').fontSize(7).fillColor(C.ink).text('JUMLAH HADIR PER HARI', x0 + noW + 4, y + rowH / 2 - 3);
    chunk.forEach((_, i) => {
      const n = rows.filter((r) => ['TEPAT_WAKTU', 'TERLAMBAT', 'ABSEN_SEKALI'].includes(r.days[start + i].status)).length;
      doc.font('Helvetica-Bold').fontSize(8).fillColor(C.ink).text(String(n), x0 + noW + nameW + i * dayW, y + rowH / 2 - 3, { width: dayW, align: 'center' });
    });
    let sx = x0 + noW + nameW + dayW * chunk.length;
    for (const t of TOT) {
      doc.text(String(total[t.key]), sx, y + rowH / 2 - 3, { width: t.w, align: 'center' });
      sx += t.w;
    }
    doc.fillColor(pctColor(overall)).text(overall === null ? '–' : `${overall}%`, sx, y + rowH / 2 - 3, { width: 40, align: 'center' });
    y += rowH + 12;

    // keterangan kode
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.ink).text('KETERANGAN:', x0, y + 3, { lineBreak: false });
    let lx = x0 + 62;
    for (const k of LEGEND) {
      const st = CODE[k];
      drawCode(doc, st, lx, y, 20, 13);
      doc.font('Helvetica').fontSize(7.5).fillColor(C.ink).text(st.meaning, lx + 24, y + 3, { lineBreak: false });
      lx += 24 + doc.widthOfString(st.meaning) + 12;
    }
    y += 20;
    doc.font('Helvetica').fontSize(7.5).fillColor(C.muted).text(
      'Kehadiran = Hadir ÷ Hari kerja. Hadir = tepat waktu + terlambat + absen sekali. Hari kerja = hari yang dijadwalkan masuk (tidak termasuk Off, libur, izin, sakit, cuti). ' +
        'Absen sekali = hanya absen masuk tanpa absen pulang. Tidak absen masuk sampai batas terlambat = Alfa.',
      x0,
      y,
      { width: tableW },
    );
  });

  // ════════ 2. Catatan per karyawan ════════
  doc.addPage();
  header('Catatan & Tindak Lanjut');
  const short = (iso: string) => `${DAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()]} ${Number(iso.slice(8, 10))}/${Number(iso.slice(5, 7))}`;
  const list = (r: EmployeeRecap, pick: (d: DayRecord) => string | null) => r.days.map(pick).filter(Boolean).join(', ');
  const notes = rows.map((r) => ({
    r,
    late: list(r, (d) => (d.status === 'TERLAMBAT' || (d.status === 'ABSEN_SEKALI' && d.slots.MASUK?.status === 'TERLAMBAT') ? `${short(d.date)} (${hhmm(d.slots.MASUK?.time)})` : null)),
    once: list(r, (d) => (d.status === 'ABSEN_SEKALI' ? `${short(d.date)} (${d.slots.MASUK ? 'tidak absen pulang' : 'tidak absen masuk'})` : null)),
    alfa: list(r, (d) => (d.status === 'ALFA' ? `${short(d.date)}${d.note?.startsWith('Ditandai') ? ' (ditandai tidak bekerja)' : ''}` : null)),
    leave: list(r, (d) => (['IZIN', 'SAKIT', 'CUTI'].includes(d.status) ? `${short(d.date)} ${STATUS[d.status].label.toLowerCase()}` : null)),
    brk: list(r, (d) => (d.break?.over ? `${short(d.date)} istirahat ${d.break.minutes ?? '?'} mnt` : d.break?.missingReturn ? `${short(d.date)} lupa absen kembali` : null)),
  }));
  const withNotes = notes.filter((n) => n.late || n.once || n.alfa || n.leave || n.brk);
  const clean = notes.filter((n) => !withNotes.includes(n) && n.r.summary.hariKerja > 0);
  if (withNotes.length) {
    drawTable(
      doc,
      [
        { label: 'No', width: 22, align: 'center' },
        { label: 'Nama karyawan', width: 140 },
        { label: 'Terlambat (jam masuk)', width: 150 },
        { label: 'Absen sekali', width: 150 },
        { label: 'Alfa', width: 110 },
        { label: 'Izin / Sakit / Cuti', width: 105 },
        { label: 'Istirahat', width: usable - 677 },
      ],
      withNotes.map((n, i) => [
        String(i + 1),
        { text: nameOf(n.r), bold: true },
        { text: n.late || '–', color: n.late ? '#b45309' : C.muted },
        { text: n.once || '–', color: n.once ? '#6d28d9' : C.muted },
        { text: n.alfa || '–', color: n.alfa ? C.red : C.muted, bold: !!n.alfa },
        { text: n.leave || '–', color: n.leave ? '#0369a1' : C.muted },
        { text: n.brk || '–', color: n.brk ? '#b45309' : C.muted },
      ]),
      M,
    );
  } else {
    doc.font('Helvetica').fontSize(10).fillColor('#15803d').text('Tidak ada catatan: semua karyawan hadir tepat waktu dan lengkap.', M, doc.y);
  }
  doc.moveDown(0.8);
  // Ringkasan singkat
  const top = (key: keyof Summary) => {
    const max = Math.max(...rows.map((r) => r.summary[key]));
    return max > 0 ? { n: max, names: rows.filter((r) => r.summary[key] === max).map((r) => r.user.fullName) } : null;
  };
  const points: string[] = [];
  if (clean.length) points.push(`Hadir lengkap tanpa catatan (${clean.length} orang): ${clean.map((n) => n.r.user.fullName).join(', ')}.`);
  const a = top('alfa');
  if (a) points.push(`Alfa terbanyak: ${a.names.join(', ')} (${a.n}×). Tindak lanjuti sesuai aturan disiplin (PKWT Pasal 8).`);
  const t = top('terlambat');
  if (t) points.push(`Terlambat terbanyak: ${t.names.join(', ')} (${t.n}×).`);
  const o = top('absenSekali');
  if (o) points.push(`Absen sekali terbanyak: ${o.names.join(', ')} (${o.n}×). Ingatkan absen pulang setiap selesai shift.`);
  if (points.length) {
    if (doc.y + 20 + points.length * 14 > bottomLimit - 110) doc.addPage(), header('Catatan & Tindak Lanjut');
    doc.font('Helvetica-Bold').fontSize(10).fillColor(C.ink).text('Ringkasan', M, doc.y);
    doc.moveDown(0.3);
    for (const p of points) {
      doc.font('Helvetica').fontSize(8.5).fillColor(C.ink).text(`•  ${p}`, M + 4, doc.y, { width: usable - 8 });
      doc.moveDown(0.25);
    }
  }
  // Tanda tangan
  if (doc.y + 110 > bottomLimit) doc.addPage(), header('Catatan & Tindak Lanjut');
  const sy = doc.y + 18;
  const colW = 230;
  const left = M + 30;
  const right = pageW - M - 30 - colW;
  doc.font('Helvetica').fontSize(9).fillColor(C.ink);
  doc.text(signDate(meta.org, fmtLongDate(now.date)), right, sy, { width: colW, align: 'center' });
  doc.text('Disusun oleh,', right, sy + 13, { width: colW, align: 'center' });
  doc.font('Helvetica-Bold').text(meta.generatedBy, right, sy + 75, { width: colW, align: 'center', underline: true });
  doc.font('Helvetica').text('Mengetahui,', left, sy + 13, { width: colW, align: 'center' });
  doc.text(meta.org.reportApproverTitle, left, sy + 26, { width: colW, align: 'center' });
  if (meta.org.reportApproverName) doc.font('Helvetica-Bold').text(meta.org.reportApproverName, left, sy + 75, { width: colW, align: 'center', underline: true });
  else doc.text('(................................................)', left, sy + 75, { width: colW, align: 'center' });

  // ════════ 3. Lampiran jam absensi wajah, per minggu ════════
  for (let i = 0; i < dates.length; i += 7) {
    const week = dates.slice(i, i + 7);
    doc.addPage();
    header('Lampiran · Jam Absensi Wajah');
    doc.font('Helvetica-Bold').fontSize(10).fillColor(C.ink).text(`Jam absensi wajah, ${fmtLongDate(week[0]).replace(/ \d{4}$/, week[0].slice(0, 4) === week[week.length - 1].slice(0, 4) && week[0].slice(5, 7) === week[week.length - 1].slice(5, 7) ? '' : ` ${week[0].slice(0, 4)}`)} – ${fmtLongDate(week[week.length - 1])}`, M, doc.y);
    doc.font('Helvetica').fontSize(7.5).fillColor(C.muted).text('Setiap kotak: jam masuk – jam pulang (--:-- = tidak absen), di bawahnya nama shift. Kotak tanpa jam berisi keterangan hari itu.', M, doc.y + 1);
    doc.moveDown(0.5);
    const nameW = 160;
    const colW2 = (usable - nameW) / week.length;
    let y = doc.y;
    doc.rect(M, y, usable, 22).fill(C.headFill);
    doc.font('Helvetica-Bold').fontSize(7).fillColor(C.muted).text('NAMA KARYAWAN', M + 6, y + 8);
    week.forEach((d, k) => {
      const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
      doc.font('Helvetica-Bold').fontSize(8).fillColor(wd === 0 ? C.red : C.ink).text(fmtDay(d), M + nameW + k * colW2, y + 4, { width: colW2, align: 'center' });
      doc.font('Helvetica').fontSize(6.5).fillColor(C.muted).text('masuk – pulang', M + nameW + k * colW2, y + 13, { width: colW2, align: 'center' });
    });
    y += 22;
    const rh = Math.max(20, Math.min(26, (bottomLimit - y - 30) / rows.length));
    rows.forEach((r, ri) => {
      if (ri % 2 === 1) doc.rect(M, y, usable, rh).fill(C.zebra);
      doc.font(r.user.role === 'KOORDINATOR' ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor(C.ink).text(nameOf(r), M + 6, y + rh / 2 - 4, { width: nameW - 10, lineBreak: false, ellipsis: true });
      week.forEach((dt, k) => {
        const d = r.days.find((x) => x.date === dt)!;
        const x = M + nameW + k * colW2;
        const st = CODE[codeOf(d)];
        doc.circle(x + 7, y + rh / 2, 2.6).fill(st.fill === '#ffffff' ? '#cbd5e1' : st.fill);
        const masuk = d.slots.MASUK?.time;
        const pulang = d.slots.PULANG?.time;
        const sh = d.shiftName ?? '';
        let text: string;
        let color = C.ink;
        const tm = (v?: string) => (v ? v.slice(0, 5) : '--:--');
        if (masuk || pulang) text = `${tm(masuk)} – ${tm(pulang)}`;
        else if (d.status === 'ALFA') ((text = 'Alfa'), (color = C.red));
        else if (d.status === 'DAY_OFF') ((text = 'Off'), (color = C.muted));
        else if (d.status === 'OFF') ((text = 'Tidak dijadwalkan'), (color = '#94a3b8'));
        else ((text = STATUS[d.status].label), (color = STATUS[d.status].color));
        if (d.status === 'ABSEN_SEKALI') color = '#6d28d9';
        if (d.status === 'TERLAMBAT') color = '#b45309';
        // baris 1: jam / keterangan, baris 2: shift (kecil)
        const two = !!sh && d.status !== 'DAY_OFF' && d.status !== 'OFF';
        doc.font(d.status === 'ALFA' ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5).fillColor(color).text(text, x + 13, y + rh / 2 - (two ? 7 : 3.5), { width: colW2 - 16, height: 9, lineBreak: false, ellipsis: true });
        if (two) doc.font('Helvetica').fontSize(6).fillColor(C.muted).text(sh, x + 13, y + rh / 2 + 1.5, { width: colW2 - 16, height: 8, lineBreak: false });
      });
      doc.moveTo(M, y + rh).lineTo(M + usable, y + rh).lineWidth(0.4).strokeColor(C.grid).stroke();
      y += rh;
    });
    doc.font('Helvetica').fontSize(7.5).fillColor(C.muted).text('Titik warna mengikuti kode di halaman rekap. Oranye = terlambat, ungu = absen sekali, merah = alfa.', M, y + 8);
  }

  // ── Kaki halaman ──
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const bm = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7).fillColor(C.muted);
    doc.text(`Dicetak ${printedAt} oleh ${meta.generatedBy} · sumber: SMC-FaceAttend (absensi wajah)`, M, doc.page.height - 20, { lineBreak: false });
    doc.text(`Halaman ${i + 1} dari ${range.count}`, M, doc.page.height - 20, { width: usable, align: 'right', lineBreak: false });
    doc.page.margins.bottom = bm;
  }
  doc.end();
}

// ── Kode harian di tabel rekap ──
type Code = 'H' | 'T' | 'X' | 'A' | 'I' | 'S' | 'C' | 'OFF' | 'L' | 'NONE' | 'BELUM';
const CODE: Record<Code, { text: string; fill: string; ink: string; meaning: string; outline?: string }> = {
  H: { text: 'H', fill: '#16a34a', ink: '#ffffff', meaning: 'Hadir tepat waktu' },
  T: { text: 'T', fill: '#f59e0b', ink: '#111827', meaning: 'Terlambat' },
  X: { text: '1x', fill: '#7c3aed', ink: '#ffffff', meaning: 'Absen sekali' },
  A: { text: 'A', fill: '#dc2626', ink: '#ffffff', meaning: 'Alfa' },
  I: { text: 'I', fill: '#0284c7', ink: '#ffffff', meaning: 'Izin' },
  S: { text: 'S', fill: '#db2777', ink: '#ffffff', meaning: 'Sakit' },
  C: { text: 'C', fill: '#4f46e5', ink: '#ffffff', meaning: 'Cuti' },
  OFF: { text: 'OFF', fill: '#9ca3af', ink: '#ffffff', meaning: 'Off / libur pribadi' },
  L: { text: 'L', fill: '#ffffff', ink: '#dc2626', meaning: 'Libur nasional', outline: '#dc2626' },
  NONE: { text: '–', fill: '#ffffff', ink: '#94a3b8', meaning: 'Tidak dijadwalkan', outline: '#e2e8f0' },
  BELUM: { text: '·', fill: '#ffffff', ink: '#94a3b8', meaning: 'Belum absen', outline: '#e2e8f0' },
};
const LEGEND: Code[] = ['H', 'T', 'X', 'A', 'I', 'S', 'C', 'OFF', 'L', 'NONE'];
const CODE_OF: Record<DayStatus, Code> = { TEPAT_WAKTU: 'H', TERLAMBAT: 'T', ABSEN_SEKALI: 'X', ALFA: 'A', IZIN: 'I', SAKIT: 'S', CUTI: 'C', DAY_OFF: 'OFF', LIBUR: 'L', OFF: 'NONE', BELUM: 'BELUM' };
const codeOf = (d: DayRecord): Code => CODE_OF[d.status];

function drawCode(doc: PDFKit.PDFDocument, st: (typeof CODE)[Code], x: number, y: number, w: number, h: number) {
  if (st.outline) doc.roundedRect(x + 0.5, y + 0.5, w - 1, h - 1, 3).lineWidth(0.7).fillAndStroke(st.fill, st.outline);
  else doc.roundedRect(x, y, w, h, 3).fill(st.fill);
  doc.font('Helvetica-Bold').fontSize(st.text.length > 2 ? 5.8 : 7.5).fillColor(st.ink).text(st.text, x, y + h / 2 - (st.text.length > 2 ? 2.4 : 3.2), { width: w, align: 'center', lineBreak: false });
}
function codeBadge(doc: PDFKit.PDFDocument, d: DayRecord, x: number, y: number, w: number, h: number) {
  drawCode(doc, CODE[codeOf(d)], x + 1.5, y + 2, w - 3, h - 4);
}

function kpiCards(doc: PDFKit.PDFDocument, x0: number, width: number, items: { label: string; value: string; color?: string }[]) {
  const gap = 7;
  const w = (width - gap * (items.length - 1)) / items.length;
  const y = doc.y;
  items.forEach((it, i) => {
    const x = x0 + i * (w + gap);
    doc.roundedRect(x, y, w, 42, 6).fill('#f1f5f9');
    doc.font('Helvetica').fontSize(7).fillColor(C.muted).text(it.label, x + 8, y + 7, { width: w - 16, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(15).fillColor(it.color ?? C.ink).text(it.value, x + 8, y + 19, { width: w - 16, lineBreak: false });
  });
  doc.y = y + 52;
  doc.x = x0;
}
