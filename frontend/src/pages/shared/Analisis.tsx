import { useState } from 'react';
import { useLoad } from '../../components/attendance';
import { Icon } from '../../components/icons';
import { Alert, Badge, Card, cx, Empty, Loading, PageHeader, PersonCell, StatCard, Table, Td, Th } from '../../components/ui';
import { api, Role } from '../../lib/api';
import { fmtDate, shortDay } from '../../lib/format';

interface Sum {
  scheduled: number;
  present: number;
  late: number;
  once: number;
  alfa: number;
  presentPct: number | null;
  latePct: number | null;
  alfaPct: number | null;
}
interface Analytics {
  from: string;
  to: string;
  prevFrom: string;
  prevTo: string;
  total: Sum;
  prevTotal: Sum;
  weekday: (Sum & { day: string })[];
  shifts: (Sum & { name: string })[];
  daily: (Sum & { date: string })[];
  employees: (Sum & { userId: number; fullName: string; role: Role; prevPresentPct: number | null; prevLate: number | null; prevAlfa: number | null; delta: number | null })[];
  warnings: { userId: number; fullName: string; level: 'ACTION' | 'SOON'; text: string }[];
  worsening: { userId: number; fullName: string; delta: number; presentPct: number | null }[];
}

const PERIODS = [7, 14, 30, 60, 90];
const fmtPct = (v: number | null) => (v === null ? '–' : `${v.toLocaleString('id-ID')}%`);

function Delta({ cur, prev, goodUp = true, unit = '' }: { cur: number | null; prev: number | null; goodUp?: boolean; unit?: string }) {
  if (cur === null || prev === null) return <span className="text-slate-400">belum ada pembanding</span>;
  const d = Math.round((cur - prev) * 10) / 10;
  if (d === 0) return <span className="text-slate-500">sama dengan periode lalu</span>;
  const good = goodUp ? d > 0 : d < 0;
  return (
    <span className={good ? 'text-emerald-700' : 'text-rose-700'}>
      {d > 0 ? '▲' : '▼'} {Math.abs(d).toLocaleString('id-ID')}
      {unit} dari periode lalu
    </span>
  );
}

/** Bar mendatar sederhana: hadir hijau, terlambat oranye, alfa merah (persen dari jadwal). */
function RateBar({ s }: { s: Sum }) {
  if (!s.scheduled) return <div className="h-3 rounded-full bg-slate-100" />;
  const late = (s.late / s.scheduled) * 100;
  const alfa = (s.alfa / s.scheduled) * 100;
  const ok = Math.max(0, 100 - late - alfa);
  return (
    <div className="flex h-3 overflow-hidden rounded-full bg-slate-100">
      <div className="bg-emerald-500" style={{ width: `${ok}%` }} />
      <div className="bg-amber-400" style={{ width: `${late}%` }} />
      <div className="bg-rose-500" style={{ width: `${alfa}%` }} />
    </div>
  );
}

/** Garis persentase hadir harian. */
function DailyLine({ data }: { data: Analytics['daily'] }) {
  const pts = data.filter((d) => d.presentPct !== null);
  if (pts.length < 2) return <Empty icon="chart" title="Data belum cukup" />;
  const W = 640;
  const H = 160;
  const min = Math.min(80, ...pts.map((p) => p.presentPct!));
  const x = (i: number) => 24 + (i / (data.length - 1)) * (W - 32);
  const y = (v: number) => 8 + (1 - (v - min) / (100 - min || 1)) * (H - 28);
  const line = data.map((d, i) => (d.presentPct === null ? null : `${x(i)},${y(d.presentPct)}`)).filter(Boolean).join(' ');
  const step = Math.ceil(data.length / 8);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-44 w-full">
      {[min, (min + 100) / 2, 100].map((v) => (
        <g key={v}>
          <line x1={24} x2={W - 8} y1={y(v)} y2={y(v)} stroke="#e2e8f0" />
          <text x={0} y={y(v) + 3} fontSize={9} fill="#94a3b8">
            {Math.round(v)}%
          </text>
        </g>
      ))}
      <polyline points={line} fill="none" stroke="#124a91" strokeWidth={2} strokeLinejoin="round" />
      {data.map((d, i) =>
        d.presentPct === null ? null : (
          <circle key={d.date} cx={x(i)} cy={y(d.presentPct)} r={d.presentPct < 85 ? 3.5 : 2} fill={d.presentPct < 85 ? '#e11d48' : '#124a91'}>
            <title>{`${fmtDate(d.date, false)}: hadir ${fmtPct(d.presentPct)} (${d.present}/${d.scheduled}), alfa ${d.alfa}, terlambat ${d.late}`}</title>
          </circle>
        ),
      )}
      {data.map((d, i) =>
        i % step === 0 ? (
          <text key={d.date} x={x(i)} y={H - 4} fontSize={9} fill="#94a3b8" textAnchor="middle">
            {shortDay(d.date).num} {shortDay(d.date).day}
          </text>
        ) : null,
      )}
    </svg>
  );
}

