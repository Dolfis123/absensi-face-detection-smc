import { FormEvent, useEffect, useState } from 'react';
import { useLoad } from '../../components/attendance';
import { useFeedback } from '../../components/feedback';
import { Alert, Badge, Button, Card, cx, Empty, Field, Input, Loading, PageHeader, Select, Textarea } from '../../components/ui';
import { api, errMsg, openProtectedFile } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, todayWIT } from '../../lib/format';
import { DepositRow, HandoverRow, hourLabel, HourlyRow, IncidentRow, mismatchText, ParkingSettings, rupiah, useParkingSettings } from '../../lib/parking';
import { Detail, IncidentForm, IncidentList, NumField, StatusPill, Tabs } from './shared';

type Tab = 'jam' | 'setoran' | 'serah' | 'batal' | 'kejadian';

/** Halaman petugas: laporan per jam, setoran, serah terima shift, karcis batal, dan laporan kejadian. */
export default function OperasionalPetugas() {
  const settings = useParkingSettings();
  const [tab, setTab] = useState<Tab>('jam');
  if (!settings) return <Loading />;
  const tabs = [
    ...(settings.karcisEnabled
      ? ([
          { key: 'jam', label: 'Laporan Per Jam' },
          { key: 'setoran', label: 'Setoran' },
          { key: 'serah', label: 'Serah Terima' },
          { key: 'batal', label: 'Karcis Batal/Hilang' },
        ] as const)
      : []),
    ...(settings.kejadianEnabled ? ([{ key: 'kejadian', label: 'Lapor Kejadian' }] as const) : []),
  ];
  if (tabs.length === 0) return <Alert kind="info">Fitur operasional parkir belum diaktifkan oleh Super Admin.</Alert>;
  const active = tabs.some((t) => t.key === tab) ? tab : tabs[0].key;
  return (
    <>
      <PageHeader title="Operasional Parkir" subtitle="Laporan karcis, setoran, serah terima shift, dan kejadian di pos" />
      <Tabs tabs={[...tabs]} value={active} onChange={setTab} />
      {active === 'jam' && <LaporanJam />}
      {active === 'setoran' && <Setoran settings={settings} />}
      {active === 'serah' && <SerahTerima />}
      {active === 'batal' && <KarcisBatal />}
      {active === 'kejadian' && <Kejadian />}
    </>
  );
}

// ─────────── Laporan per jam ───────────
interface MineResponse {
  settings: ParkingSettings;
  date: string;
  currentHour: number;
  shift: { name: string; startTime: string; endTime: string } | null;
  post: string | null;
  hours: number[];
  missing: number[];
  reports: HourlyRow[];
}
const EMPTY_COUNTS = { carIn: 0, motorIn: 0, carOut: 0, motorOut: 0, ticketCar: 0, ticketMotor: 0, note: '' };

