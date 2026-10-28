import { useState } from 'react';
import { RequestBadge, useLoad } from '../../components/attendance';
import { Alert, Button, Card, Empty, Field, Loading, Modal, PageHeader, Select, Textarea } from '../../components/ui';
import { api, errMsg, LeaveRequest, openProtectedFile } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate } from '../../lib/format';

export default function ReviewIzin() {
  const { user } = useAuth();
  const [status, setStatus] = useState('PENDING');
  const { data, error, loading, reload } = useLoad(
    () => api.get<LeaveRequest[]>(`/leaves${status ? `?status=${status}` : ''}`),
    [status],
  );
  const [target, setTarget] = useState<{ leave: LeaveRequest; decision: 'APPROVED' | 'REJECTED' } | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function decide() {
    if (!target) return;
    setSaving(true);
    setActionError(null);
    try {
      await api.patch(`/leaves/${target.leave.id}`, { decision: target.decision, note: note || undefined });
      setTarget(null);
      setNote('');
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
        title="Pengajuan Izin / Sakit / Cuti"
        subtitle="Pengajuan yang disetujui otomatis mengunci status kehadiran pada tanggal tersebut."
        actions={
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-44">
            <option value="PENDING">Menunggu</option>
            <option value="APPROVED">Disetujui</option>
            <option value="REJECTED">Ditolak</option>
            <option value="">Semua</option>
          </Select>
        }
      />
      {error && <Alert>{error}</Alert>}
      <Card>
        {loading ? (
          <Loading />
        ) : !data?.length ? (
          <Empty>Tidak ada pengajuan</Empty>
        ) : (
          <ul className="divide-y divide-slate-100">
            {data.map((l) => (
              <li key={l.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{l.user?.fullName}</span>
                    <span className="text-xs text-slate-500">{l.user?.nik}</span>
                    <RequestBadge status={l.status} />
                  </div>
                  <div className="mt-1 text-sm">
                    <b>{l.type}</b> · {fmtDate(l.startDate, false)}
                    {l.endDate !== l.startDate && ` – ${fmtDate(l.endDate, false)}`}
                  </div>
                  <p className="text-sm text-slate-600">{l.reason}</p>
                  {l.attachmentPath && (
                    <button className="text-xs text-brand-600 hover:underline" onClick={() => openProtectedFile(`/leaves/${l.id}/attachment`)}>
                      Lihat lampiran
                    </button>
                  )}
                  {l.reviewedBy && (
                    <p className="text-xs text-slate-500">
                      Diputuskan oleh {l.reviewedBy.fullName}
                      {l.reviewNote && ` — ${l.reviewNote}`}
                    </p>
                  )}
                </div>
                {l.status === 'PENDING' && l.userId !== user?.id && (
                  <div className="flex gap-2">
                    <Button variant="success" onClick={() => setTarget({ leave: l, decision: 'APPROVED' })}>
                      Setujui
                    </Button>
                    <Button variant="danger" onClick={() => setTarget({ leave: l, decision: 'REJECTED' })}>
                      Tolak
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Modal open={!!target} title={target?.decision === 'APPROVED' ? 'Setujui Pengajuan' : 'Tolak Pengajuan'} onClose={() => setTarget(null)}>
        {target && (
          <div className="space-y-3">
            <p className="text-sm">
              {target.leave.user?.fullName} · {target.leave.type} {fmtDate(target.leave.startDate, false)}
              {target.leave.endDate !== target.leave.startDate && ` – ${fmtDate(target.leave.endDate, false)}`}
            </p>
            {actionError && <Alert>{actionError}</Alert>}
            <Field label={target.decision === 'REJECTED' ? 'Alasan penolakan (wajib)' : 'Catatan (opsional)'}>
              <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <Button className="w-full" variant={target.decision === 'APPROVED' ? 'success' : 'danger'} loading={saving} onClick={decide}>
              Konfirmasi
            </Button>
          </div>
        )}
      </Modal>
    </>
  );
}
