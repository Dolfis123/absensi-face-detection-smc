import { useEffect, useState } from 'react';
import { BreakCell, SlotTime, StatusBadge, useLoad } from '../../components/attendance';
import { Icon } from '../../components/icons';
import { Alert, Card, cx, Empty, Loading, PageHeader, PersonCell, SearchInput, Table, Td, Th } from '../../components/ui';
import { api, DayRecord, DayStatus, Role } from '../../lib/api';
import { fmtDate, STATUS_STYLE } from '../../lib/format';

interface TodayResponse {
  serverTime: { date: string; time: string };
  rows: (DayRecord & { user: { id: number; fullName: string; nik: string; phone: string; role: Role } })[];
}

const ORDER: DayStatus[] = ['TEPAT_WAKTU', 'TERLAMBAT', 'ABSEN_SEKALI', 'BELUM', 'ALFA', 'IZIN', 'SAKIT', 'CUTI', 'LIBUR', 'DAY_OFF', 'OFF'];

export default function Monitoring() {
  const { data, error, loading, reload } = useLoad(() => api.get<TodayResponse>('/monitor/today'));
  const [filter, setFilter] = useState<DayStatus | 'ALL' | 'BREAK'>('ALL');
  const [q, setQ] = useState('');

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
          <Table>
            <thead>
              <tr>
                <Th>Karyawan</Th>
                <Th>Shift</Th>
                <Th>Status</Th>
                <Th>Masuk</Th>
                <Th>Istirahat</Th>
                <Th>Pulang</Th>
                <Th>Kontak</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {visible.map((r) => (
                <tr key={r.user.id} className={r.status === 'OFF' || r.status === 'DAY_OFF' ? 'opacity-60' : ''}>
                  <Td>
                    <PersonCell name={r.user.fullName} sub={r.user.role === 'KOORDINATOR' ? `${r.user.nik} · Koordinator` : r.user.nik} />
                  </Td>
                  <Td className="text-slate-600">{r.shiftName ?? '—'}</Td>
                  <Td>
                    <StatusBadge status={r.status} />
                    {r.status === 'ABSEN_SEKALI' && r.note && <div className="mt-1 text-xs text-violet-700">{r.note}</div>}
                  </Td>
                  <Td>
                    <SlotTime d={r} slot="MASUK" />
                  </Td>
                  <Td>
                    <BreakCell d={r} />
                  </Td>
                  <Td>
                    <SlotTime d={r} slot="PULANG" />
                  </Td>
                  <Td>
                    <a
                      className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50"
                      href={`https://wa.me/${r.user.phone.replace(/^0/, '62').replace(/\D/g, '')}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Icon name="phone" className="h-3.5 w-3.5" />
                      {r.user.phone}
                    </a>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
