/**
 * PDF rekap upah kehadiran (interaktif): halaman rekap semua petugas dengan nama yang bisa diklik
 * menuju slip masing-masing, bookmark per petugas, dan tautan kembali ke rekap. Juga piagam penghargaan.
 */
import type { Response } from 'express';
import PDFDocument from 'pdfkit';
import type { DisciplineSettings } from './discipline';
import { PayRow, PayrollSettings, rupiah } from './payroll';
import { areaText, drawLogo, signDate } from './organization';
import { fmtLongDate } from './pdfReport';

const INK = '#111827';
const MUTED = '#4b5563';
const RULE = '#d1d5db';
const BRAND = '#0c2b52';
const LINK = '#1d4ed8';
const GOOD = '#047857';
const BAD = '#b91c1c';
const position = (role: string, kop: DisciplineSettings) => (role === 'KOORDINATOR' ? kop.coordinatorTitle : role === 'KARYAWAN' ? 'Petugas Parkir' : '');
const DAY = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
const shortDate = (iso: string) => `${DAY[new Date(`${iso}T00:00:00Z`).getUTCDay()]} ${Number(iso.slice(8, 10))}/${Number(iso.slice(5, 7))}`;

export interface PayrollMeta {
  monthLabel: string; // "November 2026"
  /** Periode berjalan: data baru sampai tanggal ini */
  until: string | null;
  settings: PayrollSettings;
  kop: DisciplineSettings;
  printedBy: string;
  printedAt: string;
}

// pdfkit punya addNamedDestination, tetapi @types/pdfkit belum mencantumkannya
const destination = (doc: PDFKit.PDFDocument, name: string) => (doc as unknown as { addNamedDestination(n: string): void }).addNamedDestination(name);

function kop(doc: PDFKit.PDFDocument, m: PayrollMeta, x: number, w: number, y: number) {
  const logoW = drawLogo(doc, x, y - 4, 40);
  const tx = logoW ? x + logoW + 8 : x;
  const tw = logoW ? w - (logoW + 8) * 2 : w;
  doc.font('Times-Bold').fontSize(17).fillColor(INK).text(m.kop.companyName.toUpperCase(), tx, y, { width: tw, align: 'center', characterSpacing: 0.6 });
  const sub = [m.kop.companyAddress, m.kop.companyContact, `Penugasan: ${areaText(m.kop)}`].filter(Boolean).join(' · ');
  doc.font('Times-Roman').fontSize(9).fillColor(MUTED).text(sub, tx, doc.y, { width: tw, align: 'center' });
  const ly = Math.max(doc.y, logoW ? y - 4 + logoW : 0) + 5;
  doc.moveTo(x, ly).lineTo(x + w, ly).lineWidth(1.6).strokeColor(INK).stroke();
  doc.moveTo(x, ly + 2.5).lineTo(x + w, ly + 2.5).lineWidth(0.5).strokeColor(INK).stroke();
  doc.y = ly + 12;
}

const lateRuleText = (s: PayrollSettings) =>
  `setiap ${s.lateDeduction.perCount} kali terlambat dalam sebulan = ${s.lateDeduction.days} × upah per hari`;

/** Rekap semua petugas + slip tiap petugas (mode "all"), atau slip satu orang saja. */
export function sendPayrollPdf(res: Response, rows: PayRow[], m: PayrollMeta, filename: string, mode: 'all' | 'single') {
  const doc = new PDFDocument({ size: 'A4', layout: mode === 'all' ? 'landscape' : 'portrait', margin: 36, autoFirstPage: false, info: { Title: `Rekap Upah Kehadiran ${m.monthLabel}`, Author: m.kop.companyName } });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);
  if (mode === 'all') {
    rekapPage(doc, rows, m);
    const slips = doc.outline.addItem('Slip per petugas');
    for (const r of rows) {
      slipPage(doc, r, m, true);
      slips.addItem(r.user.fullName);
    }
  } else {
    for (const r of rows) slipPage(doc, r, m, false);
  }
  doc.end();
}

