/**
 * Kontrak PKWT dalam format PDF (A4) — isi sama persis dengan versi Word (lihat contract.ts).
 */
import PDFDocument from 'pdfkit';
import type { Block, ContractDoc } from './contract';

const INK = '#111827';
const M = { top: 60, bottom: 64, left: 72, right: 72 };
const FS = 10.5;
const LABEL_W = 152; // jarak titik dua dari tepi kiri (setara 3200 twip)

export function contractsPdf(docs: ContractDoc[]): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margins: M, bufferPages: true, info: { Title: docs.length === 1 ? docs[0].fileTitle : 'Kontrak PKWT' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const W = doc.page.width - M.left - M.right;
  const footers: { from: number; to: number; text: string }[] = [];

  const ensure = (h: number) => {
    if (doc.y + h > doc.page.height - M.bottom) doc.addPage();
  };
  const text = (t: string, x: number, w: number, o: PDFKit.Mixins.TextOptions & { font?: string; size?: number } = {}) => {
    doc.font(o.font ?? 'Helvetica').fontSize(o.size ?? FS).fillColor(INK).text(t, x, doc.y, { width: w, lineGap: 1.2, ...o });
  };

  function draw(b: Block) {
    switch (b.t) {
      case 'title':
        text(b.text, M.left, W, { font: 'Helvetica-Bold', size: 12, align: 'center', underline: true });
        doc.moveDown(0.15);
        return;
      case 'subtitle':
        text(b.text, M.left, W, { align: 'center' });
        doc.moveDown(0.9);
        return;
      case 'field': {
        ensure(14);
        const x = M.left + (b.indent ? 18 : 0);
        const y = doc.y;
        text(b.label, x, LABEL_W - (x - M.left));
        const yLabel = doc.y;
        doc.y = y;
        text(':', M.left + LABEL_W, 8);
        doc.y = y;
        text(b.value, M.left + LABEL_W + 8, W - LABEL_W - 8, { font: b.bold ? 'Helvetica-Bold' : 'Helvetica' });
        doc.y = Math.max(doc.y, yLabel) + 2;
        return;
      }
      case 'para':
        ensure(14);
        text(b.text, M.left, W, { align: 'justify' });
        doc.moveDown(0.3);
        return;
      case 'gap':
        doc.moveDown(0.5);
        return;
      case 'heading':
        ensure(40); // judul pasal tidak boleh terpisah dari isinya
        doc.moveDown(0.4);
        text(b.text, M.left, W, { font: 'Helvetica-Bold' });
        doc.moveDown(0.25);
        return;
      case 'note':
        ensure(14);
        text(b.text, M.left, W, { font: 'Helvetica-Oblique', size: 9, align: 'justify' });
        doc.moveDown(0.3);
        return;
      case 'list':
        b.items.forEach((it, i) => {
          const t = typeof it === 'string' ? it : it.text;
          ensure(14);
          const y = doc.y;
          text(`${i + 1}.`, M.left, 18);
          doc.y = y;
          text(t, M.left + 18, W - 18, { align: 'justify' });
          doc.moveDown(0.2);
          if (typeof it !== 'string')
            for (const s of it.sub) {
              ensure(14);
              const ys = doc.y;
              text('–', M.left + 40, 14);
              doc.y = ys;
              text(s, M.left + 54, W - 54, { align: 'justify' });
              doc.moveDown(0.15);
            }
        });
        return;
      case 'sign': {
        ensure(110);
        doc.moveDown(0.4);
        const y = doc.y;
        const half = W / 2;
        const col = (c: [string, string, string], x: number) => {
          doc.y = y;
          text(c[0], x, half, { font: 'Helvetica-Bold', align: 'center' });
          text(c[1], x, half, { font: 'Helvetica-Bold', align: 'center' });
          doc.y = y + 82;
          text(c[2], x, half, { font: 'Helvetica-Bold', align: 'center', underline: true });
        };
        col(b.left, M.left);
        col(b.right, M.left + half);
        doc.moveDown(0.6);
        return;
      }
    }
  }

  docs.forEach((d, i) => {
    if (i > 0) doc.addPage();
    const from = doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1;
    doc.y = M.top;
    d.blocks.forEach(draw);
    footers.push({ from, to: doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1, text: d.footer });
  });

  // Kaki halaman: "PKWT Nama | Halaman n     Paraf: ........" (nomor halaman per kontrak)
  for (const f of footers) {
    for (let pg = f.from; pg <= f.to; pg++) {
      doc.switchToPage(pg);
      const bottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('Helvetica').fontSize(8).fillColor('#4b5563').text(`${f.text} | Halaman ${pg - f.from + 1}     Paraf: ........`, M.left, doc.page.height - 40, { width: W, align: 'right', lineBreak: false });
      doc.page.margins.bottom = bottom;
    }
  }
  doc.end();
  return done;
}
