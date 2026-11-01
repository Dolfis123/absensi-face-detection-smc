/**
 * Unduhan roster yang sudah disimpan (PDF & Excel) untuk dibagikan ke grup WhatsApp.
 * Isinya hanya jadwal + keterangan simbol; aturan internal karyawan tidak ikut dicetak.
 */
import ExcelJS from 'exceljs';
import type { Response } from 'express';
import PDFDocument from 'pdfkit';
import { Op } from 'sequelize';
import { ATTENDEE_ROLES, EmployeeSchedule, Holiday, Shift, User } from '../models';
import { eachDate, witNow } from '../utils/time';
import { fmtLongDate } from './pdfReport';
import { getPosts, Post, RESERVE } from './placement';

const DAY_LONG = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const DAY_SHORT = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
const weekday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();
const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

type Kind = 'S1' | 'S2' | 'FULL' | 'OTHER' | 'OFF' | 'HOLIDAY' | 'EMPTY';
/** Warna & teks tiap jenis sel; dipakai bersama oleh PDF, Excel, dan keterangan. */
const STYLE: Record<Kind, { fill: string; ink: string }> = {
  S1: { fill: '#e0f2fe', ink: '#075985' },
  S2: { fill: '#ede9fe', ink: '#5b21b6' },
  FULL: { fill: '#ccfbf1', ink: '#115e59' },
  OTHER: { fill: '#fef3c7', ink: '#92400e' },
  OFF: { fill: '#475569', ink: '#ffffff' },
  HOLIDAY: { fill: '#fee2e2', ink: '#9f1239' },
  EMPTY: { fill: '#ffffff', ink: '#94a3b8' },
};

interface RosterCell {
  kind: Kind;
  text: string;
  /** Kode pos penempatan, mis. "CK" atau "CAD" */
  post?: string | null;
}
export interface RosterData {
  from: string;
  to: string;
  dates: string[];
  holidays: Map<string, string>;
  shifts: Shift[];
  rows: { id: number; name: string; coordinator: boolean; cells: RosterCell[] }[];
  legend: { kind: Kind; symbol: string; meaning: string }[];
  /** Pos penempatan yang dipakai di periode ini (urut sesuai pengaturan), termasuk Cadangan bila ada */
  posts: Post[];
}

const kindOf = (s: Shift): Kind => (s.code === 'SHIFT_1' ? 'S1' : s.code === 'SHIFT_2' ? 'S2' : s.code === 'SHIFT_PENUH' ? 'FULL' : 'OTHER');
const symbolOf = (s: Shift) => (s.code === 'SHIFT_PENUH' ? 'PENUH' : s.name.replace(/^Shift\s*/i, 'S').toUpperCase());

