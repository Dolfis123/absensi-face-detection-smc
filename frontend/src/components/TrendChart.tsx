import { useState } from 'react';
import { fmtDate, shortDay } from '../lib/format';

export interface TrendPoint {
  date: string;
  tepat: number;
  terlambat: number;
  sekali: number; // hadir, absen tidak lengkap
  izin: number; // izin + sakit + cuti
  alfa: number;
}

// Urutan tetap (tumpukan dari bawah). Warna lolos validasi CVD; teks tetap memakai warna teks.
const SERIES = [
  { key: 'tepat', label: 'Tepat waktu', color: '#10b981' },
  { key: 'terlambat', label: 'Terlambat', color: '#f59e0b' },
  { key: 'sekali', label: 'Absen sekali', color: '#8b5cf6' },
  { key: 'izin', label: 'Izin/Sakit/Cuti', color: '#0ea5e9' },
  { key: 'alfa', label: 'Alfa', color: '#f43f5e' },
] as const;

const W = 640;
const H = 240;
const PAD = { left: 32, right: 8, top: 12, bottom: 30 };

/** Grafik batang bertumpuk kehadiran harian, dengan tooltip saat disentuh/hover. */
export function TrendChart({ data }: { data: TrendPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const totals = data.map((d) => d.tepat + d.terlambat + d.sekali + d.izin + d.alfa);
  const rawMax = Math.max(4, ...totals);
  const step = Math.ceil(rawMax / 4);
  const max = step * 4;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const band = plotW / Math.max(1, data.length);
  const barW = Math.min(44, band * 0.55);
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;

  const sums = SERIES.map((s) => data.reduce((acc, d) => acc + d[s.key], 0));
  const hovered = hover === null ? null : data[hover];

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1.5">
        {SERIES.map((s, i) => (
          <div key={s.key} className="flex items-center gap-1.5 text-xs text-slate-600">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
            {s.label}
            <span className="font-semibold text-slate-900">{sums[i]}</span>
          </div>
        ))}
      </div>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Grafik kehadiran 7 hari terakhir">
          {[0, 1, 2, 3, 4].map((i) => (
            <g key={i}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(i * step)} y2={y(i * step)} stroke="#e2e8f0" strokeDasharray={i ? '3 4' : undefined} />
              <text x={PAD.left - 8} y={y(i * step) + 4} textAnchor="end" fontSize="11" fill="#94a3b8">
                {i * step}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const cx = PAD.left + band * i + band / 2;
            let acc = 0;
            const sd = shortDay(d.date);
            return (
              <g key={d.date}>
                {hover === i && <rect x={cx - band / 2 + 4} y={PAD.top} width={band - 8} height={plotH} rx="6" fill="#f1f5f9" />}
                {SERIES.map((s) => {
                  const v = d[s.key];
                  if (!v) return null;
                  const y0 = y(acc);
                  acc += v;
                  const y1 = y(acc);
                  // 2px celah antar-segmen agar batas warna tetap terbaca
                  return <rect key={s.key} x={cx - barW / 2} y={y1 + 1} width={barW} height={Math.max(1, y0 - y1 - 2)} rx="3" fill={s.color} />;
                })}
                <text x={cx} y={H - 10} textAnchor="middle" fontSize="11" fill={hover === i ? '#0f172a' : '#64748b'} fontWeight={hover === i ? 600 : 400}>
                  {sd.day} {sd.num}
                </text>
                <rect
                  x={cx - band / 2}
                  y={0}
                  width={band}
                  height={H}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => setHover(i)}
                />
              </g>
            );
          })}
        </svg>
        {hovered && hover !== null && (
          <div
            className="pointer-events-none absolute top-2 z-10 w-44 -translate-x-1/2 rounded-lg bg-slate-900 px-3 py-2 text-xs text-white shadow-pop"
            style={{ left: `${Math.min(85, Math.max(15, ((PAD.left + band * hover + band / 2) / W) * 100))}%` }}
          >
            <div className="mb-1 font-semibold">{fmtDate(hovered.date)}</div>
            {[...SERIES].reverse().map((s) => (
              <div key={s.key} className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} />
                  {s.label}
                </span>
                <span className="font-semibold tabular-nums">{hovered[s.key]}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
