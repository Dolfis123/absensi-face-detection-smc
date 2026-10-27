import { FormEvent, useState } from 'react';
import { RequestBadge, useLoad } from '../../components/attendance';
import { Alert, Button, Card, Empty, Field, Input, Loading, PageHeader, Select, Textarea } from '../../components/ui';
import { api, errMsg, LeaveRequest, openProtectedFile } from '../../lib/api';
import { fmtDate, todayWIT } from '../../lib/format';

export default function Izin() {
  const { data, error, loading, reload } = useLoad(() => api.get<LeaveRequest[]>('/me/leaves'));
  const today = todayWIT();
  const [form, setForm] = useState({ type: 'IZIN', startDate: today, endDate: today, reason: '' });
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    try {
      const fd = new FormData();
      Object.entries(form).forEach(([k, v]) => fd.append(k, v));
      if (file) fd.append('attachment', file);
      await api.post('/me/leaves', fd);
      setMsg({ kind: 'success', text: 'Pengajuan terkirim dan menunggu persetujuan.' });
      setForm({ ...form, reason: '' });
      setFile(null);
      (e.target as HTMLFormElement).reset();
      reload();
    } catch (err) {
      setMsg({ kind: 'error', text: errMsg(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader title="Izin / Sakit / Cuti" subtitle="Pengajuan akan ditinjau Koordinator atau Super Admin" />
      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <form onSubmit={submit} className="space-y-3">
            {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
            <Field label="Kategori">
              <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                <option value="IZIN">Izin</option>
                <option value="SAKIT">Sakit</option>
                <option value="CUTI">Cuti</option>
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Dari">
                <Input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} required />
              </Field>
              <Field label="Sampai">
                <Input type="date" value={form.endDate} min={form.startDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} required />
              </Field>
            </div>
            <Field label="Alasan">
              <Textarea rows={3} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} required minLength={5} />
            </Field>
            <Field label="Foto / dokumen pendukung" hint={form.type === 'SAKIT' ? 'Wajib: surat dokter (JPG/PNG/PDF, maks 5 MB)' : 'Opsional (JPG/PNG/PDF, maks 5 MB)'}>
              <Input type="file" accept="image/*,application/pdf" capture="environment" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </Field>
            <Button type="submit" className="w-full" loading={saving}>
              Kirim Pengajuan
            </Button>
          </form>
        </Card>

        <Card className="lg:col-span-3">
          <h2 className="mb-3 font-semibold">Riwayat Pengajuan</h2>
          {error && <Alert>{error}</Alert>}
          {loading ? (
            <Loading />
          ) : !data?.length ? (
            <Empty>Belum ada pengajuan</Empty>
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.map((l) => (
                <li key={l.id} className="py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-medium">
                      {l.type} · {fmtDate(l.startDate, false)}
                      {l.endDate !== l.startDate && ` – ${fmtDate(l.endDate, false)}`}
                    </div>
                    <RequestBadge status={l.status} />
                  </div>
                  <p className="mt-1 text-sm text-slate-600">{l.reason}</p>
                  {l.attachmentPath && (
                    <button className="mt-1 text-xs text-brand-600 hover:underline" onClick={() => openProtectedFile(`/leaves/${l.id}/attachment`)}>
                      Lihat lampiran
                    </button>
                  )}
                  {l.reviewNote && <p className="mt-1 text-xs text-slate-500">Catatan peninjau: {l.reviewNote}</p>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
