import { FormEvent, useState } from 'react';
import { useLoad } from '../../components/attendance';
import { Alert, Badge, Button, Card, Empty, Field, Input, Loading, PageHeader, Select, Table, Td, Textarea, Th } from '../../components/ui';
import { api, AttendanceIssue, errMsg, PublicUser, SlotType } from '../../lib/api';
import { fmtDate, SLOT_LABEL, todayWIT } from '../../lib/format';

interface AuditLogRow {
  id: number;
  action: 'ADD_ATTENDANCE' | 'VOID_ATTENDANCE';
  date: string;
  slotType: SlotType;
  before: { localTime: string; status: string } | null;
  after: { localTime: string; status: string } | null;
  reason: string;
  createdAt: string;
  actor: { fullName: string };
  targetUser: { fullName: string; nik: string };
}

export default function Koreksi() {
  const { data, error, loading, reload } = useLoad(() =>
    Promise.all([
      api.get<PublicUser[]>('/admin/users'),
      api.get<AuditLogRow[]>('/admin/audit-logs'),
      api.get<AttendanceIssue[]>('/issues'),
    ]),
  );
  const [form, setForm] = useState({
    userId: 0,
    date: todayWIT(),
    slotType: 'MASUK',
    action: 'ADD',
    time: '08:00',
    status: 'TEPAT_WAKTU',
    reason: '',
    issueId: '',
  });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  if (loading && !data) return <Loading />;
  if (!data) return <Alert>{error}</Alert>;
  const [users, logs, issues] = data;
  const employees = users.filter((u) => u.role !== 'SUPER_ADMIN');
  const openIssues = issues.filter((i) => !['RESOLVED', 'REJECTED'].includes(i.status));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    try {
      await api.post('/admin/corrections', {
        userId: form.userId,
        date: form.date,
        slotType: form.slotType,
        action: form.action,
        reason: form.reason,
        ...(form.action === 'ADD' ? { time: form.time, status: form.status } : {}),
        ...(form.issueId ? { issueId: Number(form.issueId) } : {}),
      });
      setMsg({ kind: 'success', text: 'Koreksi tersimpan dan tercatat di audit trail.' });
      setForm({ ...form, reason: '', issueId: '' });
      reload();
    } catch (err) {
      setMsg({ kind: 'error', text: errMsg(err) });
    } finally {
      setSaving(false);
    }
  }

  const set = (k: keyof typeof form, v: string | number) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <>
      <PageHeader
        title="Koreksi Darurat & Audit Trail"
        subtitle="Data absensi tidak pernah dihapus. Koreksi = membatalkan catatan lama (VOID) dan/atau menambah catatan pengganti, wajib dengan alasan."
      />
      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <form onSubmit={submit} className="space-y-3">
            {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
            <Field label="Karyawan">
              <Select value={form.userId} onChange={(e) => set('userId', Number(e.target.value))} required>
                <option value={0} disabled>
                  — pilih —
                </option>
                {employees.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.fullName} ({u.nik})
                  </option>
                ))}
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Tanggal">
                <Input type="date" max={todayWIT()} value={form.date} onChange={(e) => set('date', e.target.value)} required />
              </Field>
              <Field label="Slot">
                <Select value={form.slotType} onChange={(e) => set('slotType', e.target.value)}>
                  {Object.entries(SLOT_LABEL).map(([v, l]) => (
                    <option key={v} value={v}>
                      Absen {l}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Tindakan">
              <Select value={form.action} onChange={(e) => set('action', e.target.value)}>
                <option value="ADD">Tambah catatan absensi</option>
                <option value="VOID">Batalkan catatan yang ada (VOID)</option>
              </Select>
            </Field>
            {form.action === 'ADD' && (
              <div className="grid grid-cols-2 gap-2">
                <Field label="Jam (WIT)">
                  <Input type="time" value={form.time} onChange={(e) => set('time', e.target.value)} required />
                </Field>
                <Field label="Status">
                  <Select value={form.status} onChange={(e) => set('status', e.target.value)}>
                    <option value="TEPAT_WAKTU">Tepat Waktu</option>
                    <option value="TERLAMBAT">Terlambat</option>
                  </Select>
                </Field>
              </div>
            )}
            <Field label="Tautkan laporan kendala (opsional)">
              <Select value={form.issueId} onChange={(e) => set('issueId', e.target.value)}>
                <option value="">— tidak ada —</option>
                {openIssues.map((i) => (
                  <option key={i.id} value={i.id}>
                    #{i.id} · {i.user?.fullName} · {i.date}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Alasan koreksi (wajib, min. 10 karakter)">
              <Textarea rows={3} value={form.reason} onChange={(e) => set('reason', e.target.value)} minLength={10} required />
            </Field>
            <Button type="submit" variant="danger" className="w-full" loading={saving} disabled={!form.userId}>
              Terapkan Koreksi
            </Button>
          </form>
        </Card>

        <Card className="lg:col-span-3">
          <h2 className="mb-3 font-semibold">Riwayat Audit</h2>
          {!logs.length ? (
            <Empty>Belum ada koreksi</Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Waktu</Th>
                  <Th>Karyawan</Th>
                  <Th>Koreksi</Th>
                  <Th>Alasan</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {logs.map((l) => (
                  <tr key={l.id}>
                    <Td className="text-xs">{new Date(l.createdAt).toLocaleString('id-ID', { timeZone: 'Asia/Jayapura' })}</Td>
                    <Td>
                      <div>{l.targetUser.fullName}</div>
                      <div className="text-xs text-slate-500">
                        {fmtDate(l.date, false)} · {SLOT_LABEL[l.slotType]}
                      </div>
                    </Td>
                    <Td>
                      <Badge className={l.action === 'VOID_ATTENDANCE' ? 'bg-rose-100 text-rose-800' : 'bg-emerald-100 text-emerald-800'}>
                        {l.action === 'VOID_ATTENDANCE' ? 'VOID' : 'TAMBAH'}
                      </Badge>
                      <div className="mt-1 font-mono text-xs">{(l.before ?? l.after)?.localTime}</div>
                    </Td>
                    <Td className="max-w-xs whitespace-normal text-xs">
                      {l.reason}
                      <div className="text-slate-400">oleh {l.actor.fullName}</div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
