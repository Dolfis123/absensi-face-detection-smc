import { FormEvent, useEffect, useState } from 'react';
import { useLoad } from '../../components/attendance';
import { useFeedback } from '../../components/feedback';
import { Alert, Button, Card, cx, Empty, Field, Input, Loading, Modal, PageHeader, Select, StatCard, Table, Td, Textarea, Th } from '../../components/ui';
import { api, errMsg, openProtectedFile } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { addDays, fmtDate, todayWIT } from '../../lib/format';
import { DepositRow, HandoverRow, hourLabel, HourlyRow, IncidentRow, mismatchText, Mismatch, ParkingSettings, rupiah, setParkingSettingsCache, useParkingSettings } from '../../lib/parking';
import { Detail, IncidentForm, IncidentList, NumField, StatusPill, Tabs } from './shared';

type Tab = 'ringkasan' | 'stok' | 'setoran' | 'serah' | 'kejadian' | 'pengaturan';

/** Halaman Koordinator & Super Admin untuk operasional parkir. */
export default function OperasionalPengelola() {
  const { user } = useAuth();
  const settings = useParkingSettings();
  const isAdmin = user?.role === 'SUPER_ADMIN';
  const { data: pending } = useLoad(() => api.get<{ deposits: number; handovers: number; incidents: number }>('/parking/pending').catch(() => null));
  const [tab, setTab] = useState<Tab>('ringkasan');
  if (!settings) return <Loading />;
  // Super Admin melihat semua tab supaya bisa menyiapkan & mencoba sebelum modul diaktifkan
  const karcis = settings.karcisEnabled || isAdmin;
  const kejadian = settings.kejadianEnabled || isAdmin;
  const tabs = [
    ...(karcis
      ? ([
          { key: 'ringkasan', label: 'Ringkasan Harian' },
          { key: 'stok', label: 'Stok Karcis' },
          { key: 'setoran', label: 'Setoran', count: pending?.deposits },
          { key: 'serah', label: 'Serah Terima', count: pending?.handovers },
        ] as const)
      : []),
    ...(kejadian ? ([{ key: 'kejadian', label: 'Kejadian', count: pending?.incidents }] as const) : []),
    ...(isAdmin ? ([{ key: 'pengaturan', label: 'Pengaturan' }] as const) : []),
  ];
  if (tabs.length === 0) return <Alert kind="info">Fitur operasional parkir belum diaktifkan oleh Super Admin.</Alert>;
  const active = tabs.some((t) => t.key === tab) ? tab : tabs[0].key;
  return (
    <>
      <PageHeader title="Karcis & Kejadian" subtitle="Laporan per jam, stok karcis, setoran, serah terima shift, dan laporan kejadian" />
      {isAdmin && !settings.karcisEnabled && !settings.kejadianEnabled && (
        <div className="mb-4">
          <Alert kind="info">Modul ini belum aktif untuk petugas. Anda bisa menyiapkan tarif dan stok karcis lebih dulu, lalu aktifkan di tab Pengaturan.</Alert>
        </div>
      )}
      <Tabs tabs={[...tabs]} value={active} onChange={setTab} />
      {active === 'ringkasan' && <Ringkasan />}
      {active === 'stok' && <Stok />}
      {active === 'setoran' && <SetoranReview />}
      {active === 'serah' && <SerahReview />}
      {active === 'kejadian' && <KejadianReview />}
      {active === 'pengaturan' && <Pengaturan current={settings} />}
    </>
  );
}

const DateNav = ({ date, onChange }: { date: string; onChange: (d: string) => void }) => (
  <div className="flex items-center gap-2">
    <Button variant="secondary" onClick={() => onChange(addDays(date, -1))}>
      ‹
    </Button>
    <Input type="date" max={todayWIT()} value={date} onChange={(e) => e.target.value && onChange(e.target.value)} className="!w-auto" />
    <Button variant="secondary" onClick={() => onChange(addDays(date, 1))} disabled={date >= todayWIT()}>
      ›
    </Button>
  </div>
);

