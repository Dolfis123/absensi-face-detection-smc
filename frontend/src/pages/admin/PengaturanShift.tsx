import { useEffect, useState } from 'react';
import { useLoad } from '../../components/attendance';
import { useFeedback } from '../../components/feedback';
import { Icon } from '../../components/icons';
import { Alert, Avatar, Button, Card, cx, Empty, Field, Input, Loading, PageHeader } from '../../components/ui';
import { api, errMsg, Shift, SlotType } from '../../lib/api';
import { SLOT_LABEL } from '../../lib/format';

interface SlotDraft {
  type: SlotType;
  windowStart: string;
  windowEnd: string;
}
interface ShiftDraft {
  startTime: string;
  endTime: string;
  slots: SlotDraft[];
}
interface ChangeLog {
  id: number;
  target: string;
  before: { minutes?: number } & Partial<ShiftDraft>;
  after: { minutes?: number } & Partial<ShiftDraft>;
  createdAt: string;
  actor?: { fullName: string };
}
interface SettingsResponse {
  shifts: Shift[];
  lateToleranceMinutes: number;
  logs: ChangeLog[];
}

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const toDraft = (s: Shift): ShiftDraft => ({
  startTime: s.startTime,
  endTime: s.endTime,
  slots: s.slots.map(({ type, windowStart, windowEnd }) => ({ type, windowStart, windowEnd })),
});
const fmtMinutes = (m: number) => (m % 60 === 0 && m ? `${m / 60} jam` : `${m} menit`);

