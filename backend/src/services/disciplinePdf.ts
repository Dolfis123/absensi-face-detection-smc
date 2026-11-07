/**
 * Surat Peringatan / Surat Panggilan (PDF, A4 tegak) berdasarkan catatan absensi online dan PKWT Pasal 8.
 */
import type { Response } from 'express';
import PDFDocument from 'pdfkit';
import type { LetterType } from '../models';
import { DisciplineSettings, LETTER_TITLE } from './discipline';
import { areaText, drawImage, drawLogo, signDate } from './organization';
import { fmtLongDate } from './pdfReport';

const DAY = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const dayDate = (iso: string) => `${DAY[new Date(`${iso}T00:00:00Z`).getUTCDay()]}, ${fmtLongDate(iso)}`;
const INK = '#111827';
const MUTED = '#4b5563';
const RULE = '#9ca3af';
const NUM_WORD = ['nol', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'delapan', 'sembilan', 'sepuluh'];
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const countText = (n: number) => (n <= 10 ? `${n} (${cap(NUM_WORD[n])})` : String(n));

export interface LetterData {
  type: LetterType;
  number: string;
  letterDate: string;
  alfaDates: string[];
  reportDate: string | null;
  reportTime: string | null;
  reportPlace: string | null;
  note: string | null;
  employee: { fullName: string; nik: string; position: string };
  /** Surat sebelumnya yang dirujuk (Peringatan Pertama untuk SP-2, Panggilan Pertama untuk Panggilan Kedua) */
  previous: { number: string; letterDate: string } | null;
  voided: boolean;
}

