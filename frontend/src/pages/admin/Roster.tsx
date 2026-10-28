import { useEffect, useMemo, useState } from 'react';
import { useLoad } from '../../components/attendance';
import { Alert, Button, Card, Loading, PageHeader } from '../../components/ui';
import { api, errMsg, Holiday, Role, Shift } from '../../lib/api';
import { addDays, mondayOf, shortDay, todayWIT } from '../../lib/format';

interface RosterResponse {
  employees: { id: number; fullName: string; nik: string; role: Role; defaultShiftId: number | null }[];
  schedules: { userId: number; date: string; shiftId: number }[];
}

const key = (u: number, d: string) => `${u}|${d}`;
const CELL_CLS = ['bg-white text-slate-400', 'bg-sky-100 text-sky-800', 'bg-violet-100 text-violet-800', 'bg-teal-100 text-teal-800'];

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
  const [draft, setDraft] = useState<Map<string, number | null>>(new Map());
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  useEffect(() => {
    if (data) setDraft(new Map(data[0].schedules.map((s) => [key(s.userId, s.date), s.shiftId])));
  }, [data]);

  if (loading && !data) return <Loading />;
  if (!data) return <Alert>{error}</Alert>;
  const [roster, shifts, holidays] = data;
  const original = new Map(roster.schedules.map((s) => [key(s.userId, s.date), s.shiftId]));
  const holidaySet = new Map(holidays.map((h) => [h.date, h.name]));
  const changes = [...draft.entries()].filter(([k, v]) => (original.get(k) ?? null) !== v);
  for (const k of original.keys()) if (!draft.has(k)) changes.push([k, null]);

  // Klik sel: kosong → Shift 1 → Shift 2 → … → kosong
  const cycle = (userId: number, date: string) => {
    if (date < today) return;
    const order: (number | null)[] = [null, ...shifts.map((s) => s.id)];
    const cur = draft.get(key(userId, date)) ?? null;
    const next = order[(order.indexOf(cur) + 1) % order.length];
    setDraft((d) => new Map(d).set(key(userId, date), next));
  };

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const entries = changes.map(([k, shiftId]) => {
        const [userId, date] = k.split('|');
        return { userId: Number(userId), date, shiftId };
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

  const shiftIdx = (id: number | null | undefined) => (id ? shifts.findIndex((s) => s.id === id) + 1 : 0);

  return (
    <>
      <PageHeader
        title="Roster Shift Dinamis"
        subtitle="Klik sel untuk mengganti: kosong → Shift 1 → Shift 2. Tanggal yang sudah lewat terkunci."
        actions={
          <>
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
                          className={`h-10 w-full min-w-[4.5rem] rounded-lg text-xs font-semibold ring-1 ring-slate-200 ${CELL_CLS[shiftIdx(v)]} ${
                            changed ? 'ring-2 ring-amber-400' : ''
                          } ${past ? 'cursor-not-allowed opacity-60' : 'hover:ring-brand-500'}`}
                        >
                          {v ? shifts.find((s) => s.id === v)?.name : '—'}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={fillDefault}>
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
