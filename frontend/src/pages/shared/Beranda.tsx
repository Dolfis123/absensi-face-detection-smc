import { Link } from 'react-router-dom';
import { StatusBadge, useLoad } from '../../components/attendance';
import { Icon, IconName } from '../../components/icons';
import { TrendChart, TrendPoint } from '../../components/TrendChart';
import { Alert, Avatar, Badge, Card, Empty, PageHeader, PersonCell, Skeleton, StatCard } from '../../components/ui';
import { api, AttendanceIssue, DayRecord, EmployeeRecap, LeaveRequest, PublicUser, SlotType } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useServerClock } from '../../lib/clock';
import { addDays, fmtDate, greeting, SLOT_LABEL } from '../../lib/format';

interface TodayResponse {
  serverTime: { date: string; time: string };
  rows: (DayRecord & { user: { id: number; fullName: string; nik: string; phone: string } })[];
}

const waLink = (phone: string) => `https://wa.me/${phone.replace(/^0/, '62').replace(/\D/g, '')}`;

/** Beranda Super Admin & Koordinator Lapangan. */
export default function BerandaPengawas() {
  const { user } = useAuth();
  const clock = useServerClock(30_000);
  const isAdmin = user?.role === 'SUPER_ADMIN';

  const { data, error, loading } = useLoad(async () => {
    const today = await api.get<TodayResponse>('/monitor/today');
    const date = today.serverTime.date;
    const [recap, leaves, issues, users] = await Promise.all([
      api.get<EmployeeRecap[]>(`/monitor/recap?from=${addDays(date, -6)}&to=${date}`),
      api.get<LeaveRequest[]>('/leaves?status=PENDING'),
      api.get<AttendanceIssue[]>('/issues'),
      isAdmin ? api.get<PublicUser[]>('/admin/users') : Promise.resolve([] as PublicUser[]),
    ]);
    return { today, recap, leaves, issues, users };
  }, [isAdmin]);

  const header = (
    <PageHeader
      title={`${greeting(clock.minutes)}, ${user?.fullName.split(' ')[0] ?? ''}`}
      subtitle={`${fmtDate(clock.date)} · Ringkasan kehadiran Pos Parkir Mal SMC`}
      actions={
        <Link
          to="/app/monitoring"
          className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-700"
        >
          <Icon name="activity" className="h-4 w-4" />
          Buka Monitoring
        </Link>
      }
    />
  );

  if (error) return <>{header}<Alert>{error}</Alert></>;
  if (loading || !data) {
    return (
      <>
        {header}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-32" />)}
        </div>
        <Skeleton className="mt-6 h-72" />
      </>
    );
  }

  const rows = data.today.rows;
  const count = (...s: string[]) => rows.filter((r) => s.includes(r.status)).length;
  const scheduled = rows.filter((r) => r.shiftId !== null).length;
  const hadir = count('TEPAT_WAKTU', 'TERLAMBAT');
  const terlambat = count('TERLAMBAT');
  const belum = rows.filter((r) => r.status === 'BELUM');
  const alfa = count('ALFA');
  const cuti = count('IZIN', 'SAKIT', 'CUTI');
  const openIssues = data.issues.filter((i) => i.status === 'OPEN' || (isAdmin && i.status === 'ESCALATED'));
  const needFace = data.users.filter((u) => u.role === 'KARYAWAN' && u.isActive && u.faceCount < 3);

  const trend: TrendPoint[] = Array.from({ length: 7 }, (_, i) => addDays(data.today.serverTime.date, i - 6)).map((date) => {
    const p: TrendPoint = { date, tepat: 0, terlambat: 0, izin: 0, alfa: 0 };
    for (const r of data.recap) {
      const s = r.days.find((d) => d.date === date)?.status;
      if (s === 'TEPAT_WAKTU') p.tepat++;
      else if (s === 'TERLAMBAT') p.terlambat++;
      else if (s === 'IZIN' || s === 'SAKIT' || s === 'CUTI') p.izin++;
      else if (s === 'ALFA') p.alfa++;
    }
    return p;
  });

  const activity = rows
    .flatMap((r) =>
      (Object.entries(r.slots) as [SlotType, { time: string; status: string; source: string }][]).map(([slot, v]) => ({
        name: r.user.fullName,
        slot,
        ...v,
      })),
    )
    .sort((a, b) => b.time.localeCompare(a.time))
    .slice(0, 7);

  const actions: { to: string; icon: IconName; label: string; n: number; tone: string }[] = [
    { to: '/app/review-izin', icon: 'send', label: 'Pengajuan izin menunggu keputusan', n: data.leaves.length, tone: 'bg-amber-50 text-amber-600' },
    {
      to: '/app/review-kendala',
      icon: 'alert',
      label: isAdmin ? 'Laporan kendala baru / diteruskan' : 'Laporan kendala baru',
      n: openIssues.length,
      tone: 'bg-rose-50 text-rose-600',
    },
    ...(isAdmin
      ? [{ to: '/app/karyawan', icon: 'scan' as const, label: 'Karyawan perlu daftar ulang wajah', n: needFace.length, tone: 'bg-violet-50 text-violet-600' }]
      : []),
  ];

  return (
    <>
      {header}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Hadir hari ini"
          value={<>{hadir}<span className="text-lg font-semibold text-slate-400"> / {scheduled}</span></>}
          sub={scheduled ? `${Math.round((hadir / scheduled) * 100)}% dari karyawan yang dijadwalkan` : 'Belum ada jadwal hari ini'}
          icon="userCheck"
          tone="green"
          progress={scheduled ? hadir / scheduled : 0}
        />
        <StatCard label="Terlambat" value={terlambat} sub="Absen masuk setelah jendela tutup" icon="clock" tone="amber" />
        <StatCard
          label="Belum absen"
          value={belum.length}
          sub={alfa ? `${alfa} karyawan sudah tercatat Alfa` : `${cuti} karyawan izin/sakit/cuti`}
          icon="userX"
          tone="rose"
        />
        <StatCard
          label="Perlu ditinjau"
          value={data.leaves.length + openIssues.length}
          sub={`${data.leaves.length} izin · ${openIssues.length} kendala`}
          icon="inbox"
          tone="violet"
        />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2" title="Kehadiran 7 hari terakhir" subtitle="Jumlah karyawan per status. Sentuh batang untuk detail.">
          <TrendChart data={trend} />
        </Card>

        <Card title="Perlu tindakan" subtitle="Hal yang menunggu Anda">
          <div className="space-y-2">
            {actions.map((a) => (
              <Link key={a.to} to={a.to} className="flex items-center gap-3 rounded-xl border border-slate-100 p-3 transition hover:border-slate-200 hover:bg-slate-50">
                <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${a.tone}`}>
                  <Icon name={a.icon} />
                </span>
                <span className="flex-1 text-sm text-slate-700">{a.label}</span>
                <span className="text-xl font-bold text-slate-900">{a.n}</span>
                <Icon name="chevronRight" className="h-4 w-4 text-slate-300" />
              </Link>
            ))}
          </div>
        </Card>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card title="Aktivitas absen hari ini" subtitle="Catatan terbaru dari pos parkir">
          {activity.length === 0 ? (
            <Empty icon="clock" title="Belum ada absensi hari ini" />
          ) : (
            <ul className="divide-y divide-slate-100">
              {activity.map((a, i) => (
                <li key={i} className="flex items-center gap-3 py-3">
                  <Avatar name={a.name} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-slate-900">{a.name}</div>
                    <div className="text-xs text-slate-500">
                      Absen {SLOT_LABEL[a.slot]}
                      {a.source === 'CORRECTION' && ' · koreksi admin'}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-sm font-semibold text-slate-800">{a.time.slice(0, 5)}</div>
                    {a.status === 'TERLAMBAT' && <Badge className="mt-0.5 bg-amber-50 text-amber-700">Terlambat</Badge>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="Belum absen masuk"
          subtitle="Dijadwalkan hari ini, jendela masuk masih terbuka"
          actions={<Badge className="bg-slate-100 text-slate-600">{belum.length} orang</Badge>}
        >
          {belum.length === 0 ? (
            <Empty icon="check" title="Semua karyawan terjadwal sudah absen" />
          ) : (
            <ul className="divide-y divide-slate-100">
              {belum.map((r) => (
                <li key={r.user.id} className="flex items-center justify-between gap-3 py-3">
                  <PersonCell name={r.user.fullName} sub={r.shiftName ?? undefined} />
                  <div className="flex items-center gap-2">
                    <StatusBadge status={r.status} />
                    <a
                      href={waLink(r.user.phone)}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-lg p-2 text-emerald-600 hover:bg-emerald-50"
                      title={`WhatsApp ${r.user.phone}`}
                    >
                      <Icon name="phone" className="h-4 w-4" />
                    </a>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