export function sendDisciplinePdf(res: Response, L: LetterData, s: DisciplineSettings, filename: string) {
  const M = 64;
  const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 40, left: M, right: M }, info: { Title: `${LETTER_TITLE[L.type]} ${L.number}`, Author: s.companyName } });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);
  const W = doc.page.width - M * 2;
  const para = (text: string, opts: PDFKit.Mixins.TextOptions = {}) => {
    doc.font('Times-Roman').fontSize(11).fillColor(INK).text(text, M, doc.y, { width: W, align: 'justify', lineGap: 1.5, ...opts });
    doc.moveDown(0.45);
  };

  // ── Kop surat ──
  // Logo (bila diunggah) di kiri; teks kop tetap di tengah halaman
  const logoW = drawLogo(doc, M, 36, 56);
  const tx = logoW ? M + logoW + 8 : M;
  const tw = logoW ? W - (logoW + 8) * 2 : W;
  doc.font('Times-Bold').fontSize(20).fillColor(INK).text(s.companyName.toUpperCase(), tx, 40, { width: tw, align: 'center', characterSpacing: 1 });
  doc.font('Times-Roman').fontSize(10).fillColor(MUTED);
  if (s.companyAddress) doc.text(s.companyAddress, tx, doc.y, { width: tw, align: 'center' });
  if (s.companyContact) doc.text(s.companyContact, tx, doc.y, { width: tw, align: 'center' });
  doc.text(`Penugasan: ${areaText(s)}${s.cityRegion ? `, ${s.cityRegion}` : ''}`, tx, doc.y, { width: tw, align: 'center' });
  let y = Math.max(doc.y, logoW ? 36 + logoW : 0) + 8;
  doc.moveTo(M, y).lineTo(M + W, y).lineWidth(2).strokeColor(INK).stroke();
  doc.moveTo(M, y + 3).lineTo(M + W, y + 3).lineWidth(0.6).strokeColor(INK).stroke();

  // ── Judul & nomor ──
  doc.font('Times-Bold').fontSize(14).fillColor(INK).text(LETTER_TITLE[L.type].toUpperCase(), M, y + 18, { width: W, align: 'center', underline: true });
  doc.font('Times-Roman').fontSize(11).text(`Nomor: ${L.number}`, { width: W, align: 'center' });
  if (L.voided) {
    doc.save().rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
    doc.font('Times-Bold').fontSize(90).fillColor('#dc2626').opacity(0.12).text('DIBATALKAN', 0, doc.page.height / 2 - 50, { width: doc.page.width, align: 'center' });
    doc.restore().opacity(1);
  }
  doc.moveDown(0.8);

  // ── Penerima ──
  doc.font('Times-Roman').fontSize(11.5).fillColor(INK).text('Kepada Yth.', M, doc.y);
  y = doc.y + 2;
  const fields: [string, string][] = [
    ['Nama', L.employee.fullName],
    ['NIK', L.employee.nik],
    ['Jabatan', L.employee.position],
  ];
  for (const [k, v] of fields) {
    doc.font('Times-Roman').fontSize(11).text(k, M + 16, y, { width: 90 });
    doc.text(':', M + 106, y);
    doc.font('Times-Bold').text(v, M + 116, y, { width: W - 116 });
    y += 15;
  }
  doc.font('Times-Roman').text('di Tempat', M, y + 1);
  doc.y = y + 22;

  para('Dengan hormat,', { align: 'left' });

  const n = L.alfaDates.length;
  const first = L.alfaDates[0];
  const last = L.alfaDates[n - 1];
  const prevText = L.previous ? `Nomor ${L.previous.number} tanggal ${fmtLongDate(L.previous.letterDate)}` : null;

  // ── Isi menurut jenis surat ──
  if (L.type === 'PERINGATAN_1' || L.type === 'PERINGATAN_2') {
    para(
      `Berdasarkan catatan absensi online SMC-FaceAttend, Saudara tercatat tidak masuk bekerja tanpa keterangan yang sah (mangkir) sebanyak ${countText(n)} hari kerja sesuai jadwal tugas, dengan rincian sebagai berikut:`,
    );
    dateTable(doc, M, W, L.alfaDates);
    para(
      L.type === 'PERINGATAN_1'
        ? 'Ketidakhadiran tersebut melanggar kewajiban hadir sesuai roster dan kewajiban mengajukan izin melalui aplikasi sebagaimana diatur dalam Perjanjian Kerja Waktu Tertentu (PKWT) Pasal 4 dan Pasal 8 serta Standar Operasional Prosedur (SOP) Parkiran BAB IV dan BAB V. Sesuai PKWT Pasal 8, Perusahaan dengan ini memberikan PERINGATAN PERTAMA kepada Saudara.'
        : `Ketidakhadiran tersebut melanggar kewajiban hadir sesuai roster dan kewajiban mengajukan izin melalui aplikasi sebagaimana diatur dalam Perjanjian Kerja Waktu Tertentu (PKWT) Pasal 4 dan Pasal 8 serta Standar Operasional Prosedur (SOP) Parkiran BAB IV dan BAB V${prevText ? `, dan terjadi setelah Saudara menerima Surat Peringatan Pertama ${prevText}` : ''}. Sesuai PKWT Pasal 8, Perusahaan dengan ini memberikan PERINGATAN KEDUA secara tertulis kepada Saudara.`,
    );
    para('Sehubungan dengan peringatan ini, Saudara diminta untuk:', { align: 'left' });
    numbered(doc, M, W, [
      'Hadir dan melakukan absensi online sesuai roster serta jendela absen yang berlaku.',
      'Mengajukan izin, sakit, atau cuti melalui aplikasi sebelum tidak masuk bekerja, disertai bukti pendukung yang sah.',
      'Memahami bahwa sesuai prinsip no work no pay (PKWT Pasal 8), upah untuk hari mangkir tidak dibayarkan dan dihitung proporsional: Upah Pokok ÷ 25 × jumlah hari mangkir.',
      L.type === 'PERINGATAN_1'
        ? 'Memperhatikan bahwa apabila mangkir terulang, Perusahaan akan memberikan Surat Peringatan Kedua secara tertulis sesuai PKWT Pasal 8.'
        : 'Memperhatikan bahwa mangkir 5 (lima) hari kerja berturut-turut atau lebih akan ditindaklanjuti dengan pemanggilan secara tertulis, dan apabila tidak dapat memberikan alasan yang sah, Saudara dikualifikasikan mengundurkan diri sesuai PKWT Pasal 8.',
    ]);
  } else {
    para(
      `Berdasarkan catatan absensi online SMC-FaceAttend, Saudara tercatat tidak masuk bekerja tanpa keterangan yang sah selama ${countText(n)} hari kerja berturut-turut, terhitung sejak ${dayDate(first)} sampai dengan ${dayDate(last)}${
        L.type === 'PANGGILAN_2' && prevText ? `, dan belum memenuhi Surat Panggilan Pertama ${prevText}` : ''
      }.`,
    );
    para(`Sehubungan dengan hal tersebut, sesuai PKWT Pasal 8, Saudara ${L.type === 'PANGGILAN_2' ? 'dipanggil untuk kedua kalinya' : 'dipanggil'} untuk menghadap pada:`, { align: 'left' });
    callBox(doc, M, W, [
      ['Hari, tanggal', L.reportDate ? dayDate(L.reportDate) : '................................'],
      ['Pukul', L.reportTime ? `${L.reportTime.replace(':', '.')} WIT` : '................ WIT'],
      ['Tempat', L.reportPlace ?? s.defaultReportPlace],
      ['Menemui', [s.hrdTitle, s.coordinatorTitle].join(' / ')],
    ]);
    para('Saudara diminta membawa bukti pendukung atas ketidakhadiran tersebut, misalnya surat keterangan dokter atau dokumen lain yang sah.');
    para(
      L.type === 'PANGGILAN_1'
        ? 'Apabila Saudara tidak memenuhi panggilan ini tanpa alasan yang sah, Perusahaan akan menyampaikan Surat Panggilan Kedua.'
        : 'Apabila Saudara kembali tidak memenuhi panggilan ini dan tidak dapat memberikan alasan yang sah, maka sesuai PKWT Pasal 8 dan peraturan perundang-undangan ketenagakerjaan yang berlaku, Saudara dikualifikasikan mengundurkan diri dan hubungan kerja dapat diakhiri.',
    );
  }
  if (L.note) para(`Catatan: ${L.note}`);
  para(
    L.type.startsWith('PERINGATAN')
      ? 'Saudara berhak menyampaikan penjelasan atau keberatan secara tertulis kepada Perusahaan paling lambat 3 (tiga) hari kerja setelah surat ini diterima. Demikian surat peringatan ini disampaikan untuk diperhatikan dan dilaksanakan dengan sebaik-baiknya.'
      : 'Demikian surat panggilan ini disampaikan. Atas perhatian dan kehadiran Saudara, kami ucapkan terima kasih.',
  );

  signatures(doc, M, W, L, s);

  doc.end();
}

