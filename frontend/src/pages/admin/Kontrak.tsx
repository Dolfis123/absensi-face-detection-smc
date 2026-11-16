import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useLoad } from '../../components/attendance';
import { useFeedback } from '../../components/feedback';
import { Alert, Badge, Button, Card, Empty, Field, Input, Loading, Modal, PageHeader, PersonCell, StatCard, Table, Td, Textarea, Th } from '../../components/ui';
import { api, downloadFile, errMsg, Role } from '../../lib/api';
import { fmtDate, todayWIT } from '../../lib/format';
import { Tabs } from '../parkir/shared';

type Status = 'AKAN_BERLAKU' | 'AKTIF' | 'BERAKHIR' | 'DIBATALKAN';
interface Contract {
  id: number;
  userId: number;
  fullName: string;
  nik: string;
  isActive: boolean;
  number: string;
  position: 'PETUGAS' | 'KOORDINATOR';
  signDate: string;
  startDate: string;
  endDate: string;
  baseWage: number;
  allowance: number | null;
  companyName: string;
  status: Status;
  daysLeft: number;
  openedAt: string | null;
  receivedAt: string | null;
  voidReason: string | null;
}
interface ListData {
  contracts: Contract[];
  expiring: { userId: number; fullName: string; contractId: number; endDate: string; daysLeft: number }[];
  expired: { userId: number; fullName: string; contractId: number; endDate: string; daysAgo: number }[];
}
interface Profile {
  ktpNumber: string | null;
  birthPlace: string | null;
  birthDate: string | null;
  address: string | null;
  bankName: string | null;
  bankAccount: string | null;
}
interface Employee {
  userId: number;
  fullName: string;
  nik: string;
  role: Role;
  phone: string;
  profile: Profile;
  missing: string[];
  lastContract: { id: number; number: string; startDate: string; endDate: string; status: Status; daysLeft: number } | null;
}
interface Settings {
  signerName: string;
  signerTitle: string;
  numberFormat: string;
  recordedPlace: string;
  defaultWage: number;
  defaultMonths: number;
  workHoursText: string;
}

