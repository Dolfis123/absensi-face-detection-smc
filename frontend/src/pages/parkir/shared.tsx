import { FormEvent, ReactNode, useState } from 'react';
import { useFeedback } from '../../components/feedback';
import { Badge, Button, cx, Empty, Field, Input, Select, Textarea } from '../../components/ui';
import { api, errMsg, openProtectedFile } from '../../lib/api';
import { fmtDate, todayWIT } from '../../lib/format';
import { INCIDENT_LABEL, IncidentRow } from '../../lib/parking';

/** Tab sederhana untuk halaman operasional parkir. */
export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { key: T; label: string; count?: number }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="-mx-1 mb-4 flex gap-1 overflow-x-auto rounded-xl bg-slate-100 p-1">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => onChange(t.key)}
          className={cx(
            'inline-flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition',
            value === t.key ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200' : 'text-slate-500 hover:text-slate-800',
          )}
        >
          {t.label}
          {!!t.count && <span className="rounded-md bg-rose-500 px-1.5 text-xs text-white">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Kolom angka bulat ≥ 0 (jumlah kendaraan, karcis, rupiah). */
export function NumField({ label, value, onChange, hint }: { label: string; value: number; onChange: (n: number) => void; hint?: string }) {
  return (
    <Field label={label} hint={hint}>
      <Input type="number" inputMode="numeric" min={0} value={Number.isFinite(value) ? value : 0} onChange={(e) => onChange(Math.max(0, Math.floor(Number(e.target.value) || 0)))} />
    </Field>
  );
}

const STATUS_CLS: Record<string, string> = {
  MENUNGGU: 'bg-amber-100 text-amber-800',
  DITERIMA: 'bg-emerald-100 text-emerald-800',
  SELISIH: 'bg-rose-100 text-rose-800',
  DIKETAHUI: 'bg-sky-100 text-sky-800',
  BARU: 'bg-amber-100 text-amber-800',
  DITINDAKLANJUTI: 'bg-sky-100 text-sky-800',
  SELESAI: 'bg-emerald-100 text-emerald-800',
};
const STATUS_TEXT: Record<string, string> = {
  MENUNGGU: 'Menunggu',
  DITERIMA: 'Diterima',
  SELISIH: 'Ada selisih',
  DIKETAHUI: 'Diketahui Koordinator',
  BARU: 'Baru',
  DITINDAKLANJUTI: 'Ditindaklanjuti',
  SELESAI: 'Selesai',
};
export const StatusPill = ({ status }: { status: string }) => <Badge className={STATUS_CLS[status] ?? 'bg-slate-100 text-slate-700'}>{STATUS_TEXT[status] ?? status}</Badge>;

export const Detail = ({ label, children }: { label: string; children: ReactNode }) =>
  children ? (
    <div className="text-sm">
      <span className="text-slate-500">{label}: </span>
      {children}
    </div>
  ) : null;

/** Formulir laporan kejadian (Lampiran B). Dipakai petugas maupun Koordinator. */
export function IncidentForm({ onSaved, defaultLocation }: { onSaved: () => void; defaultLocation?: string | null }) {
  const { toast } = useFeedback();
  const now = new Date(Date.now() + 9 * 3600_000).toISOString().slice(11, 16);
  const blank = {
    date: todayWIT(),
    time: now,
    location: defaultLocation ?? '',
    type: 'KELUHAN_PENGUNJUNG',
    parties: '',
    plate: '',
    vehicle: '',
    ticketNo: '',
    chronology: '',
    actions: '',
    contacted: '',
  };
  const [form, setForm] = useState(blank);
  const [files, setFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const fd = new FormData();
      Object.entries(form).forEach(([k, v]) => fd.append(k, v));
      files.slice(0, 3).forEach((f) => fd.append('photos', f));
      await api.post('/parking/incidents', fd);
      toast('Laporan kejadian terkirim ke Koordinator');
      setForm(blank);
      setFiles([]);
      (e.target as HTMLFormElement).reset();
      onSaved();
    } catch (err) {
      toast(errMsg(err), 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Jenis kejadian">
        <Select value={form.type} onChange={set('type')}>
          {Object.entries(INCIDENT_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Tanggal">
          <Input type="date" max={todayWIT()} value={form.date} onChange={set('date')} required />
        </Field>
        <Field label="Jam">
          <Input type="time" value={form.time} onChange={set('time')} required />
        </Field>
      </div>
      <Field label="Lokasi" hint="Mis. Lobi Kasuari — Pintu Keluar, lot B12">
        <Input value={form.location} onChange={set('location')} required minLength={2} maxLength={100} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Nomor plat">
          <Input value={form.plate} onChange={set('plate')} maxLength={20} placeholder="PB 1234 XX" />
        </Field>
        <Field label="Kendaraan">
          <Select value={form.vehicle} onChange={set('vehicle')}>
            <option value="">—</option>
            <option value="MOBIL">Mobil</option>
            <option value="MOTOR">Motor</option>
            <option value="LAINNYA">Lainnya</option>
          </Select>
        </Field>
      </div>
      <Field label="Nama & kontak pihak terkait">
        <Input value={form.parties} onChange={set('parties')} maxLength={300} />
      </Field>
      <Field label="Nomor karcis (bila ada)">
        <Input value={form.ticketNo} onChange={set('ticketNo')} maxLength={40} />
      </Field>
      <Field label="Kronologi">
        <Textarea rows={4} value={form.chronology} onChange={set('chronology')} required minLength={10} maxLength={4000} />
      </Field>
      <Field label="Tindakan yang dilakukan">
        <Textarea rows={2} value={form.actions} onChange={set('actions')} maxLength={1000} />
      </Field>
      <Field label="Pihak yang dihubungi" hint="Mis. Security, Koordinator, polisi">
        <Input value={form.contacted} onChange={set('contacted')} maxLength={300} />
      </Field>
      <Field label="Foto (maks. 3, JPG/PNG)" hint="Ambil foto hanya bila aman. Foto tidak boleh disebar di media sosial (SOP 7.4).">
        <Input type="file" accept="image/jpeg,image/png,image/webp" multiple capture="environment" onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, 3))} />
      </Field>
      <Button type="submit" loading={saving} className="w-full">
        Kirim Laporan Kejadian
      </Button>
    </form>
  );
}

/** Daftar laporan kejadian; bila `onReview` diberikan, peninjau bisa mengubah statusnya. */
export function IncidentList({ rows, onReview }: { rows: IncidentRow[]; onReview?: (row: IncidentRow) => void }) {
  if (rows.length === 0) return <Empty title="Belum ada laporan kejadian" />;
  return (
    <ul className="divide-y divide-slate-100">
      {rows.map((r) => (
        <li key={r.id} className="space-y-1 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="font-semibold">{INCIDENT_LABEL[r.type] ?? r.type}</div>
            <StatusPill status={r.status} />
          </div>
          <div className="text-xs text-slate-500">
            {fmtDate(r.date)} · {r.time} · {r.location} · dilaporkan {r.reporter}
          </div>
          <p className="whitespace-pre-line text-sm">{r.chronology}</p>
          <Detail label="Kendaraan">{[r.vehicle, r.plate].filter(Boolean).join(' · ')}</Detail>
          <Detail label="Pihak terkait">{r.parties}</Detail>
          <Detail label="Karcis">{r.ticketNo}</Detail>
          <Detail label="Tindakan">{r.actions}</Detail>
          <Detail label="Dihubungi">{r.contacted}</Detail>
          {r.reviewNote && <Detail label={`Catatan ${r.reviewedBy ?? ''}`}>{r.reviewNote}</Detail>}
          <div className="flex flex-wrap gap-2 pt-1">
            {Array.from({ length: r.photoCount }, (_, i) => (
              <Button key={i} variant="secondary" className="!px-2 !py-1 text-xs" onClick={() => openProtectedFile(`/parking/incidents/${r.id}/photos/${i}`)}>
                Foto {i + 1}
              </Button>
            ))}
            {onReview && (
              <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => onReview(r)}>
                Tindak lanjut
              </Button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