// ─────────── Ringkasan harian ───────────
interface Totals {
  carIn: number;
  motorIn: number;
  carOut: number;
  motorOut: number;
  ticketCar: number;
  ticketMotor: number;
  revenue: number;
}
interface DayResponse {
  settings: ParkingSettings;
  summary: {
    totals: Totals;
    mismatch: Mismatch;
    hourly: { hour: number; carInside: number; motorInside: number; carFree: number; motorFree: number }[];
    blocks: { from: number; to: number; carIn: number; motorIn: number; carOut: number; motorOut: number; carFree: number; motorFree: number }[];
    perPost: { post: string; carIn: number; motorIn: number; ticketCar: number; ticketMotor: number; revenue: number }[];
  };
  rows: HourlyRow[];
  missing: { userId: number; fullName: string; post: string | null; missing: number[] }[];
}

function Ringkasan() {
  const [date, setDate] = useState(todayWIT());
  const { data, error, loading } = useLoad(() => api.get<DayResponse>(`/parking/reports?date=${date}`), [date]);
  if (loading && !data) return <Loading />;
  if (!data) return <Alert>{error}</Alert>;
  const { totals, mismatch, blocks, perPost } = data.summary;
  const last = data.summary.hourly.at(-1);
  const h = (n: number) => String(n).padStart(2, '0');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <DateNav date={date} onChange={setDate} />
        <span className="text-xs text-slate-500">
          Tarif: mobil {rupiah(data.settings.rateCar)}, motor {rupiah(data.settings.rateMotor)} · karcis diterbitkan saat {data.settings.ticketAt === 'MASUK' ? 'masuk' : 'keluar'}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Pendapatan (karcis × tarif)" value={rupiah(totals.revenue)} icon="chart" />
        <StatCard label="Kendaraan masuk (mobil / motor)" value={`${totals.carIn} / ${totals.motorIn}`} icon="car" />
        <StatCard label="Karcis terpakai (mobil / motor)" value={`${totals.ticketCar} / ${totals.ticketMotor}`} icon="fileText" />
        <StatCard
          label="Perkiraan lot kosong (mobil / motor)"
          value={last ? `${last.carFree} / ${last.motorFree}` : `${data.settings.carLots} / ${data.settings.motorLots}`}
          icon="mapPin"
        />
      </div>
      {mismatch.any ? (
        <Alert>Selisih hari ini: {mismatchText(mismatch)} (kendaraan dibanding karcis). Periksa laporan per jam yang berwarna merah di bawah (SOP 6.4).</Alert>
      ) : data.rows.length > 0 ? (
        <Alert kind="success">Jumlah kendaraan sama dengan karcis terpakai.</Alert>
      ) : null}
      {data.missing.length > 0 && (
        <Card title="Belum lapor" subtitle="Jam yang sudah lewat tetapi laporannya belum masuk">
          <ul className="space-y-1 text-sm">
            {data.missing.map((m) => (
              <li key={m.userId}>
                <b>{m.fullName}</b>
                {m.post && <span className="text-slate-500"> · {m.post}</span>}: {m.missing.map(hourLabel).join(', ')}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Kondisi parkir per 3 jam" subtitle="Untuk laporan ke Manajemen (SOP 6.1). Lot kosong = kapasitas − (masuk − keluar sejak pagi)">
          {blocks.length === 0 ? (
            <Empty title="Belum ada laporan" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Jam</Th>
                  <Th className="text-center">Masuk M/T</Th>
                  <Th className="text-center">Keluar M/T</Th>
                  <Th className="text-center">Lot kosong M/T</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {blocks.map((b) => (
                  <tr key={b.from}>
                    <Td>
                      {h(b.from)}.00–{h(b.to % 24)}.00
                    </Td>
                    <Td className="text-center">
                      {b.carIn}/{b.motorIn}
                    </Td>
                    <Td className="text-center">
                      {b.carOut}/{b.motorOut}
                    </Td>
                    <Td className="text-center">
                      {b.carFree}/{b.motorFree}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        <Card title="Per pos">
          {perPost.length === 0 ? (
            <Empty title="Belum ada laporan" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Pos</Th>
                  <Th className="text-center">Masuk M/T</Th>
                  <Th className="text-center">Karcis M/T</Th>
                  <Th className="text-right">Pendapatan</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {perPost.map((p) => (
                  <tr key={p.post}>
                    <Td className="font-semibold">{p.post}</Td>
                    <Td className="text-center">
                      {p.carIn}/{p.motorIn}
                    </Td>
                    <Td className="text-center">
                      {p.ticketCar}/{p.ticketMotor}
                    </Td>
                    <Td className="text-right">{rupiah(p.revenue)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
      <Card title={`Semua laporan per jam · ${fmtDate(date)}`}>
        {data.rows.length === 0 ? (
          <Empty title="Belum ada laporan" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Jam</Th>
                <Th>Petugas</Th>
                <Th className="text-center">Masuk M/T</Th>
                <Th className="text-center">Keluar M/T</Th>
                <Th className="text-center">Karcis M/T</Th>
                <Th className="text-right">Pendapatan</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {data.rows.map((r) => (
                <tr key={r.id} className={r.mismatch.any ? 'bg-rose-50' : ''}>
                  <Td>{hourLabel(r.hour)}</Td>
                  <Td>
                    <div className="font-medium">{r.fullName}</div>
                    <div className="text-xs text-slate-500">{r.postLabel ?? '—'}</div>
                    {r.note && <div className="text-xs text-slate-600">“{r.note}”</div>}
                  </Td>
                  <Td className="text-center">
                    {r.carIn}/{r.motorIn}
                  </Td>
                  <Td className="text-center">
                    {r.carOut}/{r.motorOut}
                  </Td>
                  <Td className="text-center">
                    {r.ticketCar}/{r.ticketMotor}
                    {r.mismatch.any && <div className="text-xs font-semibold text-rose-700">selisih {mismatchText(r.mismatch)}</div>}
                  </Td>
                  <Td className="text-right">{rupiah(r.revenue)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

// ─────────── Stok karcis ───────────
interface StockResponse {
  stock: { type: 'MOBIL' | 'MOTOR'; received: number; used: number; voided: number; remaining: number }[];
  batches: { id: number; type: string; serialFrom: number; serialTo: number; count: number; receivedDate: string; note: string | null; recordedBy: string }[];
  voids: { id: number; type: string; serial: string; reason: string; date: string; note: string | null; reportedBy: string }[];
}
function Stok() {
  const { toast } = useFeedback();
  const { data, reload } = useLoad(() => api.get<StockResponse>('/parking/tickets'));
  const blank = { type: 'MOBIL', serialFrom: 0, serialTo: 0, receivedDate: todayWIT(), note: '' };
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post('/parking/tickets/batches', { ...form, note: form.note || undefined });
      toast(`${form.serialTo - form.serialFrom + 1} karcis ${form.type.toLowerCase()} dicatat`);
      setForm({ ...blank, type: form.type });
      reload();
    } catch (err) {
      toast(errMsg(err), 'error');
    } finally {
      setSaving(false);
    }
  }

  if (!data) return <Loading />;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {data.stock.map((s) => (
          <Card key={s.type} title={`Karcis ${s.type === 'MOBIL' ? 'mobil' : 'motor'}`}>
            <div className="grid grid-cols-4 gap-2 text-center text-sm">
              <div>
                <div className="text-xs text-slate-500">Diterima</div>
                <div className="text-lg font-bold">{s.received}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Terpakai</div>
                <div className="text-lg font-bold">{s.used}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Batal/hilang</div>
                <div className="text-lg font-bold">{s.voided}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Perkiraan sisa</div>
                <div className={cx('text-lg font-bold', s.remaining < 0 ? 'text-rose-600' : 'text-emerald-700')}>{s.remaining}</div>
              </div>
            </div>
          </Card>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-2" title="Catat Karcis Diterima" subtitle="Sesuai bukti serah terima dari Manajemen (SOP 6.6)">
          <form onSubmit={submit} className="space-y-3">
            <Field label="Jenis">
              <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                <option value="MOBIL">Mobil</option>
                <option value="MOTOR">Motor</option>
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <NumField label="Nomor seri awal" value={form.serialFrom} onChange={(n) => setForm({ ...form, serialFrom: n })} />
              <NumField label="Nomor seri akhir" value={form.serialTo} onChange={(n) => setForm({ ...form, serialTo: n })} />
            </div>
            <Field label="Tanggal terima">
              <Input type="date" max={todayWIT()} value={form.receivedDate} onChange={(e) => setForm({ ...form, receivedDate: e.target.value })} />
            </Field>
            <Field label="Catatan">
              <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} maxLength={300} />
            </Field>
            <p className="text-sm text-slate-600">Jumlah: {Math.max(0, form.serialTo - form.serialFrom + 1)} lembar</p>
            <Button type="submit" loading={saving} className="w-full">
              Simpan
            </Button>
          </form>
        </Card>
        <Card className="lg:col-span-3" title="Riwayat Penerimaan">
          {data.batches.length === 0 ? (
            <Empty title="Belum ada karcis yang dicatat" />
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {data.batches.map((b) => (
                <li key={b.id} className="flex flex-wrap justify-between gap-2 py-2">
                  <span>
                    <b>{b.type === 'MOBIL' ? 'Mobil' : 'Motor'}</b> {b.serialFrom}–{b.serialTo} ({b.count} lembar){b.note && <span className="text-slate-500"> · {b.note}</span>}
                  </span>
                  <span className="text-slate-500">
                    {fmtDate(b.receivedDate, false)} · {b.recordedBy}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <Card title="Karcis Batal / Hilang" subtitle="Dicatat petugas per nomor seri">
        {data.voids.length === 0 ? (
          <Empty title="Belum ada" />
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {data.voids.map((v) => (
              <li key={v.id} className="flex flex-wrap justify-between gap-2 py-2">
                <span>
                  {v.type === 'MOBIL' ? 'Mobil' : 'Motor'} <b>{v.serial}</b> · {v.reason === 'BATAL' ? 'Batal' : 'Hilang'}
                  {v.note && <span className="text-slate-500"> · {v.note}</span>}
                </span>
                <span className="text-slate-500">
                  {fmtDate(v.date, false)} · {v.reportedBy}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ─────────── Setoran ───────────
function useRange() {
  const today = todayWIT();
  const [range, setRange] = useState({ from: addDays(today, -6), to: today });
  const picker = (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Input type="date" value={range.from} max={range.to} onChange={(e) => setRange({ ...range, from: e.target.value })} className="!w-auto" />
      <span>s.d.</span>
      <Input type="date" value={range.to} min={range.from} max={today} onChange={(e) => setRange({ ...range, to: e.target.value })} className="!w-auto" />
    </div>
  );
  return { range, picker };
}

function SetoranReview() {
  const { toast } = useFeedback();
  const { user } = useAuth();
  const { range, picker } = useRange();
  const { data, reload } = useLoad(() => api.get<DepositRow[]>(`/parking/deposits?from=${range.from}&to=${range.to}`), [range.from, range.to]);
  const [review, setReview] = useState<DepositRow | null>(null);
  const [note, setNote] = useState('');

  async function decide(status: 'DITERIMA' | 'SELISIH') {
    if (!review) return;
    try {
      await api.patch(`/parking/deposits/${review.id}/review`, { status, note: note || undefined });
      toast(status === 'DITERIMA' ? 'Setoran diterima' : 'Setoran ditandai ada selisih');
      setReview(null);
      setNote('');
      reload();
    } catch (err) {
      toast(errMsg(err), 'error');
    }
  }

  return (
    <Card title="Setoran Petugas" subtitle="Bandingkan uang disetor dengan karcis × tarif dan dengan laporan per jam petugas" actions={picker}>
      {!data ? (
        <Loading />
      ) : data.length === 0 ? (
        <Empty title="Belum ada setoran di rentang ini" />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Tanggal</Th>
              <Th>Petugas</Th>
              <Th className="text-right">Disetor</Th>
              <Th className="text-right">Seharusnya</Th>
              <Th className="text-right">Menurut laporan jam</Th>
              <Th>Status</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {data.map((d) => (
              <tr key={d.id} className={d.diff !== 0 ? 'bg-amber-50' : ''}>
                <Td>{fmtDate(d.date, false)}</Td>
                <Td>
                  <div className="font-medium">{d.fullName}</div>
                  <div className="text-xs text-slate-500">
                    karcis {d.ticketCar} mobil, {d.ticketMotor} motor
                  </div>
                  {d.note && <div className="text-xs text-slate-600">“{d.note}”</div>}
                </Td>
                <Td className="text-right font-semibold">{rupiah(d.amount)}</Td>
                <Td className="text-right">
                  {rupiah(d.expected)}
                  {d.diff !== 0 && <div className="text-xs text-rose-700">{rupiah(d.diff)}</div>}
                </Td>
                <Td className="text-right">{d.reportedRevenue !== undefined ? rupiah(d.reportedRevenue) : '—'}</Td>
                <Td>
                  <StatusPill status={d.status} />
                  {d.reviewNote && <div className="text-xs text-slate-500">{d.reviewNote}</div>}
                </Td>
                <Td className="whitespace-nowrap">
                  {d.hasPhoto && (
                    <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => openProtectedFile(`/parking/deposits/${d.id}/photo`)}>
                      Bukti
                    </Button>
                  )}
                  {d.status === 'MENUNGGU' && d.userId !== user?.id && (
                    <Button className="!px-2 !py-1 text-xs" onClick={() => setReview(d)}>
                      Periksa
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Modal open={!!review} title="Periksa Setoran" onClose={() => setReview(null)}>
        {review && (
          <div className="space-y-3">
            <p className="text-sm">
              {review.fullName} menyetor <b>{rupiah(review.amount)}</b>; seharusnya <b>{rupiah(review.expected)}</b>
              {review.diff !== 0 && <span className="text-rose-700"> (selisih {rupiah(review.diff)})</span>}.
            </p>
            <Field label="Catatan" hint="Wajib bila ada selisih (SOP 6.8)">
              <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="danger" onClick={() => decide('SELISIH')}>
                Ada Selisih
              </Button>
              <Button variant="success" onClick={() => decide('DITERIMA')}>
                Diterima Sesuai
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </Card>
  );
}

// ─────────── Serah terima ───────────
function SerahReview() {
  const { toast } = useFeedback();
  const { range, picker } = useRange();
  const { data, reload } = useLoad(() => api.get<HandoverRow[]>(`/parking/handovers?from=${range.from}&to=${range.to}`), [range.from, range.to]);

  async function acknowledge(h: HandoverRow) {
    try {
      await api.patch(`/parking/handovers/${h.id}/acknowledge`, {});
      toast('Serah terima ditandai diketahui');
      reload();
    } catch (err) {
      toast(errMsg(err), 'error');
    }
  }

  return (
    <Card title="Serah Terima Shift" subtitle="Setelah penerima mengonfirmasi, Koordinator menandai Diketahui (Lampiran A)" actions={picker}>
      {!data ? (
        <Loading />
      ) : data.length === 0 ? (
        <Empty title="Belum ada serah terima" />
      ) : (
        <ul className="divide-y divide-slate-100">
          {data.map((h) => (
            <li key={h.id} className="space-y-1 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-semibold">
                  {h.fromName} → {h.toName}
                </div>
                <StatusPill status={h.status} />
              </div>
              <div className="text-xs text-slate-500">
                {fmtDate(h.date)}
                {h.postLabel && ` · ${h.postLabel}`}
                {h.acknowledgedBy && ` · diketahui ${h.acknowledgedBy}`}
              </div>
              <div className="text-sm">
                Sisa karcis {h.remainingCar} mobil (seri {h.lastSerialCar ?? '—'}), {h.remainingMotor} motor (seri {h.lastSerialMotor ?? '—'}) · uang {rupiah(h.cashAmount)}
              </div>
              <Detail label="Karcis batal/hilang">{h.voidNote}</Detail>
              <Detail label="Uang">{h.cashNote}</Detail>
              <Detail label="Perlengkapan">{h.equipment}</Detail>
              <Detail label="Belum selesai">{h.pendingIssues}</Detail>
              {h.status === 'DITERIMA' && (
                <Button className="mt-1 !py-1 text-xs" onClick={() => acknowledge(h)}>
                  Tandai Diketahui
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ─────────── Kejadian ───────────
function KejadianReview() {
  const { toast } = useFeedback();
  const { range, picker } = useRange();
  const { data, reload } = useLoad(() => api.get<IncidentRow[]>(`/parking/incidents?from=${range.from}&to=${range.to}`), [range.from, range.to]);
  const [review, setReview] = useState<IncidentRow | null>(null);
  const [status, setStatus] = useState<IncidentRow['status']>('DITINDAKLANJUTI');
  const [note, setNote] = useState('');

  async function save() {
    if (!review) return;
    try {
      await api.patch(`/parking/incidents/${review.id}/review`, { status, note: note || undefined });
      toast('Status kejadian diperbarui');
      setReview(null);
      reload();
    } catch (err) {
      toast(errMsg(err), 'error');
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <Card className="lg:col-span-3" title="Laporan Kejadian" subtitle="Foto dan data pengunjung hanya untuk Manajemen (SOP 7.4)" actions={picker}>
        {!data ? (
          <Loading />
        ) : (
          <IncidentList
            rows={data}
            onReview={(r) => {
              setReview(r);
              setStatus(r.status === 'BARU' ? 'DITINDAKLANJUTI' : r.status);
              setNote(r.reviewNote ?? '');
            }}
          />
        )}
      </Card>
      <Card className="lg:col-span-2" title="Buat Laporan Kejadian">
        <IncidentForm onSaved={reload} />
      </Card>
      <Modal open={!!review} title="Tindak Lanjut Kejadian" onClose={() => setReview(null)}>
        <div className="space-y-3">
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value as IncidentRow['status'])}>
              <option value="BARU">Baru</option>
              <option value="DITINDAKLANJUTI">Ditindaklanjuti</option>
              <option value="SELESAI">Selesai</option>
            </Select>
          </Field>
          <Field label="Catatan tindak lanjut">
            <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          </Field>
          <div className="flex justify-end">
            <Button onClick={save}>Simpan</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ─────────── Pengaturan (Super Admin) ───────────
function Pengaturan({ current }: { current: ParkingSettings }) {
  const { toast, confirm } = useFeedback();
  const [form, setForm] = useState(current);
  const [saving, setSaving] = useState(false);
  useEffect(() => setForm(current), [current]);

  async function save() {
    const turningOn = (form.karcisEnabled && !current.karcisEnabled) || (form.kejadianEnabled && !current.kejadianEnabled);
    if (turningOn) {
      const ok = await confirm({
        title: 'Aktifkan untuk petugas?',
        message: 'Menu Operasional Parkir akan langsung muncul di aplikasi semua petugas. Pastikan SOP sudah disosialisasikan.',
        confirmLabel: 'Aktifkan',
      });
      if (!ok) return;
    }
    setSaving(true);
    try {
      const saved = await api.put<ParkingSettings>('/parking/settings', form);
      setParkingSettingsCache(saved);
      toast('Pengaturan parkir disimpan');
    } catch (err) {
      toast(errMsg(err), 'error');
    } finally {
      setSaving(false);
    }
  }

  const Toggle = ({ k, title, desc }: { k: 'karcisEnabled' | 'kejadianEnabled'; title: string; desc: string }) => (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl p-3 ring-1 ring-slate-200 hover:bg-slate-50">
      <input type="checkbox" className="mt-1" checked={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.checked })} />
      <span>
        <span className="font-semibold">{title}</span>
        <span className="block text-sm text-slate-500">{desc}</span>
      </span>
    </label>
  );

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Aktifkan Modul" subtitle="Bawaan mati. Selama mati, menu ini tidak terlihat oleh petugas; Super Admin tetap bisa menyiapkan dan mencoba">
        <div className="space-y-2">
          <Toggle k="karcisEnabled" title="Karcis, setoran & serah terima" desc="Laporan per jam, stok karcis, karcis batal/hilang, setoran uang, dan serah terima shift" />
          <Toggle k="kejadianEnabled" title="Laporan kejadian" desc="Petugas melaporkan kejadian lapangan beserta foto. Bisa diaktifkan walau karcis belum dipakai" />
        </div>
      </Card>
      <Card title="Tarif & Kapasitas" subtitle="Tarif dipakai untuk menghitung pendapatan = karcis × tarif">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <NumField label="Tarif mobil (Rp)" value={form.rateCar} onChange={(n) => setForm({ ...form, rateCar: n })} />
            <NumField label="Tarif motor (Rp)" value={form.rateMotor} onChange={(n) => setForm({ ...form, rateMotor: n })} />
            <NumField label="Kapasitas lot mobil" value={form.carLots} onChange={(n) => setForm({ ...form, carLots: n })} />
            <NumField label="Kapasitas lot motor" value={form.motorLots} onChange={(n) => setForm({ ...form, motorLots: n })} />
          </div>
          <Field label="Karcis diterbitkan saat" hint="Dasar pencocokan selisih: jumlah kendaraan masuk (atau keluar) harus sama dengan karcis">
            <Select value={form.ticketAt} onChange={(e) => setForm({ ...form, ticketAt: e.target.value as ParkingSettings['ticketAt'] })}>
              <option value="MASUK">Kendaraan masuk</option>
              <option value="KELUAR">Kendaraan keluar</option>
            </Select>
          </Field>
        </div>
      </Card>
      <div className="flex justify-end lg:col-span-2">
        <Button onClick={save} loading={saving}>
          Simpan Pengaturan
        </Button>
      </div>
    </div>
  );
}
