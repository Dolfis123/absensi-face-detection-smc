/**
 * Pembuat Roster Otomatis: membagi Shift 1, Shift 2, dan hari Off secara rata
 * untuk periode beberapa minggu, sambil mematuhi aturan per karyawan.
 *
 * Fungsi murni (tanpa database) supaya bisa diuji; route memanggilnya lalu menampilkan
 * hasilnya sebagai pratinjau sebelum disimpan ke roster.
 */
import { addDays } from '../utils/time';

export interface GenEmployee {
  id: number;
  name: string;
  fixedShiftId: number | null;
  offDays: number[]; // hari (0=Minggu..6=Sabtu) yang boleh Off
  noShift1Days: number[];
  noShift2Days: number[];
}

export interface GenOptions {
  start: string; // YYYY-MM-DD
  weeks: number; // 4..7
  offPerWeek: number; // 1..2
  /** Shift 2 minimal lebih banyak sekian orang dari Shift 1 setiap hari */
  shift2Extra: number;
  shift1Id: number;
  shift2Id: number;
  holidays: Set<string>;
  /** Shift masing-masing karyawan pada hari sebelum periode (untuk aturan jeda istirahat) */
  prevDay: Map<number, number | 'OFF' | null>;
  /** Variasi urutan untuk pencarian hasil terbaik (0 = default) */
  seed?: number;
}

export type GenCell = number | 'OFF'; // id shift atau Off

export interface GenStats {
  userId: number;
  name: string;
  shift1: number;
  shift2: number;
  fixed: number;
  off: number;
  weekendOff: number;
  /** Shift 2 (pulang 23:00) lalu Shift 1 besok paginya */
  shortRest: number;
}

export interface GenResult {
  dates: string[];
  cells: Map<number, Map<string, GenCell>>; // userId → tanggal → isi
  stats: GenStats[];
  daily: { date: string; shift1: number; shift2: number; fixed: number; off: number }[];
  warnings: string[];
}

const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
const isWeekend = (d: number) => d === 0 || d === 6;
const DAY_NAME = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

