// Waktu Indonesia Timur (Asia/Jayapura) = UTC+9, tanpa daylight saving.
const WIT_OFFSET_MS = 9 * 60 * 60 * 1000;

export interface WitNow {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM:SS
  minutes: number; // menit sejak 00:00 WIT
  instant: Date; // waktu server sebenarnya (UTC)
}

/** Waktu server dalam WIT. Satu-satunya sumber waktu absensi (bukan jam HP). */
export function witNow(at: Date = new Date()): WitNow {
  const shifted = new Date(at.getTime() + WIT_OFFSET_MS);
  const iso = shifted.toISOString();
  return {
    date: iso.slice(0, 10),
    time: iso.slice(11, 19),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    instant: at,
  };
}

export const hhmmToMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

export const minutesToHhmm = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const MONTH_RE = /^\d{4}-\d{2}$/;
