import { useEffect, useState } from 'react';
import { useLoad } from '../../components/attendance';
import { useFeedback } from '../../components/feedback';
import { Alert, Badge, Button, Card, Empty, Field, Input, Loading, PageHeader, PersonCell, StatCard, Table, Td, Th } from '../../components/ui';
import { api, downloadFile, errMsg, Role } from '../../lib/api';
import { addDays, fmtDate, todayWIT } from '../../lib/format';
import { Tabs } from '../parkir/shared';

interface Settings {
  divisor: number;
  defaultWageKaryawan: number;
  defaultWageKoordinator: number;
  lateDeduction: { enabled: boolean; perCount: number; days: number };
  perfectBonus: { enabled: boolean; amount: number; allowLeave: boolean };
  bestEmployee: { enabled: boolean; count: number; amounts: number[] };
}
interface PayRow {
  user: { id: number; fullName: string; nik: string; role: Role };
  baseWage: number;
  dailyWage: number;
  workDays: number;
  present: number;
  onTime: number;
  lateCount: number;
  absenSekali: number;
  alfa: number;
  leave: { izin: number; sakit: number; cuti: number };
  offDays: number;
  alfaDates: string[];
  lateDates: string[];
  deductMangkir: number;
  lateUnits: number;
  lateSimulated: number;
  deductLate: number;
  perfect: boolean;
  bonusPerfect: number;
  rank: number | null;
  bonusRank: number;
  totalDeduction: number;
  totalBonus: number;
  takeHome: number;
  heavyDeduction: boolean;
}
interface Publication {
  id: number;
  version: number;
  publishedAt: string;
  withdrawnAt: string | null;
  total: number;
  received: Record<number, string>;
}
interface MonthData {
  rows: PayRow[];
  settings: Settings;
  until: string;
  partial: boolean;
  publication: Publication | null;
}
interface Wage {
  userId: number;
  fullName: string;
  nik: string;
  role: Role;
  baseWage: number;
  custom: boolean;
}

