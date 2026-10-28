import { Link } from 'react-router-dom';
import { RequestBadge, StatusBadge, SummaryGrid, useLoad } from '../../components/attendance';
import { Icon } from '../../components/icons';
import { Alert, Card, cx, Empty, Skeleton } from '../../components/ui';
import { api, EmployeeRecap, Holiday, LeaveRequest, Shift, SlotType } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useServerClock } from '../../lib/clock';
import { addDays, fmtDate, greeting, shortDay, SLOT_LABEL } from '../../lib/format';

interface ScheduleResponse {
  schedules: { date: string; off: boolean; shift: { id: number; name: string; startTime: string; endTime: string } | null }[];
  holidays: Holiday[];
}

const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

function countdown(mins: number) {
  if (mins < 60) return `${mins} menit lagi`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} jam ${m} menit lagi` : `${h} jam lagi`;
}

/** Beranda Karyawan Parkir: shift hari ini, status tiap slot absen, ringkasan bulan. */
export default function BerandaKaryawan() {
  const { user } = useAuth();
  const clock = useServerClock(15_000);
  const today = clock.date;

  const { data, error, loading } = useLoad(
    () =>
      Promise.all([
        api.get<EmployeeRecap & { month: string }>(`/me/recap?month=${today.slice(0, 7)}`),
        api.get<ScheduleResponse>(`/me/schedule?from=${today}&to=${addDays(today, 6)}`),
        api.get<Shift[]>('/shifts'),
        api.get<LeaveRequest[]>('/me/leaves'),
        api.get<{ lateToleranceMinutes: number }>('/settings'),
      ]),
    [today],
  );

  if (error) return <Alert>{error}</Alert>;
  if (loading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-56" />
        <Skeleton className="h-24" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  const [recap, sched, shifts, leaves, settings] = data;
  const lateTolerance = settings.lateToleranceMinutes;
  const todayRecord = recap.days.find((d) => d.date === today);
  const todayShiftRef = sched.schedules.find((s) => s.date === today)?.shift ?? null;
  const shift = todayShiftRef ? shifts.find((s) => s.id === todayShiftRef.id) : undefined;
  const holiday = sched.holidays.find((h) => h.date === today);
  const offToday = !!sched.schedules.find((s) => s.date === today)?.off;
  const blocked = todayRecord && ['IZIN', 'SAKIT', 'CUTI', 'LIBUR', 'DAY_OFF'].includes(todayRecord.status);

  type TileState = 'done' | 'open' | 'upcoming' | 'missed';
  interface Tile {
    key: string;
    type: SlotType;
    windowText: string;
    start: number;
    end: number; // batas terakhir tap
    done?: { time: string; status: string };
    state: TileState;
  }
  const stateOf = (done: unknown, start: number, end: number): TileState =>
    done ? 'done' : clock.minutes > end ? 'missed' : clock.minutes >= start ? 'open' : 'upcoming';

  const fixed: Tile[] = (shift?.slots ?? []).map((s) => {
    const start = toMin(s.windowStart);
    const end = toMin(s.windowEnd) + (s.type === 'MASUK' ? lateTolerance : 0);
    const done = todayRecord?.slots[s.type];
    return { key: s.type, type: s.type, windowText: `${s.windowStart}–${s.windowEnd} WIT`, start, end, done, state: stateOf(done, start, end) };
  });
  const brk = shift?.breakConfig?.enabled ? shift.breakConfig : null;
  const breakTiles: Tile[] = [];
  if (brk) {
    const ws = toMin(brk.windowStart);
    const we = toMin(brk.windowEnd);
    const started = todayRecord?.slots.ISTIRAHAT;
    const back = todayRecord?.slots.KEMBALI;
    const returnBy = we + brk.maxMinutes + brk.toleranceMinutes;
    breakTiles.push(
      { key: 'ISTIRAHAT', type: 'ISTIRAHAT', windowText: `Gantian, antara ${brk.windowStart}–${brk.windowEnd}`, start: ws, end: we, done: started, state: stateOf(started, ws, we) },
      {
        key: 'KEMBALI',
        type: 'KEMBALI',
        windowText: `Maks. ${brk.maxMinutes} menit (+${brk.toleranceMinutes} toleransi)`,
        start: started ? toMin(started.time) : ws,
        end: started ? returnBy : we,
        done: back,
        state: back ? 'done' : started ? stateOf(undefined, toMin(started.time), returnBy) : stateOf(undefined, ws + 1, we),
      },
    );
  }
  const slots = [...fixed, ...breakTiles].sort((a, b) => a.start - b.start);
  const openSlot = slots.find((s) => s.state === 'open');
  const nextSlot = slots.find((s) => s.state === 'upcoming');
  const lastLeave = leaves[0];
  const week = Array.from({ length: 7 }, (_, i) => addDays(today, i));

  let headline: string;
  let detail: string;
  if (holiday) {
    headline = 'Hari ini libur';
    detail = holiday.name;
  } else if (offToday) {
    headline = 'Hari ini jadwal Anda Off';
    detail = 'Selamat beristirahat. Tidak perlu absen hari ini.';
  } else if (blocked && todayRecord) {
    headline = `Hari ini Anda tercatat ${todayRecord.status.charAt(0) + todayRecord.status.slice(1).toLowerCase()}`;
    detail = 'Tidak perlu absen hari ini.';
  } else if (!shift) {
    headline = 'Tidak ada jadwal hari ini';
    detail = 'Cek menu Jadwal Shift untuk hari kerja berikutnya.';
  } else if (openSlot?.type === 'KEMBALI' && brk) {
    headline = 'Anda sedang istirahat';
    detail = `Absen Selesai Istirahat saat kembali ke pos. Batas ${brk.maxMinutes} menit (+${brk.toleranceMinutes} menit toleransi), sudah berjalan ${countdown(Math.max(0, clock.minutes - openSlot.start)).replace(' lagi', '')}.`;
  } else if (openSlot?.type === 'ISTIRAHAT') {
    headline = 'Waktu istirahat bergantian';
    detail = `Absen Mulai Istirahat saat meninggalkan pos (${openSlot.windowText}). Pastikan ada rekan yang menjaga pos.`;
  } else if (openSlot) {
    headline = `Saatnya Absen ${SLOT_LABEL[openSlot.type]}`;
    detail = `Jendela dibuka ${openSlot.windowText}${openSlot.type === 'MASUK' ? ' (lewat dari itu dihitung terlambat)' : ''}.`;
  } else if (nextSlot) {
    headline = `Absen ${SLOT_LABEL[nextSlot.type]} berikutnya pukul ${String(Math.floor(nextSlot.start / 60)).padStart(2, '0')}:${String(nextSlot.start % 60).padStart(2, '0')}`;
    detail = countdown(nextSlot.start - clock.minutes);
  } else {
    headline = 'Absensi hari ini selesai';
    detail = 'Terima kasih, sampai jumpa di shift berikutnya.';
  }

  return (
    <div className="space-y-6">
      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-700 via-brand-800 to-brand-950 p-5 text-white shadow-pop sm:p-7">
        <div className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-brand-400/20 blur-2xl" />
        <div className="relative">
          <p className="text-sm text-brand-100/80">
            {greeting(clock.minutes)}, {user?.fullName.split(' ')[0]} · {fmtDate(today)}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {shift ? (
              <span className="rounded-full bg-white/15 px-3 py-1 text-xs font-semibold">
                {shift.name} · {shift.startTime}–{shift.endTime} WIT
              </span>
            ) : (
              <span className="rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-brand-100">
                {offToday ? 'Off (libur)' : 'Belum dijadwalkan'}
              </span>
            )}
            {todayRecord && todayRecord.status !== 'OFF' && todayRecord.status !== 'BELUM' && (
              <span className="rounded-full bg-white px-0.5 py-0.5">
                <StatusBadge status={todayRecord.status} />
              </span>
            )}
          </div>
          <h1 className="mt-4 text-2xl font-bold tracking-tight sm:text-3xl">{headline}</h1>
          <p className="mt-1 text-sm text-brand-100/90">{detail}</p>

          {slots.length > 0 && !blocked && (
            <div className={cx('mt-6 grid gap-2 sm:grid-cols-2', slots.length === 4 ? 'xl:grid-cols-4' : 'lg:grid-cols-3')}>
              {slots.map((s) => (
                <div
                  key={s.key}
                  className={cx(
                    'flex items-center gap-3 rounded-2xl p-3 ring-1',
                    s.state === 'done' && 'bg-emerald-400/15 ring-emerald-300/30',
                    s.state === 'open' && 'bg-white/15 ring-white/40',
                    s.state === 'upcoming' && 'bg-white/5 ring-white/10',
                    s.state === 'missed' && 'bg-rose-400/15 ring-rose-300/30',
                  )}
                >
                  <span
                    className={cx(
                      'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
                      s.state === 'done' ? 'bg-emerald-400 text-emerald-950' : s.state === 'missed' ? 'bg-rose-400 text-rose-950' : 'bg-white/15',
                    )}
                  >
                    <Icon name={s.state === 'done' ? 'check' : s.state === 'missed' ? 'x' : 'clock'} className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold">Absen {SLOT_LABEL[s.type]}</div>
                    <div className="text-xs text-brand-100/80">
                      {s.done
                        ? s.type === 'KEMBALI'
                          ? `Tercatat ${s.done.time.slice(0, 5)}${todayRecord?.break?.minutes != null ? ` · ${todayRecord.break.minutes} mnt` : ''}${s.done.status === 'TERLAMBAT' ? ' · lebih' : ''}`
                          : `Tercatat ${s.done.time.slice(0, 5)}${s.done.status === 'TERLAMBAT' ? ' · terlambat' : ''}`
                        : s.state === 'missed'
                          ? s.type === 'ISTIRAHAT'
                            ? 'Tidak absen istirahat'
                            : 'Terlewat · lapor kendala bila hadir'
                          : s.windowText}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="mt-6 flex flex-wrap gap-2">
            <Link
              to="/absen"
              className="inline-flex items-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-semibold text-brand-800 shadow-lg hover:bg-brand-50"
            >
              <Icon name="scan" className="h-5 w-5" />
              Buka Halaman Absen
            </Link>
            {slots.some((s) => s.state === 'missed') && (
              <Link to="/app/kendala" className="inline-flex items-center gap-2 rounded-xl bg-white/10 px-5 py-3 text-sm font-semibold ring-1 ring-white/20 hover:bg-white/15">
                <Icon name="alert" className="h-5 w-5" />
                Lapor Kendala
              </Link>
            )}
          </div>
        </div>
      </section>

      <div>
        <div className="mb-3 flex items-end justify-between">
          <h2 className="text-[15px] font-semibold text-slate-900">Rekap bulan ini</h2>
          <Link to="/app/rekap" className="text-sm font-medium text-brand-600 hover:text-brand-700">
            Lihat detail →
          </Link>
        </div>
        <SummaryGrid summary={recap.summary} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Jadwal 7 hari ke depan" actions={<Link to="/app/jadwal" className="text-sm font-medium text-brand-600">Semua jadwal →</Link>}>
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
            {week.map((d) => {
              const sd = shortDay(d);
              const row = sched.schedules.find((s) => s.date === d);
              const sh = row?.shift;
              const isOff = !!row?.off;
              const isHoliday = sched.holidays.some((h) => h.date === d);
              const shiftIdx = sh ? Math.max(0, shifts.findIndex((s) => s.id === sh.id)) : 0;
              return (
                <div
                  key={d}
                  className={cx(
                    'rounded-xl border p-2.5 text-center',
                    d === today ? 'border-brand-300 bg-brand-50' : 'border-slate-100 bg-slate-50/60',
                  )}
                >
                  <div className={cx('text-[11px] font-medium', sd.weekend ? 'text-rose-500' : 'text-slate-500')}>{sd.day}</div>
                  <div className="text-lg font-bold text-slate-900">{sd.num}</div>
                  <div
                    className={cx(
                      'mt-1 truncate rounded-md px-1 py-0.5 text-[10px] font-semibold',
                      isHoliday
                        ? 'bg-slate-200 text-slate-600'
                        : isOff
                          ? 'bg-slate-600 text-white'
                          : sh
                            ? ['bg-sky-100 text-sky-700', 'bg-violet-100 text-violet-700', 'bg-teal-100 text-teal-700'][shiftIdx % 3]
                            : 'text-slate-400',
                    )}
                  >
                    {isHoliday ? 'Libur' : isOff ? 'Off' : sh ? sh.name : '—'}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        <Card title="Pengajuan terakhir" actions={<Link to="/app/izin" className="text-sm font-medium text-brand-600">Ajukan →</Link>}>
          {lastLeave ? (
            <div>
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-slate-900">{lastLeave.type}</span>
                <RequestBadge status={lastLeave.status} />
              </div>
              <p className="mt-1 text-sm text-slate-500">
                {fmtDate(lastLeave.startDate, false)}
                {lastLeave.endDate !== lastLeave.startDate && ` – ${fmtDate(lastLeave.endDate, false)}`}
              </p>
              <p className="mt-2 line-clamp-2 text-sm text-slate-600">{lastLeave.reason}</p>
              {lastLeave.reviewNote && <p className="mt-2 rounded-lg bg-slate-50 p-2 text-xs text-slate-500">Catatan: {lastLeave.reviewNote}</p>}
            </div>
          ) : (
            <Empty icon="send" title="Belum ada pengajuan">
              Ajukan izin, sakit, atau cuti dari menu Izin.
            </Empty>
          )}
        </Card>
      </div>
    </div>
  );
}