/** Analisis kehadiran: pola hari & shift, tren per petugas, peringatan dini. */
export default function Analisis() {
  const [days, setDays] = useState(30);
  const { data, error, loading } = useLoad(() => api.get<Analytics>(`/analytics?days=${days}`), [days]);

  return (
    <>
      <PageHeader
        title="Analisis Kehadiran"
        subtitle="Pola keterlambatan & alfa, tren tiap petugas dibanding periode sebelumnya, dan peringatan dini sebelum batas surat peringatan."
        actions={
          <div className="flex gap-1 rounded-xl bg-slate-100 p-1">
            {PERIODS.map((p) => (
              <button
                key={p}
                onClick={() => setDays(p)}
                className={cx('rounded-lg px-3 py-1.5 text-sm font-medium', days === p ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200' : 'text-slate-500')}
              >
                {p} hari
              </button>
            ))}
          </div>
        }
      />
      {error && <Alert>{error}</Alert>}
      {loading && !data ? (
        <Loading />
      ) : (
        data && (
          <div className="space-y-4">
            <p className="text-xs text-slate-500">
              Periode {fmtDate(data.from, false)} – {fmtDate(data.to, false)} (sampai kemarin), dibanding {fmtDate(data.prevFrom, false)} – {fmtDate(data.prevTo, false)}. Akun uji coba tidak dihitung.
            </p>
            <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
              {/* Periode sebelumnya tanpa jadwal = belum ada pembanding */}
              <StatCard label="Tingkat kehadiran" value={fmtPct(data.total.presentPct)} icon="userCheck" sub={<Delta cur={data.total.presentPct} prev={data.prevTotal.scheduled ? data.prevTotal.presentPct : null} unit=" poin" />} />
              <StatCard label="Terlambat" value={data.total.late} icon="clock" sub={<Delta cur={data.total.late} prev={data.prevTotal.scheduled ? data.prevTotal.late : null} goodUp={false} unit="×" />} />
              <StatCard label="Alfa" value={data.total.alfa} icon="userX" sub={<Delta cur={data.total.alfa} prev={data.prevTotal.scheduled ? data.prevTotal.alfa : null} goodUp={false} unit="×" />} />
              <StatCard label="Absen sekali" value={data.total.once} icon="alert" sub={<Delta cur={data.total.once} prev={data.prevTotal.scheduled ? data.prevTotal.once : null} goodUp={false} unit="×" />} />
            </div>

            {(data.warnings.length > 0 || data.worsening.length > 0) && (
              <Card title="Perlu perhatian" subtitle="Ditindaklanjuti sebelum menjadi surat peringatan">
                <div className="space-y-2">
                  {data.warnings.map((w) => (
                    <div key={`w${w.userId}`} className={cx('flex items-start gap-3 rounded-xl p-3 text-sm', w.level === 'ACTION' ? 'bg-rose-50' : 'bg-amber-50')}>
                      <Icon name="alert" className={cx('mt-0.5 h-4 w-4 shrink-0', w.level === 'ACTION' ? 'text-rose-600' : 'text-amber-600')} />
                      <span>
                        <b>{w.fullName}</b> · {w.text}
                      </span>
                    </div>
                  ))}
                  {data.worsening.map((w) => (
                    <div key={`d${w.userId}`} className="flex items-start gap-3 rounded-xl bg-slate-50 p-3 text-sm">
                      <Icon name="chart" className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
                      <span>
                        <b>{w.fullName}</b> · kehadiran turun {Math.abs(w.delta)} poin menjadi {fmtPct(w.presentPct)} dibanding periode lalu.
                      </span>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            <div className="grid gap-4 xl:grid-cols-2">
              <Card title="Per hari dalam seminggu" subtitle="Hari mana yang paling sering terlambat / alfa">
                <div className="space-y-2.5">
                  {data.weekday.map((w) => (
                    <div key={w.day} className="grid grid-cols-[64px_1fr_auto] items-center gap-3 text-sm">
                      <span className="font-medium text-slate-700">{w.day}</span>
                      <RateBar s={w} />
                      <span className="whitespace-nowrap text-right text-xs text-slate-500">
                        {w.scheduled ? (
                          <>
                            hadir {fmtPct(w.presentPct)} · <span className="text-amber-700">tlmbt {w.late}</span> · <span className="text-rose-700">alfa {w.alfa}</span>
                          </>
                        ) : (
                          'tidak ada jadwal'
                        )}
                      </span>
                    </div>
                  ))}
                </div>
                <Legend />
              </Card>
              <Card title="Per shift" subtitle="Shift mana yang paling bermasalah">
                <div className="space-y-2.5">
                  {data.shifts.map((s) => (
                    <div key={s.name} className="grid grid-cols-[96px_1fr_auto] items-center gap-3 text-sm">
                      <span className="font-medium text-slate-700">{s.name}</span>
                      <RateBar s={s} />
                      <span className="whitespace-nowrap text-right text-xs text-slate-500">
                        hadir {fmtPct(s.presentPct)} · <span className="text-amber-700">tlmbt {s.late}</span> · <span className="text-rose-700">alfa {s.alfa}</span>
                      </span>
                    </div>
                  ))}
                </div>
                <Legend />
              </Card>
            </div>

            <Card title="Kehadiran harian" subtitle="Persentase petugas terjadwal yang hadir. Titik merah = di bawah 85%.">
              <DailyLine data={data.daily} />
            </Card>

            <Card title="Per petugas" subtitle="Diurutkan dari kehadiran terendah. Panah = perubahan dibanding periode lalu.">
              {data.employees.length === 0 ? (
                <Empty icon="users" title="Belum ada data" />
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>Petugas</Th>
                      <Th className="text-center">Kehadiran</Th>
                      <Th className="text-center">Perubahan</Th>
                      <Th className="text-center">Terlambat</Th>
                      <Th className="text-center">Absen sekali</Th>
                      <Th className="text-center">Alfa</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.employees.map((e) => (
                      <tr key={e.userId}>
                        <Td>
                          <PersonCell name={e.fullName} sub={`${e.present}/${e.scheduled} hari hadir${e.role === 'KOORDINATOR' ? ' · Koordinator' : ''}`} />
                        </Td>
                        <Td className="text-center">
                          <Badge className={e.presentPct === null ? 'bg-slate-100 text-slate-500' : e.presentPct >= 95 ? 'bg-emerald-100 text-emerald-800' : e.presentPct >= 85 ? 'bg-amber-100 text-amber-800' : 'bg-rose-100 text-rose-800'}>
                            {fmtPct(e.presentPct)}
                          </Badge>
                        </Td>
                        <Td className="text-center text-xs">
                          {e.delta === null ? (
                            <span className="text-slate-400">–</span>
                          ) : e.delta === 0 ? (
                            <span className="text-slate-500">tetap</span>
                          ) : (
                            <span className={e.delta > 0 ? 'text-emerald-700' : 'text-rose-700'}>
                              {e.delta > 0 ? '▲' : '▼'} {Math.abs(e.delta)}
                            </span>
                          )}
                        </Td>
                        <Td className="text-center">{e.late || <span className="text-slate-300">–</span>}</Td>
                        <Td className="text-center">{e.once || <span className="text-slate-300">–</span>}</Td>
                        <Td className="text-center">{e.alfa ? <b className="text-rose-700">{e.alfa}</b> : <span className="text-slate-300">–</span>}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
          </div>
        )
      )}
    </>
  );
}

const Legend = () => (
  <div className="mt-3 flex flex-wrap gap-3 text-xs text-slate-500">
    <span className="flex items-center gap-1.5">
      <span className="h-2.5 w-4 rounded bg-emerald-500" />
      Hadir tepat waktu
    </span>
    <span className="flex items-center gap-1.5">
      <span className="h-2.5 w-4 rounded bg-amber-400" />
      Terlambat
    </span>
    <span className="flex items-center gap-1.5">
      <span className="h-2.5 w-4 rounded bg-rose-500" />
      Alfa
    </span>
  </div>
);