export function generateRoster(employees: GenEmployee[], opt: GenOptions): GenResult {
  const dates = Array.from({ length: opt.weeks * 7 }, (_, i) => addDays(opt.start, i));
  const warnings: string[] = [];
  const cells = new Map<number, Map<string, GenCell>>(employees.map((e) => [e.id, new Map()]));
  const stats = new Map<number, GenStats>(
    employees.map((e) => [e.id, { userId: e.id, name: e.name, shift1: 0, shift2: 0, fixed: 0, off: 0, weekendOff: 0, shortRest: 0 }]),
  );
  const lastOffWeekday = new Map<number, number>();
  const seed = opt.seed ?? 0;

  // ── 1) Hari Off per minggu: diratakan antar-hari dan antar-karyawan ──
  for (let w = 0; w < opt.weeks; w++) {
    const weekDates = dates.slice(w * 7, w * 7 + 7).filter((d) => !opt.holidays.has(d));
    const offCount = new Map<string, number>(weekDates.map((d) => [d, 0]));
    // Karyawan dengan pilihan hari Off paling sedikit dipilihkan lebih dulu
    const order = [...employees].sort((a, b) => a.offDays.length - b.offDays.length || a.id - b.id);
    for (const [idx, e] of order.entries()) {
      for (let k = 0; k < opt.offPerWeek; k++) {
        const options = weekDates.filter((d) => e.offDays.includes(weekday(d)) && cells.get(e.id)!.get(d) !== 'OFF');
        if (options.length === 0) {
          warnings.push(`${e.name}: tidak ada hari yang boleh Off pada minggu ke-${w + 1}`);
          break;
        }
        const s = stats.get(e.id)!;
        // Geser hari Off tiap minggu supaya tidak selalu hari yang sama, dan bagi jatah Off akhir pekan
        const preferred = (idx * (1 + seed % 5) + w * 3 + seed) % 7;
        const score = (d: string) => {
          const wd = weekday(d);
          return (
            offCount.get(d)! * 10 +
            (isWeekend(wd) ? s.weekendOff * 4 : 0) +
            (lastOffWeekday.get(e.id) === wd ? 3 : 0) +
            ((wd - preferred + 7) % 7) / 10
          );
        };
        const best = options.reduce((a, b) => (score(b) < score(a) ? b : a));
        cells.get(e.id)!.set(best, 'OFF');
        offCount.set(best, offCount.get(best)! + 1);
        lastOffWeekday.set(e.id, weekday(best));
        s.off++;
        if (isWeekend(weekday(best))) s.weekendOff++;
      }
    }
  }

  // ── 2) Shift harian: Shift 2 lebih banyak, Shift 1/2 dibagi rata, hindari Shift 2 → Shift 1 ──
  const prev = new Map(opt.prevDay);
  const daily: GenResult['daily'] = [];
  for (const date of dates) {
    const wd = weekday(date);
    if (opt.holidays.has(date)) {
      for (const e of employees) prev.set(e.id, 'OFF');
      daily.push({ date, shift1: 0, shift2: 0, fixed: 0, off: 0 });
      continue;
    }
    const working = employees.filter((e) => cells.get(e.id)!.get(date) !== 'OFF');
    const fixed = working.filter((e) => e.fixedShiftId !== null);
    for (const e of fixed) {
      cells.get(e.id)!.set(date, e.fixedShiftId!);
      stats.get(e.id)!.fixed++;
    }
    const pool = working.filter((e) => e.fixedShiftId === null);
    const mustS1 = pool.filter((e) => e.noShift2Days.includes(wd) && !e.noShift1Days.includes(wd));
    const mustS2 = pool.filter((e) => e.noShift1Days.includes(wd) && !e.noShift2Days.includes(wd));
    const conflict = pool.filter((e) => e.noShift1Days.includes(wd) && e.noShift2Days.includes(wd));
    for (const e of conflict) warnings.push(`${e.name}: tidak boleh Shift 1 maupun Shift 2 pada hari ${DAY_NAME[wd]} — dijadwalkan Shift 2`);
    const free = pool.filter((e) => !mustS1.includes(e) && !mustS2.includes(e) && !conflict.includes(e));

    const targetS1 = Math.max(0, Math.floor((pool.length - opt.shift2Extra) / 2));
    const needS1 = Math.max(0, targetS1 - mustS1.length);
    const ratio = pool.length ? targetS1 / pool.length : 0.5;
    const tomorrow = addDays(date, 1);
    const twd = weekday(tomorrow);
    const s1Score = (e: GenEmployee) => {
      const s = stats.get(e.id)!;
      // Kelebihan Shift 1 dibanding jatah rata-ratanya: makin lebih, makin kecil peluang dapat Shift 1 lagi
      const surplus = s.shift1 - ratio * (s.shift1 + s.shift2);
      const p = prev.get(e.id);
      // Besok wajib Shift 1 (mis. ada kuliah malam) → hari ini Shift 1 juga supaya tidak pulang 23:00 lalu masuk 08:00
      const forcedS1Tomorrow =
        dates.includes(tomorrow) && cells.get(e.id)!.get(tomorrow) !== 'OFF' && e.noShift2Days.includes(twd) && !e.noShift1Days.includes(twd);
      return (p === opt.shift2Id ? 100 : 0) - (p === opt.shift1Id ? 2 : 0) - (forcedS1Tomorrow ? 60 : 0) + 4 * surplus + (((e.id * 7919 + seed * 104729) % 1000) / 1e5);
    };
    const chosenS1 = new Set([...free].sort((a, b) => s1Score(a) - s1Score(b)).slice(0, needS1).map((e) => e.id));

    let n1 = 0;
    let n2 = 0;
    for (const e of pool) {
      const s = stats.get(e.id)!;
      const toS1 = mustS1.includes(e) || chosenS1.has(e.id);
      const shift = toS1 ? opt.shift1Id : opt.shift2Id;
      if (toS1 && prev.get(e.id) === opt.shift2Id) s.shortRest++;
      cells.get(e.id)!.set(date, shift);
      if (toS1) {
        s.shift1++;
        n1++;
      } else {
        s.shift2++;
        n2++;
      }
    }
    for (const e of employees) prev.set(e.id, cells.get(e.id)!.get(date) ?? null);
    daily.push({ date, shift1: n1, shift2: n2, fixed: fixed.length, off: employees.length - working.length });
    if (pool.length > 0 && (n1 === 0 || n2 === 0)) {
      warnings.push(`${date} (${DAY_NAME[wd]}): Shift ${n1 === 0 ? 1 : 2} tidak ada orangnya`);
    }
  }

  return { dates, cells, stats: [...stats.values()], daily, warnings: [...new Set(warnings)] };
}

/** Biaya ketidakrataan: selisih jatah Shift 1, Off akhir pekan, dan jumlah Shift 2 → Shift 1. */
function unfairness(r: GenResult, employees: GenEmployee[]): number {
  const flexible = r.stats.filter((s) => {
    const e = employees.find((x) => x.id === s.userId)!;
    return e.fixedShiftId === null && e.noShift1Days.length === 0 && e.noShift2Days.length === 0;
  });
  const spread = (xs: number[]) => (xs.length ? Math.max(...xs) - Math.min(...xs) : 0);
  const pool = flexible.length ? flexible : r.stats;
  return (
    spread(pool.map((s) => s.shift1)) * 10 +
    spread(r.stats.filter((s) => s.off > 0).map((s) => s.weekendOff)) * 6 +
    r.stats.reduce((a, s) => a + s.shortRest, 0) * 3 +
    r.warnings.length * 50
  );
}

/** Coba beberapa variasi lalu ambil roster yang paling rata. */
export function generateBestRoster(employees: GenEmployee[], opt: Omit<GenOptions, 'seed'>, tries = 200): GenResult {
  let best: GenResult | null = null;
  let bestCost = Infinity;
  for (let seed = 0; seed < tries; seed++) {
    const r = generateRoster(employees, { ...opt, seed });
    const cost = unfairness(r, employees);
    if (cost < bestCost) {
      best = r;
      bestCost = cost;
    }
  }
  return best!;
}
