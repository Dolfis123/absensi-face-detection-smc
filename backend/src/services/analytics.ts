/**
 * Analisis kehadiran untuk Super Admin & Koordinator: pola per hari dan per shift, tren tiap petugas
 * dibanding periode sebelumnya, dan peringatan dini sebelum batas surat peringatan (PKWT Pasal 8).
 */
import { overview as disciplineOverview } from '../routes/discipline';
import { LETTER_TITLE } from './discipline';
import { buildRecap, DayRecord, EmployeeRecap } from './recapService';
import { addDays, witNow } from '../utils/time';

const WORK = new Set(['TEPAT_WAKTU', 'TERLAMBAT', 'ABSEN_SEKALI', 'ALFA']);
const PRESENT = new Set(['TEPAT_WAKTU', 'TERLAMBAT', 'ABSEN_SEKALI']);
const isLate = (d: DayRecord) => d.status === 'TERLAMBAT' || (d.status === 'ABSEN_SEKALI' && d.slots.MASUK?.status === 'TERLAMBAT');

interface Bucket {
  scheduled: number;
  present: number;
  late: number;
  once: number;
  alfa: number;
}
const empty = (): Bucket => ({ scheduled: 0, present: 0, late: 0, once: 0, alfa: 0 });
function add(b: Bucket, d: DayRecord) {
  if (!WORK.has(d.status)) return;
  b.scheduled++;
  if (PRESENT.has(d.status)) b.present++;
  if (isLate(d)) b.late++;
  if (d.status === 'ABSEN_SEKALI') b.once++;
  if (d.status === 'ALFA') b.alfa++;
}
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);
const summarize = (b: Bucket) => ({ ...b, presentPct: pct(b.present, b.scheduled), latePct: pct(b.late, b.scheduled), alfaPct: pct(b.alfa, b.scheduled) });

function perEmployee(recap: EmployeeRecap[]) {
  return new Map(
    recap.map((r) => {
      const b = empty();
      r.days.forEach((d) => add(b, d));
      return [r.user.id, summarize(b)];
    }),
  );
}

export async function buildAnalytics(days: number) {
  const today = witNow().date;
  // Sampai kemarin supaya hari ini yang belum selesai tidak menurunkan angka
  const to = addDays(today, -1);
  const from = addDays(to, -(days - 1));
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(days - 1));
  const [cur, prev, discipline] = await Promise.all([buildRecap(from, to), buildRecap(prevFrom, prevTo), disciplineOverview()]);

  const total = empty();
  const prevTotal = empty();
  const weekday = Array.from({ length: 7 }, empty);
  const shifts = new Map<string, Bucket>();
  const daily = new Map<string, Bucket>();
  for (const r of cur)
    for (const d of r.days) {
      add(total, d);
      add(weekday[new Date(`${d.date}T00:00:00Z`).getUTCDay()], d);
      if (d.shiftName && WORK.has(d.status)) {
        if (!shifts.has(d.shiftName)) shifts.set(d.shiftName, empty());
        add(shifts.get(d.shiftName)!, d);
      }
      if (!daily.has(d.date)) daily.set(d.date, empty());
      add(daily.get(d.date)!, d);
    }
  for (const r of prev) for (const d of r.days) add(prevTotal, d);

  const curEmp = perEmployee(cur);
  const prevEmp = perEmployee(prev);
  const employees = cur
    .map((r) => {
      const c = curEmp.get(r.user.id)!;
      const p = prevEmp.get(r.user.id);
      const delta = c.presentPct !== null && p?.presentPct != null ? Math.round((c.presentPct - p.presentPct) * 10) / 10 : null;
      return { userId: r.user.id, fullName: r.user.fullName, role: r.user.role, ...c, prevPresentPct: p?.presentPct ?? null, prevLate: p?.late ?? null, prevAlfa: p?.alfa ?? null, delta };
    })
    .filter((e) => e.scheduled > 0)
    .sort((a, b) => (a.presentPct ?? 101) - (b.presentPct ?? 101) || b.alfa - a.alfa);

  // Peringatan dini: sudah perlu surat, atau satu langkah lagi menuju batas (Alfa ke-3 bulan ini / 5 hari berturut-turut)
  const warnings = discipline
    .map((d) => {
      const r = d as unknown as { user: { id: number; fullName: string }; monthCount: number; streak: number; recommendation: string | null };
      if (r.recommendation) {
        const what = (LETTER_TITLE as Record<string, string>)[r.recommendation] ?? 'keputusan manajemen';
        return { userId: r.user.id, fullName: r.user.fullName, level: 'ACTION' as const, text: `Perlu ${what} · Alfa bulan ini ${r.monthCount}×${r.streak >= 2 ? `, ${r.streak} hari berturut-turut` : ''}` };
      }
      if (r.monthCount === 2) return { userId: r.user.id, fullName: r.user.fullName, level: 'SOON' as const, text: 'Sudah 2× Alfa bulan ini. Sekali lagi = Surat Peringatan Kedua.' };
      if (r.streak >= 3) return { userId: r.user.id, fullName: r.user.fullName, level: 'SOON' as const, text: `Alfa ${r.streak} hari berturut-turut. Hari ke-5 = surat panggilan.` };
      return null;
    })
    .filter(Boolean);
  const worsening = employees.filter((e) => e.delta !== null && e.delta <= -10).map((e) => ({ userId: e.userId, fullName: e.fullName, delta: e.delta, presentPct: e.presentPct }));

  const DAY = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
  return {
    from,
    to,
    prevFrom,
    prevTo,
    total: summarize(total),
    prevTotal: summarize(prevTotal),
    weekday: [1, 2, 3, 4, 5, 6, 0].map((i) => ({ day: DAY[i], ...summarize(weekday[i]) })),
    shifts: [...shifts.entries()].map(([name, b]) => ({ name, ...summarize(b) })).sort((a, b) => a.name.localeCompare(b.name)),
    daily: [...daily.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, b]) => ({ date, ...summarize(b) })),
    employees,
    warnings,
    worsening,
  };
}