function dateTable(doc: PDFKit.PDFDocument, M: number, W: number, dates: string[]) {
  const cols = dates.length > 4 ? 2 : 1;
  const colW = (W - 32) / cols;
  const rows = Math.ceil(dates.length / cols);
  let y = doc.y + 1;
  const x0 = M + 16;
  doc.rect(x0, y, W - 32, 17).fill('#f3f4f6');
  for (let c = 0; c < cols; c++) {
    doc.font('Times-Bold').fontSize(10.5).fillColor(INK).text('No.', x0 + c * colW + 8, y + 4, { width: 30 });
    doc.text('Hari, tanggal mangkir', x0 + c * colW + 40, y + 4, { width: colW - 48 });
  }
  y += 17;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = c * rows + r;
      if (i >= dates.length) continue;
      doc.font('Times-Roman').fontSize(10.5).fillColor(INK).text(`${i + 1}.`, x0 + c * colW + 8, y + 3, { width: 30 });
      doc.text(dayDate(dates[i]), x0 + c * colW + 40, y + 3, { width: colW - 48 });
    }
    doc.moveTo(x0, y + 16).lineTo(x0 + W - 32, y + 16).lineWidth(0.4).strokeColor(RULE).stroke();
    y += 16;
  }
  doc.y = y + 8;
}

function numbered(doc: PDFKit.PDFDocument, M: number, W: number, items: string[]) {
  items.forEach((t, i) => {
    const y = doc.y;
    doc.font('Times-Roman').fontSize(11).fillColor(INK).text(`${i + 1}.`, M + 16, y, { width: 18 });
    doc.text(t, M + 36, y, { width: W - 36, align: 'justify', lineGap: 1.5 });
    doc.moveDown(0.15);
  });
  doc.moveDown(0.35);
}

function callBox(doc: PDFKit.PDFDocument, M: number, W: number, rows: [string, string][]) {
  const x0 = M + 16;
  const y0 = doc.y + 2;
  const h = rows.length * 16 + 10;
  doc.roundedRect(x0, y0, W - 32, h, 4).lineWidth(0.8).strokeColor(INK).stroke();
  rows.forEach(([k, v], i) => {
    const y = y0 + 7 + i * 16;
    doc.font('Times-Roman').fontSize(11).fillColor(INK).text(k, x0 + 14, y, { width: 90 });
    doc.text(':', x0 + 104, y);
    doc.font('Times-Bold').text(v, x0 + 114, y, { width: W - 32 - 128 });
  });
  doc.y = y0 + h + 9;
}

/**
 * Satu blok tanda tangan di tengah (format surat SMC): tanggal di kanan, lalu
 * "Mengetahui, <pemilik tempat>" (atau "Hormat kami, <perusahaan>"), cap/stempel bila diunggah,
 * nama penandatangan, dan jabatannya.
 */
function signatures(doc: PDFKit.PDFDocument, M: number, W: number, L: LetterData, s: DisciplineSettings) {
  if (doc.y > doc.page.height - 40 - 150) doc.addPage();
  const y0 = doc.y + 2;
  doc.font('Times-Roman').fontSize(11).fillColor(INK).text(signDate(s, fmtLongDate(L.letterDate, true)), M, y0, { width: W - 24, align: 'right' });
  const bw = 220;
  const bx = M + (W - bw) / 2;
  const yHead = y0 + 34;
  const head = s.showManagementSign && s.managementTitle ? ['Mengetahui,', s.managementTitle] : ['Hormat kami,', s.companyName];
  doc.font('Times-Roman').fontSize(11).text(head[0], bx, yHead, { width: bw, align: 'center' });
  doc.font('Times-Bold').fontSize(11).text(head[1], bx, doc.y + 1, { width: bw, align: 'center' });
  const yName = Math.max(doc.y + 52, yHead + 82);
  // Cap/stempel di kiri tanda tangan, sedikit menimpa area tanda tangan seperti cap basah
  drawImage(doc, 'stamp', bx - 66, yName - 52, 150, 58);
  const name = s.hrdName || s.managementName;
  doc.font('Times-Bold').fontSize(11).fillColor(INK).text(name || '(.................................)', bx, yName, { width: bw, align: 'center', underline: !!name });
  if (s.hrdTitle) doc.font('Times-Roman').fontSize(10.5).text(s.hrdTitle, bx, doc.y + 1, { width: bw, align: 'center' });
  doc.y = doc.y + 6;
}
