import { FormEvent, useState } from 'react';
import { useLoad } from '../../components/attendance';
import { useFeedback } from '../../components/feedback';
import { Alert, Button, Card, Empty, Field, Input, Loading, PageHeader } from '../../components/ui';
import { api, errMsg, Holiday } from '../../lib/api';
import { fmtDate, todayWIT } from '../../lib/format';

export default function Libur() {
  const [year, setYear] = useState(todayWIT().slice(0, 4));
  const { data, error, loading, reload } = useLoad(() => api.get<Holiday[]>(`/holidays?year=${year}`), [year]);
  const [form, setForm] = useState({ date: todayWIT(), name: '' });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const { toast, confirm } = useFeedback();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    try {
      await api.post('/admin/holidays', form);
      setForm({ ...form, name: '' });
      reload();
    } catch (err) {
      setMsg(errMsg(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove(h: Holiday) {
    const ok = await confirm({
      title: 'Hapus hari libur?',
      message: `"${h.name}" (${fmtDate(h.date)}) akan kembali menjadi hari kerja biasa.`,
      confirmLabel: 'Hapus',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/admin/holidays/${h.id}`);
      toast('Hari libur dihapus.');
      reload();
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  }

  return (
    <>
      <PageHeader
        title="Hari Libur"
        subtitle="Libur nasional / mal tutup: kewajiban absensi ditiadakan otomatis pada tanggal ini."
        actions={<Input type="number" className="w-28" value={year} onChange={(e) => setYear(e.target.value)} min={2024} max={2100} />}
      />
      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <form onSubmit={submit} className="space-y-3">
            {msg && <Alert>{msg}</Alert>}
            <Field label="Tanggal">
              <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required />
            </Field>
            <Field label="Keterangan">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="mis. Hari Raya Idul Fitri" required />
            </Field>
            <Button type="submit" className="w-full" loading={saving}>
              Tambah Hari Libur
            </Button>
          </form>
        </Card>
        <Card className="lg:col-span-3">
          {error && <Alert>{error}</Alert>}
          {loading ? (
            <Loading />
          ) : !data?.length ? (
            <Empty>Belum ada hari libur di tahun {year}</Empty>
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.map((h) => (
                <li key={h.id} className="flex items-center justify-between py-2.5">
                  <div>
                    <div className="font-medium">{h.name}</div>
                    <div className="text-sm text-slate-500">{fmtDate(h.date)}</div>
                  </div>
                  <Button variant="ghost" className="text-rose-600" onClick={() => remove(h)}>
                    Hapus
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