const when = (iso: string) => new Date(iso).toLocaleString('id-ID', { timeZone: 'Asia/Jayapura', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const rp = (n: number) => `Rp ${Math.round(n).toLocaleString('id-ID')}`;
const fileSafe = (s: string) => s.replace(/[^\w]+/g, '-');
const RANK_CLS = ['bg-amber-100 text-amber-800', 'bg-slate-200 text-slate-800', 'bg-orange-100 text-orange-800'];

/** Rekap upah berdasarkan kehadiran — khusus Super Admin. */
export default function Upah() {
  const [tab, setTab] = useState<'rekap' | 'upah' | 'pengaturan'>('rekap');
  return (
    <>
      <PageHeader title="Rekap Upah Kehadiran" subtitle="Upah pokok PKWT, potongan mangkir (Pasal 8), dan penghargaan kehadiran — khusus Super Admin" />
      <Tabs
        tabs={[
          { key: 'rekap', label: 'Rekap Bulanan' },
          { key: 'upah', label: 'Upah Pokok Karyawan' },
          { key: 'pengaturan', label: 'Pengaturan' },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'rekap' && <Rekap />}
      {tab === 'upah' && <UpahPokok />}
      {tab === 'pengaturan' && <Pengaturan />}
    </>
  );
}

function Rekap() {
  const { toast } = useFeedback();
  const today = todayWIT();
  // Bawaan: bulan lalu bila masih awal bulan (≤ tgl 5), selain itu bulan berjalan
  const [month, setMonth] = useState(Number(today.slice(8, 10)) <= 5 ? addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7) : today.slice(0, 7));
  const { data, error, loading, reload } = useLoad(() => api.get<MonthData>(`/payroll/months/${month}`), [month]);
  const [busy, setBusy] = useState<string | null>(null);

  async function dl(url: string, name: string, key: string) {
    setBusy(key);
    try {
      await downloadFile(url, name);
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(null);
    }
  }

  const rows = data?.rows ?? [];
  const s = data?.settings;
  const sum = (f: (r: PayRow) => number) => rows.reduce((a, r) => a + f(r), 0);
  const best = rows.filter((r) => r.rank).sort((a, b) => a.rank! - b.rank!);

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Bulan">
            <Input type="month" value={month} max={today.slice(0, 7)} onChange={(e) => e.target.value && setMonth(e.target.value)} />
          </Field>
          <Button icon="download" loading={busy === 'all'} disabled={!rows.length} onClick={() => dl(`/payroll/months/${month}/pdf`, `rekap-upah-kehadiran_${month}.pdf`, 'all')}>
            Unduh PDF Semua Petugas
          </Button>
          <p className="text-xs text-slate-500 sm:ml-auto sm:max-w-xs">
            PDF interaktif: klik nama di tabel rekap untuk melompat ke slip petugas; tiap slip punya tautan kembali dan daftar isi (bookmark).
          </p>
        </div>
      </Card>

      {loading && !data ? (
        <div className="mt-4">
          <Loading />
        </div>
      ) : !data ? (
        <div className="mt-4">
          <Alert>{error}</Alert>
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          {data.partial && (
            <Alert kind="info">
              Bulan masih berjalan — data dihitung sampai {fmtDate(data.until, false)}. Angka akhir baru tetap setelah bulan selesai.
            </Alert>
          )}
          <PublishCard month={month} data={data} onChange={reload} />
          {s && !s.lateDeduction.enabled && (
            <Alert kind="info">
              Potongan terlambat <b>tidak aktif</b>. Kolom "Simulasi terlambat" hanya menunjukkan berapa potongannya bila aturan ({s.lateDeduction.perCount}× terlambat ={' '}
              {s.lateDeduction.days}× upah per hari) diaktifkan — tidak mengurangi upah.
            </Alert>
          )}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Total upah pokok" value={<span className="text-xl">{rp(sum((r) => r.baseWage))}</span>} icon="users" sub={`${rows.length} karyawan`} />
            <StatCard label="Total potongan" value={<span className="text-xl">{rp(sum((r) => r.totalDeduction))}</span>} icon="userX" tone="rose" sub={`${sum((r) => r.alfa)} hari mangkir`} />
            <StatCard label="Total bonus" value={<span className="text-xl">{rp(sum((r) => r.totalBonus))}</span>} icon="sparkles" tone="violet" sub={`${rows.filter((r) => r.perfect).length} hadir sempurna`} />
            <StatCard label="Total dibayarkan" value={<span className="text-xl">{rp(sum((r) => r.takeHome))}</span>} icon="check" tone="green" sub="Belum termasuk BPJS / PPh" />
          </div>

          {best.length > 0 && (
            <Card title="Petugas Terbaik Bulan Ini" subtitle="Tanpa mangkir, terlambat di bawah batas; diurutkan dari yang paling disiplin">
              <div className="grid gap-3 sm:grid-cols-3">
                {best.map((r) => (
                  <div key={r.user.id} className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 p-3">
                    <div className="min-w-0">
                      <Badge className={RANK_CLS[r.rank! - 1] ?? 'bg-slate-100 text-slate-700'}>Terbaik #{r.rank}</Badge>
                      <p className="mt-1 truncate font-semibold">{r.user.fullName}</p>
                      <p className="text-xs text-slate-500">
                        Hadir {r.present}/{r.workDays} · terlambat {r.lateCount}×{r.bonusRank > 0 ? ` · bonus ${rp(r.bonusRank)}` : ''}
                      </p>
                    </div>
                    <Button
                      variant="secondary"
                      icon="download"
                      className="!px-2 !py-1 text-xs"
                      loading={busy === `cert-${r.user.id}`}
                      onClick={() => dl(`/payroll/months/${month}/certificate/${r.user.id}`, `piagam_${month}_${fileSafe(r.user.fullName)}.pdf`, `cert-${r.user.id}`)}
                    >
                      Piagam
                    </Button>
                  </div>
                ))}
              </div>
            </Card>
          )}

          <Card title="Rincian per karyawan">
            {rows.length === 0 ? (
              <Empty title="Belum ada data kehadiran di bulan ini" />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Karyawan</Th>
                    <Th className="text-right">Upah pokok</Th>
                    <Th className="text-center">Hadir / Hari kerja</Th>
                    <Th className="text-center">Terlambat</Th>
                    <Th className="text-center">Mangkir</Th>
                    <Th className="text-center">Izin/Sakit/Cuti</Th>
                    <Th className="text-right">Potongan</Th>
                    <Th className="text-right">Bonus</Th>
                    <Th className="text-right">Diterima</Th>
                    {data.publication && !data.publication.withdrawnAt && <Th>Slip</Th>}
                    <Th />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {rows.map((r) => (
                    <tr key={r.user.id} className={r.heavyDeduction ? 'bg-rose-50/60' : ''}>
                      <Td>
                        <PersonCell
                          name={r.user.fullName}
                          sub={
                            <span className="flex flex-wrap items-center gap-1">
                              {r.user.nik}
                              {r.user.role === 'KOORDINATOR' && ' · Koordinator'}
                              {r.rank && <Badge className={RANK_CLS[r.rank - 1] ?? 'bg-slate-100 text-slate-700'}>#{r.rank}</Badge>}
                              {r.perfect && <Badge className="bg-emerald-100 text-emerald-800">Sempurna</Badge>}
                            </span>
                          }
                        />
                      </Td>
                      <Td className="whitespace-nowrap text-right">
                        {rp(r.baseWage)}
                        <div className="text-xs text-slate-500">{rp(r.dailyWage)}/hari</div>
                      </Td>
                      <Td className="text-center">
                        {r.present}/{r.workDays}
                      </Td>
                      <Td className="text-center">
                        <span className={r.lateUnits > 0 ? 'font-semibold text-amber-700' : ''}>{r.lateCount}×</span>
                        {r.lateSimulated > 0 && (
                          <div className={`text-xs ${s?.lateDeduction.enabled ? 'text-rose-700' : 'text-slate-400'}`}>
                            {s?.lateDeduction.enabled ? '-' : 'simulasi -'}
                            {rp(r.lateSimulated)}
                          </div>
                        )}
                      </Td>
                      <Td className="text-center">
                        <span className={r.alfa > 0 ? 'font-semibold text-rose-700' : ''}>{r.alfa} hari</span>
                      </Td>
                      <Td className="text-center text-sm">
                        {r.leave.izin}/{r.leave.sakit}/{r.leave.cuti}
                      </Td>
                      <Td className="whitespace-nowrap text-right text-rose-700">{r.totalDeduction ? `-${rp(r.totalDeduction)}` : '-'}</Td>
                      <Td className="whitespace-nowrap text-right text-emerald-700">{r.totalBonus ? `+${rp(r.totalBonus)}` : '-'}</Td>
                      <Td className="whitespace-nowrap text-right font-semibold">
                        {rp(r.takeHome)}
                        {r.heavyDeduction && <div className="text-xs font-normal text-rose-700">Potongan &gt; 50% — cek HRD</div>}
                      </Td>
                      {data.publication && !data.publication.withdrawnAt && (
                        <Td className="whitespace-nowrap text-xs">
                          {data.publication.received[r.user.id] ? (
                            <span className="text-emerald-700">✓ {when(data.publication.received[r.user.id])}</span>
                          ) : (
                            <span className="text-amber-700">Belum dikonfirmasi</span>
                          )}
                        </Td>
                      )}
                      <Td>
                        <Button
                          variant="secondary"
                          icon="download"
                          className="!px-2 !py-1 text-xs"
                          loading={busy === `slip-${r.user.id}`}
                          onClick={() => dl(`/payroll/months/${month}/slip/${r.user.id}`, `slip-upah_${month}_${fileSafe(r.user.fullName)}.pdf`, `slip-${r.user.id}`)}
                        >
                          Slip
                        </Button>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
      )}
    </>
  );
}

function UpahPokok() {
  const { toast } = useFeedback();
  const { data, error, loading, reload } = useLoad(() => api.get<Wage[]>('/payroll/wages'));
  const [edit, setEdit] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState<number | null>(null);

  async function save(w: Wage) {
    const v = Number((edit[w.userId] ?? '').replace(/\D/g, ''));
    if (!v) return toast('Isi upah pokok dengan angka', 'error');
    setSaving(w.userId);
    try {
      await api.put(`/payroll/wages/${w.userId}`, { baseWage: v });
      toast(`Upah pokok ${w.fullName} disimpan`);
      setEdit(({ [w.userId]: _, ...rest }) => rest);
      reload();
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setSaving(null);
    }
  }

  if (loading && !data) return <Loading />;
  if (!data) return <Alert>{error}</Alert>;
  return (
    <Card title="Upah pokok per karyawan" subtitle="Sesuai PKWT masing-masing. Yang belum diisi memakai upah bawaan per jabatan (atur di tab Pengaturan).">
      <Table>
        <thead>
          <tr>
            <Th>Karyawan</Th>
            <Th className="text-right">Upah pokok / bulan</Th>
            <Th>Ubah</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">
          {data.map((w) => (
            <tr key={w.userId}>
              <Td>
                <PersonCell name={w.fullName} sub={w.role === 'KOORDINATOR' ? `${w.nik} · Koordinator` : w.nik} />
              </Td>
              <Td className="whitespace-nowrap text-right">
                {rp(w.baseWage)}
                <div className="text-xs text-slate-500">{w.custom ? 'Diatur khusus' : 'Bawaan jabatan'}</div>
              </Td>
              <Td>
                <div className="flex items-center gap-2">
                  <Input
                    inputMode="numeric"
                    className="!w-36"
                    placeholder={String(w.baseWage)}
                    value={edit[w.userId] ?? ''}
                    onChange={(e) => setEdit({ ...edit, [w.userId]: e.target.value })}
                  />
                  <Button className="!px-3 !py-1.5 text-xs" disabled={!edit[w.userId]} loading={saving === w.userId} onClick={() => save(w)}>
                    Simpan
                  </Button>
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

function Pengaturan() {
  const { toast } = useFeedback();
  const { data } = useLoad(() => api.get<Settings>('/payroll/settings'));
  const [f, setF] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (data) setF(data);
  }, [data]);
  if (!f) return <Loading />;

  const num = (v: string) => Number(v.replace(/\D/g, '')) || 0;
  const money = (label: string, value: number, set: (n: number) => void, hint?: string) => (
    <Field label={label} hint={hint ?? rp(value)}>
      <Input inputMode="numeric" value={value} onChange={(e) => set(num(e.target.value))} />
    </Field>
  );
  const check = (label: string, value: boolean, set: (b: boolean) => void) => (
    <label className="flex items-center gap-2 text-sm font-medium">
      <input type="checkbox" className="h-4 w-4 rounded border-slate-300" checked={value} onChange={(e) => set(e.target.checked)} />
      {label}
    </label>
  );

  async function save() {
    setSaving(true);
    try {
      const body = { ...f!, bestEmployee: { ...f!.bestEmployee, amounts: f!.bestEmployee.amounts.slice(0, f!.bestEmployee.count) } };
      setF(await api.put<Settings>('/payroll/settings', body));
      toast('Pengaturan upah disimpan');
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setSaving(false);
    }
  }

  const daily = Math.round(f.defaultWageKaryawan / (f.divisor || 1));
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Upah dasar" subtitle="PKWT Pasal 8: upah per hari = upah pokok ÷ 25">
        <div className="space-y-3">
          {money('Upah bawaan Petugas Parkir', f.defaultWageKaryawan, (n) => setF({ ...f, defaultWageKaryawan: n }))}
          {money('Upah bawaan Koordinator', f.defaultWageKoordinator, (n) => setF({ ...f, defaultWageKoordinator: n }))}
          <Field label="Pembagi upah per hari" hint={`Upah per hari Petugas = ${rp(daily)}`}>
            <Input type="number" min={1} max={31} value={f.divisor} onChange={(e) => setF({ ...f, divisor: num(e.target.value) || 1 })} />
          </Field>
          <p className="text-xs text-slate-500">Mangkir (Alfa) selalu dipotong 1× upah per hari untuk setiap hari mangkir (no work no pay).</p>
        </div>
      </Card>

      <Card title="Potongan terlambat" subtitle="Bawaan: mati. Selama mati hanya ditampilkan sebagai simulasi.">
        <div className="space-y-3">
          {check('Aktifkan potongan terlambat', f.lateDeduction.enabled, (b) => setF({ ...f, lateDeduction: { ...f.lateDeduction, enabled: b } }))}
          <div className="grid grid-cols-2 gap-2">
            <Field label="Setiap terlambat (kali)">
              <Input type="number" min={1} max={31} value={f.lateDeduction.perCount} onChange={(e) => setF({ ...f, lateDeduction: { ...f.lateDeduction, perCount: num(e.target.value) || 1 } })} />
            </Field>
            <Field label="Dipotong (× upah per hari)">
              <Input type="number" min={1} max={5} value={f.lateDeduction.days} onChange={(e) => setF({ ...f, lateDeduction: { ...f.lateDeduction, days: num(e.target.value) || 1 } })} />
            </Field>
          </div>
          <p className="text-sm text-slate-600">
            Contoh: terlambat {f.lateDeduction.perCount * 2}× dalam sebulan → dipotong {f.lateDeduction.days * 2}× {rp(daily)} = {rp(f.lateDeduction.days * 2 * daily)}.
          </p>
          <Alert kind={f.lateDeduction.enabled ? 'error' : 'info'}>
            PKWT saat ini hanya mengatur potongan untuk mangkir. Sebelum mengaktifkan potongan terlambat, buat <b>adendum PKWT</b> atau peraturan perusahaan yang ditandatangani
            petugas (PP 36/2021 tentang Pengupahan), lalu sosialisasikan lebih dulu.
          </Alert>
        </div>
      </Card>

      <Card title="Bonus kehadiran sempurna" subtitle="Tidak mangkir, tidak terlambat, tidak absen sekali">
        <div className="space-y-3">
          {check('Berikan bonus kehadiran sempurna', f.perfectBonus.enabled, (b) => setF({ ...f, perfectBonus: { ...f.perfectBonus, enabled: b } }))}
          {money('Nominal bonus', f.perfectBonus.amount, (n) => setF({ ...f, perfectBonus: { ...f.perfectBonus, amount: n } }), f.perfectBonus.amount ? rp(f.perfectBonus.amount) : 'Isi 0 bila hanya penghargaan tanpa uang')}
          {check('Tetap dihitung sempurna walau ada izin/sakit/cuti yang disetujui', f.perfectBonus.allowLeave, (b) => setF({ ...f, perfectBonus: { ...f.perfectBonus, allowLeave: b } }))}
        </div>
      </Card>

      <Card title="Petugas Terbaik Bulan Ini" subtitle="Dapat piagam penghargaan (PDF) dan bonus bila diisi">
        <div className="space-y-3">
          {check('Tentukan Petugas Terbaik', f.bestEmployee.enabled, (b) => setF({ ...f, bestEmployee: { ...f.bestEmployee, enabled: b } }))}
          <Field label="Jumlah peringkat">
            <Input type="number" min={1} max={5} value={f.bestEmployee.count} onChange={(e) => setF({ ...f, bestEmployee: { ...f.bestEmployee, count: Math.min(5, num(e.target.value) || 1) } })} />
          </Field>
          <div className="grid grid-cols-3 gap-2">
            {Array.from({ length: f.bestEmployee.count }, (_, i) => (
              <Field key={i} label={`Bonus #${i + 1}`}>
                <Input
                  inputMode="numeric"
                  value={f.bestEmployee.amounts[i] ?? 0}
                  onChange={(e) => {
                    const amounts = [...f.bestEmployee.amounts];
                    amounts[i] = num(e.target.value);
                    setF({ ...f, bestEmployee: { ...f.bestEmployee, amounts: Array.from({ length: f.bestEmployee.count }, (_, j) => amounts[j] ?? 0) } });
                  }}
                />
              </Field>
            ))}
          </div>
          <p className="text-xs text-slate-500">
            Syarat: tidak mangkir dan terlambat kurang dari {f.lateDeduction.perCount}×. Urutan: hadir sempurna, paling sedikit terlambat, absen sekali, izin/cuti, masalah
            istirahat, persentase tepat waktu, lalu rata-rata datang paling awal.
          </p>
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

/** Terbitkan / tarik slip ke akun petugas, dan progres tanda terimanya. */
function PublishCard({ month, data, onChange }: { month: string; data: MonthData; onChange: () => void }) {
  const { toast } = useFeedback();
  const [busy, setBusy] = useState(false);
  const pub = data.publication && !data.publication.withdrawnAt ? data.publication : null;
  const got = pub ? Object.keys(pub.received).length : 0;

  async function call(action: 'publish' | 'withdraw', msg: string) {
    if (action === 'publish' && pub && !window.confirm('Terbitkan ulang slip? Petugas akan diminta mengonfirmasi slip versi terbaru.')) return;
    if (action === 'withdraw' && !window.confirm('Tarik slip dari akun petugas? Tanda terima yang sudah ada tetap tersimpan.')) return;
    setBusy(true);
    try {
      await api.post(`/payroll/months/${month}/${action}`);
      toast(msg);
      onChange();
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1 text-sm">
          {pub ? (
            <>
              <p className="font-semibold text-slate-900">
                Slip sudah diterbitkan ke akun petugas{pub.version > 1 ? ` (versi ${pub.version})` : ''} · {when(pub.publishedAt)} WIT
              </p>
              <p className="text-slate-600">
                Dikonfirmasi diterima: <b>{got}</b> dari {pub.total} petugas
              </p>
            </>
          ) : (
            <>
              <p className="font-semibold text-slate-900">Slip belum terlihat oleh petugas</p>
              <p className="text-slate-600">
                {data.partial ? 'Slip bisa diterbitkan setelah bulan selesai.' : 'Terbitkan supaya tiap petugas bisa membuka slipnya sendiri dan mengonfirmasi penerimaan.'}
              </p>
            </>
          )}
        </div>
        <Button icon="send" disabled={data.partial || !data.rows.length} loading={busy} onClick={() => call('publish', pub ? 'Slip diterbitkan ulang' : 'Slip diterbitkan ke akun petugas')}>
          {pub ? 'Terbitkan ulang' : 'Terbitkan slip ke petugas'}
        </Button>
        {pub && (
          <Button variant="ghost" disabled={busy} onClick={() => call('withdraw', 'Slip ditarik dari akun petugas')}>
            Tarik
          </Button>
        )}
      </div>
    </Card>
  );
}