export async function loadRosterData(from: string, to: string): Promise<RosterData> {
  const dates = eachDate(from, to);
  const [shifts, users, schedules, holidays, postList] = await Promise.all([
    Shift.findAll({ order: [['id', 'ASC']] }),
    User.findAll({ where: { role: [...ATTENDEE_ROLES], isActive: true } }),
    EmployeeSchedule.findAll({ where: { date: { [Op.between]: [from, to] } } }),
    Holiday.findAll({ where: { date: { [Op.between]: [from, to] } } }),
    getPosts(),
  ]);
  const shiftById = new Map(shifts.map((s) => [s.id, s]));
  const holidayMap = new Map(holidays.map((h) => [h.date, h.name]));
  const sched = new Map(schedules.map((s) => [`${s.userId}|${s.date}`, s]));
  // Koordinator di baris paling atas, lalu karyawan urut abjad
  const sorted = [...users].sort((a, b) => Number(b.role === 'KOORDINATOR') - Number(a.role === 'KOORDINATOR') || a.fullName.localeCompare(b.fullName));
  const rows = sorted.map((u) => ({
    id: u.id,
    name: u.fullName,
    coordinator: u.role === 'KOORDINATOR',
    cells: dates.map((d): RosterCell => {
      const s = sched.get(`${u.id}|${d}`);
      if (holidayMap.has(d) && !(s && s.shiftId !== null)) return { kind: 'HOLIDAY', text: 'LIBUR' };
      if (!s) return { kind: 'EMPTY', text: '—' };
      if (s.shiftId === null) return { kind: 'OFF', text: 'OFF' };
      const shift = shiftById.get(s.shiftId);
      return shift ? { kind: kindOf(shift), text: symbolOf(shift), post: s.post } : { kind: 'EMPTY', text: '—' };
    }),
  }));
  const used = new Set(rows.flatMap((r) => r.cells.map((c) => c.text)));
  const legend: RosterData['legend'] = [
    ...shifts
      .filter((s) => used.has(symbolOf(s)))
      .map((s) => ({
        kind: kindOf(s),
        symbol: symbolOf(s),
        meaning: `${s.name}: masuk ${s.startTime}, pulang ${s.endTime} WIT${s.code === 'SHIFT_PENUH' ? ' (pagi–malam)' : ''}`,
      })),
    { kind: 'OFF', symbol: 'OFF', meaning: 'Libur pribadi (Off mingguan), tidak perlu absen.' },
  ];
  if (used.has('LIBUR')) legend.push({ kind: 'HOLIDAY', symbol: 'LIBUR', meaning: 'Hari libur nasional / kantor. Tidak perlu absen.' });
  if (used.has('—')) legend.push({ kind: 'EMPTY', symbol: '—', meaning: 'Belum dijadwalkan. Tanyakan ke Koordinator Lapangan.' });
  const usedPosts = new Set(rows.flatMap((r) => r.cells.map((c) => c.post).filter(Boolean)));
  const posts = [...postList.filter((p) => usedPosts.has(p.code)), ...(usedPosts.has(RESERVE.code) ? [RESERVE] : [])];
  return { from, to, dates, holidays: holidayMap, shifts, rows, legend, posts };
}

function counts(cells: RosterCell[]) {
  const c: Record<Kind, number> = { S1: 0, S2: 0, FULL: 0, OTHER: 0, OFF: 0, HOLIDAY: 0, EMPTY: 0 };
  for (const x of cells) c[x.kind]++;
  return c;
}

const periodText = (r: RosterData) => `${fmtLongDate(r.from)} – ${fmtLongDate(r.to)}`;
const NOTES = [
  'Absen Masuk dibuka 30 menit sebelum jam masuk. Absen di pos dengan wajah sendiri.',
  'Jadwal terbaru selalu bisa dilihat di aplikasi, menu Jadwal Shift.',
  'Tukar shift wajib seizin Koordinator Lapangan agar roster di aplikasi ikut diubah.',
];

// ─────────────── PDF ───────────────
const MARGIN = 30;
const INK = '#0f172a';
const MUTED = '#64748b';
const GRID = '#cbd5e1';

