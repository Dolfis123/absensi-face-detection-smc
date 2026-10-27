import type { Response } from 'express';

const escape = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Mengirim CSV (pemisah `;` + BOM agar langsung rapi dibuka di Excel versi Indonesia). */
export function sendCsv(res: Response, filename: string, header: string[], rows: unknown[][]) {
  const body = [header, ...rows].map((r) => r.map(escape).join(';')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(`﻿${body}`);
}