/** Pratinjau jam kerja, jendela absen, dan zona terlambat pada garis waktu. */
function Timeline({ draft, tolerance }: { draft: ShiftDraft; tolerance: number }) {
  const points = [toMin(draft.startTime), toMin(draft.endTime), ...draft.slots.flatMap((s) => [toMin(s.windowStart), toMin(s.windowEnd)])];
  const lo = Math.max(0, Math.floor(Math.min(...points) / 60) * 60 - 60);
  const masuk = draft.slots.find((s) => s.type === 'MASUK');
  const hi = Math.min(24 * 60, Math.ceil(Math.max(...points, masuk ? toMin(masuk.windowEnd) + tolerance : 0) / 60) * 60 + 60);
  const pct = (m: number) => `${((m - lo) / (hi - lo)) * 100}%`;
  const width = (a: number, b: number) => `${(Math.max(0, b - a) / (hi - lo)) * 100}%`;
  const ticks: number[] = [];
  for (let t = lo; t <= hi; t += hi - lo > 12 * 60 ? 120 : 60) ticks.push(t);

  return (
    <div>
      <div className="relative h-16 rounded-xl bg-slate-50 ring-1 ring-slate-200">
        <div
          className="absolute top-2 h-3 rounded-full bg-brand-200"
          style={{ left: pct(toMin(draft.startTime)), width: width(toMin(draft.startTime), toMin(draft.endTime)) }}
          title={`Jam kerja ${draft.startTime}–${draft.endTime}`}
        />
        {draft.slots.map((s) => (
          <div key={s.type}>
            <div
              className="absolute top-7 h-6 rounded-md bg-emerald-500"
              style={{ left: pct(toMin(s.windowStart)), width: width(toMin(s.windowStart), toMin(s.windowEnd)), minWidth: 4 }}
              title={`Absen ${SLOT_LABEL[s.type]} ${s.windowStart}–${s.windowEnd}`}
            />
            {s.type === 'MASUK' && tolerance > 0 && (
              <div
                className="absolute top-7 h-6 rounded-md bg-amber-400/80 [background-image:repeating-linear-gradient(45deg,transparent,transparent_4px,rgba(255,255,255,.35)_4px,rgba(255,255,255,.35)_8px)]"
                style={{ left: pct(toMin(s.windowEnd)), width: width(toMin(s.windowEnd), toMin(s.windowEnd) + tolerance) }}
                title={`Masih diterima sebagai Terlambat sampai ${tolerance} menit`}
              />
            )}
          </div>
        ))}
      </div>
      <div className="relative mt-1 h-4 text-[10px] text-slate-400">
        {ticks.map((t) => (
          <span key={t} className="absolute -translate-x-1/2" style={{ left: pct(t) }}>
            {String(Math.floor(t / 60)).padStart(2, '0')}:00
          </span>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-full bg-brand-200" />Jam kerja</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-4 rounded bg-emerald-500" />Jendela absen (tepat waktu)</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-4 rounded bg-amber-400" />Masih diterima sebagai Terlambat</span>
      </div>
    </div>
  );
}

function ShiftEditor({ shift, tolerance, onSaved }: { shift: Shift; tolerance: number; onSaved: () => void }) {
  const original = toDraft(shift);
  const [draft, setDraft] = useState(original);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast, confirm } = useFeedback();
  const dirty = JSON.stringify(draft) !== JSON.stringify(original);

  useEffect(() => setDraft(toDraft(shift)), [shift]);

  const setSlot = (i: number, key: 'windowStart' | 'windowEnd', value: string) =>
    setDraft((d) => ({ ...d, slots: d.slots.map((s, j) => (j === i ? { ...s, [key]: value } : s)) }));

  async function save() {
    const ok = await confirm({
      title: `Simpan jam ${shift.name}?`,
      message: 'Jam baru langsung berlaku untuk absen berikutnya bagi semua karyawan di shift ini. Absen yang sudah tercatat tidak berubah. Beri tahu karyawan setelah menyimpan.',
      confirmLabel: 'Simpan',
    });
    if (!ok) return;
    setSaving(true);
    setError(null);
    try {
      await api.put(`/admin/shifts/${shift.id}`, draft);
      toast(`Jam ${shift.name} tersimpan dan langsung berlaku.`);
      onSaved();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setSaving(false);
    }
  }

  const workHours = (toMin(draft.endTime) - toMin(draft.startTime)) / 60;

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          {shift.name}
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">{shift.slots.length}x absen</span>
        </span>
      }
      subtitle={workHours > 0 ? `${workHours % 1 ? workHours.toFixed(1) : workHours} jam kerja` : undefined}
      actions={
        dirty ? (
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => { setDraft(original); setError(null); }}>
              Batal
            </Button>
            <Button icon="check" loading={saving} onClick={save}>
              Simpan
            </Button>
          </div>
        ) : (
          <span className="text-xs text-slate-400">Tidak ada perubahan</span>
        )
      }
    >
      <div className="space-y-5">
        {error && <Alert>{error}</Alert>}
        <div className="grid grid-cols-2 gap-3 sm:max-w-sm">
          <Field label="Jam mulai kerja">
            <Input type="time" value={draft.startTime} onChange={(e) => e.target.value && setDraft({ ...draft, startTime: e.target.value })} />
          </Field>
          <Field label="Jam selesai kerja">
            <Input type="time" value={draft.endTime} onChange={(e) => e.target.value && setDraft({ ...draft, endTime: e.target.value })} />
          </Field>
        </div>

        <div className="overflow-hidden rounded-xl border border-slate-200">
          <div className="grid grid-cols-[1fr_1fr_1fr] gap-3 bg-slate-50 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500 sm:grid-cols-[1.2fr_1fr_1fr_1.4fr]">
            <span>Slot absen</span>
            <span>Dibuka</span>
            <span>Ditutup</span>
            <span className="hidden sm:block">Keterangan</span>
          </div>
          {draft.slots.map((s, i) => (
            <div key={s.type} className="grid grid-cols-[1fr_1fr_1fr] items-center gap-3 border-t border-slate-100 px-4 py-3 sm:grid-cols-[1.2fr_1fr_1fr_1.4fr]">
              <span className="text-sm font-medium text-slate-800">Absen {SLOT_LABEL[s.type]}</span>
              <Input type="time" value={s.windowStart} onChange={(e) => e.target.value && setSlot(i, 'windowStart', e.target.value)} />
              <Input type="time" value={s.windowEnd} onChange={(e) => e.target.value && setSlot(i, 'windowEnd', e.target.value)} />
              <span className="hidden text-xs text-slate-500 sm:block">
                {s.type === 'MASUK' && tolerance > 0
                  ? `Terlambat bila ${s.windowEnd}–${(() => {
                      const m = toMin(s.windowEnd) + tolerance;
                      return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
                    })()}`
                  : 'Hanya diterima di dalam jendela'}
              </span>
            </div>
          ))}
        </div>

        <Timeline draft={draft} tolerance={tolerance} />
      </div>
    </Card>
  );
}