/** Satu halaman per minggu (Senin–Minggu) agar mudah dibaca di HP, ditutup halaman rekap. */
export function sendRosterPdf(res: Response, r: RosterData, generatedBy: string, filename: string) {
  const now = witNow();
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: MARGIN, info: { Title: `Roster Shift ${periodText(r)}`, Author: 'SMC-FaceAttend' } });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);
  const pageW = doc.page.width;
  const usable = pageW - MARGIN * 2;

  const header = (subtitle: string) => {
    doc.rect(0, 0, pageW, 62).fill('#0c2b52');
    doc.font('Helvetica-Bold').fontSize(17).fillColor('#ffffff').text('ROSTER SHIFT KARYAWAN PARKIR', MARGIN, 14);
    doc.font('Helvetica').fontSize(9).fillColor('#bcdaff').text('Pos Parkir Mall Sorong Modern City (SMC) · Kota Sorong', MARGIN, 36);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#ffffff').text(subtitle, MARGIN, 16, { width: usable, align: 'right' });
    doc.font('Helvetica').fontSize(8).fillColor('#bcdaff').text(`Periode ${periodText(r)}`, MARGIN, 36, { width: usable, align: 'right' });
    doc.y = 76;
  };

  const legendBox = (y: number) => {
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text('KETERANGAN', MARGIN, y);
    let ly = y + 13;
    const colW = usable / 3;
    // Tinggi tiap baris keterangan mengikuti teks terpanjang di baris itu (teks bisa 2 baris)
    for (let i = 0; i < r.legend.length; i += 3) {
      const row = r.legend.slice(i, i + 3);
      doc.font('Helvetica').fontSize(8);
      const h = Math.max(15, ...row.map((l) => doc.heightOfString(l.meaning, { width: colW - 60 }) + 5));
      row.forEach((l, j) => {
        const x = MARGIN + j * colW;
        doc.roundedRect(x, ly, 46, 13, 2).fill(STYLE[l.kind].fill);
        if (l.kind === 'EMPTY') doc.roundedRect(x, ly, 46, 13, 2).lineWidth(0.5).strokeColor(GRID).stroke();
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor(STYLE[l.kind].ink).text(l.symbol, x, ly + 3, { width: 46, align: 'center' });
        doc.font('Helvetica').fontSize(8).fillColor(INK).text(l.meaning, x + 52, ly + 2.5, { width: colW - 60 });
      });
      ly += h;
    }
    ly += 2;
    if (r.posts.length) {
      doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text('PENEMPATAN (PLOTTING) — kode kecil di bawah shift', MARGIN, ly);
      ly += 13;
      r.posts.forEach((p, i) => {
        const x = MARGIN + (i % 3) * colW;
        const yy = ly + Math.floor(i / 3) * 15;
        doc.roundedRect(x, yy, 46, 13, 2).lineWidth(0.6).strokeColor('#94a3b8').stroke();
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor(INK).text(p.code, x, yy + 3, { width: 46, align: 'center' });
        doc.font('Helvetica').fontSize(8).fillColor(INK).text(p.code === RESERVE.code ? p.name : `${p.area} — ${p.name}`, x + 52, yy + 2.5, { width: colW - 58 });
      });
      ly += Math.ceil(r.posts.length / 3) * 15 + 2;
    }
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED);
    for (const n of NOTES) {
      doc.text(`•  ${n}`, MARGIN, ly, { width: usable });
      ly += 11;
    }
    return ly;
  };

  const weeks: string[][] = [];
  for (let i = 0; i < r.dates.length; i += 7) weeks.push(r.dates.slice(i, i + 7));

  weeks.forEach((week, wi) => {
    if (wi > 0) doc.addPage();
    header(`Minggu ke-${wi + 1} dari ${weeks.length}`);
    const nameW = 190;
    const colW = (usable - nameW) / 7;
    const rowH = Math.min(24, Math.max(15, (doc.page.height - 76 - 30 - 34 - (r.posts.length ? 185 : 140)) / Math.max(1, r.rows.length + 1)));
    let y = doc.y;

    // Kepala kolom: hari + tanggal
    doc.rect(MARGIN, y, usable, 30).fill('#f1f5f9');
    doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text('NAMA KARYAWAN', MARGIN + 6, y + 11);
    week.forEach((d, i) => {
      const x = MARGIN + nameW + i * colW;
      const wd = weekday(d);
      const red = wd === 0 || r.holidays.has(d);
      doc.font('Helvetica-Bold').fontSize(9).fillColor(red ? '#be123c' : INK).text(DAY_LONG[wd], x, y + 5, { width: colW, align: 'center' });
      doc.font('Helvetica').fontSize(8).fillColor(red ? '#be123c' : MUTED).text(fmtLongDate(d).replace(/ \d{4}$/, ''), x, y + 17, { width: colW, align: 'center' });
    });
    y += 30;

    const start = r.dates.indexOf(week[0]);
    r.rows.forEach((row, ri) => {
      if (ri % 2 === 1) doc.rect(MARGIN, y, usable, rowH).fill('#f8fafc');
      doc.font(row.coordinator ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(INK);
      doc.text(`${ri + 1}. ${row.name}${row.coordinator ? ' (Koordinator)' : ''}`, MARGIN + 6, y + rowH / 2 - 4.5, { width: nameW - 10, lineBreak: false, ellipsis: true });
      week.forEach((_, i) => {
        const c = row.cells[start + i];
        const x = MARGIN + nameW + i * colW;
        doc.roundedRect(x + 3, y + 2, colW - 6, rowH - 4, 3).fill(STYLE[c.kind].fill);
        if (c.post) {
          doc.font('Helvetica-Bold').fontSize(8.5).fillColor(STYLE[c.kind].ink).text(c.text, x, y + rowH / 2 - 8, { width: colW, align: 'center', lineBreak: false });
          doc.font('Helvetica').fontSize(7).text(c.post, x, y + rowH / 2 + 0.5, { width: colW, align: 'center', lineBreak: false });
        } else {
          doc.font('Helvetica-Bold').fontSize(9).fillColor(STYLE[c.kind].ink).text(c.text, x, y + rowH / 2 - 4.5, { width: colW, align: 'center' });
        }
      });
      doc.moveTo(MARGIN, y + rowH).lineTo(MARGIN + usable, y + rowH).lineWidth(0.4).strokeColor(GRID).stroke();
      y += rowH;
    });

    // Baris jumlah orang per hari
    doc.rect(MARGIN, y, usable, 26).fill('#f1f5f9');
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text('JUMLAH ORANG', MARGIN + 6, y + 9);
    week.forEach((_, i) => {
      const day = counts(r.rows.map((row) => row.cells[start + i]));
      const x = MARGIN + nameW + i * colW;
      const parts = [day.S1 && `S1: ${day.S1}`, day.S2 && `S2: ${day.S2}`, day.FULL && `Penuh: ${day.FULL}`].filter(Boolean).join('  ');
      doc.font('Helvetica').fontSize(7.5).fillColor(INK).text(parts || '—', x, y + 4, { width: colW, align: 'center' });
      doc.fillColor(MUTED).text(`Off: ${day.OFF}`, x, y + 14, { width: colW, align: 'center' });
    });
    y += 34;

    const holidaysThisWeek = week.filter((d) => r.holidays.has(d));
    if (holidaysThisWeek.length) {
      doc.font('Helvetica').fontSize(8).fillColor('#be123c').text(`Hari libur: ${holidaysThisWeek.map((d) => `${DAY_LONG[weekday(d)]} ${ddmm(d)} – ${r.holidays.get(d)}`).join('; ')}`, MARGIN, y);
      y += 14;
    }
    legendBox(y);
    // Footer di area margin bawah: matikan sementara batas bawah agar pdfkit tidak membuat halaman kosong
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(`Dicetak ${fmtLongDate(now.date)} ${now.time.slice(0, 5)} WIT oleh ${generatedBy} · SMC-FaceAttend`, MARGIN, doc.page.height - MARGIN + 6, { width: usable, align: 'right', lineBreak: false });
    doc.page.margins.bottom = bottom;
  });

  // ── Rekap jumlah per karyawan ──
  doc.addPage();
  header('Rekap per Karyawan');
  const cols = [
    { label: 'No', w: 34 },
    { label: 'Nama Karyawan', w: 250 },
    { label: 'Shift 1', w: 80 },
    { label: 'Shift 2', w: 80 },
    { label: 'Shift Penuh', w: 90 },
    { label: 'Off', w: 70 },
    { label: 'Hari Off', w: usable - 604 },
  ];
  let y = doc.y;
  const headerRow = () => {
    doc.rect(MARGIN, y, usable, 22).fill('#f1f5f9');
    let x = MARGIN;
    for (const c of cols) {
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(MUTED).text(c.label.toUpperCase(), x + 6, y + 7, { width: c.w - 12, align: c.label.startsWith('Nama') || c.label === 'Hari Off' ? 'left' : 'center' });
      x += c.w;
    }
    y += 22;
  };
  headerRow();
  r.rows.forEach((row, ri) => {
    const c = counts(row.cells);
    const offDays = r.dates.filter((_, i) => row.cells[i].kind === 'OFF');
    const offText = offDays.map((d) => `${DAY_SHORT[weekday(d)]} ${ddmm(d)}`).join(', ') || '—';
    doc.font('Helvetica').fontSize(8);
    const h = Math.max(18, doc.heightOfString(offText, { width: cols[6].w - 12 }) + 8);
    if (y + h > doc.page.height - MARGIN - 20) {
      doc.addPage();
      header('Rekap per Karyawan (lanjutan)');
      y = doc.y;
      headerRow();
    }
    if (ri % 2 === 1) doc.rect(MARGIN, y, usable, h).fill('#f8fafc');
    const vals = [String(ri + 1), `${row.name}${row.coordinator ? ' (Koordinator)' : ''}`, String(c.S1 || '—'), String(c.S2 || '—'), String(c.FULL || '—'), String(c.OFF)];
    let x = MARGIN;
    vals.forEach((v, i) => {
      doc.font(i === 1 && row.coordinator ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(INK).text(v, x + 6, y + 5, { width: cols[i].w - 12, align: i === 1 ? 'left' : 'center', lineBreak: false });
      x += cols[i].w;
    });
    doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(offText, x + 6, y + 5, { width: cols[6].w - 12 });
    doc.moveTo(MARGIN, y + h).lineTo(MARGIN + usable, y + h).lineWidth(0.4).strokeColor(GRID).stroke();
    y += h;
  });
  doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(`Jumlah hari dihitung selama periode ${periodText(r)} (${r.dates.length} hari).`, MARGIN, y + 8);

  // ── Rekap penempatan: berapa kali tiap orang di tiap pos ──
  const plotted = r.rows.filter((row) => row.cells.some((c) => c.post));
  if (r.posts.length && plotted.length) {
    doc.addPage();
    header('Rekap Penempatan (Plotting)');
    const nameW = 230;
    const postW = Math.min(80, (usable - nameW - 34 - 60) / r.posts.length);
    let py = doc.y;
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text('Jumlah hari tiap petugas ditempatkan di setiap pos. Penempatan digilir otomatis supaya merata dan tidak di pos yang sama dua hari berturut-turut.', MARGIN, py, { width: usable });
    py += 18;
    doc.rect(MARGIN, py, usable, 34).fill('#f1f5f9');
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(MUTED).text('NO', MARGIN, py + 13, { width: 34, align: 'center' });
    doc.text('NAMA PETUGAS', MARGIN + 40, py + 13);
    r.posts.forEach((p, i) => {
      const x = MARGIN + 34 + nameW + i * postW;
      doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(p.code, x, py + 5, { width: postW, align: 'center' });
      doc.font('Helvetica').fontSize(6.5).fillColor(MUTED).text(p.code === RESERVE.code ? 'Cadangan' : p.name, x + 2, py + 17, { width: postW - 4, align: 'center', lineBreak: false, ellipsis: true });
    });
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(MUTED).text('TOTAL', MARGIN + 34 + nameW + r.posts.length * postW, py + 13, { width: 60, align: 'center' });
    py += 34;
    plotted.forEach((row, ri) => {
      if (ri % 2 === 1) doc.rect(MARGIN, py, usable, 18).fill('#f8fafc');
      doc.font('Helvetica').fontSize(9).fillColor(INK).text(String(ri + 1), MARGIN, py + 5, { width: 34, align: 'center' });
      doc.text(row.name, MARGIN + 40, py + 5, { width: nameW - 10, lineBreak: false });
      let total = 0;
      r.posts.forEach((p, i) => {
        const n = row.cells.filter((c) => c.post === p.code).length;
        total += n;
        doc.text(n ? String(n) : '—', MARGIN + 34 + nameW + i * postW, py + 5, { width: postW, align: 'center' });
      });
      doc.font('Helvetica-Bold').text(String(total), MARGIN + 34 + nameW + r.posts.length * postW, py + 5, { width: 60, align: 'center' });
      doc.moveTo(MARGIN, py + 18).lineTo(MARGIN + usable, py + 18).lineWidth(0.4).strokeColor(GRID).stroke();
      py += 18;
    });
    py += 10;
    r.posts.forEach((p, i) => {
      doc.font('Helvetica').fontSize(8).fillColor(INK).text(`${p.code} = ${p.code === RESERVE.code ? p.name : `${p.area} — ${p.name}`}`, MARGIN + (i % 2) * (usable / 2), py + Math.floor(i / 2) * 12, { width: usable / 2 - 10 });
    });
  }
  doc.end();
}

// ─────────────── Excel ───────────────
const argb = (hex: string) => `FF${hex.slice(1).toUpperCase()}`;

export async function sendRosterXlsx(res: Response, r: RosterData, generatedBy: string, filename: string) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SMC-FaceAttend';
  const ws = wb.addWorksheet('Roster', { views: [{ state: 'frozen', xSplit: 2, ySplit: 5 }], pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } });
  const lastCol = r.dates.length + 2;
  const thin = { style: 'thin' as const, color: { argb: 'FFCBD5E1' } };
  const border = { top: thin, left: thin, bottom: thin, right: thin };

  ws.mergeCells(1, 1, 1, lastCol);
  ws.getCell(1, 1).value = 'ROSTER SHIFT KARYAWAN PARKIR — Pos Parkir Mall Sorong Modern City (SMC)';
  ws.getCell(1, 1).font = { bold: true, size: 14, color: { argb: 'FF0C2B52' } };
  ws.mergeCells(2, 1, 2, lastCol);
  ws.getCell(2, 1).value = `Periode ${periodText(r)} · dicetak ${fmtLongDate(witNow().date)} oleh ${generatedBy}`;
  ws.getCell(2, 1).font = { size: 10, color: { argb: 'FF64748B' } };

  // Baris 4: hari, baris 5: tanggal
  ws.getCell(4, 1).value = 'No';
  ws.getCell(4, 2).value = 'Nama Karyawan';
  ws.mergeCells(4, 1, 5, 1);
  ws.mergeCells(4, 2, 5, 2);
  r.dates.forEach((d, i) => {
    const wd = weekday(d);
    const red = wd === 0 || r.holidays.has(d);
    const top = ws.getCell(4, i + 3);
    const bot = ws.getCell(5, i + 3);
    top.value = DAY_SHORT[wd];
    bot.value = ddmm(d);
    for (const c of [top, bot]) {
      c.font = { bold: true, size: 9, color: { argb: red ? 'FFBE123C' : 'FF334155' } };
      c.alignment = { horizontal: 'center', vertical: 'middle' };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: wd === 1 ? 'FFE2E8F0' : 'FFF1F5F9' } };
      c.border = border;
    }
  });
  for (const c of [ws.getCell(4, 1), ws.getCell(4, 2)]) {
    c.font = { bold: true, size: 10, color: { argb: 'FF334155' } };
    c.alignment = { horizontal: 'center', vertical: 'middle' };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
    c.border = border;
  }

  r.rows.forEach((row, ri) => {
    const rowNo = 6 + ri;
    ws.getCell(rowNo, 1).value = ri + 1;
    ws.getCell(rowNo, 2).value = `${row.name}${row.coordinator ? ' (Koordinator)' : ''}`;
    ws.getCell(rowNo, 1).alignment = { horizontal: 'center' };
    ws.getCell(rowNo, 2).font = { bold: row.coordinator };
    ws.getCell(rowNo, 1).border = border;
    ws.getCell(rowNo, 2).border = border;
    row.cells.forEach((c, i) => {
      const cell = ws.getCell(rowNo, i + 3);
      cell.value = c.post ? `${c.text} ${c.post}` : c.text;
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.font = { bold: true, size: 9, color: { argb: argb(STYLE[c.kind].ink) } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(STYLE[c.kind].fill) } };
      cell.border = border;
    });
  });

  // Jumlah orang per hari
  const sumStart = 6 + r.rows.length;
  const sumRows: [string, (k: ReturnType<typeof counts>) => number][] = [
    ['Jumlah Shift 1', (k) => k.S1],
    ['Jumlah Shift 2', (k) => k.S2],
    ['Jumlah Shift Penuh', (k) => k.FULL],
    ['Jumlah Off', (k) => k.OFF],
  ];
  sumRows.forEach(([label, pick], si) => {
    const rowNo = sumStart + si;
    ws.getCell(rowNo, 2).value = label;
    ws.getCell(rowNo, 2).font = { bold: true, color: { argb: 'FF64748B' } };
    r.dates.forEach((_, i) => {
      const cell = ws.getCell(rowNo, i + 3);
      cell.value = pick(counts(r.rows.map((row) => row.cells[i])));
      cell.alignment = { horizontal: 'center' };
      cell.font = { size: 9, color: { argb: 'FF475569' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
      cell.border = border;
    });
  });

  // Keterangan simbol
  let ly = sumStart + sumRows.length + 2;
  ws.getCell(ly, 2).value = 'KETERANGAN';
  ws.getCell(ly, 2).font = { bold: true, size: 11 };
  ly++;
  for (const l of r.legend) {
    const sym = ws.getCell(ly, 2);
    sym.value = l.symbol;
    sym.alignment = { horizontal: 'center' };
    sym.font = { bold: true, color: { argb: argb(STYLE[l.kind].ink) } };
    sym.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(STYLE[l.kind].fill) } };
    sym.border = border;
    ws.mergeCells(ly, 3, ly, Math.min(lastCol, 16));
    ws.getCell(ly, 3).value = l.meaning;
    ly++;
  }
  if (r.posts.length) {
    ly++;
    ws.getCell(ly, 2).value = 'PENEMPATAN (PLOTTING) — kode setelah shift, mis. "S1 CK"';
    ws.getCell(ly, 2).font = { bold: true, size: 11 };
    ly++;
    for (const p of r.posts) {
      const sym = ws.getCell(ly, 2);
      sym.value = p.code;
      sym.alignment = { horizontal: 'center' };
      sym.font = { bold: true };
      sym.border = border;
      ws.mergeCells(ly, 3, ly, Math.min(lastCol, 16));
      ws.getCell(ly, 3).value = p.code === RESERVE.code ? p.name : `${p.area} — ${p.name}`;
      ly++;
    }
  }
  for (const [d, name] of r.holidays) {
    ws.mergeCells(ly, 3, ly, Math.min(lastCol, 16));
    ws.getCell(ly, 2).value = 'Hari libur';
    ws.getCell(ly, 3).value = `${DAY_LONG[weekday(d)]} ${fmtLongDate(d)}: ${name}`;
    ly++;
  }
  ly++;
  for (const n of NOTES) {
    ws.mergeCells(ly, 2, ly, Math.min(lastCol, 16));
    ws.getCell(ly, 2).value = `• ${n}`;
    ws.getCell(ly, 2).font = { size: 9, color: { argb: 'FF64748B' } };
    ly++;
  }

  ws.getColumn(1).width = 5;
  ws.getColumn(2).width = 34;
  for (let i = 3; i <= lastCol; i++) ws.getColumn(i).width = r.posts.length ? 9.5 : 7.5;

  // Lembar rekap
  const rk = wb.addWorksheet('Rekap per Karyawan', { views: [{ state: 'frozen', ySplit: 3 }] });
  rk.mergeCells(1, 1, 1, 7 + r.posts.length);
  rk.getCell(1, 1).value = `Rekap Roster ${periodText(r)} (${r.dates.length} hari)`;
  rk.getCell(1, 1).font = { bold: true, size: 13, color: { argb: 'FF0C2B52' } };
  const head = ['No', 'Nama Karyawan', 'Shift 1', 'Shift 2', 'Shift Penuh', 'Off', 'Tanggal Off', ...r.posts.map((p) => `Pos ${p.code}`)];
  head.forEach((h, i) => {
    const c = rk.getCell(3, i + 1);
    c.value = h;
    c.font = { bold: true, color: { argb: 'FF334155' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
    c.border = border;
    c.alignment = { horizontal: i === 1 || i === 6 ? 'left' : 'center' };
  });
  r.rows.forEach((row, ri) => {
    const c = counts(row.cells);
    const offs = r.dates.filter((_, i) => row.cells[i].kind === 'OFF').map((d) => `${DAY_SHORT[weekday(d)]} ${ddmm(d)}`).join(', ');
    const vals = [ri + 1, `${row.name}${row.coordinator ? ' (Koordinator)' : ''}`, c.S1, c.S2, c.FULL, c.OFF, offs || '—', ...r.posts.map((p) => row.cells.filter((x) => x.post === p.code).length)];
    vals.forEach((v, i) => {
      const cell = rk.getCell(4 + ri, i + 1);
      cell.value = v;
      cell.border = border;
      cell.alignment = { horizontal: i === 1 || i === 6 ? 'left' : 'center', wrapText: i === 6 };
    });
  });
  [5, 34, 10, 10, 12, 8, 70, ...r.posts.map(() => 9)].forEach((w, i) => (rk.getColumn(i + 1).width = w));
  r.posts.forEach((p, i) => (rk.getCell(4 + r.rows.length + 2 + i, 2).value = `Pos ${p.code} = ${p.code === RESERVE.code ? p.name : `${p.area} — ${p.name}`}`));

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
}

// ─────────────── Teks WhatsApp harian ───────────────
const dot = (t: string) => t.replace(':', '.');
const partOfDay = (t: string) => {
  const h = Number(t.slice(0, 2));
  return h < 11 ? 'PAGI' : h < 15 ? 'SIANG' : h < 18 ? 'SORE' : 'MALAM';
};
const longDate = (d: string) => `${DAY_LONG[weekday(d)]}, ${fmtLongDate(d)}`;

/** Teks jadwal satu hari dengan format seperti jadwal manual manajemen Mall SMC. */
export async function buildWhatsappText(date: string): Promise<string> {
  const [shifts, users, schedules, holiday, posts] = await Promise.all([
    Shift.findAll({ order: [['id', 'ASC']] }),
    User.findAll({ where: { role: [...ATTENDEE_ROLES], isActive: true } }),
    EmployeeSchedule.findAll({ where: { date } }),
    Holiday.findOne({ where: { date } }),
    getPosts(),
  ]);
  const name = new Map(users.map((u) => [u.id, u.fullName]));
  const coordinators = new Set(users.filter((u) => u.role === 'KOORDINATOR').map((u) => u.id));
  const rows = schedules.filter((s) => name.has(s.userId));
  const working = rows.filter((s) => s.shiftId !== null);
  const coordNames = working.filter((s) => coordinators.has(s.userId)).map((s) => name.get(s.userId)!);
  const coordText = coordNames.length ? coordNames.join(', ') : 'Off hari ini';
  const rotation = shifts.filter((sh) => working.some((s) => s.shiftId === sh.id && !coordinators.has(s.userId)));

  const out: string[] = [];
  out.push('📅 *JADWAL SHIFT PETUGAS PARKIRAN*', '', 'Mall Sorong Modern City', `📅 Berlaku: *${longDate(date)}*`);
  if (holiday) out.push(`🎉 Hari libur: ${holiday.name}`);
  out.push('', '✅ *INFORMASI UMUM*', '', '- 📌 Sistem Absensi: Absensi Online (wajah + lokasi di pos)');
  for (const sh of rotation) out.push(`- ⏰ ${sh.name}: ${dot(sh.startTime)} – ${dot(sh.endTime)}`);
  out.push(`- 👤 Koordinator: ${coordText}`);

  for (const sh of rotation) {
    const members = working
      .filter((s) => s.shiftId === sh.id && !coordinators.has(s.userId))
      .sort((a, b) => name.get(a.userId)!.localeCompare(name.get(b.userId)!));
    out.push('', `*${sh.name.toUpperCase()} — ${partOfDay(sh.startTime)} – ${partOfDay(sh.endTime)} · ${dot(sh.startTime)} – ${dot(sh.endTime)}*`, '', `Koordinator: ${coordText}`, '', 'Anggota:', '');
    members.forEach((m, i) => out.push(`${i + 1}. ${name.get(m.userId)}`));
    const byPost = new Map(members.filter((m) => m.post).map((m) => [m.post!, name.get(m.userId)!]));
    if (byPost.size) {
      out.push('', '📍 *PENEMPATAN (PLOTTING):*');
      for (const area of [...new Set(posts.map((p) => p.area))]) {
        const inArea = posts.filter((p) => p.area === area && byPost.has(p.code));
        if (!inArea.length) continue;
        out.push('', `🔹 ${area}`, '');
        for (const p of inArea) out.push(`- ${p.name} : ${byPost.get(p.code)}`);
      }
      const reserve = members.filter((m) => m.post === RESERVE.code).map((m) => name.get(m.userId));
      if (reserve.length) out.push('', `🔸 Cadangan (bantu pos ramai & gantikan saat istirahat): ${reserve.join(', ')}`);
    }
  }

  const off = rows.filter((s) => s.shiftId === null).map((s) => name.get(s.userId)!).sort();
  if (off.length) {
    out.push('', `*OFF / ISTIRAHAT — ${longDate(date)}*`, '');
    off.forEach((n, i) => out.push(`${i + 1}. ${n}`));
  }
  if (working.length === 0) out.push('', '_Belum ada jadwal untuk tanggal ini._');
  return out.join('\n');
}
