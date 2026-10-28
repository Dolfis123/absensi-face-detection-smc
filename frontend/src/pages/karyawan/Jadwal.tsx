import { useLoad } from '../../components/attendance';
import { Alert, Badge, Card, Empty, Loading, PageHeader } from '../../components/ui';
import { api, Holiday, Shift } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { addDays, fmtDate, SLOT_LABEL, todayWIT } from '../../lib/format';

interface ScheduleResponse {
  schedules: { date: string; off: boolean; shift: { id: number; name: string; startTime: string; endTime: string } | null }[];
  holidays: Holiday[];
}

export default function Jadwal() {
  const { user } = useAuth();
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
  const offDates = new Set(sched.schedules.filter((s) => s.off).map((s) => s.date));
  const holidays = new Map(sched.holidays.map((h) => [h.date, h.name]));
  const SHIFT_BADGE = ['bg-sky-100 text-sky-800', 'bg-violet-100 text-violet-800', 'bg-teal-100 text-teal-800', 'bg-amber-100 text-amber-800'];
  const shiftBadge = (id: number) => SHIFT_BADGE[Math.max(0, shifts.findIndex((s) => s.id === id)) % SHIFT_BADGE.length];
  const days = Array.from({ length: 14 }, (_, i) => addDays(today, i));

  return (
    <>
      <PageHeader title="Jadwal Shift" subtitle="14 hari ke depan sesuai roster dari Super Admin" />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
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
                      <Badge className={shiftBadge(shift.id)}>
                        {shift.name} · {shift.startTime}–{shift.endTime}
                      </Badge>
                    ) : (
                      <span className="text-sm text-slate-400">Belum dijadwalkan</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        <Card>
          <h2 className="mb-3 font-semibold">Jendela Absensi (WIT)</h2>
          {shifts.map((s) => (
            <div key={s.id} className="mb-4">
              <div className="font-medium">
                {s.name} ({s.startTime}–{s.endTime})
              </div>
              <ul className="mt-1 text-sm text-slate-600">
                {s.slots.map((sl) => (
                  <li key={sl.id}>
                    Absen {SLOT_LABEL[sl.type]}: {sl.windowStart}–{sl.windowEnd}
                  </li>
                ))}
                {s.breakConfig?.enabled && user?.role === 'KARYAWAN' && (
                  <li>
                    Istirahat bergantian: mulai antara {s.breakConfig.windowStart}–{s.breakConfig.windowEnd}, maks.{' '}
                    {s.breakConfig.maxMinutes} menit (+{s.breakConfig.toleranceMinutes} menit toleransi). Absen saat mulai & saat kembali.
                  </li>
                )}
              </ul>
            </div>
          ))}
        </Card>
      </div>
    </>
  );
}