function rekapPage(doc: PDFKit.PDFDocument, rows: PayRow[], m: PayrollMeta) {
  doc.addPage({ size: 'A4', layout: 'landscape', margin: 36 });
  doc.outline.addItem(`Rekap upah ${m.monthLabel}`);
  const x = 36;
  const w = doc.page.width - 72;
  destination(doc, 'rekap');
  kop(doc, m, x, w, 30);
  doc.font('Helvetica-Bold').fontSize(13).fillColor(BRAND).text('REKAP UPAH BERDASARKAN KEHADIRAN', x, doc.y, { width: w, align: 'center' });
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(
    `Periode ${m.monthLabel}${m.until ? ` · periode berjalan, data s.d. ${fmtLongDate(m.until)}` : ''} · Upah per hari = Upah Pokok ÷ ${m.settings.divisor} (PKWT Pasal 8)`,
    x,
    doc.y + 1,
    { width: w, align: 'center' },
  );
  doc.moveDown(0.6);

  // Angka utama
  const totals = [
    ['Petugas', String(rows.length)],
    ['Total upah pokok', rupiah(rows.reduce((a, r) => a + r.baseWage, 0))],
    ['Total potongan', rupiah(rows.reduce((a, r) => a + r.totalDeduction, 0))],
    ['Total bonus', rupiah(rows.reduce((a, r) => a + r.totalBonus, 0))],
    ['Total diterima', rupiah(rows.reduce((a, r) => a + r.takeHome, 0))],
  ];
  const bw = (w - 4 * 8) / 5;
  let y = doc.y;
  totals.forEach(([k, v], i) => {
    const bx = x + i * (bw + 8);
    doc.roundedRect(bx, y, bw, 38, 5).lineWidth(0.7).strokeColor(RULE).stroke();
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(k, bx + 8, y + 6, { width: bw - 16 });
    doc.font('Helvetica-Bold').fontSize(12).fillColor(i === 4 ? BRAND : INK).text(v, bx + 8, y + 18, { width: bw - 16 });
  });
  y += 48;

  // Tabel rekap: nama = tautan ke slip
  const cols: { label: string; w: number; align?: 'left' | 'right' | 'center' }[] = [
    { label: 'No', w: 22, align: 'center' },
    { label: 'Nama petugas (klik untuk slip)', w: 160 },
    { label: 'Hari kerja', w: 44, align: 'center' },
    { label: 'Hadir', w: 36, align: 'center' },
    { label: 'Terlambat', w: 54, align: 'center' },
    { label: 'Alfa', w: 32, align: 'center' },
    { label: 'Izin/Sakit/Cuti', w: 58, align: 'center' },
    { label: 'Upah pokok', w: 70, align: 'right' },
    { label: 'Pot. mangkir', w: 64, align: 'right' },
    { label: 'Pot. terlambat', w: 66, align: 'right' },
    { label: 'Bonus', w: 58, align: 'right' },
    { label: 'Diterima', w: w - 664, align: 'right' },
  ];
  const head = () => {
    doc.rect(x, y, w, 24).fill('#eef2f7');
    let cx = x;
    for (const c of cols) {
      doc.font('Helvetica-Bold').fontSize(7).fillColor(MUTED).text(c.label.toUpperCase(), cx + 4, y + 4, { width: c.w - 8, align: c.align ?? 'left', height: 20 });
      cx += c.w;
    }
    y += 24;
  };
  head();
  rows.forEach((r, i) => {
    if (y > doc.page.height - 120) {
      doc.addPage({ size: 'A4', layout: 'landscape', margin: 36 });
      y = 36;
      head();
    }
    if (i % 2 === 1) doc.rect(x, y, w, 19).fill('#f9fafb');
    const vals = [
      String(i + 1),
      r.user.fullName,
      String(r.workDays),
      String(r.present),
      String(r.lateCount),
      String(r.alfa),
      `${r.leave.izin}/${r.leave.sakit}/${r.leave.cuti}`,
      rupiah(r.baseWage),
      r.deductMangkir ? `-${rupiah(r.deductMangkir)}` : '—',
      r.deductLate ? `-${rupiah(r.deductLate)}` : r.lateSimulated ? `(${rupiah(r.lateSimulated)})` : '—',
      r.totalBonus ? `+${rupiah(r.totalBonus)}` : '—',
      rupiah(r.takeHome),
    ];
    let cx = x;
    vals.forEach((v, ci) => {
      const c = cols[ci];
      const isName = ci === 1;
      const color = isName ? LINK : ci === 8 || ci === 9 ? (v.startsWith('-') ? BAD : MUTED) : ci === 10 && v !== '—' ? GOOD : INK;
      doc.font(isName || ci === 11 ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(color);
      doc.text(v + (isName && r.rank ? `  (Terbaik #${r.rank})` : ''), cx + 4, y + 5.5, { width: c.w - 8, align: c.align ?? 'left', lineBreak: false, underline: isName });
      // Area klik nama → slip petugas tersebut
      if (isName) doc.goTo(cx + 2, y + 1, c.w - 4, 17, `slip-${r.user.id}`);
      cx += c.w;
    });
    doc.moveTo(x, y + 19).lineTo(x + w, y + 19).lineWidth(0.4).strokeColor(RULE).stroke();
    y += 19;
  });

  // Keterangan
  y += 8;
  const s = m.settings;
  const notes = [
    `Potongan mangkir (Alfa): 1 × upah per hari untuk setiap hari mangkir, sesuai PKWT Pasal 8 (no work no pay).`,
    s.lateDeduction.enabled
      ? `Potongan terlambat DIBERLAKUKAN: ${lateRuleText(s)}.`
      : `Potongan terlambat TIDAK DIBERLAKUKAN. Angka dalam kurung adalah simulasi bila aturan (${lateRuleText(s)}) diberlakukan; tidak mengurangi upah.`,
    `Bonus: kehadiran sempurna ${s.perfectBonus.enabled ? rupiah(s.perfectBonus.amount) : 'tidak aktif'}; Petugas Terbaik ${s.bestEmployee.enabled ? s.bestEmployee.amounts.slice(0, s.bestEmployee.count).map((a, i) => `peringkat ${i + 1} ${rupiah(a)}`).join(', ') : 'tidak aktif'}.`,
    'Jumlah diterima belum termasuk potongan BPJS dan PPh yang dihitung HRD sesuai ketentuan.',
  ];
  doc.font('Helvetica').fontSize(8).fillColor(MUTED);
  for (const n of notes) {
    doc.text(`•  ${n}`, x, y, { width: w * 0.66 });
    y = doc.y + 2;
  }
  // Tanda tangan
  const sx = x + w * 0.7;
  const sy = Math.max(y - notes.length * 12 - 8, doc.page.height - 132);
  doc.font('Times-Roman').fontSize(10).fillColor(INK).text(signDate(m.kop, fmtLongDate(m.printedAt)), sx, sy, { width: w * 0.3, align: 'center' });
  doc.text(`${m.kop.companyName}`, sx, doc.y + 1, { width: w * 0.3, align: 'center' });
  doc.font('Times-Bold').text(m.kop.hrdName || '(.................................)', sx, sy + 64, { width: w * 0.3, align: 'center', underline: !!m.kop.hrdName });
  doc.font('Times-Roman').fontSize(9).text(m.kop.hrdTitle, sx, doc.y + 1, { width: w * 0.3, align: 'center' });
  footer(doc, m);
}

function slipPage(doc: PDFKit.PDFDocument, r: PayRow, m: PayrollMeta, linked: boolean) {
  doc.addPage({ size: 'A4', layout: 'portrait', margin: 48 });
  const x = 48;
  const w = doc.page.width - 96;
  destination(doc, `slip-${r.user.id}`);
  if (linked) {
    doc.font('Helvetica').fontSize(8.5).fillColor(LINK).text('« Kembali ke rekap semua petugas', x, 24, { width: 200, underline: true, lineBreak: false });
    doc.goTo(x - 2, 21, 170, 14, 'rekap');
  }
  kop(doc, m, x, w, 38);
  doc.font('Helvetica-Bold').fontSize(12.5).fillColor(BRAND).text('SLIP RINCIAN UPAH BERDASARKAN KEHADIRAN', x, doc.y, { width: w, align: 'center' });
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(`Periode ${m.monthLabel}${m.until ? ` (data s.d. ${fmtLongDate(m.until)})` : ''}`, x, doc.y + 1, { width: w, align: 'center' });
  doc.moveDown(0.8);

  // Identitas
  let y = doc.y;
  const ident: [string, string][] = [
    ['Nama', r.user.fullName],
    ['NIK', r.user.nik],
    ['Jabatan', position(r.user.role, m.kop) || '-'],
    ['Upah pokok', `${rupiah(r.baseWage)} per bulan`],
    ['Upah per hari', `${rupiah(r.dailyWage)} (Upah Pokok ÷ ${m.settings.divisor})`],
  ];
  for (const [k, v] of ident) {
    doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(k, x, y, { width: 90 });
    doc.font('Helvetica-Bold').fillColor(INK).text(v, x + 92, y, { width: w - 92 });
    y += 15;
  }
  if (r.rank) {
    doc.roundedRect(x + w - 150, y - 75, 150, 40, 6).fill('#fef3c7');
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#92400e').text(`Petugas Terbaik #${r.rank}`, x + w - 150, y - 67, { width: 150, align: 'center' });
    doc.font('Helvetica').fontSize(8).text(m.monthLabel, x + w - 150, y - 52, { width: 150, align: 'center' });
  }
  y += 8;

  // Kehadiran
  doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text('Rekap kehadiran', x, y);
  y = doc.y + 4;
  const att: [string, number][] = [
    ['Hari kerja terjadwal', r.workDays],
    ['Hadir', r.present],
    ['Tepat waktu', r.onTime],
    ['Terlambat masuk', r.lateCount],
    ['Absen sekali', r.absenSekali],
    ['Alfa (mangkir)', r.alfa],
    ['Izin', r.leave.izin],
    ['Sakit', r.leave.sakit],
    ['Cuti', r.leave.cuti],
    ['Hari Off', r.offDays],
  ];
  const cw = w / 5;
  att.forEach(([k, v], i) => {
    const cx = x + (i % 5) * cw;
    const cy = y + Math.floor(i / 5) * 40;
    doc.roundedRect(cx + 2, cy, cw - 4, 34, 4).lineWidth(0.6).strokeColor(RULE).stroke();
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(k, cx + 8, cy + 5, { width: cw - 16 });
    doc.font('Helvetica-Bold').fontSize(12).fillColor(k.startsWith('Alfa') && v ? BAD : INK).text(String(v), cx + 8, cy + 16, { width: cw - 16 });
  });
  y += 90;

  // Rincian perhitungan
  doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text('Rincian perhitungan', x, y);
  y = doc.y + 4;
  const s = m.settings;
  const lines: [string, string, string][] = [
    ['Upah pokok', '', rupiah(r.baseWage)],
    ['Potongan mangkir', `${r.alfa} hari × ${rupiah(r.dailyWage)} (PKWT Pasal 8)`, r.deductMangkir ? `- ${rupiah(r.deductMangkir)}` : '—'],
    [
      'Potongan terlambat',
      s.lateDeduction.enabled
        ? `${r.lateCount} kali terlambat = ${r.lateUnits} × ${rupiah(r.dailyWage)} (${lateRuleText(s)})`
        : `Tidak diberlakukan${r.lateSimulated ? ` · simulasi ${rupiah(r.lateSimulated)} (${r.lateCount} kali terlambat)` : ''}`,
      r.deductLate ? `- ${rupiah(r.deductLate)}` : '—',
    ],
    ['Bonus kehadiran sempurna', r.perfect ? 'Tanpa alfa, terlambat, dan absen sekali' : 'Tidak memenuhi syarat', r.bonusPerfect ? `+ ${rupiah(r.bonusPerfect)}` : '—'],
    ['Bonus Petugas Terbaik', r.rank ? `Peringkat ${r.rank} ${m.monthLabel}` : '—', r.bonusRank ? `+ ${rupiah(r.bonusRank)}` : '—'],
  ];
  for (const [k, d, v] of lines) {
    doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(k, x, y + 4, { width: 150 });
    doc.fontSize(8.5).fillColor(MUTED).text(d, x + 152, y + 5, { width: w - 152 - 110 });
    const descBottom = doc.y;
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(v.startsWith('-') ? BAD : v.startsWith('+') ? GOOD : INK).text(v, x + w - 110, y + 4, { width: 110, align: 'right' });
    y = Math.max(doc.y, descBottom, y + 16) + 3;
    doc.moveTo(x, y).lineTo(x + w, y).lineWidth(0.4).strokeColor(RULE).stroke();
  }
  doc.rect(x, y + 4, w, 26).fill('#eef2f7');
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor(BRAND).text('JUMLAH DITERIMA (sebelum BPJS & PPh)', x + 8, y + 12, { width: w - 140 });
  doc.text(rupiah(r.takeHome), x + w - 130, y + 12, { width: 122, align: 'right' });
  y += 40;

  // Tanggal-tanggal
  const list = (label: string, dates: string[]) => {
    if (!dates.length) return;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text(`${label}: `, x, y, { continued: true });
    doc.font('Helvetica').fillColor(MUTED).text(dates.map(shortDate).join(', '), { width: w });
    y = doc.y + 3;
  };
  list('Tanggal alfa', r.alfaDates);
  list('Tanggal terlambat', r.lateDates);
  list('Tanggal absen sekali', r.absenSekaliDates);
  if (r.heavyDeduction) {
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(BAD).text('Perhatian: potongan melebihi separuh upah pokok, mohon diperiksa HRD sebelum dibayarkan.', x, y + 2, { width: w });
    y = doc.y + 3;
  }

  // Tanda tangan
  const sy = Math.max(y + 18, doc.page.height - 190);
  const half = w / 2;
  doc.font('Times-Roman').fontSize(10.5).fillColor(INK).text(signDate(m.kop, fmtLongDate(m.printedAt)), x + half, sy, { width: half, align: 'center' });
  doc.text('Diterima oleh,', x, sy + 16, { width: half, align: 'center' });
  doc.text(`${m.kop.companyName}`, x + half, sy + 16, { width: half, align: 'center' });
  doc.font('Times-Bold').text(r.user.fullName, x, sy + 84, { width: half, align: 'center', underline: true });
  doc.text(m.kop.hrdName || '(.................................)', x + half, sy + 84, { width: half, align: 'center', underline: !!m.kop.hrdName });
  doc.font('Times-Roman').fontSize(9.5).text(position(r.user.role, m.kop), x, sy + 99, { width: half, align: 'center' });
  doc.text(m.kop.hrdTitle, x + half, sy + 99, { width: half, align: 'center' });
  footer(doc, m);
}

function footer(doc: PDFKit.PDFDocument, m: PayrollMeta) {
  const bottom = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(
    `Disusun dari absensi online SMC-FaceAttend · dicetak ${fmtLongDate(m.printedAt)} oleh ${m.printedBy} · dokumen internal ${m.kop.companyName}`,
    36,
    doc.page.height - 22,
    { width: doc.page.width - 72, align: 'center', lineBreak: false },
  );
  doc.page.margins.bottom = bottom;
}

/** Piagam penghargaan Petugas Terbaik (A4 mendatar). */
export function sendCertificatePdf(res: Response, r: PayRow, m: PayrollMeta, filename: string) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0, info: { Title: `Piagam Penghargaan ${r.user.fullName}`, Author: m.kop.companyName } });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);
  const W = doc.page.width;
  const H = doc.page.height;
  const GOLD = '#b8892d';
  doc.rect(0, 0, W, H).fill('#fffdf7');
  doc.rect(18, 18, W - 36, H - 36).lineWidth(3).strokeColor(BRAND).stroke();
  doc.rect(28, 28, W - 56, H - 56).lineWidth(1).strokeColor(GOLD).stroke();
  // Ornamen sudut
  for (const [cx, cy] of [[28, 28], [W - 28, 28], [28, H - 28], [W - 28, H - 28]]) {
    doc.circle(cx, cy, 7).fill(GOLD);
  }
  // Logo (bila ada) di atas nama perusahaan, di dalam bingkai
  const lo = drawLogo(doc, W / 2 - 19, 40, 38) ? 22 : 0;
  doc.font('Times-Bold').fontSize(16).fillColor(BRAND).text(m.kop.companyName.toUpperCase(), 0, 62 + lo, { width: W, align: 'center', characterSpacing: 2 });
  doc.font('Times-Roman').fontSize(10).fillColor(MUTED).text([areaText(m.kop), m.kop.cityRegion].filter(Boolean).join(' · '), 0, 84 + lo, { width: W, align: 'center' });
  doc.font('Times-Bold').fontSize(40).fillColor(GOLD).text('PIAGAM PENGHARGAAN', 0, 128 + lo / 2, { width: W, align: 'center', characterSpacing: 3 });
  doc.moveTo(W / 2 - 140, 182).lineTo(W / 2 + 140, 182).lineWidth(1).strokeColor(GOLD).stroke();
  doc.font('Times-Italic').fontSize(14).fillColor(INK).text('dengan bangga diberikan kepada', 0, 200, { width: W, align: 'center' });
  doc.font('Times-Bold').fontSize(34).fillColor(BRAND).text(r.user.fullName, 0, 230, { width: W, align: 'center' });
  doc.font('Times-Roman').fontSize(12).fillColor(MUTED).text(`${position(r.user.role, m.kop)} · NIK ${r.user.nik}`, 0, 274, { width: W, align: 'center' });
  doc.font('Times-Roman').fontSize(14).fillColor(INK).text(
    `sebagai PETUGAS TERBAIK PERINGKAT ${r.rank} bulan ${m.monthLabel}, atas kedisiplinan dan tanggung jawab dalam kehadiran bertugas di ${areaText(m.kop)}.`,
    W * 0.15,
    306,
    { width: W * 0.7, align: 'center', lineGap: 4 },
  );
  doc.font('Helvetica').fontSize(10).fillColor(MUTED).text(
    `${r.workDays} hari kerja · ${r.onTime} tepat waktu · ${r.lateCount} terlambat · ${r.alfa} alfa${r.perfect ? ' · kehadiran sempurna' : ''}${
      r.avgEarlyMinutes !== null && r.avgEarlyMinutes > 0 ? ` · rata-rata hadir ${Math.round(r.avgEarlyMinutes)} menit sebelum jam mulai` : ''
    }`,
    0,
    368,
    { width: W, align: 'center' },
  );
  const y = 410;
  const signs = [
    ['Mengetahui,', m.kop.coordinatorTitle, m.kop.coordinatorName],
    ...(m.kop.showManagementSign ? [['Mengetahui,', m.kop.managementTitle, m.kop.managementName]] : []),
    [signDate(m.kop, fmtLongDate(m.printedAt)), `${m.kop.companyName} · ${m.kop.hrdTitle}`, m.kop.hrdName],
  ];
  const colW = W / signs.length;
  signs.forEach(([a, b, name], i) => {
    const cx = colW * i + 30;
    doc.font('Times-Roman').fontSize(11).fillColor(INK).text(a, cx, y, { width: colW - 60, align: 'center' });
    doc.font('Times-Bold').fontSize(10).text(b, cx, y + 15, { width: colW - 60, align: 'center' });
    doc.font('Times-Bold').fontSize(11).text(name || '(.................................)', cx, y + 78, { width: colW - 60, align: 'center', underline: !!name });
  });
  doc.end();
}
