import { useLoad } from '../../components/attendance';
import { Alert, Badge, Card, Empty, Loading, PageHeader } from '../../components/ui';
import { api, Holiday, Shift } from '../../lib/api';
import { addDays, fmtDate, todayWIT } from '../../lib/format';

interface ScheduleResponse {
  schedules: { date: string; off: boolean; post: string | null; shift: { id: number; name: string; startTime: string; endTime: string } | null }[];
  holidays: Holiday[];
}

export default function Jadwal() {
  const today = todayWIT();
  const { data, error, loading } = useLoad(() =>
    Promise.all([
      api.get<ScheduleResponse>(`/me/schedule?from=${today}&to=${addDays(today, 13)}`),
      api.get<Shift[]>('/shifts'),
    ]),
  );

  if (loading) return <Loading />;
  if (error || !data) return <Alert>{error}</Alert>;
  const [sched, shifts] = data;
  const byDate = new Map(sched.schedules.map((s) => [s.date, s.shift]));
  const postByDate = new Map(sched.schedules.map((s) => [s.date, s.post]));
  const offDates = new Set(sched.schedules.filter((s) => s.off).map((s) => s.date));
  const holidays = new Map(sched.holidays.map((h) => [h.date, h.name]));
  const SHIFT_BADGE = ['bg-sky-100 text-sky-800', 'bg-violet-100 text-violet-800', 'bg-teal-100 text-teal-800', 'bg-amber-100 text-amber-800'];
  const shiftBadge = (id: number) => SHIFT_BADGE[Math.max(0, shifts.findIndex((s) => s.id === id)) % SHIFT_BADGE.length];
  const days = Array.from({ length: 14 }, (_, i) => addDays(today, i));

  return (
    <>
      <PageHeader title="Jadwal Shift" subtitle="14 hari ke depan sesuai roster dari Super Admin" />
      <Card className="max-w-3xl">
        {days.length === 0 ? (
          <Empty>Belum ada jadwal</Empty>
        ) : (
          <ul className="divide-y divide-slate-100">
            {days.map((d) => {
              const shift = byDate.get(d);
              return (
                <li key={d} className={`flex items-center justify-between py-2.5 ${d === today ? 'font-semibold' : ''}`}>
                  <span>
                    {fmtDate(d)} {d === today && <Badge className="ml-1 bg-brand-100 text-brand-700">Hari ini</Badge>}
                  </span>
                  {holidays.has(d) ? (
                    <Badge className="bg-slate-200 text-slate-700">Libur · {holidays.get(d)}</Badge>
                  ) : offDates.has(d) ? (
                    <Badge className="bg-slate-600 text-white">Off (libur)</Badge>
                  ) : shift ? (
                    <span className="text-right">
                      <Badge className={shiftBadge(shift.id)}>
                        {shift.name} · {shift.startTime}–{shift.endTime}
                      </Badge>
                      {postByDate.get(d) && <div className="mt-0.5 text-xs font-normal text-slate-500">Pos: {postByDate.get(d)}</div>}
                    </span>
                  ) : (
                    <span className="text-sm text-slate-400">Belum dijadwalkan</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}
