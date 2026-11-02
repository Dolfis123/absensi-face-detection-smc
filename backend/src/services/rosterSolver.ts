/**
 * Mesin penyusun roster baru: Google OR-Tools CP-SAT di layanan Python (face-service).
 * Seluruh periode disusun sekaligus, jadi aturan wajib pasti terpenuhi atau dinyatakan mustahil.
 */
import { env } from '../config/env';
import { addDays } from '../utils/time';
import { GenCell, GenEmployee, GenOptions, GenResult, resultFromCells } from './rosterGenerator';

export class SolverUnavailable extends Error {}
export class RosterInfeasible extends Error {
  constructor(public reasons: string[]) {
    super('Roster tidak bisa disusun dengan semua aturan wajib');
  }
}

type Code = 'S1' | 'S2' | 'FULL' | 'OFF' | null;
interface SolveResponse {
  status: 'OPTIMAL' | 'FEASIBLE' | 'INFEASIBLE' | 'UNKNOWN';
  cells?: Record<string, Code[]>;
  wallTime?: number;
  reasons?: string[];
}

const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

export async function solveRoster(employees: GenEmployee[], opt: Omit<GenOptions, 'seed'>): Promise<{ result: GenResult; status: string; wallTime: number }> {
  const dates = Array.from({ length: opt.weeks * 7 }, (_, i) => addDays(opt.start, i));
  const code = (c: number | 'OFF' | null | undefined): Code =>
    c === 'OFF' ? 'OFF' : c === opt.shift1Id ? 'S1' : c === opt.shift2Id ? 'S2' : typeof c === 'number' ? 'FULL' : null;
  const payload = {
    employees: employees.map((e) => ({ id: e.id, fixed: e.fixedShiftId !== null, offDays: e.offDays, noShift1Days: e.noShift1Days, noShift2Days: e.noShift2Days })),
    dates: dates.map((date) => ({ date, weekday: weekday(date), holiday: opt.holidays.has(date) })),
    offPerWeek: opt.offPerWeek,
    shift2Extra: opt.shift2Extra,
    prevDay: Object.fromEntries([...opt.prevDay].map(([id, c]) => [id, code(c)])),
    timeLimit: 15,
  };

  let res: Response;
  try {
    res = await fetch(`${env.faceServiceUrl}/roster/solve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new SolverUnavailable('Layanan penyusun roster tidak dapat dihubungi');
  }
  if (res.status === 503 || res.status === 404) throw new SolverUnavailable('OR-Tools belum terpasang di server');
  if (!res.ok) throw new SolverUnavailable(`Layanan penyusun roster error ${res.status}`);
  const body = (await res.json()) as SolveResponse;
  if (!body.cells) throw new RosterInfeasible(body.reasons ?? ['Solver tidak menemukan susunan dalam batas waktu']);

  const rows = new Map<number, Map<string, GenCell>>();
  for (const e of employees) {
    const row = new Map<string, GenCell>();
    (body.cells[String(e.id)] ?? []).forEach((c, i) => {
      if (c === 'OFF') row.set(dates[i], 'OFF');
      else if (c === 'S1') row.set(dates[i], opt.shift1Id);
      else if (c === 'S2') row.set(dates[i], opt.shift2Id);
      else if (c === 'FULL' && e.fixedShiftId !== null) row.set(dates[i], e.fixedShiftId);
    });
    rows.set(e.id, row);
  }
  return { result: resultFromCells(employees, { ...opt, seed: 0 }, rows), status: body.status, wallTime: body.wallTime ?? 0 };
}
