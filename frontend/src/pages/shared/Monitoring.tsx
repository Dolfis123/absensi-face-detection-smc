import { useEffect, useState } from 'react';
import { BreakCell, SlotTime, StatusBadge, useLoad } from '../../components/attendance';
import { Icon } from '../../components/icons';
import { MarkNotWorkingModal } from '../../components/notWorking';
import { useAuth } from '../../lib/auth';
import { Alert, Avatar, Button, Card, cx, Empty, Loading, PageHeader, PersonCell, SearchInput, Table, Td, Th } from '../../components/ui';
import { api, DayRecord, DayStatus, Role } from '../../lib/api';
import { fmtDate, STATUS_STYLE } from '../../lib/format';

interface TodayResponse {
  serverTime: { date: string; time: string };
  rows: (DayRecord & { post: string | null; user: { id: number; fullName: string; nik: string; phone: string; role: Role } })[];
}

const ORDER: DayStatus[] = ['TEPAT_WAKTU', 'TERLAMBAT', 'ABSEN_SEKALI', 'BELUM', 'ALFA', 'IZIN', 'SAKIT', 'CUTI', 'LIBUR', 'DAY_OFF', 'OFF'];

export default function Monitoring() {
  const { data, error, loading, reload } = useLoad(() => api.get<TodayResponse>('/monitor/today'));
  const [filter, setFilter] = useState<DayStatus | 'ALL' | 'BREAK'>('ALL');
  const [q, setQ] = useState('');
  const isAdmin = useAuth().user?.role === 'SUPER_ADMIN';
  const [markUser, setMarkUser] = useState<number | null>(null);

  useEffect(() => {
    const id = setInterval(reload, 15_000);
    return () => clearInterval(id);
  }, [reload]);

  const rows = data?.rows ?? [];
  const counts = rows.reduce<Partial<Record<DayStatus, number>>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  const onBreak = rows.filter((r) => r.break?.onBreak).length;
  const needle = q.trim().toLowerCase();
  const visible = rows
    .filter((r) => filter === 'ALL' || (filter === 'BREAK' ? r.break?.onBreak : r.status === filter))
    .filter((r) => !needle || r.user.fullName.toLowerCase().includes(needle) || r.user.nik.toLowerCase().includes(needle))
    .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));

  const tab = (key: DayStatus | 'ALL' | 'BREAK', label: string, n: number, dot?: string) => (
    <button
      key={key}
      onClick={() => setFilter(key)}
      className={cx(
        'inline-flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition',
        filter === key ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200' : 'text-slate-500 hover:text-slate-800',
      )}
    >
      {dot && <span className={`h-2 w-2 rounded-full ${dot}`} />}
      {label}
      <span className={cx('rounded-md px-1.5 text-xs', filter === key ? 'bg-slate-100 text-slate-700' : 'bg-slate-200/60')}>{n}</span>
    </button>
  );

  return (
    <>
      <PageHeader
        title="Monitoring Hari Ini"
        subtitle={
          data ? (
            <span className="inline-flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              {fmtDate(data.serverTime.date)} · diperbarui {data.serverTime.time} WIT, otomatis tiap 15 detik
            </span>
          ) : undefined
        }
      />
      {error && <Alert>{error}</Alert>}
      <Card>
        <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="-mx-1 flex gap-1 overflow-x-auto rounded-xl bg-slate-100 p-1">
            {tab('ALL', 'Semua', rows.length)}
            {onBreak > 0 && tab('BREAK', 'Sedang istirahat', onBreak, 'bg-violet-500')}
            {ORDER.filter((s) => counts[s]).map((s) => tab(s, STATUS_STYLE[s].label, counts[s] ?? 0, STATUS_STYLE[s].dot))}
          </div>
          <SearchInput value={q} onChange={setQ} placeholder="Cari nama atau NIK…" className="lg:w-64" />
        </div>

        {loading && !data ? (
          <Loading />
        ) : visible.length === 0 ? (
          <Empty icon="search" title="Tidak ada karyawan yang cocok" />
        ) : (
          <>
          {/* HP: kartu per orang supaya status, pos, dan jam langsung terlihat tanpa digeser */}
          <div className="-mx-1 space-y-2 md:hidden">
            {visible.map((r) => (
              <div key={r.user.id} className={cx('rounded-xl border border-slate-200 p-3', (r.status === 'OFF' || r.status === 'DAY_OFF') && 'opacity-60')}>
                <div className="flex items-start gap-3">
                  <Avatar name={r.user.fullName} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-slate-900">{r.user.fullName}</p>
                        <p className="truncate text-xs text-slate-500">
                          {r.user.role === 'KOORDINATOR' ? 'Koordinator · ' : ''}
                          {r.shiftName ?? 'Tidak dijadwalkan'}
                        </p>
                      </div>
                      <StatusBadge status={r.status} />
                    </div>
                    {r.post && (
                      <p className="mt-1 flex items-center gap-1 text-xs text-slate-600">
                        <Icon name="mapPin" className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                        <span>{r.post.replace(/\s*—\s*Area Parkiran/, '')}</span>
                      </p>
                    )}
                    {r.note && (r.status === 'ABSEN_SEKALI' || r.status === 'ALFA') && (
                      <p className={cx('mt-1 text-xs', r.status === 'ALFA' ? 'text-rose-700' : 'text-violet-700')}>{r.note}</p>
                    )}
                    {!['OFF', 'DAY_OFF', 'IZIN', 'SAKIT', 'CUTI', 'LIBUR'].includes(r.status) && (
                      <div className="mt-2 grid grid-cols-3 gap-1.5 text-center">
                        {(['MASUK', 'ISTIRAHAT', 'PULANG'] as const).map((slot) => (
                          <div key={slot} className="rounded-lg bg-slate-50 px-1 py-1.5">
                            <p className="text-[10px] uppercase tracking-wide text-slate-400">{slot === 'MASUK' ? 'Masuk' : slot === 'PULANG' ? 'Pulang' : 'Istirahat'}</p>
                            <p className="font-mono text-xs text-slate-800">
                              {slot === 'ISTIRAHAT'
                                ? r.break?.start
                                  ? `${r.break.start.slice(0, 5)}${r.break.end ? `–${r.break.end.slice(0, 5)}` : '…'}`
                                  : '—'
                                : (r.slots[slot]?.time.slice(0, 5) ?? '—')}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <a
                        className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700"
                        href={`https://wa.me/${r.user.phone.replace(/^0/, '62').replace(/\D/g, '')}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <Icon name="phone" className="h-3.5 w-3.5" />
                        WhatsApp
                      </a>
                      {isAdmin && ['TEPAT_WAKTU', 'TERLAMBAT', 'ABSEN_SEKALI'].includes(r.status) && (
                        <button className="rounded-lg px-2.5 py-1 text-xs font-medium text-rose-700 ring-1 ring-rose-200" onClick={() => setMarkUser(r.user.id)}>
                          Tandai tidak bekerja
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="hidden md:block">
          <Table>
            <thead>
              <tr>
                <Th>Karyawan</Th>
                <Th>Shift</Th>
                <Th>Status</Th>
                <Th>Jam absen</Th>
                <Th className="text-right">Kontak</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {visible.map((r) => (
                <tr key={r.user.id} className={r.status === 'OFF' || r.status === 'DAY_OFF' ? 'opacity-60' : ''}>
                  <Td>
                    <PersonCell name={r.user.fullName} sub={r.user.role === 'KOORDINATOR' ? `${r.user.nik} · Koordinator` : r.user.nik} />
                  </Td>
                  <Td className="text-slate-600">
                    {r.shiftName ?? '—'}
                    {r.post && <div className="text-xs text-slate-400">{r.post.replace(/\s*—\s*Area Parkiran/, '')}</div>}
                  </Td>
                  <Td>
                    <StatusBadge status={r.status} />
                    {r.status === 'ABSEN_SEKALI' && r.note && <div className="mt-1 text-xs text-violet-700">{r.note}</div>}
                    {r.status === 'ALFA' && r.note && <div className="mt-1 max-w-[14rem] text-xs text-rose-700">{r.note}</div>}
                    {isAdmin && ['TEPAT_WAKTU', 'TERLAMBAT', 'ABSEN_SEKALI'].includes(r.status) && (
                      <div>
                        <Button variant="ghost" className="mt-1 !px-2 !py-0.5 text-xs text-rose-700 ring-1 ring-rose-200" onClick={() => setMarkUser(r.user.id)}>
                          Tandai tidak bekerja
                        </Button>
                      </div>
                    )}
                  </Td>
                  <Td>
                    <div className="space-y-0.5 text-xs">
                      <div><span className="inline-block w-14 text-slate-400">Masuk</span><SlotTime d={r} slot="MASUK" /></div>
                      {(r.break?.start || r.break?.end) && (
                        <div className="flex items-start"><span className="inline-block w-14 shrink-0 text-slate-400">Istirahat</span><BreakCell d={r} /></div>
                      )}
                      <div><span className="inline-block w-14 text-slate-400">Pulang</span><SlotTime d={r} slot="PULANG" /></div>
                    </div>
                  </Td>
                  <Td className="text-right">
                    <a
                      title={`WhatsApp ${r.user.phone}`}
                      className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50"
                      href={`https://wa.me/${r.user.phone.replace(/^0/, '62').replace(/\D/g, '')}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Icon name="phone" className="h-4 w-4" />
                      <span className="hidden 2xl:inline">WhatsApp</span>
                    </a>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          </div>
          </>
        )}
      </Card>
      {isAdmin && data && (
        <MarkNotWorkingModal
          open={markUser !== null}
          onClose={() => setMarkUser(null)}
          onDone={() => {
            setMarkUser(null);
            reload();
          }}
          employees={rows.map((r) => r.user)}
          initialUserId={markUser ?? undefined}
          initialDate={data.serverTime.date}
        />
      )}
    </>
  );
}