function ToleranceCard({ value, onSaved }: { value: number; onSaved: () => void }) {
  const [minutes, setMinutes] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast, confirm } = useFeedback();
  useEffect(() => setMinutes(value), [value]);

  async function save() {
    const ok = await confirm({
      title: 'Ubah toleransi terlambat?',
      message: `Absen Masuk akan diterima sebagai Terlambat sampai ${fmtMinutes(minutes)} setelah jendela masuk ditutup. Lewat dari itu dihitung Alfa. Berlaku untuk semua shift.`,
      confirmLabel: 'Simpan',
    });
    if (!ok) return;
    setSaving(true);
    setError(null);
    try {
      await api.put('/admin/settings/late-tolerance', { minutes });
      toast('Toleransi terlambat tersimpan.');
      onSaved();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="Toleransi terlambat" subtitle="Berlaku untuk Absen Masuk di semua shift">
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Batas terlambat (menit)">
            <Input type="number" min={0} max={240} step={5} value={minutes} onChange={(e) => setMinutes(Math.max(0, Number(e.target.value)))} className="w-32" />
          </Field>
          <div className="flex flex-wrap gap-1.5 pb-0.5">
            {[0, 30, 60, 90, 120].map((p) => (
              <button
                key={p}
                onClick={() => setMinutes(p)}
                className={cx(
                  'rounded-lg px-3 py-1.5 text-xs font-semibold ring-1 transition',
                  minutes === p ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-slate-600 ring-slate-200 hover:bg-slate-50',
                )}
              >
                {p === 0 ? 'Tanpa toleransi' : fmtMinutes(p)}
              </button>
            ))}
          </div>
          <Button className="ml-auto" icon="check" loading={saving} disabled={minutes === value} onClick={save}>
            Simpan
          </Button>
        </div>
        <p className="text-sm text-slate-500">
          {minutes === 0
            ? 'Absen Masuk hanya diterima di dalam jendela masuk. Lewat sedikit saja langsung dihitung Alfa.'
            : `Absen Masuk setelah jendela ditutup tetap diterima dengan status Terlambat selama ${fmtMinutes(minutes)}. Lewat dari itu dihitung Alfa.`}
        </p>
      </div>
    </Card>
  );
}

function describe(log: ChangeLog) {
  if (log.before.minutes !== undefined) return `${fmtMinutes(log.before.minutes)} → ${fmtMinutes(log.after.minutes ?? 0)}`;
  const parts: string[] = [];
  if (log.before.startTime !== log.after.startTime || log.before.endTime !== log.after.endTime) {
    parts.push(`Jam kerja ${log.before.startTime}–${log.before.endTime} → ${log.after.startTime}–${log.after.endTime}`);
  }
  log.after.slots?.forEach((s, i) => {
    const b = log.before.slots?.[i];
    if (b && (b.windowStart !== s.windowStart || b.windowEnd !== s.windowEnd)) {
      parts.push(`${SLOT_LABEL[s.type]} ${b.windowStart}–${b.windowEnd} → ${s.windowStart}–${s.windowEnd}`);
    }
  });
  return parts.join(' · ');
}

export default function PengaturanShift() {
  const { data, error, loading, reload } = useLoad(() => api.get<SettingsResponse>('/admin/shift-settings'));

  return (
    <>
      <PageHeader
        title="Pengaturan Shift"
        subtitle="Atur jam kerja, jendela absen, dan toleransi terlambat. Perubahan langsung berlaku untuk absen berikutnya."
      />
      {error && <Alert>{error}</Alert>}
      {loading && !data ? (
        <Loading />
      ) : (
        data && (
          <div className="space-y-6">
            <Alert kind="info">
              Data absen yang sudah tercatat tidak berubah. Jendela absen tidak boleh saling tumpang tindih dan semua jam berada di hari yang sama (tidak
              melewati 24:00). Jenis slot tiap shift tetap: Shift 1 tiga kali absen, Shift 2 dua kali.
            </Alert>
            <ToleranceCard value={data.lateToleranceMinutes} onSaved={reload} />
            <div className="grid gap-6 xl:grid-cols-2">
              {data.shifts.map((s) => (
                <ShiftEditor key={s.id} shift={s} tolerance={data.lateToleranceMinutes} onSaved={reload} />
              ))}
            </div>
            <Card title="Riwayat perubahan" subtitle="Tercatat otomatis setiap kali jam shift atau toleransi diubah">
              {data.logs.length === 0 ? (
                <Empty icon="clock" title="Belum ada perubahan" />
              ) : (
                <ul className="divide-y divide-slate-100">
                  {data.logs.map((l) => (
                    <li key={l.id} className="flex items-start gap-3 py-3">
                      <Avatar name={l.actor?.fullName ?? '?'} size="sm" />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm">
                          <span className="font-semibold text-slate-900">{l.target}</span>
                          <span className="text-slate-500"> diubah oleh {l.actor?.fullName ?? '-'}</span>
                        </div>
                        <div className="mt-0.5 text-xs text-slate-600">{describe(l)}</div>
                      </div>
                      <span className="flex shrink-0 items-center gap-1 text-xs text-slate-400">
                        <Icon name="clock" className="h-3.5 w-3.5" />
                        {new Date(l.createdAt).toLocaleString('id-ID', { timeZone: 'Asia/Jayapura', dateStyle: 'medium', timeStyle: 'short' })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        )
      )}
    </>
  );
}
