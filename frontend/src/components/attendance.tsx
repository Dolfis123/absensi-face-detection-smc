import { useCallback, useEffect, useState } from 'react';
import { DayRecord, DayStatus, errMsg, SlotType, Summary } from '../lib/api';
import { fmtDate, REQUEST_STATUS, STATUS_STYLE, StatusStyle } from '../lib/format';
import { Badge, Table, Td, Th } from './ui';

const StyledBadge = ({ style }: { style: StatusStyle }) => (
  <Badge className={style.cls}>
    <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
    {style.label}
  </Badge>
);

export const StatusBadge = ({ status }: { status: DayStatus }) => <StyledBadge style={STATUS_STYLE[status]} />;

export const RequestBadge = ({ status }: { status: string }) => (
  <StyledBadge style={REQUEST_STATUS[status] ?? { label: status, cls: 'bg-slate-100 text-slate-600', dot: 'bg-slate-400' }} />
);

const SUMMARY_ITEMS: { key: keyof Summary; label: string; bar: string }[] = [
  { key: 'tepatWaktu', label: 'Tepat Waktu', bar: 'bg-emerald-500' },
  { key: 'terlambat', label: 'Terlambat', bar: 'bg-amber-500' },
  { key: 'izin', label: 'Izin', bar: 'bg-sky-500' },
  { key: 'sakit', label: 'Sakit', bar: 'bg-violet-500' },
  { key: 'cuti', label: 'Cuti', bar: 'bg-indigo-500' },
  { key: 'alfa', label: 'Alfa', bar: 'bg-rose-500' },
  { key: 'istirahatLebih', label: 'Istirahat Lebih', bar: 'bg-orange-500' },
  { key: 'lupaKembali', label: 'Lupa Absen Kembali', bar: 'bg-slate-400' },
];

export function SummaryGrid({ summary }: { summary: Summary }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
      {SUMMARY_ITEMS.map((i) => (
        <div key={i.key} className="relative overflow-hidden rounded-2xl border border-slate-200/80 bg-white p-4 shadow-card">
          <span className={`absolute inset-y-0 left-0 w-1 ${i.bar}`} />
          <div className="text-xs font-medium text-slate-500">{i.label}</div>
          <div className="mt-1 text-2xl font-bold tracking-tight text-slate-900">
            {summary[i.key]}
            <span className="ml-1 text-xs font-medium text-slate-400">hari</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export const SlotTime = ({ d, slot }: { d: DayRecord; slot: SlotType }) => {
  const s = d.slots[slot];
  if (!s) return <span className="text-slate-300">—</span>;
  return (
    <span className="font-mono text-xs text-slate-700">
      {s.time.slice(0, 5)}
      {s.source === 'CORRECTION' && <span title="Hasil koreksi admin"> *</span>}
    </span>
  );
};

/** Jam mulai–selesai istirahat, durasi, dan penanda Istirahat lebih / Lupa kembali / Sedang istirahat. */
export function BreakCell({ d }: { d: DayRecord }) {
  const b = d.break;
  if (!b || (!b.start && !b.end)) return <span className="text-slate-300">—</span>;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="font-mono text-xs text-slate-700">
        <SlotTime d={d} slot="ISTIRAHAT" /> – {b.end ? <SlotTime d={d} slot="KEMBALI" /> : '…'}
      </span>
      {b.minutes !== null && <span className={`text-xs ${b.over ? 'font-semibold text-orange-600' : 'text-slate-500'}`}>({b.minutes} mnt)</span>}
      {b.over && <Badge className="bg-orange-50 text-orange-700 ring-1 ring-orange-600/20">Istirahat lebih</Badge>}
      {b.missingReturn && <Badge className="bg-slate-100 text-slate-600 ring-1 ring-slate-500/15">Lupa absen kembali</Badge>}
      {b.onBreak && <Badge className="bg-violet-50 text-violet-700 ring-1 ring-violet-600/15">Sedang istirahat</Badge>}
    </div>
  );
}

export function DaysTable({ days, hideOff = true }: { days: DayRecord[]; hideOff?: boolean }) {
  const rows = hideOff ? days.filter((d) => d.status !== 'OFF') : days;
  return (
    <Table>
      <thead>
        <tr>
          <Th>Tanggal</Th>
          <Th>Shift</Th>
          <Th>Status</Th>
          <Th>Masuk</Th>
          <Th>Istirahat</Th>
          <Th>Pulang</Th>
          <Th>Ket.</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((d) => (
          <tr key={d.date}>
            <Td>{fmtDate(d.date)}</Td>
            <Td>{d.shiftName ?? '—'}</Td>
            <Td>
              <StatusBadge status={d.status} />
            </Td>
            <Td className="font-mono text-xs">
              <SlotTime d={d} slot="MASUK" />
            </Td>
            <Td>
              <BreakCell d={d} />
            </Td>
            <Td className="font-mono text-xs">
              <SlotTime d={d} slot="PULANG" />
            </Td>
            <Td className="max-w-[16rem] truncate text-xs text-slate-500">{d.note ?? ''}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/** Hook sederhana untuk memuat data + reload. */
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(loader, deps);
  const reload = useCallback(() => {
    setLoading(true);
    return load()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(errMsg(e)))
      .finally(() => setLoading(false));
  }, [load]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}
