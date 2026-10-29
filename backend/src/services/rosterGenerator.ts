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
  /** Jumlah Off per hari (indeks 0 = Minggu … 6 = Sabtu) */
  offByWeekday: number[];
  /** Paling sering Off bersamaan dengan orang yang sama */
  maxSameMate: number;
}

export interface GenResult {
  dates: string[];
  cells: Map<number, Map<string, GenCell>>; // userId → tanggal → isi
  stats: GenStats[];
  daily: { date: string; shift1: number; shift2: number; fixed: number; off: number }[];
  warnings: string[];
  /** Pelanggaran aturan karyawan. Harus kosong; roster yang melanggar tidak dipakai. */
  violations: string[];
}

const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
const isWeekend = (d: number) => d === 0 || d === 6;
const DAY_NAME = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

export function generateRoster(employees: GenEmployee[], opt: GenOptions): GenResult {
  const dates = Array.from({ length: opt.weeks * 7 }, (_, i) => addDays(opt.start, i));
  const warnings: string[] = [];
  const cells = new Map<number, Map<string, GenCell>>(employees.map((e) => [e.id, new Map()]));
  const stats = new Map<number, GenStats>(
    employees.map((e) => [e.id, { userId: e.id, name: e.name, shift1: 0, shift2: 0, fixed: 0, off: 0, weekendOff: 0, shortRest: 0, offByWeekday: [], maxSameMate: 0 }]),
  );
  const seed = opt.seed ?? 0;
  // Riwayat Off: berapa kali tiap orang Off di tiap hari, dan berapa kali dua orang Off bersamaan
  const offByWeekday = new Map<number, number[]>(employees.map((e) => [e.id, [0, 0, 0, 0, 0, 0, 0]]));
  const together = new Map<string, number>();
  const pairKey = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const jitter = (id: number, w: number) => ((id * 7919 + w * 104729 + seed * 15485863) % 997) / 997;

  // ── 1) Hari Off per minggu: hari Off tiap orang bergeser, dan pasangan Off-nya berganti-ganti ──
  for (let w = 0; w < opt.weeks; w++) {
    const weekDates = dates.slice(w * 7, w * 7 + 7).filter((d) => !opt.holidays.has(d));
    const offOn = new Map<string, number[]>(weekDates.map((d) => [d, []]));
    // Yang pilihan hari Off-nya paling sedikit dipilihkan lebih dulu; sisanya diacak tiap minggu
    const order = [...employees].sort((a, b) => a.offDays.length - b.offDays.length || jitter(a.id, w) - jitter(b.id, w));
    for (const e of order) {
      for (let k = 0; k < opt.offPerWeek; k++) {
        const options = weekDates.filter((d) => e.offDays.includes(weekday(d)) && cells.get(e.id)!.get(d) !== 'OFF');
        if (options.length === 0) {
          warnings.push(`${e.name}: tidak ada hari yang boleh Off pada minggu ke-${w + 1}`);
          break;
        }
        const s = stats.get(e.id)!;
        const hist = offByWeekday.get(e.id)!;
        const score = (d: string) => {
          const wd = weekday(d);
          const mates = offOn.get(d)!;
          return (
            mates.length * 20 + // jumlah orang Off per hari tetap rata
            hist[wd] * 25 + // hari Off berpindah-pindah, tidak di hari yang sama terus
            mates.reduce((sum, m) => sum + (together.get(pairKey(e.id, m)) ?? 0), 0) * 6 + // ganti pasangan Off
            (isWeekend(wd) ? s.weekendOff * 16 : 0) + // Off Sabtu/Minggu bergiliran
            jitter(e.id * 31 + wd, w)
          );
        };
        const best = options.reduce((x, y) => (score(y) < score(x) ? y : x));
        const wd = weekday(best);
        for (const m of offOn.get(best)!) together.set(pairKey(e.id, m), (together.get(pairKey(e.id, m)) ?? 0) + 1);
        offOn.get(best)!.push(e.id);
        cells.get(e.id)!.set(best, 'OFF');
        hist[wd]++;
        s.off++;
        if (isWeekend(wd)) s.weekendOff++;
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
      return (p === opt.shift2Id ? 100 : 0) - (p === opt.shift1Id ? 2 : 0) - (forcedS1Tomorrow ? 60 : 0) + 8 * surplus + (((e.id * 7919 + seed * 104729) % 1000) / 1e5);
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

  // ── 3) Penyeimbangan akhir: tukar Shift 1 ⇄ Shift 2 antar dua orang di hari yang sama ──
  balanceShifts(employees, dates, cells, stats, opt);

  for (const e of employees) {
    const s = stats.get(e.id)!;
    s.offByWeekday = offByWeekday.get(e.id)!;
    s.maxSameMate = Math.max(0, ...employees.filter((m) => m.id !== e.id).map((m) => together.get(pairKey(e.id, m.id)) ?? 0));
  }
  const result: GenResult = { dates, cells, stats: [...stats.values()], daily, warnings: [...new Set(warnings)], violations: [] };
  result.violations = checkRules(result, employees, opt);
  return result;
}

/**
 * Menukar Shift 1 milik orang yang kelebihan dengan Shift 2 milik orang yang kekurangan pada hari yang sama,
 * selama tidak melanggar aturan dan tidak menimbulkan "pulang 23:00 lalu masuk 08:00". Jumlah orang per shift
 * setiap hari tidak berubah. Hanya antar-karyawan yang sebanding (digilir, batasan maks. 1 hari per minggu).
 */
function balanceShifts(employees: GenEmployee[], dates: string[], cells: GenResult['cells'], stats: Map<number, GenStats>, opt: GenOptions) {
  const group = employees.filter((e) => e.fixedShiftId === null && e.noShift1Days.length + e.noShift2Days.length <= 1);
  const at = (e: GenEmployee, i: number) => (i < 0 || i >= dates.length ? undefined : cells.get(e.id)!.get(dates[i]));
  const canS1 = (e: GenEmployee, i: number) => !e.noShift1Days.includes(weekday(dates[i])) && at(e, i - 1) !== opt.shift2Id;
  const canS2 = (e: GenEmployee, i: number) => !e.noShift2Days.includes(weekday(dates[i])) && at(e, i + 1) !== opt.shift1Id;
  for (let guard = 0; guard < 500; guard++) {
    const sorted = [...group].sort((a, b) => stats.get(b.id)!.shift1 - stats.get(a.id)!.shift1);
    let swapped = false;
    outer: for (const hi of sorted) {
      for (const lo of [...sorted].reverse()) {
        if (stats.get(hi.id)!.shift1 - stats.get(lo.id)!.shift1 < 2) break;
        for (let i = 0; i < dates.length; i++) {
          if (at(hi, i) === opt.shift1Id && at(lo, i) === opt.shift2Id && canS1(lo, i) && canS2(hi, i)) {
            cells.get(hi.id)!.set(dates[i], opt.shift2Id);
            cells.get(lo.id)!.set(dates[i], opt.shift1Id);
            stats.get(hi.id)!.shift1--;
            stats.get(hi.id)!.shift2++;
            stats.get(lo.id)!.shift1++;
            stats.get(lo.id)!.shift2--;
            swapped = true;
            break outer;
          }
        }
      }
    }
    if (!swapped) break;
  }
  // Hitung ulang "pulang malam lalu masuk pagi" setelah penukaran
  for (const e of employees) {
    const s = stats.get(e.id)!;
    s.shortRest = 0;
    for (let i = 1; i < dates.length; i++) if (at(e, i - 1) === opt.shift2Id && at(e, i) === opt.shift1Id) s.shortRest++;
  }
}

/** Cek ulang setiap sel terhadap aturan karyawan (pengaman terakhir sebelum roster ditampilkan/disimpan). */
export function checkRules(r: GenResult, employees: GenEmployee[], opt: Pick<GenOptions, 'shift1Id' | 'shift2Id' | 'holidays'>): string[] {
  const out: string[] = [];
  for (const e of employees) {
    const row = r.cells.get(e.id)!;
    for (const date of r.dates) {
      if (opt.holidays.has(date)) continue;
      const c = row.get(date);
      const wd = weekday(date);
      const where = `${e.name}, ${DAY_NAME[wd]} ${date}`;
      if (c === undefined) out.push(`${where}: belum dijadwalkan`);
      else if (c === 'OFF') {
        if (!e.offDays.includes(wd)) out.push(`${where}: Off padahal hanya boleh Off hari ${e.offDays.map((d) => DAY_NAME[d]).join('/')}`);
      } else if (e.fixedShiftId !== null) {
        if (c !== e.fixedShiftId) out.push(`${where}: seharusnya selalu shift tetapnya`);
      } else if (c === opt.shift1Id && e.noShift1Days.includes(wd)) out.push(`${where}: tidak boleh Shift 1`);
      else if (c === opt.shift2Id && e.noShift2Days.includes(wd)) out.push(`${where}: tidak boleh Shift 2`);
    }
  }
  return out;
}

/** Biaya ketidakrataan: selisih jatah Shift 1, Off akhir pekan, dan jumlah Shift 2 → Shift 1. */
function unfairness(r: GenResult, employees: GenEmployee[]): number {
  const flexible = r.stats.filter((s) => {
    const e = employees.find((x) => x.id === s.userId)!;
    // Yang hanya dibatasi 1 hari per minggu tetap harus setara dengan yang lain
    return e.fixedShiftId === null && e.noShift1Days.length + e.noShift2Days.length <= 1;
  });
  const spread = (xs: number[]) => (xs.length ? Math.max(...xs) - Math.min(...xs) : 0);
  const pool = flexible.length ? flexible : r.stats;
  const rotating = r.stats.filter((s) => employees.find((x) => x.id === s.userId)!.offDays.length > 1);
  return (
    spread(pool.map((s) => s.shift1)) * 10 +
    spread(rotating.map((s) => s.weekendOff)) * 10 +
    r.stats.reduce((a, s) => a + s.shortRest, 0) * 3 +
    r.warnings.length * 50 +
    r.violations.length * 10_000 +
    rotating.reduce((a, s) => a + Math.max(...s.offByWeekday) - 1, 0) * 4 +
    rotating.reduce((a, s) => a + Math.max(0, s.maxSameMate - 1), 0) * 3
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
