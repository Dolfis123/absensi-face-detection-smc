import { FormEvent, useEffect, useState } from 'react';
import { useLoad } from '../../components/attendance';
import { useFeedback } from '../../components/feedback';
import { Alert, Button, Card, cx, Empty, Field, Input, Loading, PageHeader, Textarea } from '../../components/ui';
import { api, errMsg } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, todayWIT } from '../../lib/format';

interface Report {
  id: number;
  date: string;
  time: string;
  carParked: number;
  motorParked: number;
  carOut: number;
  motorOut: number;
  capacityCar: number;
  capacityMotor: number;
  note: string | null;
  createdBy: string;
  createdById: number;
  text: string;
}
interface DayData {
  date: string;
  settings: { capacityCar: number; capacityMotor: number };
  reports: Report[];
}

const nowHM = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(11, 16);
const pct = (n: number, cap: number) => (cap ? Math.round((n / cap) * 100) : 0);

async function copyText(t: string) {
  try {
    await navigator.clipboard.writeText(t);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = t;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}
const waLink = (t: string) => `https://wa.me/?text=${encodeURIComponent(t)}`;

/** Laporan update parkiran tiap ±2 jam: isi angka, sistem menyusun teks siap tempel ke WhatsApp. */
export default function LaporanKendaraan() {
  const { toast, confirm } = useFeedback();
  const { user } = useAuth();
  const isAdmin = user?.role === 'SUPER_ADMIN';
  const canManage = isAdmin || user?.role === 'KOORDINATOR';
  const [date, setDate] = useState(todayWIT());
  const { data, error, loading, reload } = useLoad(() => api.get<DayData>(`/parking-status?date=${date}`), [date]);
  const [f, setF] = useState({ time: nowHM(), carParked: '', carOut: '', motorParked: '', motorOut: '', note: '' });
  const [saving, setSaving] = useState(false);
  const [shown, setShown] = useState<Report | null>(null);

  useEffect(() => setShown(null), [date]);
  if (loading && !data) return <Loading />;
  if (!data) return <Alert>{error}</Alert>;

  const cap = data.settings;
  const isToday = date === todayWIT();
  const last = data.reports[data.reports.length - 1];
  const v = (k: 'carParked' | 'carOut' | 'motorParked' | 'motorOut') => (f[k] === '' ? null : Number(f[k]));
  const warnOut = (k: 'carOut' | 'motorOut') => last && v(k) !== null && v(k)! < last[k];

  async function submit(e: FormEvent) {
    e.preventDefault();
    const vals = { carParked: v('carParked'), carOut: v('carOut'), motorParked: v('motorParked'), motorOut: v('motorOut') };
    if (Object.values(vals).some((x) => x === null || Number.isNaN(x) || x < 0)) return toast('Isi keempat angka kendaraan', 'error');
    setSaving(true);
    try {
      const r = await api.post<Report>('/parking-status', { ...vals, time: f.time, note: f.note || undefined });
      await copyText(r.text);
      toast('Laporan tersimpan dan teks sudah disalin. Tinggal tempel di WhatsApp.');
      setShown(r);
      setF({ time: nowHM(), carParked: '', carOut: '', motorParked: '', motorOut: '', note: '' });
      reload();
    } catch (err) {
      toast(errMsg(err), 'error');
    } finally {
      setSaving(false);
    }
  }

  const numField = (k: 'carParked' | 'carOut' | 'motorParked' | 'motorOut', label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <Input type="number" inputMode="numeric" min={0} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value.replace(/\D/g, '') })} placeholder="0" />
    </Field>
  );
  const live = (parked: number | null, capN: number) =>
    parked === null ? null : (
      <span className={cx('text-xs', pct(parked, capN) >= 85 ? 'text-rose-700' : pct(parked, capN) >= 50 ? 'text-amber-700' : 'text-emerald-700')}>
        Lot kosong {Math.max(0, capN - parked)} · terisi {pct(parked, capN)}%
      </span>
    );

  return (
    <>
      <PageHeader
        title="Laporan Kendaraan"
        subtitle="Laporan update parkiran untuk pimpinan (±2 jam sekali). Isi jumlah kendaraan, lalu teks laporan otomatis tersalin dan siap ditempel di WhatsApp."
      />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {isToday ? (
          <Card title="Buat laporan baru" subtitle={`Kapasitas: mobil ${cap.capacityCar} lot · motor ${cap.capacityMotor} lot`}>
            <form onSubmit={submit} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Jam laporan (WIT)">
                  <Input type="time" value={f.time} onChange={(e) => e.target.value && setF({ ...f, time: e.target.value })} />
                </Field>
              </div>
              <div className="rounded-xl border border-slate-200 p-3">
                <p className="mb-2 text-sm font-semibold text-slate-800">🚗 Mobil</p>
                <div className="grid grid-cols-2 gap-3">
                  {numField('carParked', 'Sedang terisi (unit)')}
                  {numField('carOut', 'Keluar sejak buka (unit)', last ? `Laporan ${last.time}: ${last.carOut}` : 'Jumlah kumulatif hari ini')}
                </div>
                <div className="mt-1">{live(v('carParked'), cap.capacityCar)}</div>
                {warnOut('carOut') && <p className="mt-1 text-xs text-amber-700">Keluar lebih kecil dari laporan sebelumnya ({last!.carOut}). Angka keluar dihitung sejak buka, jadi biasanya terus naik.</p>}
              </div>
              <div className="rounded-xl border border-slate-200 p-3">
                <p className="mb-2 text-sm font-semibold text-slate-800">🏍️ Motor</p>
                <div className="grid grid-cols-2 gap-3">
                  {numField('motorParked', 'Sedang terisi (unit)')}
                  {numField('motorOut', 'Keluar sejak buka (unit)', last ? `Laporan ${last.time}: ${last.motorOut}` : 'Jumlah kumulatif hari ini')}
                </div>
                <div className="mt-1">{live(v('motorParked'), cap.capacityMotor)}</div>
                {warnOut('motorOut') && <p className="mt-1 text-xs text-amber-700">Keluar lebih kecil dari laporan sebelumnya ({last!.motorOut}).</p>}
              </div>
              <Field label="Catatan (opsional)" hint="mis. Ada acara di lobi, lot B4 ditutup sementara">
                <Textarea rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
              </Field>
              <Button type="submit" className="w-full" icon="send" loading={saving}>
                Simpan & salin teks laporan
              </Button>
            </form>
          </Card>
        ) : (
          <Card title="Laporan tanggal lain">
            <p className="text-sm text-slate-600">Laporan baru hanya bisa dibuat untuk hari ini. Laporan {fmtDate(date, false)} bisa dilihat dan disalin ulang di sebelah kanan.</p>
          </Card>
        )}

        <Card
          title={shown ? `Teks laporan pukul ${shown.time}` : 'Pratinjau teks'}
          subtitle="Persis seperti yang akan tampil di WhatsApp (*tebal* menjadi huruf tebal)"
          actions={
            shown ? (
              <div className="flex gap-2">
                <Button variant="secondary" className="!px-3 !py-1.5 text-xs" icon="download" onClick={() => copyText(shown.text).then(() => toast('Teks disalin'))}>
                  Salin
                </Button>
                <a href={waLink(shown.text)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700">
                  Kirim ke WhatsApp
                </a>
              </div>
            ) : undefined
          }
        >
          {shown ? (
            <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap rounded-xl bg-[#e7f6e9] p-4 font-sans text-[13px] leading-relaxed text-slate-800">{shown.text}</pre>
          ) : (
            <Empty icon="fileText" title="Belum ada teks">
              Simpan laporan baru, atau tekan “Lihat” pada riwayat di bawah.
            </Empty>
          )}
        </Card>
      </div>

      <Card
        className="mt-4"
        title="Riwayat laporan"
        subtitle="Perubahan dihitung dari laporan sebelumnya di hari yang sama"
        actions={<Input type="date" className="!w-40" value={date} max={todayWIT()} onChange={(e) => e.target.value && setDate(e.target.value)} />}
      >
        {data.reports.length === 0 ? (
          <Empty icon="inbox" title={`Belum ada laporan ${isToday ? 'hari ini' : fmtDate(date, false)}`} />
        ) : (
          <div className="space-y-2">
            {[...data.reports].reverse().map((r) => (
              <div key={r.id} className={cx('flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border p-3 text-sm', shown?.id === r.id ? 'border-brand-300 bg-brand-50/50' : 'border-slate-200')}>
                <span className="w-14 font-mono font-semibold text-slate-900">{r.time}</span>
                <span className="text-slate-700">
                  🚗 terisi <b>{r.carParked}</b>/{r.capacityCar} ({pct(r.carParked, r.capacityCar)}%) · keluar {r.carOut}
                </span>
                <span className="text-slate-700">
                  🏍️ terisi <b>{r.motorParked}</b>/{r.capacityMotor} ({pct(r.motorParked, r.capacityMotor)}%) · keluar {r.motorOut}
                </span>
                <span className="text-xs text-slate-400">oleh {r.createdBy}</span>
                <span className="ml-auto flex gap-1">
                  <Button variant="ghost" className="!px-2.5 !py-1 text-xs" onClick={() => setShown(r)}>
                    Lihat
                  </Button>
                  <Button variant="ghost" className="!px-2.5 !py-1 text-xs" onClick={() => copyText(r.text).then(() => toast(`Teks laporan ${r.time} disalin`))}>
                    Salin
                  </Button>
                  {(isAdmin || (isToday && r.createdById === user?.id)) && (
                    <Button
                      variant="ghost"
                      className="!px-2.5 !py-1 text-xs text-rose-600"
                      onClick={async () => {
                        if (!(await confirm({ title: `Hapus laporan ${r.time}?`, message: 'Laporan sesudahnya akan menghitung perubahan dari laporan sebelumnya.', confirmLabel: 'Hapus', danger: true }))) return;
                        await api.del(`/parking-status/${r.id}`).catch((e) => toast(errMsg(e), 'error'));
                        if (shown?.id === r.id) setShown(null);
                        reload();
                      }}
                    >
                      Hapus
                    </Button>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {canManage && <DelegatesCard />}
      {isAdmin && <CapacityCard value={cap} onSaved={reload} />}
    </>
  );
}

/** Karyawan yang boleh membuat laporan saat Koordinator Off (Koordinator & Super Admin yang memilih). */
function DelegatesCard() {
  const { toast } = useFeedback();
  const { data, reload } = useLoad(() => api.get<{ userId: number; fullName: string; delegate: boolean }[]>('/parking-status/delegates'));
  const [sel, setSel] = useState<number[] | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => setSel(data ? data.filter((d) => d.delegate).map((d) => d.userId) : null), [data]);
  if (!data || !sel) return null;
  const dirty = JSON.stringify([...sel].sort()) !== JSON.stringify(data.filter((d) => d.delegate).map((d) => d.userId).sort());
  return (
    <Card
      className="mt-4"
      title="Karyawan pembantu laporan"
      subtitle="Karyawan yang dicentang bisa membuat laporan ini dari HP-nya (mis. saat Koordinator Off). Tanda tangannya: “a.n. Koordinator Lapangan” dengan nama karyawan itu."
      actions={
        <Button
          disabled={!dirty}
          loading={saving}
          onClick={async () => {
            setSaving(true);
            try {
              await api.put('/parking-status/delegates', { userIds: sel });
              toast('Daftar pembantu laporan tersimpan');
              reload();
            } catch (e) {
              toast(errMsg(e), 'error');
            } finally {
              setSaving(false);
            }
          }}
        >
          Simpan
        </Button>
      }
    >
      <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
        {data.map((d) => (
          <label key={d.userId} className={cx('flex items-center gap-2 rounded-lg border px-3 py-2 text-sm', sel.includes(d.userId) ? 'border-brand-300 bg-brand-50/60' : 'border-slate-200')}>
            <input type="checkbox" checked={sel.includes(d.userId)} onChange={(e) => setSel(e.target.checked ? [...sel, d.userId] : sel.filter((x) => x !== d.userId))} />
            {d.fullName}
          </label>
        ))}
      </div>
    </Card>
  );
}

function CapacityCard({ value, onSaved }: { value: DayData['settings']; onSaved: () => void }) {
  const { toast } = useFeedback();
  const [v, setV] = useState(value);
  const [saving, setSaving] = useState(false);
  useEffect(() => setV(value), [value]);
  const dirty = v.capacityCar !== value.capacityCar || v.capacityMotor !== value.capacityMotor;
  return (
    <Card className="mt-4" title="Kapasitas lot parkir" subtitle="Khusus Super Admin. Dipakai untuk menghitung lot kosong dan persentase keterisian.">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Lot mobil">
          <Input type="number" min={1} className="!w-32" value={v.capacityCar} onChange={(e) => setV({ ...v, capacityCar: Math.max(1, Number(e.target.value) || 1) })} />
        </Field>
        <Field label="Lot motor">
          <Input type="number" min={1} className="!w-32" value={v.capacityMotor} onChange={(e) => setV({ ...v, capacityMotor: Math.max(1, Number(e.target.value) || 1) })} />
        </Field>
        <Button
          disabled={!dirty}
          loading={saving}
          onClick={async () => {
            setSaving(true);
            try {
              await api.put('/parking-status/settings', v);
              toast('Kapasitas tersimpan');
              onSaved();
            } catch (e) {
              toast(errMsg(e), 'error');
            } finally {
              setSaving(false);
            }
          }}
        >
          Simpan
        </Button>
      </div>
    </Card>
  );
}
