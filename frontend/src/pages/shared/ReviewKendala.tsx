import { useState } from 'react';
import { RequestBadge, useLoad } from '../../components/attendance';
import { Alert, Button, Card, Empty, Field, Loading, Modal, PageHeader, Select, Textarea } from '../../components/ui';
import { api, AttendanceIssue, errMsg } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate } from '../../lib/format';

const ACTIONS = {
  KOORDINATOR: [
    { value: 'REVIEWED', label: 'Sudah ditinjau (tidak perlu koreksi)' },
    { value: 'ESCALATED', label: 'Teruskan ke Super Admin untuk koreksi' },
    { value: 'REJECTED', label: 'Tolak laporan' },
  ],
  SUPER_ADMIN: [
    { value: 'REVIEWED', label: 'Sudah ditinjau' },
    { value: 'RESOLVED', label: 'Selesai' },
    { value: 'REJECTED', label: 'Tolak laporan' },
  ],
};

export default function ReviewKendala() {
  const { user } = useAuth();
  const { data, error, loading, reload } = useLoad(() => api.get<AttendanceIssue[]>('/issues'));
  const options = user?.role === 'SUPER_ADMIN' ? ACTIONS.SUPER_ADMIN : ACTIONS.KOORDINATOR;
  const [target, setTarget] = useState<AttendanceIssue | null>(null);
  const [form, setForm] = useState({ status: options[0].value, note: '' });
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function save() {
    if (!target) return;
    setSaving(true);
    setActionError(null);
    try {
      await api.patch(`/issues/${target.id}`, form);
      setTarget(null);
      reload();
    } catch (e) {
      setActionError(errMsg(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Laporan Kendala Absensi"
        subtitle={
          user?.role === 'SUPER_ADMIN'
            ? 'Koreksi data dilakukan di menu Koreksi & Audit (laporan bisa ditautkan agar otomatis selesai).'
            : 'Tinjau awal laporan karyawan; teruskan ke Super Admin bila perlu koreksi data.'
        }
      />
      {error && <Alert>{error}</Alert>}
      <Card>
        {loading ? (
          <Loading />
        ) : !data?.length ? (
          <Empty>Belum ada laporan</Empty>
        ) : (
          <ul className="divide-y divide-slate-100">
            {data.map((i) => (
              <li key={i.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-slate-400">#{i.id}</span>
                    <span className="font-semibold">{i.user?.fullName}</span>
                    <span className="text-sm text-slate-500">{fmtDate(i.date)}</span>
                    <RequestBadge status={i.status} />
                  </div>
                  <p className="mt-1 text-sm text-slate-600">{i.description}</p>
                  {i.reviewNote && (
                    <p className="text-xs text-slate-500">
                      {i.reviewedBy?.fullName}: {i.reviewNote}
                    </p>
                  )}
                </div>
                {!['RESOLVED', 'REJECTED'].includes(i.status) && (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setTarget(i);
                      setForm({ status: options[0].value, note: '' });
                    }}
                  >
                    Tindak Lanjut
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Modal open={!!target} title="Tindak Lanjut Laporan" onClose={() => setTarget(null)}>
        <div className="space-y-3">
          {actionError && <Alert>{actionError}</Alert>}
          <Field label="Status">
            <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Catatan">
            <Textarea rows={3} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} required />
          </Field>
          <Button className="w-full" loading={saving} onClick={save} disabled={form.note.trim().length < 3}>
            Simpan
          </Button>
        </div>
      </Modal>
    </>
  );
}
