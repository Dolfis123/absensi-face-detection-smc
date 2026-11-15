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
  /** Hari yang tidak boleh Shift Siang (petugas perempuan: semua hari) */
  noSiangDays: number[];
}

export interface GenOptions {
  start: string; // YYYY-MM-DD
  weeks: number; // 4..7
  offPerWeek: number; // 1..2
  /** Jumlah petugas Shift 1 setiap hari (di luar Koordinator / shift tetap) */
  shift1Count: number;
  /** Jumlah petugas Shift Siang setiap hari (0 = tanpa Shift Siang) */
  siangCount: number;
  shift1Id: number;
  shift2Id: number;
  siangId: number | null;
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
  siang: number;
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
  daily: { date: string; shift1: number; shift2: number; siang: number; fixed: number; off: number }[];
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
    employees.map((e) => [e.id, { userId: e.id, name: e.name, shift1: 0, shift2: 0, siang: 0, fixed: 0, off: 0, weekendOff: 0, shortRest: 0, offByWeekday: [], maxSameMate: 0 }]),
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
    // Batas keras jumlah orang Off per hari (mis. 14 orang × 1 Off ÷ 7 hari = 2), supaya tidak ada hari yang kekurangan orang
    const cap = Math.ceil((employees.filter((e) => e.offDays.length > 0).length * opt.offPerWeek) / Math.max(1, weekDates.length));
    for (const e of order) {
      for (let k = 0; k < opt.offPerWeek; k++) {
        const allowed = weekDates.filter((d) => e.offDays.includes(weekday(d)) && cells.get(e.id)!.get(d) !== 'OFF');
        const underCap = allowed.filter((d) => offOn.get(d)!.length < cap);
        const options = underCap.length > 0 ? underCap : allowed;
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
      daily.push({ date, shift1: 0, shift2: 0, siang: 0, fixed: 0, off: 0 });
      continue;
    }
    const working = employees.filter((e) => cells.get(e.id)!.get(date) !== 'OFF');
    const fixed = working.filter((e) => e.fixedShiftId !== null);
    for (const e of fixed) {
      cells.get(e.id)!.set(date, e.fixedShiftId!);
      stats.get(e.id)!.fixed++;
    }
    const pool = working.filter((e) => e.fixedShiftId === null);
    const siangOn = opt.siangId !== null && opt.siangCount > 0;
    const canS1 = (e: GenEmployee) => !e.noShift1Days.includes(wd);
    const canS2 = (e: GenEmployee) => !e.noShift2Days.includes(wd);
    const canSG = (e: GenEmployee) => siangOn && !e.noSiangDays.includes(wd);
    for (const e of pool.filter((x) => !canS1(x) && !canS2(x) && !canSG(x))) {
      warnings.push(`${e.name}: tidak boleh Shift 1, Shift 2, maupun Shift Siang pada hari ${DAY_NAME[wd]} — dijadwalkan Shift 2`);
    }
    const tomorrow = addDays(date, 1);
    const twd = weekday(tomorrow);
    // Besok wajib Shift 1 (mis. kuliah malam) → hari ini sebaiknya tidak pulang malam
    const forcedS1Tomorrow = (e: GenEmployee) =>
      dates.includes(tomorrow) && cells.get(e.id)!.get(tomorrow) !== 'OFF' && e.noShift2Days.includes(twd) && !e.noShift1Days.includes(twd);
    const late = (p: GenCell | null | undefined) => p === opt.shift2Id || (opt.siangId !== null && p === opt.siangId);
    const jit = (e: GenEmployee) => ((e.id * 7919 + seed * 104729) % 1000) / 1e5;
    const ratio1 = pool.length ? opt.shift1Count / pool.length : 0.3;
    const s1Score = (e: GenEmployee) => {
      const s = stats.get(e.id)!;
      const surplus = s.shift1 - ratio1 * (s.shift1 + s.shift2 + s.siang);
      const p = prev.get(e.id);
      // Yang tidak bisa Shift 2 hari ini didahulukan ke Shift 1 (atau Siang)
      return (canS2(e) ? 0 : -500) + (p === opt.shift2Id ? 100 : late(p) ? 40 : 0) - (forcedS1Tomorrow(e) ? 60 : 0) + 8 * surplus + jit(e);
    };
    const siangPool = pool.filter(canSG).length || 1;
    const sgScore = (e: GenEmployee) => {
      const s = stats.get(e.id)!;
      const surplus = s.siang - (opt.siangCount / siangPool) * (s.shift1 + s.shift2 + s.siang);
      return (canS2(e) ? 0 : -500) + (forcedS1Tomorrow(e) ? 60 : 0) + 8 * surplus + jit(e);
    };
    // 1) Shift 1 tepat sejumlah shift1Count; yang hanya bisa Shift 1 pasti masuk
    const onlyS1 = pool.filter((e) => canS1(e) && !canS2(e) && !canSG(e));
    if (onlyS1.length > opt.shift1Count) warnings.push(`${date} (${DAY_NAME[wd]}): ${onlyS1.length} orang hanya bisa Shift 1, melebihi jatah ${opt.shift1Count}`);
    const s1 = new Set(onlyS1.map((e) => e.id));
    for (const e of pool.filter((x) => canS1(x) && !s1.has(x.id)).sort((a, b) => s1Score(a) - s1Score(b))) {
      if (s1.size >= opt.shift1Count) break;
      s1.add(e.id);
    }
    // 2) Shift Siang tepat sejumlah siangCount dari yang boleh
    const sg = new Set<number>();
    if (siangOn) {
      for (const e of pool.filter((x) => !s1.has(x.id) && canSG(x)).sort((a, b) => sgScore(a) - sgScore(b))) {
        if (sg.size >= opt.siangCount) break;
        sg.add(e.id);
      }
      if (sg.size < opt.siangCount) warnings.push(`${date} (${DAY_NAME[wd]}): Shift Siang hanya ${sg.size} orang (seharusnya ${opt.siangCount})`);
    }
    // 3) Sisanya Shift 2
    let n1 = 0;
    let n2 = 0;
    let nSg = 0;
    for (const e of pool) {
      const s = stats.get(e.id)!;
      const shift = s1.has(e.id) ? opt.shift1Id : sg.has(e.id) ? opt.siangId! : opt.shift2Id;
      if (shift === opt.shift1Id && prev.get(e.id) === opt.shift2Id) s.shortRest++;
      cells.get(e.id)!.set(date, shift);
      if (shift === opt.shift1Id) {
        s.shift1++;
        n1++;
      } else if (shift === opt.shift2Id) {
        s.shift2++;
        n2++;
      } else {
        s.siang++;
        nSg++;
      }
    }
    for (const e of employees) prev.set(e.id, cells.get(e.id)!.get(date) ?? null);
    daily.push({ date, shift1: n1, shift2: n2, siang: nSg, fixed: fixed.length, off: employees.length - working.length });
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
  const canS1 = (e: GenEmployee, i: number) => !e.noShift1Days.includes(weekday(dates[i])) && at(e, i - 1) !== opt.shift2Id && at(e, i - 1) !== opt.siangId;
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
export function checkRules(r: GenResult, employees: GenEmployee[], opt: Pick<GenOptions, 'shift1Id' | 'shift2Id' | 'siangId' | 'holidays'>): string[] {
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
      else if (opt.siangId !== null && c === opt.siangId && e.noSiangDays.includes(wd)) out.push(`${where}: tidak boleh Shift Siang`);
    }
  }
  return out;
}