function LaporanJam() {
  const { toast } = useFeedback();
  const { data, error, loading, reload } = useLoad(() => api.get<MineResponse>('/parking/reports/mine'));
  const [hour, setHour] = useState<number | null>(null);
  const [form, setForm] = useState(EMPTY_COUNTS);
  const [saving, setSaving] = useState(false);

  // Pilih otomatis jam yang belum dilaporkan, lalu isi formulir dengan laporan yang sudah ada (bila diubah)
  useEffect(() => {
    if (!data) return;
    const h = hour ?? data.missing[0] ?? data.hours.at(-1) ?? null;
    if (hour === null && h !== null) setHour(h);
    const existing = data.reports.find((r) => r.hour === h);
    setForm(existing ? { ...existing, note: existing.note ?? '' } : EMPTY_COUNTS);
  }, [data, hour]);

  if (loading && !data) return <Loading />;
  if (!data) return <Alert>{error}</Alert>;
  if (!data.shift) return <Alert kind="info">Anda tidak punya jadwal shift hari ini, jadi tidak ada laporan per jam.</Alert>;
  const s = data.settings;
  const set = (k: keyof typeof EMPTY_COUNTS) => (n: number) => setForm({ ...form, [k]: n });
  const liveMismatch = {
    car: (s.ticketAt === 'MASUK' ? form.carIn : form.carOut) - form.ticketCar,
    motor: (s.ticketAt === 'MASUK' ? form.motorIn : form.motorOut) - form.ticketMotor,
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (hour === null) return;
    setSaving(true);
    try {
      const { carIn, motorIn, carOut, motorOut, ticketCar, ticketMotor, note } = form;
      const r = await api.post<{ updated: boolean; mismatch: { car: number; motor: number; any: boolean } }>('/parking/reports', {
        hour,
        carIn,
        motorIn,
        carOut,
        motorOut,
        ticketCar,
        ticketMotor,
        note: note || undefined,
      });
      toast(r.mismatch.any ? `Laporan tersimpan, tetapi ada selisih karcis: ${mismatchText(r.mismatch)}` : `Laporan jam ${hourLabel(hour)} tersimpan`, r.mismatch.any ? 'error' : 'success');
      setHour(null);
      reload();
    } catch (err) {
      toast(errMsg(err), 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <Card className="lg:col-span-2" title={`${data.shift.name} · ${data.shift.startTime}–${data.shift.endTime}`} subtitle={data.post ? `Pos: ${data.post}` : undefined}>
        {data.missing.length > 0 && (
          <div className="mb-3">
            <Alert>Belum lapor: {data.missing.map(hourLabel).join(', ')}</Alert>
          </div>
        )}
        <form onSubmit={submit} className="space-y-3">
          <Field label="Jam laporan">
            <Select value={hour ?? ''} onChange={(e) => setHour(Number(e.target.value))}>
              {data.hours.map((h) => (
                <option key={h} value={h}>
                  {hourLabel(h)} {data.reports.some((r) => r.hour === h) ? '· sudah (ubah)' : data.missing.includes(h) ? '· belum' : ''}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <NumField label="Mobil masuk" value={form.carIn} onChange={set('carIn')} />
            <NumField label="Motor masuk" value={form.motorIn} onChange={set('motorIn')} />
            <NumField label="Mobil keluar" value={form.carOut} onChange={set('carOut')} />
            <NumField label="Motor keluar" value={form.motorOut} onChange={set('motorOut')} />
            <NumField label="Karcis mobil terpakai" value={form.ticketCar} onChange={set('ticketCar')} />
            <NumField label="Karcis motor terpakai" value={form.ticketMotor} onChange={set('ticketMotor')} />
          </div>
          <div className={cx('rounded-lg p-3 text-sm ring-1', liveMismatch.car || liveMismatch.motor ? 'bg-rose-50 text-rose-800 ring-rose-200' : 'bg-emerald-50 text-emerald-800 ring-emerald-200')}>
            Pendapatan jam ini: <b>{rupiah(form.ticketCar * s.rateCar + form.ticketMotor * s.rateMotor)}</b>
            <div className="text-xs">
              {liveMismatch.car || liveMismatch.motor
                ? `Selisih: kendaraan ${s.ticketAt === 'MASUK' ? 'masuk' : 'keluar'} tidak sama dengan karcis (${mismatchText({ ...liveMismatch, any: true })}). Periksa lagi atau tulis penjelasannya.`
                : `Jumlah kendaraan ${s.ticketAt === 'MASUK' ? 'masuk' : 'keluar'} sama dengan karcis terpakai.`}
            </div>
          </div>
          <Field label="Catatan (bila ada)">
            <Textarea rows={2} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} maxLength={500} />
          </Field>
          <Button type="submit" loading={saving} className="w-full" disabled={hour === null}>
            Simpan Laporan
          </Button>
        </form>
      </Card>
      <Card className="lg:col-span-3" title={`Laporan hari ini · ${fmtDate(data.date)}`}>
        {data.reports.length === 0 ? (
          <Empty title="Belum ada laporan hari ini" />
        ) : (
          <div className="-mx-4 overflow-x-auto sm:mx-0">
            <table className="min-w-full text-sm">
              <thead className="text-xs text-slate-500">
                <tr>
                  <th className="px-2 py-1 text-left">Jam</th>
                  <th className="px-2 py-1">Masuk M/T</th>
                  <th className="px-2 py-1">Keluar M/T</th>
                  <th className="px-2 py-1">Karcis M/T</th>
                  <th className="px-2 py-1 text-right">Pendapatan</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.reports.map((r) => (
                  <tr key={r.id} className={r.mismatch.any ? 'bg-rose-50' : ''}>
                    <td className="px-2 py-1.5">
                      {hourLabel(r.hour)}
                      {r.mismatch.any && <div className="text-xs text-rose-700">Selisih {mismatchText(r.mismatch)}</div>}
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      {r.carIn}/{r.motorIn}
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      {r.carOut}/{r.motorOut}
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      {r.ticketCar}/{r.ticketMotor}
                    </td>
                    <td className="px-2 py-1.5 text-right">{rupiah(r.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-slate-500">M/T = mobil/motor. Laporan bisa diubah selama hari yang sama.</p>
          </div>
        )}
      </Card>
    </div>
  );
}

// ─────────── Setoran ───────────
function Setoran({ settings: s }: { settings: ParkingSettings }) {
  const { toast } = useFeedback();
  const { data, reload } = useLoad(() => api.get<DepositRow[]>('/parking/deposits/mine'));
  const blank = { date: todayWIT(), amount: 0, ticketCar: 0, ticketMotor: 0, note: '' };
  const [form, setForm] = useState(blank);
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const expected = form.ticketCar * s.rateCar + form.ticketMotor * s.rateMotor;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const fd = new FormData();
      Object.entries(form).forEach(([k, v]) => fd.append(k, String(v)));
      if (file) fd.append('photo', file);
      await api.post('/parking/deposits', fd);
      toast('Setoran tercatat dan menunggu diperiksa');
      setForm(blank);
      setFile(null);
      (e.target as HTMLFormElement).reset();
      reload();
    } catch (err) {
      toast(errMsg(err), 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <Card className="lg:col-span-2" title="Catat Setoran" subtitle="Hasil parkir disetor seluruhnya; jumlahnya harus sama dengan karcis × tarif (SOP 6.7)">
        <form onSubmit={submit} className="space-y-3">
          <Field label="Tanggal">
            <Input type="date" max={todayWIT()} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <NumField label="Karcis mobil" value={form.ticketCar} onChange={(n) => setForm({ ...form, ticketCar: n })} />
            <NumField label="Karcis motor" value={form.ticketMotor} onChange={(n) => setForm({ ...form, ticketMotor: n })} />
          </div>
          <NumField label="Uang disetor (Rp)" value={form.amount} onChange={(n) => setForm({ ...form, amount: n })} />
          <div className={cx('rounded-lg p-3 text-sm ring-1', form.amount === expected ? 'bg-emerald-50 text-emerald-800 ring-emerald-200' : 'bg-amber-50 text-amber-800 ring-amber-200')}>
            Seharusnya {rupiah(expected)} ({form.ticketCar} × {rupiah(s.rateCar)} + {form.ticketMotor} × {rupiah(s.rateMotor)})
            {form.amount !== expected && <div className="text-xs">Selisih {rupiah(form.amount - expected)}. Tulis penjelasannya di catatan.</div>}
          </div>
          <Field label="Foto bukti setoran" hint="Foto bukti yang ditandatangani penyetor dan penerima">
            <Input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
          <Field label="Catatan">
            <Textarea rows={2} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} maxLength={500} />
          </Field>
          <Button type="submit" loading={saving} className="w-full">
            Simpan Setoran
          </Button>
        </form>
      </Card>
      <Card className="lg:col-span-3" title="Riwayat Setoran Saya">
        {!data || data.length === 0 ? (
          <Empty title="Belum ada setoran" />
        ) : (
          <ul className="divide-y divide-slate-100">
            {data.map((d) => (
              <li key={d.id} className="flex flex-wrap items-start justify-between gap-2 py-3">
                <div>
                  <div className="font-semibold">{rupiah(d.amount)}</div>
                  <div className="text-xs text-slate-500">
                    {fmtDate(d.date)} · karcis {d.ticketCar} mobil, {d.ticketMotor} motor · seharusnya {rupiah(d.expected)}
                  </div>
                  {d.diff !== 0 && <div className="text-xs text-rose-700">Selisih {rupiah(d.diff)}</div>}
                  {d.reviewNote && <Detail label={`Catatan ${d.reviewedBy ?? ''}`}>{d.reviewNote}</Detail>}
                </div>
                <div className="flex items-center gap-2">
                  {d.hasPhoto && (
                    <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => openProtectedFile(`/parking/deposits/${d.id}/photo`)}>
                      Bukti
                    </Button>
                  )}
                  <StatusPill status={d.status} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ─────────── Serah terima shift ───────────
interface Candidate {
  id: number;
  fullName: string;
  shiftToday: string | null;
}
function SerahTerima() {
  const { toast, confirm } = useFeedback();
  const { user } = useAuth();
  const { data, reload } = useLoad(() => Promise.all([api.get<HandoverRow[]>('/parking/handovers/mine'), api.get<Candidate[]>('/parking/handovers/candidates')]));
  const blank = { toUserId: 0, remainingCar: 0, remainingMotor: 0, lastSerialCar: '', lastSerialMotor: '', voidNote: '', cashAmount: 0, cashNote: '', equipment: '', pendingIssues: '' };
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);
  if (!data) return <Loading />;
  const [list, candidates] = data;
  const text = (k: keyof typeof blank) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!form.toUserId) return toast('Pilih petugas penerima', 'error');
    setSaving(true);
    try {
      const payload = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v === '' ? undefined : v]));
      await api.post('/parking/handovers', payload);
      toast('Serah terima terkirim. Minta penerima mengonfirmasi di aplikasinya.');
      setForm(blank);
      reload();
    } catch (err) {
      toast(errMsg(err), 'error');
    } finally {
      setSaving(false);
    }
  }

  async function accept(h: HandoverRow) {
    const ok = await confirm({
      title: 'Terima serah terima?',
      message: `Pastikan sisa karcis (${h.remainingCar} mobil, ${h.remainingMotor} motor), uang ${rupiah(h.cashAmount)}, dan perlengkapan dari ${h.fromName} sudah Anda cek.`,
      confirmLabel: 'Ya, sudah sesuai',
    });
    if (!ok) return;
    try {
      await api.patch(`/parking/handovers/${h.id}/accept`, {});
      toast('Serah terima dikonfirmasi');
      reload();
    } catch (err) {
      toast(errMsg(err), 'error');
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <Card className="lg:col-span-2" title="Serahkan Tugas" subtitle="Isi saat pergantian shift; pos tidak boleh kosong (SOP 3.9, Lampiran A)">
        <form onSubmit={submit} className="space-y-3">
          <Field label="Diserahkan kepada">
            <Select value={form.toUserId} onChange={(e) => setForm({ ...form, toUserId: Number(e.target.value) })} required>
              <option value={0}>— pilih petugas —</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.fullName}
                  {c.shiftToday ? ` · ${c.shiftToday} hari ini` : ''}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <NumField label="Sisa karcis mobil" value={form.remainingCar} onChange={(n) => setForm({ ...form, remainingCar: n })} />
            <NumField label="Sisa karcis motor" value={form.remainingMotor} onChange={(n) => setForm({ ...form, remainingMotor: n })} />
            <Field label="No. seri terakhir mobil">
              <Input value={form.lastSerialCar} onChange={text('lastSerialCar')} maxLength={40} />
            </Field>
            <Field label="No. seri terakhir motor">
              <Input value={form.lastSerialMotor} onChange={text('lastSerialMotor')} maxLength={40} />
            </Field>
          </div>
          <Field label="Karcis batal / hilang">
            <Input value={form.voidNote} onChange={text('voidNote')} maxLength={300} placeholder="Mis. mobil 001234 batal" />
          </Field>
          <NumField label="Uang diserahkan (Rp)" value={form.cashAmount} onChange={(n) => setForm({ ...form, cashAmount: n })} hint="0 bila sudah disetor; tulis keterangannya" />
          <Field label="Keterangan uang / bukti setoran">
            <Input value={form.cashNote} onChange={text('cashNote')} maxLength={300} />
          </Field>
          <Field label="Perlengkapan">
            <Input value={form.equipment} onChange={text('equipment')} maxLength={300} placeholder="Mis. rompi, peluit, senter lengkap" />
          </Field>
          <Field label="Kejadian yang belum selesai">
            <Textarea rows={2} value={form.pendingIssues} onChange={text('pendingIssues')} maxLength={500} />
          </Field>
          <Button type="submit" loading={saving} className="w-full">
            Kirim Serah Terima
          </Button>
        </form>
      </Card>
      <Card className="lg:col-span-3" title="Serah Terima Saya">
        {list.length === 0 ? (
          <Empty title="Belum ada serah terima" />
        ) : (
          <ul className="divide-y divide-slate-100">
            {list.map((h) => (
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
                </div>
                <div className="text-sm">
                  Sisa karcis {h.remainingCar} mobil (seri {h.lastSerialCar ?? '—'}), {h.remainingMotor} motor (seri {h.lastSerialMotor ?? '—'}) · uang {rupiah(h.cashAmount)}
                </div>
                <Detail label="Karcis batal/hilang">{h.voidNote}</Detail>
                <Detail label="Uang">{h.cashNote}</Detail>
                <Detail label="Perlengkapan">{h.equipment}</Detail>
                <Detail label="Belum selesai">{h.pendingIssues}</Detail>
                {h.status === 'MENUNGGU' && h.toUserId === user?.id && (
                  <Button className="mt-1 !py-1 text-xs" onClick={() => accept(h)}>
                    Terima & Konfirmasi
                  </Button>
                )}
                {h.status === 'MENUNGGU' && h.toUserId !== user?.id && <Badge className="bg-slate-100 text-slate-600">Menunggu konfirmasi {h.toName}</Badge>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ─────────── Karcis batal / hilang ───────────
interface VoidRow {
  id: number;
  type: 'MOBIL' | 'MOTOR';
  serial: string;
  reason: 'BATAL' | 'HILANG';
  date: string;
  note: string | null;
}
function KarcisBatal() {
  const { toast } = useFeedback();
  const { data, reload } = useLoad(() => api.get<VoidRow[]>('/parking/tickets/voids/mine'));
  const blank = { type: 'MOBIL', serial: '', reason: 'BATAL', date: todayWIT(), note: '' };
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post('/parking/tickets/voids', { ...form, note: form.note || undefined });
      toast(`Karcis ${form.serial} dicatat ${form.reason.toLowerCase()}`);
      setForm({ ...blank, type: form.type, reason: form.reason });
      reload();
    } catch (err) {
      toast(errMsg(err), 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <Card className="lg:col-span-2" title="Catat Karcis Batal / Hilang" subtitle="Karcis rusak jangan dibuang: tandai BATAL, simpan, lalu catat di sini (SOP 6.6)">
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <Field label="Jenis karcis">
              <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                <option value="MOBIL">Mobil</option>
                <option value="MOTOR">Motor</option>
              </Select>
            </Field>
            <Field label="Keterangan">
              <Select value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })}>
                <option value="BATAL">Batal / rusak</option>
                <option value="HILANG">Hilang</option>
              </Select>
            </Field>
          </div>
          <Field label="Nomor seri">
            <Input value={form.serial} onChange={(e) => setForm({ ...form, serial: e.target.value })} required maxLength={40} />
          </Field>
          <Field label="Tanggal">
            <Input type="date" max={todayWIT()} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required />
          </Field>
          <Field label="Catatan">
            <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} maxLength={300} />
          </Field>
          <Button type="submit" loading={saving} className="w-full">
            Simpan
          </Button>
        </form>
      </Card>
      <Card className="lg:col-span-3" title="Yang Sudah Saya Catat">
        {!data || data.length === 0 ? (
          <Empty title="Belum ada" />
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {data.map((v) => (
              <li key={v.id} className="flex justify-between py-2">
                <span>
                  {v.type === 'MOBIL' ? 'Mobil' : 'Motor'} · <b>{v.serial}</b> {v.note && <span className="text-slate-500">· {v.note}</span>}
                </span>
                <span className="text-slate-500">
                  {v.reason === 'BATAL' ? 'Batal' : 'Hilang'} · {fmtDate(v.date, false)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ─────────── Laporan kejadian ───────────
function Kejadian() {
  const { data, reload } = useLoad(() => Promise.all([api.get<IncidentRow[]>('/parking/incidents/mine'), api.get<{ post: string | null }>('/parking/reports/mine').catch(() => ({ post: null }))]));
  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <Card className="lg:col-span-2" title="Lapor Kejadian" subtitle="Isi pada hari yang sama. Untuk keadaan darurat, hubungi Security lebih dulu (SOP 7.2)">
        <IncidentForm onSaved={reload} defaultLocation={data?.[1].post} />
      </Card>
      <Card className="lg:col-span-3" title="Laporan Kejadian Saya">
        {!data ? <Loading /> : <IncidentList rows={data[0]} />}
      </Card>
    </div>
  );
}
