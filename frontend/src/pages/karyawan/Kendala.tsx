import { FormEvent, useState } from 'react';
import { RequestBadge, useLoad } from '../../components/attendance';
import { Alert, Button, Card, Empty, Field, Input, Loading, PageHeader, Textarea } from '../../components/ui';
import { api, AttendanceIssue, errMsg } from '../../lib/api';
import { fmtDate, todayWIT } from '../../lib/format';

export default function Kendala() {
  const { data, error, loading, reload } = useLoad(() => api.get<AttendanceIssue[]>('/me/issues'));
  const [date, setDate] = useState(todayWIT());
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    try {
      await api.post('/me/issues', { date, description });
      setDescription('');
      setMsg({ kind: 'success', text: 'Laporan terkirim ke Koordinator Lapangan.' });
      reload();
    } catch (err) {
      setMsg({ kind: 'error', text: errMsg(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Lapor Kendala Absensi"
        subtitle="Misal: kamera/GPS bermasalah sehingga gagal absen. Koordinator meninjau, koreksi resmi dilakukan Super Admin."
      />
      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <form onSubmit={submit} className="space-y-3">
            {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
            <Field label="Tanggal kejadian">
              <Input type="date" max={todayWIT()} value={date} onChange={(e) => setDate(e.target.value)} required />
            </Field>
            <Field label="Uraian kendala">
              <Textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} minLength={10} required />
            </Field>
            <Button type="submit" className="w-full" loading={saving}>
              Kirim Laporan
            </Button>
          </form>
        </Card>
        <Card className="lg:col-span-3">
          <h2 className="mb-3 font-semibold">Laporan Saya</h2>
          {error && <Alert>{error}</Alert>}
          {loading ? (
            <Loading />
          ) : !data?.length ? (
            <Empty>Belum ada laporan</Empty>
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.map((i) => (
                <li key={i.id} className="py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{fmtDate(i.date)}</span>
                    <RequestBadge status={i.status} />
                  </div>
                  <p className="mt-1 text-sm text-slate-600">{i.description}</p>
                  {i.reviewNote && <p className="mt-1 text-xs text-slate-500">Tanggapan: {i.reviewNote}</p>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