const rp = (n: number) => `Rp ${n.toLocaleString('id-ID')}`;
const STATUS: Record<Status, [string, string]> = {
  AKAN_BERLAKU: ['Akan berlaku', 'bg-sky-100 text-sky-800'],
  AKTIF: ['Aktif', 'bg-emerald-100 text-emerald-800'],
  BERAKHIR: ['Berakhir', 'bg-slate-200 text-slate-700'],
  DIBATALKAN: ['Dibatalkan', 'bg-rose-100 text-rose-700'],
};
function StatusBadge({ c }: { c: Pick<Contract, 'status' | 'daysLeft'> }) {
  if (c.status === 'AKTIF' && c.daysLeft <= 14)
    return <Badge className={c.daysLeft <= 7 ? 'bg-rose-100 text-rose-800' : 'bg-amber-100 text-amber-800'}>Habis {c.daysLeft === 0 ? 'hari ini' : `${c.daysLeft} hari lagi`}</Badge>;
  return <Badge className={STATUS[c.status][1]}>{STATUS[c.status][0]}</Badge>;
}
/** Tanggal yang sama N bulan kemudian (sama dengan perhitungan server) */
function addMonths(iso: string, months: number) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** Data pribadi karyawan & kontrak PKWT otomatis (Word & PDF), dengan peringatan kontrak habis. */
export default function Kontrak() {
  const [tab, setTab] = useState<'kontrak' | 'data' | 'pengaturan'>('kontrak');
  const list = useLoad(() => api.get<ListData>('/contracts'));
  const emps = useLoad(() => api.get<Employee[]>('/contracts/employees'));
  const settings = useLoad(() => api.get<Settings>('/contracts/settings'));
  const reloadAll = () => {
    list.reload();
    emps.reload();
  };
  const incomplete = emps.data?.filter((e) => e.missing.length).length ?? 0;
  return (
    <>
      <PageHeader title="Kontrak PKWT" subtitle="Isi data pribadi karyawan, buat kontrak otomatis (Word & PDF), dan pantau kontrak yang akan habis. Karyawan menerima kontraknya di menu Surat & Slip." />
      <Tabs
        tabs={[
          { key: 'kontrak', label: 'Kontrak', count: (list.data?.expiring.length ?? 0) + (list.data?.expired.length ?? 0) },
          { key: 'data', label: 'Data Pribadi', count: incomplete },
          { key: 'pengaturan', label: 'Pengaturan' },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'kontrak' && <ContractsTab list={list} emps={emps.data ?? []} settings={settings.data} onChange={reloadAll} />}
      {tab === 'data' && <ProfilesTab emps={emps} />}
      {tab === 'pengaturan' && <SettingsTab settings={settings} />}
    </>
  );
}

// ───────────────────────── Tab Kontrak ─────────────────────────
interface Draft {
  userIds: number[];
  signDate: string;
  startDate: string;
  endDate: string;
  baseWage: number;
  allowance: number | null;
  syncWage: boolean;
}

function ContractsTab({ list, emps, settings, onChange }: { list: ReturnType<typeof useLoad<ListData>>; emps: Employee[]; settings: Settings | null; onChange: () => void }) {
  const { toast } = useFeedback();
  const [filter, setFilter] = useState<'berlaku' | 'semua'>('berlaku');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [edit, setEdit] = useState<Contract | null>(null);
  const [voiding, setVoiding] = useState<Contract | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const data = list.data;

  const shown = useMemo(() => (data?.contracts ?? []).filter((c) => filter === 'semua' || c.status === 'AKTIF' || c.status === 'AKAN_BERLAKU'), [data, filter]);
  if (list.loading && !data) return <Loading />;
  if (!data) return <Alert>{list.error}</Alert>;

  const today = todayWIT();
  const withoutContract = emps.filter((e) => !e.lastContract || e.lastContract.daysLeft < 0);
  const active = data.contracts.filter((c) => c.status === 'AKTIF');
  const unreceived = data.contracts.filter((c) => c.status !== 'DIBATALKAN' && c.status !== 'BERAKHIR' && !c.receivedAt).length;

  function newDraft(userIds: number[], startDate = today) {
    const months = settings?.defaultMonths ?? 2;
    setDraft({ userIds, signDate: startDate, startDate, endDate: addMonths(startDate, months), baseWage: settings?.defaultWage ?? 2_500_000, allowance: null, syncWage: true });
  }
  async function renew(ids: number[]) {
    try {
      const p = await api.get<{ userIds: number[]; startDate: string; endDate: string; baseWage: number; allowance: number | null }>(`/contracts/renewal-proposal?ids=${ids.join(',')}`);
      setDraft({ ...p, signDate: today < p.startDate ? today : p.startDate, syncWage: true });
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  }
  async function download(ids: number[], format: 'docx' | 'pdf', name: string) {
    setBusy(`${ids.join(',')}-${format}`);
    try {
      await downloadFile(`/contracts/download?ids=${ids.join(',')}&format=${format}`, `${name}.${format}`);
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(null);
    }
  }
  const fileBase = (c: Contract) => `PKWT_${(c.number || `kontrak-${c.id}`).replace(/\//g, '-')}_${c.fullName.replace(/[^\w]+/g, '-')}`;

  return (
    <>
      {(data.expiring.length > 0 || data.expired.length > 0) && (
        <div className="mb-4 space-y-2">
          {data.expiring.length > 0 && (
            <Alert kind="error">
              <b>{data.expiring.length} kontrak akan habis:</b> {data.expiring.map((x) => `${x.fullName} (${x.daysLeft === 0 ? 'hari ini' : `${x.daysLeft} hari lagi`})`).join(', ')}. Sesuai Pasal 2 ayat 3, keputusan perpanjangan harus disampaikan paling lambat 7 hari sebelum kontrak habis.{' '}
              <button className="font-semibold underline" onClick={() => renew(data.expiring.map((x) => x.contractId))}>
                Buat perpanjangan
              </button>
            </Alert>
          )}
          {data.expired.length > 0 && (
            <Alert kind="error">
              <b>{data.expired.length} karyawan aktif bekerja tanpa kontrak berlaku:</b> {data.expired.map((x) => `${x.fullName} (habis ${fmtDate(x.endDate, false)})`).join(', ')}.{' '}
              <button className="font-semibold underline" onClick={() => renew(data.expired.map((x) => x.contractId))}>
                Buat perpanjangan
              </button>
            </Alert>
          )}
        </div>
      )}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Kontrak aktif" value={active.length} icon="fileText" />
        <StatCard label="Habis ≤ 14 hari" value={data.expiring.length} icon="alert" />
        <StatCard label="Karyawan tanpa kontrak" value={withoutContract.length} icon="users" />
        <StatCard label="Belum diterima karyawan" value={unreceived} icon="inbox" />
      </div>
      <Card
        title="Daftar kontrak"
        subtitle="Kontrak bisa diubah selama karyawan belum menekan “Saya sudah menerima”. Setelah itu hanya bisa dibatalkan lalu dibuat baru."
        actions={
          <div className="flex flex-wrap gap-2">
            <select className="rounded-lg px-2 py-1.5 text-sm ring-1 ring-slate-200" value={filter} onChange={(e) => setFilter(e.target.value as 'berlaku' | 'semua')}>
              <option value="berlaku">Aktif & akan berlaku</option>
              <option value="semua">Semua (termasuk berakhir/dibatalkan)</option>
            </select>
            {shown.length > 1 && (
              <>
                <Button variant="secondary" icon="download" loading={busy === `${shown.map((c) => c.id).join(',')}-docx`} onClick={() => download(shown.map((c) => c.id), 'docx', `PKWT_${shown.length}-karyawan`)}>
                  Semua (Word)
                </Button>
                <Button variant="secondary" icon="download" loading={busy === `${shown.map((c) => c.id).join(',')}-pdf`} onClick={() => download(shown.map((c) => c.id), 'pdf', `PKWT_${shown.length}-karyawan`)}>
                  Semua (PDF)
                </Button>
              </>
            )}
            <Button icon="plus" onClick={() => newDraft(withoutContract.map((e) => e.userId))}>
              Buat Kontrak
            </Button>
          </div>
        }
      >
        {shown.length === 0 ? (
          <Empty icon="fileText" title="Belum ada kontrak">
            Tekan “Buat Kontrak” untuk membuat PKWT sekaligus untuk semua karyawan.
          </Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Karyawan</Th>
                <Th>Nomor</Th>
                <Th>Masa berlaku</Th>
                <Th>Upah pokok</Th>
                <Th>Status</Th>
                <Th>Tanda terima</Th>
                <Th className="text-right">Aksi</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {shown.map((c) => (
                <tr key={c.id} className={c.status === 'DIBATALKAN' ? 'opacity-60' : ''}>
                  <Td>
                    <PersonCell name={c.fullName} sub={c.position === 'KOORDINATOR' ? 'Koordinator Lapangan' : 'Petugas Parkir'} />
                  </Td>
                  <Td className="text-xs">{c.number || <span className="text-slate-400">diisi tangan</span>}</Td>
                  <Td className="text-xs">
                    {fmtDate(c.startDate, false)} – {fmtDate(c.endDate, false)}
                  </Td>
                  <Td className="text-xs">{rp(c.baseWage)}</Td>
                  <Td>
                    <StatusBadge c={c} />
                    {c.voidReason && <p className="mt-1 max-w-[220px] whitespace-normal text-[11px] text-slate-500">{c.voidReason}</p>}
                  </Td>
                  <Td className="text-xs">
                    {c.receivedAt ? (
                      <span className="text-emerald-700">✓ {fmtDate(c.receivedAt.slice(0, 10), false)}</span>
                    ) : c.openedAt ? (
                      <span className="text-amber-700">Dibuka, belum dikonfirmasi</span>
                    ) : (
                      <span className="text-slate-400">Belum dibuka</span>
                    )}
                  </Td>
                  <Td className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" className="!px-2 !py-1 text-xs" loading={busy === `${c.id}-docx`} onClick={() => download([c.id], 'docx', fileBase(c))}>
                        Word
                      </Button>
                      <Button variant="ghost" className="!px-2 !py-1 text-xs" loading={busy === `${c.id}-pdf`} onClick={() => download([c.id], 'pdf', fileBase(c))}>
                        PDF
                      </Button>
                      {c.status !== 'DIBATALKAN' && (
                        <>
                          {!c.receivedAt && (
                            <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => setEdit(c)}>
                              Ubah
                            </Button>
                          )}
                          {c.status !== 'AKAN_BERLAKU' && (
                            <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => renew([c.id])}>
                              Perpanjang
                            </Button>
                          )}
                          <Button variant="ghost" className="!px-2 !py-1 text-xs text-rose-600" onClick={() => setVoiding(c)}>
                            Batalkan
                          </Button>
                        </>
                      )}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {draft && <CreateModal draft={draft} emps={emps} onClose={() => setDraft(null)} onDone={() => { setDraft(null); onChange(); }} />}
      {edit && <EditModal c={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); onChange(); }} />}
      {voiding && <VoidModal c={voiding} onClose={() => setVoiding(null)} onDone={() => { setVoiding(null); onChange(); }} />}
    </>
  );
}

function TermsFields({ v, set, coordinator }: { v: Omit<Draft, 'userIds'>; set: (p: Partial<Draft>) => void; coordinator: boolean }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Tanggal ditandatangani" hint="“Pada hari ini …” di kontrak">
        <Input type="date" value={v.signDate} onChange={(e) => set({ signDate: e.target.value })} />
      </Field>
      <div className="hidden sm:block" />
      <Field label="Mulai berlaku">
        <Input type="date" value={v.startDate} onChange={(e) => set({ startDate: e.target.value })} />
      </Field>
      <Field label="Berakhir">
        <Input type="date" value={v.endDate} onChange={(e) => set({ endDate: e.target.value })} />
      </Field>
      <div className="flex flex-wrap gap-1 sm:col-span-2">
        {[1, 2, 3, 6, 12].map((m) => (
          <button key={m} type="button" className="rounded-md bg-slate-100 px-2 py-1 text-xs hover:bg-slate-200" onClick={() => set({ endDate: addMonths(v.startDate, m) })}>
            {m} bulan
          </button>
        ))}
      </div>
      <Field label="Upah pokok per bulan (Rp)">
        <Input type="number" min={0} value={v.baseWage} onChange={(e) => set({ baseWage: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
      </Field>
      <Field label="Tunjangan jabatan (Rp)" hint={coordinator ? 'Kosong = titik-titik untuk Koordinator, “-” untuk petugas' : 'Kosong = “-”'}>
        <Input type="number" min={0} value={v.allowance ?? ''} onChange={(e) => set({ allowance: e.target.value === '' ? null : Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
      </Field>
      <label className="flex items-start gap-2 text-sm sm:col-span-2">
        <input type="checkbox" className="mt-0.5" checked={v.syncWage} onChange={(e) => set({ syncWage: e.target.checked })} />
        <span>Samakan upah pokok di menu Rekap Upah dengan kontrak ini</span>
      </label>
    </div>
  );
}

function CreateModal({ draft, emps, onClose, onDone }: { draft: Draft; emps: Employee[]; onClose: () => void; onDone: () => void }) {
  const { toast } = useFeedback();
  const [v, setV] = useState(draft);
  const [saving, setSaving] = useState(false);
  const set = (p: Partial<Draft>) => setV((x) => ({ ...x, ...p }));
  const chosen = emps.filter((e) => v.userIds.includes(e.userId));
  const incomplete = chosen.filter((e) => e.missing.length);
  const toggle = (id: number) => set({ userIds: v.userIds.includes(id) ? v.userIds.filter((x) => x !== id) : [...v.userIds, id] });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const out = await api.post<Contract[]>('/contracts', v);
      toast(`${out.length} kontrak dibuat`);
      onDone();
    } catch (err) {
      toast(errMsg(err), 'error');
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal open title="Buat kontrak PKWT" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-sm font-medium text-slate-700">Karyawan ({v.userIds.length} dipilih)</span>
            <span className="space-x-2 text-xs">
              <button type="button" className="text-brand-700 underline" onClick={() => set({ userIds: emps.map((e) => e.userId) })}>
                semua
              </button>
              <button type="button" className="text-brand-700 underline" onClick={() => set({ userIds: [] })}>
                kosongkan
              </button>
            </span>
          </div>
          <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg p-2 ring-1 ring-slate-200">
            {emps.map((e) => (
              <label key={e.userId} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={v.userIds.includes(e.userId)} onChange={() => toggle(e.userId)} />
                <span className="flex-1">
                  {e.fullName}
                  {e.role === 'KOORDINATOR' && <span className="text-xs text-slate-500"> · Koordinator</span>}
                </span>
                {e.lastContract && e.lastContract.daysLeft >= 0 && <span className="text-[11px] text-slate-500">kontrak s.d. {fmtDate(e.lastContract.endDate, false)}</span>}
                {e.missing.length > 0 && <span className="text-[11px] text-amber-700">data belum lengkap</span>}
              </label>
            ))}
          </div>
        </div>
        <TermsFields v={v} set={set} coordinator={chosen.some((e) => e.role === 'KOORDINATOR')} />
        {incomplete.length > 0 && (
          <Alert kind="info">
            Data pribadi {incomplete.length} karyawan belum lengkap ({incomplete.map((e) => e.fullName.split(' ')[0]).join(', ')}). Kontrak tetap bisa dibuat; bagian yang kosong tercetak titik-titik dan otomatis terisi setelah data dilengkapi di tab Data Pribadi.
          </Alert>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Batal
          </Button>
          <Button type="submit" loading={saving} disabled={!v.userIds.length}>
            Buat {v.userIds.length} kontrak
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function EditModal({ c, onClose, onDone }: { c: Contract; onClose: () => void; onDone: () => void }) {
  const { toast } = useFeedback();
  const [v, setV] = useState({ number: c.number, signDate: c.signDate, startDate: c.startDate, endDate: c.endDate, baseWage: c.baseWage, allowance: c.allowance, syncWage: true });
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.patch(`/contracts/${c.id}`, v);
      toast('Kontrak diperbarui');
      onDone();
    } catch (err) {
      toast(errMsg(err), 'error');
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal open title={`Ubah kontrak — ${c.fullName}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Nomor kontrak" hint="Kosongkan bila nomor akan ditulis tangan">
          <Input value={v.number} onChange={(e) => setV({ ...v, number: e.target.value })} />
        </Field>
        <TermsFields v={{ ...v, userIds: [] } as unknown as Draft} set={(p) => setV({ ...v, ...p })} coordinator={c.position === 'KOORDINATOR'} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Batal
          </Button>
          <Button type="submit" loading={saving}>
            Simpan
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function VoidModal({ c, onClose, onDone }: { c: Contract; onClose: () => void; onDone: () => void }) {
  const { toast } = useFeedback();
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post(`/contracts/${c.id}/void`, { reason });
      toast('Kontrak dibatalkan');
      onDone();
    } catch (err) {
      toast(errMsg(err), 'error');
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal open title={`Batalkan kontrak — ${c.fullName}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-slate-600">
          Kontrak {c.number || `#${c.id}`} tidak dihapus, hanya ditandai dibatalkan dan tidak lagi tampil di menu karyawan. Gunakan ini bila ada kesalahan isi setelah karyawan menerima kontrak, atau karyawan berhenti.
        </p>
        <Field label="Alasan pembatalan">
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="mis. Salah tanggal mulai, diganti kontrak baru" />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Kembali
          </Button>
          <Button type="submit" variant="danger" loading={saving} disabled={reason.trim().length < 5}>
            Batalkan kontrak
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ───────────────────────── Tab Data Pribadi ─────────────────────────
function ProfilesTab({ emps }: { emps: ReturnType<typeof useLoad<Employee[]>> }) {
  const [edit, setEdit] = useState<Employee | null>(null);
  if (emps.loading && !emps.data) return <Loading />;
  if (!emps.data) return <Alert>{emps.error}</Alert>;
  return (
    <Card title="Data pribadi karyawan" subtitle="Dipakai untuk bagian PIHAK KEDUA di kontrak. No. HP diambil dari menu Data Pengguna. Data akun & wajah tidak diubah dari sini.">
      <Table>
        <thead>
          <tr>
            <Th>Karyawan</Th>
            <Th>NIK KTP</Th>
            <Th>Tempat, tgl lahir</Th>
            <Th>Alamat</Th>
            <Th>Kelengkapan</Th>
            <Th />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {emps.data.map((e) => (
            <tr key={e.userId}>
              <Td>
                <PersonCell name={e.fullName} sub={e.phone || 'No. HP belum ada'} />
              </Td>
              <Td className="font-mono text-xs">{e.profile.ktpNumber ?? '–'}</Td>
              <Td className="text-xs">{e.profile.birthPlace || e.profile.birthDate ? `${e.profile.birthPlace ?? '…'}, ${e.profile.birthDate ? fmtDate(e.profile.birthDate, false) : '…'}` : '–'}</Td>
              <Td className="max-w-[260px] truncate text-xs">{e.profile.address ?? '–'}</Td>
              <Td>{e.missing.length ? <Badge className="bg-amber-100 text-amber-800">Kurang: {e.missing.join(', ')}</Badge> : <Badge className="bg-emerald-100 text-emerald-800">Lengkap</Badge>}</Td>
              <Td className="text-right">
                <Button variant="secondary" className="!px-3 !py-1 text-xs" onClick={() => setEdit(e)}>
                  Isi / ubah
                </Button>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      {edit && <ProfileModal e={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); emps.reload(); }} />}
    </Card>
  );
}

function ProfileModal({ e, onClose, onDone }: { e: Employee; onClose: () => void; onDone: () => void }) {
  const { toast } = useFeedback();
  const [v, setV] = useState({
    ktpNumber: e.profile.ktpNumber ?? '',
    birthPlace: e.profile.birthPlace ?? '',
    birthDate: e.profile.birthDate ?? '',
    address: e.profile.address ?? '',
    bankName: e.profile.bankName ?? '',
    bankAccount: e.profile.bankAccount ?? '',
  });
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof v) => (ev: { target: { value: string } }) => setV({ ...v, [k]: ev.target.value });
  async function submit(ev: FormEvent) {
    ev.preventDefault();
    setSaving(true);
    try {
      await api.put(`/contracts/employees/${e.userId}/profile`, v);
      toast('Data pribadi disimpan');
      onDone();
    } catch (err) {
      toast(errMsg(err), 'error');
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal open title={`Data pribadi — ${e.fullName}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="No. KTP / NIK" hint="16 angka sesuai KTP">
          <Input inputMode="numeric" maxLength={16} value={v.ktpNumber} onChange={(ev) => setV({ ...v, ktpNumber: ev.target.value.replace(/\D/g, '') })} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Tempat lahir">
            <Input value={v.birthPlace} onChange={set('birthPlace')} />
          </Field>
          <Field label="Tanggal lahir">
            <Input type="date" value={v.birthDate} onChange={set('birthDate')} />
          </Field>
        </div>
        <Field label="Alamat (sesuai KTP)">
          <Textarea rows={2} value={v.address} onChange={set('address')} />
        </Field>
        <Field label="No. HP/WhatsApp" hint="Diubah lewat menu Data Pengguna">
          <Input value={e.phone} disabled />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Bank (opsional)">
            <Input value={v.bankName} onChange={set('bankName')} placeholder="mis. BRI" />
          </Field>
          <Field label="No. rekening (opsional)">
            <Input value={v.bankAccount} onChange={set('bankAccount')} />
          </Field>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose}>
            Batal
          </Button>
          <Button type="submit" loading={saving}>
            Simpan
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ───────────────────────── Tab Pengaturan ─────────────────────────
function SettingsTab({ settings }: { settings: ReturnType<typeof useLoad<Settings>> }) {
  const { toast } = useFeedback();
  const [v, setV] = useState<Settings | null>(settings.data);
  const [saving, setSaving] = useState(false);
  useEffect(() => setV(settings.data), [settings.data]);
  if (!v) return settings.error ? <Alert>{settings.error}</Alert> : <Loading />;
  const set = (p: Partial<Settings>) => setV({ ...v, ...p });
  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.put('/contracts/settings', v);
      toast('Pengaturan kontrak disimpan');
      settings.reload();
    } catch (err) {
      toast(errMsg(err), 'error');
    } finally {
      setSaving(false);
    }
  }
  return (
    <form onSubmit={submit} className="grid gap-4 lg:grid-cols-2">
      <Card title="Pihak Pertama" subtitle="Nama & alamat perusahaan diambil dari menu Identitas & Kop Surat. Perubahan hanya berlaku untuk kontrak yang dibuat sesudahnya.">
        <div className="space-y-3">
          <Field label="Diwakili oleh">
            <Input value={v.signerName} onChange={(e) => set({ signerName: e.target.value })} />
          </Field>
          <Field label="Jabatan">
            <Input value={v.signerTitle} onChange={(e) => set({ signerTitle: e.target.value })} />
          </Field>
          <Field label="Dicatatkan">
            <Input value={v.recordedPlace} onChange={(e) => set({ recordedPlace: e.target.value })} />
          </Field>
        </div>
      </Card>
      <Card title="Nomor & isian bawaan">
        <div className="space-y-3">
          <Field label="Pola nomor kontrak" hint="Token: {no} {kode} {bulan} {bulanAngka} {tahun}. {kode} = kode surat di Identitas. Kosongkan bila nomor ditulis tangan.">
            <Input value={v.numberFormat} onChange={(e) => set({ numberFormat: e.target.value })} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Upah pokok bawaan (Rp)">
              <Input type="number" min={0} value={v.defaultWage} onChange={(e) => set({ defaultWage: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
            </Field>
            <Field label="Lama kontrak bawaan (bulan)">
              <Input type="number" min={1} max={60} value={v.defaultMonths} onChange={(e) => set({ defaultMonths: Math.min(60, Math.max(1, Math.floor(Number(e.target.value) || 1))) })} />
            </Field>
          </div>
        </div>
      </Card>
      <Card title="Pasal 4 ayat 1 — waktu kerja Petugas Parkir" className="lg:col-span-2" subtitle="Untuk Koordinator tertulis “Waktu kerja PIHAK KEDUA diatur sesuai roster yang ditetapkan PIHAK PERTAMA.”">
        <Textarea rows={3} value={v.workHoursText} onChange={(e) => set({ workHoursText: e.target.value })} />
        <p className="mt-2 text-xs text-slate-500">Contoh bila Shift Siang ikut dicantumkan: “… yaitu Shift 1 pukul 08.00–16.00 WIT, Shift Siang pukul 14.00–22.00 WIT, atau Shift 2 pukul 16.00–23.00 WIT.”</p>
      </Card>
      <div className="lg:col-span-2">
        <Button type="submit" loading={saving}>
          Simpan pengaturan
        </Button>
      </div>
    </form>
  );
}
