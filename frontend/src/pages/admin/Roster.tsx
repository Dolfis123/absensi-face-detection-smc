import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLoad } from '../../components/attendance';
import { Alert, Button, Card, Loading, PageHeader } from '../../components/ui';
import { api, errMsg, Holiday, Role, Shift } from '../../lib/api';
import { addDays, mondayOf, shortDay, todayWIT } from '../../lib/format';

interface RosterResponse {
  employees: { id: number; fullName: string; nik: string; role: Role; defaultShiftId: number | null }[];
  // shiftId null = hari Off yang sengaja ditetapkan
  schedules: { userId: number; date: string; shiftId: number | null }[];
}

/** Isi satu sel roster: id shift, 'OFF' (libur pribadi), atau null (belum dijadwalkan). */
type Cell = number | 'OFF' | null;

const key = (u: number, d: string) => `${u}|${d}`;
const SHIFT_CLS = ['bg-sky-100 text-sky-800', 'bg-violet-100 text-violet-800', 'bg-teal-100 text-teal-800', 'bg-amber-100 text-amber-800'];
const OFF_CLS = 'bg-slate-600 text-white';
const EMPTY_CLS = 'bg-white text-slate-400';

export default function Roster() {
  const today = todayWIT();
  const [weekStart, setWeekStart] = useState(mondayOf(today));
  const weekEnd = addDays(weekStart, 6);
  const dates = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);

  const { data, error, loading, reload } = useLoad(
    () =>
      Promise.all([
        api.get<RosterResponse>(`/admin/schedules?from=${weekStart}&to=${weekEnd}`),
        api.get<Shift[]>('/shifts'),
        api.get<Holiday[]>(`/holidays?year=${weekStart.slice(0, 4)}`),
      ]),
    [weekStart],
  );
  const [draft, setDraft] = useState<Map<string, Cell>>(new Map());
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  const toCell = (shiftId: number | null): Cell => (shiftId === null ? 'OFF' : shiftId);

  useEffect(() => {
    if (data) setDraft(new Map(data[0].schedules.map((s) => [key(s.userId, s.date), toCell(s.shiftId)])));
  }, [data]);

  if (loading && !data) return <Loading />;
  if (!data) return <Alert>{error}</Alert>;
  const [roster, shifts, holidays] = data;
  const original = new Map<string, Cell>(roster.schedules.map((s) => [key(s.userId, s.date), toCell(s.shiftId)]));
  const holidaySet = new Map(holidays.map((h) => [h.date, h.name]));
  const changes = [...draft.entries()].filter(([k, v]) => (original.get(k) ?? null) !== v);
  for (const k of original.keys()) if (!draft.has(k)) changes.push([k, null]);

  // Klik sel: kosong → Shift 1 → Shift 2 → Shift Penuh → Off → kosong
  const cycle = (userId: number, date: string) => {
    if (date < today) return;
    const order: Cell[] = [null, ...shifts.map((s) => s.id), 'OFF'];
    const cur = draft.get(key(userId, date)) ?? null;
    const next = order[(order.indexOf(cur) + 1) % order.length];
    setDraft((d) => new Map(d).set(key(userId, date), next));
  };

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const entries = changes.map(([k, v]) => {
        const [userId, date] = k.split('|');
        return { userId: Number(userId), date, shiftId: typeof v === 'number' ? v : null, off: v === 'OFF' };
      });
      await api.put('/admin/schedules', { entries });
      setMsg({ kind: 'success', text: `${entries.length} perubahan roster disimpan` });
      reload();
    } catch (e) {
      setMsg({ kind: 'error', text: errMsg(e) });
    } finally {
      setSaving(false);
    }
  }

  async function fillDefault() {
    setMsg(null);
    try {
      const r = await api.post<{ created: number }>('/admin/schedules/fill-default', { from: weekStart, to: weekEnd });
      setMsg({ kind: 'success', text: `${r.created} jadwal kosong diisi dari shift default` });
      reload();
    } catch (e) {
      setMsg({ kind: 'error', text: errMsg(e) });
    }
  }

  const cellCls = (v: Cell) =>
    v === 'OFF' ? OFF_CLS : v === null ? EMPTY_CLS : SHIFT_CLS[Math.max(0, shifts.findIndex((s) => s.id === v)) % SHIFT_CLS.length];
  const cellText = (v: Cell) => (v === 'OFF' ? 'Off' : v === null ? '—' : (shifts.find((s) => s.id === v)?.name ?? '?'));

  return (
    <>
      <PageHeader
        title="Roster Shift Dinamis"
        subtitle={`Klik sel untuk mengganti: kosong → ${shifts.map((s) => s.name).join(' → ')} → Off. Tanggal yang sudah lewat terkunci.`}
        actions={
          <>
            <Link to="/app/roster-otomatis">
              <Button icon="sparkles">Roster Otomatis</Button>
            </Link>
            <Button variant="secondary" onClick={() => setWeekStart(addDays(weekStart, -7))}>
              ‹ Minggu lalu
            </Button>
            <Button variant="secondary" onClick={() => setWeekStart(mondayOf(today))}>
              Minggu ini
            </Button>
            <Button variant="secondary" onClick={() => setWeekStart(addDays(weekStart, 7))}>
              Minggu depan ›
            </Button>
          </>
        }
      />
      {msg && (
        <div className="mb-3">
          <Alert kind={msg.kind}>{msg.text}</Alert>
        </div>
      )}
      <Card>
        <div className="-mx-4 overflow-x-auto sm:mx-0">
          <table className="min-w-full text-sm">
            <thead>
              <tr>
                <th className="sticky left-0 bg-white px-2 py-2 text-left text-xs font-semibold text-slate-500">Karyawan</th>
                {dates.map((d) => {
                  const sd = shortDay(d);
                  return (
                    <th key={d} className={`px-1 py-2 text-center text-xs ${sd.weekend ? 'text-rose-500' : 'text-slate-500'} ${d === today ? 'font-bold text-brand-600' : ''}`}>
                      {sd.day}
                      <div className="text-base">{sd.num}</div>
                      {holidaySet.has(d) && <div className="text-[10px] text-rose-500">Libur</div>}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {roster.employees.map((e) => (
                <tr key={e.id} className="border-t border-slate-100">
                  <td className="sticky left-0 whitespace-nowrap bg-white px-2 py-1.5">
                    <div className="font-medium">{e.fullName}</div>
                    <div className="text-xs text-slate-400">{e.nik}{e.role === 'KOORDINATOR' && ' · Koordinator'}</div>
                  </td>
                  {dates.map((d) => {
                    const v = draft.get(key(e.id, d)) ?? null;
                    const changed = (original.get(key(e.id, d)) ?? null) !== v;
                    const past = d < today;
                    return (
                      <td key={d} className="p-1">
                        <button
                          onClick={() => cycle(e.id, d)}
                          disabled={past}
                          className={`h-10 w-full min-w-[5rem] rounded-lg px-1 text-xs font-semibold ring-1 ring-slate-200 ${cellCls(v)} ${
                            changed ? 'ring-2 ring-amber-400' : ''
                          } ${past ? 'cursor-not-allowed opacity-60' : 'hover:ring-brand-500'}`}
                        >
                          {cellText(v)}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-600">
          {shifts.map((s) => (
            <span key={s.id} className="flex items-center gap-1.5">
              <span className={`h-3 w-5 rounded ${cellCls(s.id)}`} />
              {s.name} ({s.startTime}–{s.endTime})
            </span>
          ))}
          <span className="flex items-center gap-1.5">
            <span className={`h-3 w-5 rounded ${OFF_CLS}`} />
            Off (libur pribadi, tidak dihitung Alfa)
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-3 w-5 rounded bg-white ring-1 ring-slate-300" />— belum dijadwalkan
          </span>
        </div>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={fillDefault} title="Hari yang sudah ditandai Off atau sudah berisi shift tidak diubah">
            Isi yang kosong dari shift default
          </Button>
          <Button onClick={save} loading={saving} disabled={changes.length === 0}>
            Simpan {changes.length > 0 && `(${changes.length})`}
          </Button>
        </div>
      </Card>
    </>
  );
}