/** Pria tanpa batasan Shift Siang: jatah Shift Siangnya harus rata satu sama lain. */
const siangFree = (e: GenEmployee) => e.fixedShiftId === null && e.noSiangDays.length === 0;

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
    spread(r.stats.filter((s) => siangFree(employees.find((x) => x.id === s.userId)!)).map((s) => s.siang)) * 10 +
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

/**
 * Menyusun GenResult (statistik, ringkasan harian, pemeriksaan aturan) dari sel yang sudah jadi —
 * dipakai mesin baru (OR-Tools) supaya pratinjau, pemerataan, dan penyimpanan sama dengan mesin lama.
 */
export function resultFromCells(employees: GenEmployee[], opt: GenOptions, rows: Map<number, Map<string, GenCell>>): GenResult {
  const dates = Array.from({ length: opt.weeks * 7 }, (_, i) => addDays(opt.start, i));
  const stats: GenStats[] = employees.map((e) => {
    const row = rows.get(e.id)!;
    const s: GenStats = { userId: e.id, name: e.name, shift1: 0, shift2: 0, siang: 0, fixed: 0, off: 0, weekendOff: 0, shortRest: 0, offByWeekday: [0, 0, 0, 0, 0, 0, 0], maxSameMate: 0 };
    dates.forEach((d, i) => {
      const c = row.get(d);
      if (c === 'OFF') {
        s.off++;
        s.offByWeekday[weekday(d)]++;
        if (isWeekend(weekday(d))) s.weekendOff++;
      } else if (c === opt.shift1Id && e.fixedShiftId === null) s.shift1++;
      else if (c === opt.shift2Id && e.fixedShiftId === null) s.shift2++;
      else if (opt.siangId !== null && c === opt.siangId && e.fixedShiftId === null) s.siang++;
      else if (c !== undefined) s.fixed++;
      const before = i === 0 ? opt.prevDay.get(e.id) : row.get(dates[i - 1]);
      if (before === opt.shift2Id && c === opt.shift1Id) s.shortRest++;
    });
    return s;
  });
  for (const s of stats) {
    const mine = rows.get(s.userId)!;
    s.maxSameMate = Math.max(
      0,
      ...stats.filter((o) => o.userId !== s.userId).map((o) => dates.filter((d) => mine.get(d) === 'OFF' && rows.get(o.userId)!.get(d) === 'OFF').length),
    );
  }
  const daily = dates.map((date) => {
    const cell = (e: GenEmployee) => rows.get(e.id)!.get(date);
    return {
      date,
      shift1: employees.filter((e) => e.fixedShiftId === null && cell(e) === opt.shift1Id).length,
      shift2: employees.filter((e) => e.fixedShiftId === null && cell(e) === opt.shift2Id).length,
      siang: employees.filter((e) => e.fixedShiftId === null && opt.siangId !== null && cell(e) === opt.siangId).length,
      fixed: employees.filter((e) => e.fixedShiftId !== null && typeof cell(e) === 'number').length,
      off: employees.filter((e) => cell(e) === 'OFF').length,
    };
  });
  const result: GenResult = { dates, cells: rows, stats, daily, warnings: [], violations: [] };
  result.violations = [...checkRules(result, employees, opt), ...checkShortRest(result, employees, opt)];
  return result;
}

/**
 * Pulang malam (Shift 2) lalu besok masuk pagi (Shift 1) — wajib bagi mesin baru, kecuali Shift 1
 * besoknya memang diwajibkan aturan orang itu (mis. kuliah malam: tidak bisa Shift 2 di hari itu).
 */
export function checkShortRest(r: GenResult, employees: GenEmployee[], opt: Pick<GenOptions, 'shift1Id' | 'shift2Id' | 'prevDay'>): string[] {
  const out: string[] = [];
  for (const e of employees) {
    const row = r.cells.get(e.id)!;
    r.dates.forEach((d, i) => {
      const before = i === 0 ? opt.prevDay.get(e.id) : row.get(r.dates[i - 1]);
      if (before === opt.shift2Id && row.get(d) === opt.shift1Id && !e.noShift2Days.includes(weekday(d))) {
        out.push(`${e.name}, ${DAY_NAME[weekday(d)]} ${d}: pulang malam lalu masuk pagi`);
      }
    });
  }
  return out;
}
