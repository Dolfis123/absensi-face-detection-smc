import { useEffect, useState } from 'react';
import { api, DayRecord, errMsg } from '../lib/api';
import { fmtDate, STATUS_STYLE, todayWIT } from '../lib/format';
import { useFeedback } from './feedback';
import { Alert, Button, Field, Input, Modal, Select, Spinner, Textarea } from './ui';

export interface Employee {
  id: number;
  fullName: string;
  nik: string;
}

/**
 * Dialog "Tandai Tidak Bekerja" (khusus Super Admin): absensi hari itu dibatalkan lewat audit trail
 * dan hari tersebut dihitung Alfa (mangkir) → ikut Peringatan Disiplin & potongan upah.
 */
export function MarkNotWorkingModal({
  open,
  onClose,
  onDone,
  employees,
  initialUserId,
  initialDate,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  employees: Employee[];
  initialUserId?: number;
  initialDate?: string;
}) {
  const { toast } = useFeedback();
  const today = todayWIT();
  const [userId, setUserId] = useState(initialUserId ?? 0);
  const [date, setDate] = useState(initialDate ?? today);
  const [reason, setReason] = useState('');
  const [day, setDay] = useState<DayRecord | null>(null);
  const [dayErr, setDayErr] = useState<string | null>(null);
  const [loadingDay, setLoadingDay] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setUserId(initialUserId ?? 0);
    setDate(initialDate ?? today);
    setReason('');
  }, [open, initialUserId, initialDate, today]);

  useEffect(() => {
    setDay(null);
    setDayErr(null);
    if (!open || !userId || !date) return;
    setLoadingDay(true);
    api
      .get<{ day: DayRecord }>(`/admin/not-working/day?userId=${userId}&date=${date}`)
      .then((r) => setDay(r.day))
      .catch((e) => setDayErr(errMsg(e)))
      .finally(() => setLoadingDay(false));
  }, [open, userId, date]);

  const emp = employees.find((e) => e.id === userId);
  const alreadyMarked = day?.status === 'ALFA' && day.note?.startsWith('Ditandai tidak bekerja');
  const workDay = day && !['OFF', 'DAY_OFF', 'LIBUR', 'IZIN', 'SAKIT', 'CUTI'].includes(day.status);
  const slots = day ? Object.entries(day.slots) : [];

  async function submit() {
    setSaving(true);
    try {
      await api.post('/admin/not-working', { userId, date, reason });
      toast(`${emp?.fullName ?? 'Karyawan'} ditandai tidak bekerja pada ${fmtDate(date, false)} — dihitung Alfa`);
      onDone();
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} title="Tandai Tidak Bekerja" onClose={onClose}>
      <div className="space-y-3">
        <Alert kind="info">
          Untuk petugas yang <b>absen tetapi tidak bekerja</b> (mis. datang absen lalu pulang). Absen hari itu dibatalkan (tercatat di audit trail), hari
          itu dihitung <b>Alfa</b>, ikut Peringatan Disiplin dan dipotong 1× upah per hari. Petugas juga tidak bisa absen lagi di tanggal itu.
        </Alert>
        <Field label="Karyawan">
          <Select value={userId} onChange={(e) => setUserId(Number(e.target.value))}>
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
        <Field label="Tanggal" hint="Boleh tanggal yang sudah lewat bila baru diketahui belakangan">
          <Input type="date" max={today} value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
        </Field>

        {userId > 0 && (
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
            {loadingDay ? (
              <Spinner className="h-4 w-4" />
            ) : dayErr ? (
              <span className="text-rose-700">{dayErr}</span>
            ) : day ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{fmtDate(date)}</span>
                  <span className="text-slate-500">· {day.shiftName ?? 'tanpa shift'}</span>
                  <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[day.status].cls}`}>{STATUS_STYLE[day.status].label}</span>
                </div>
                <div className="mt-1 text-slate-600">
                  {slots.length ? slots.map(([k, v]) => `${k === 'MASUK' ? 'Masuk' : k === 'PULANG' ? 'Pulang' : k.charAt(0) + k.slice(1).toLowerCase()} ${v.time.slice(0, 5)}`).join(' · ') : 'Tidak ada absen tercatat'}
                </div>
                {alreadyMarked && <div className="mt-1 font-medium text-rose-700">Sudah ditandai tidak bekerja.</div>}
                {!workDay && <div className="mt-1 font-medium text-amber-700">Bukan hari kerja (Off / libur / izin) — tidak bisa ditandai.</div>}
              </>
            ) : null}
          </div>
        )}

        <Field label="Alasan (wajib, min. 10 karakter)" hint="Contoh: Hanya datang absen masuk lalu pulang, pos kosong sejak 08.15 (laporan Koordinator)">
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Batal
          </Button>
          <Button variant="danger" loading={saving} disabled={!userId || !workDay || !!alreadyMarked || reason.trim().length < 10} onClick={submit}>
            Tandai Tidak Bekerja (Alfa)
          </Button>
        </div>
      </div>
    </Modal>
  );
}
