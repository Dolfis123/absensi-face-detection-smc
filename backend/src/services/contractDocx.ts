/**
 * Kontrak PKWT dalam format Word (.docx) — ditulis langsung sebagai WordprocessingML tanpa pustaka tambahan.
 * Format mengikuti PKWT yang dipakai perusahaan: A4, Arial 11, label bertitik dua sejajar.
 * Beberapa kontrak bisa digabung dalam satu berkas (tiap orang mulai di halaman baru, kaki halaman masing-masing).
 */
import zlib from 'zlib';
import type { Block, ContractDoc } from './contract';

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const TAB = 3200; // posisi titik dua (twip)
const VAL = 3400; // awal isian; baris lanjutan (mis. alamat panjang) sejajar di sini

function run(text: string, o: { b?: boolean; u?: boolean; sz?: number; i?: boolean } = {}) {
  const rpr = `${o.b ? '<w:b/><w:bCs/>' : ''}${o.i ? '<w:i/>' : ''}${o.u ? '<w:u w:val="single"/>' : ''}${o.sz ? `<w:sz w:val="${o.sz}"/><w:szCs w:val="${o.sz}"/>` : ''}`;
  const parts = text.split('\t').map((p) => `<w:t xml:space="preserve">${esc(p)}</w:t>`);
  return `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}${parts.join('<w:tab/>')}</w:r>`;
}
function p(runs: string, o: { jc?: string; after?: number; before?: number; ind?: number; hanging?: number; tabs?: number[]; keep?: boolean } = {}) {
  const tabs = o.tabs?.length ? `<w:tabs>${o.tabs.map((t) => `<w:tab w:val="left" w:pos="${t}"/>`).join('')}</w:tabs>` : '';
  const ind = o.ind !== undefined ? `<w:ind w:left="${o.ind}"${o.hanging ? ` w:hanging="${o.hanging}"` : ''}/>` : '';
  return `<w:p><w:pPr>${o.keep ? '<w:keepNext/>' : ''}${tabs}<w:spacing w:before="${o.before ?? 0}" w:after="${o.after ?? 80}"/>${ind}${o.jc ? `<w:jc w:val="${o.jc}"/>` : ''}</w:pPr>${runs}</w:p>`;
}

function block(b: Block): string {
  switch (b.t) {
    case 'title':
      return p(run(b.text, { b: true, u: true, sz: 26 }), { jc: 'center', after: 40 });
    case 'subtitle':
      return p(run(b.text), { jc: 'center', after: 200 });
    case 'field':
      return p(run(`${b.label}\t:\t`) + run(b.value, { b: b.bold }), { tabs: [TAB, VAL], after: 50, ind: VAL, hanging: VAL - (b.indent ? 360 : 0) });
    case 'para':
      return p(run(b.text), { jc: 'both', after: 80 });
    case 'gap':
      return p('', { after: 80 });
    case 'heading':
      return p(run(b.text, { b: true }), { before: 160, after: 80, keep: true });
    case 'note':
      return p(run(b.text, { i: true, sz: 18 }), { jc: 'both', after: 60 });
    case 'list':
      return b.items
        .map((it, i) => {
          const text = typeof it === 'string' ? it : it.text;
          const main = p(run(`${i + 1}.\t${text}`), { jc: 'both', ind: 360, hanging: 360, tabs: [360], after: 60 });
          const subs = typeof it === 'string' ? '' : it.sub.map((s) => p(run(`–\t${s}`), { jc: 'both', ind: 1080, hanging: 300, tabs: [1080], after: 40 })).join('');
          return main + subs;
        })
        .join('');
    case 'sign': {
      const cell = (c: [string, string, string]) =>
        `<w:tc><w:tcPr><w:tcW w:w="4513" w:type="dxa"/></w:tcPr>${p(run(c[0], { b: true }), { jc: 'center', after: 0 })}${p(run(c[1], { b: true }), { jc: 'center', after: 0 })}${'<w:p/>'.repeat(4)}${p(run(c[2], { b: true, u: true }), { jc: 'center', after: 0 })}</w:tc>`;
      return `<w:tbl><w:tblPr><w:tblW w:w="9026" w:type="dxa"/><w:jc w:val="center"/><w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid><w:gridCol w:w="4513"/><w:gridCol w:w="4513"/></w:tblGrid><w:tr><w:trPr><w:cantSplit/></w:trPr>${cell(b.left)}${cell(b.right)}</w:tr></w:tbl>`;
    }
  }
}

const sectPr = (footerRid: string) =>
  `<w:sectPr><w:footerReference w:type="default" r:id="${footerRid}"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1200" w:right="1440" w:bottom="1200" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/><w:pgNumType w:start="1"/><w:cols w:space="720"/></w:sectPr>`;

const footerXml = (text: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="right"/></w:pPr>${run(`${text} | Halaman `, { sz: 16 })}<w:r><w:rPr><w:sz w:val="16"/></w:rPr><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:rPr><w:sz w:val="16"/></w:rPr><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:rPr><w:sz w:val="16"/></w:rPr><w:fldChar w:fldCharType="separate"/></w:r>${run('1', { sz: 16 })}<w:r><w:rPr><w:sz w:val="16"/></w:rPr><w:fldChar w:fldCharType="end"/></w:r>${run('     Paraf: ........', { sz: 16 })}</w:p></w:ftr>`;

/** Satu berkas .docx berisi satu atau beberapa kontrak. */
export function contractsDocx(docs: ContractDoc[]): Buffer {
  const body = docs
    .map((d, i) => {
      const content = d.blocks.map(block).join('');
      const last = i === docs.length - 1;
      // sectPr di paragraf terakhir tiap kontrak = pemisah bagian (halaman baru, nomor halaman mulai dari 1)
      return last ? content + sectPr(`rIdF${i}`) : `${content}<w:p><w:pPr>${sectPr(`rIdF${i}`)}</w:pPr></w:p>`;
    })
    .join('');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}</w:body></w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:eastAsia="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="id-ID"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${docs
    .map((_, i) => `<Relationship Id="rIdF${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer${i + 1}.xml"/>`)
    .join('')}</Relationships>`;
  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>${docs
    .map((_, i) => `<Override PartName="/word/footer${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>`)
    .join('')}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(docs.length === 1 ? docs[0].fileTitle : 'Kontrak PKWT')}</dc:title></cp:coreProperties>`;
  return zip([
    ['[Content_Types].xml', types],
    ['_rels/.rels', rootRels],
    ['docProps/core.xml', core],
    ['word/document.xml', document],
    ['word/styles.xml', styles],
    ['word/_rels/document.xml.rels', rels],
    ...docs.map((d, i): [string, string] => [`word/footer${i + 1}.xml`, footerXml(d.footer)]),
  ]);
}

// ───────────── ZIP sederhana (deflate) ─────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files: [string, string][]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.from(content, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // nama UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(0x00210000, 10); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0x00210000, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
