import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLoad } from '../../components/attendance';
import { useFeedback } from '../../components/feedback';
import { RosterDownloadButtons } from '../../components/RosterDownload';
import { Alert, Badge, Button, Card, cx, Field, Loading, Modal, PageHeader, Select, Table, Td, Th } from '../../components/ui';
import { api, errMsg, Role } from '../../lib/api';
import { addDays, fmtDate, mondayOf, shortDay, todayWIT } from '../../lib/format';

interface Rule {
  userId: number;
  fullName: string;
  nik: string;
  role: Role;
  saved: boolean;
  fixedShiftId: number | null;
  offDays: number[];
  noShift1Days: number[];
  noShift2Days: number[];
  active: boolean;
}
interface RulesResponse {
  rules: Rule[];
  shifts: { id: number; code: string; name: string; startTime: string; endTime: string }[];
  shift1Id: number;
  shift2Id: number;
}
type Cell = number | 'OFF' | null;
interface Preview {
  start: string;
  end: string;
  dates: string[];
  holidays: { date: string; name: string }[];
  rows: { userId: number; fullName: string; role: Role; cells: Cell[] }[];
  stats: {
    userId: number;
    name: string;
    shift1: number;
    shift2: number;
    fixed: number;
    off: number;
    weekendOff: number;
    shortRest: number;
    offByWeekday: number[];
    maxSameMate: number;
  }[];
  daily: { date: string; shift1: number; shift2: number; fixed: number; off: number }[];
  warnings: string[];
  existingSchedules: number;
}

/**
 * 7 minggu = periode terpendek yang paling rata untuk 1 hari Off per minggu: setiap orang mendapat 7 hari Off
 * sehingga Off-nya bisa bergilir ke semua hari Senin–Minggu, Off Sabtu/Minggu sama banyak, dan jumlah
 * Shift 1 / Shift 2 antar karyawan selisih paling banyak 1 hari.
 */
const RECOMMENDED_WEEKS = 7;

// Urutan Senin → Minggu (angka hari: 0 = Minggu)
const WEEK = [1, 2, 3, 4, 5, 6, 0];
const DAY_SHORT = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
const daysText = (xs: number[]) => (xs.length === 7 ? 'Semua hari' : xs.length === 0 ? '—' : WEEK.filter((d) => xs.includes(d)).map((d) => DAY_SHORT[d]).join(', '));

function DayToggles({ value, onChange, tone }: { value: number[]; onChange: (v: number[]) => void; tone: string }) {
  return (
    <div className="flex flex-wrap gap-1">
      {WEEK.map((d) => {
        const on = value.includes(d);
        return (
          <button
            key={d}
            type="button"
            onClick={() => onChange(on ? value.filter((x) => x !== d) : [...value, d])}
            className={cx('h-8 w-11 rounded-lg text-xs font-semibold ring-1 transition', on ? tone : 'bg-white text-slate-500 ring-slate-200 hover:ring-slate-300')}
          >
            {DAY_SHORT[d]}
          </button>
        );
      })}
    </div>
  );
}

export default function RosterOtomatis() {
  const { toast, confirm } = useFeedback();
  const today = todayWIT();
  const { data, error, loading, reload } = useLoad(() => api.get<RulesResponse>('/admin/roster/rules'));
  const [editing, setEditing] = useState<Rule | null>(null);
  const [savingRule, setSavingRule] = useState(false);

  const nextMonday = mondayOf(today) === today ? today : addDays(mondayOf(today), 7);
  const [start, setStart] = useState(nextMonday);
  const [weeks, setWeeks] = useState(RECOMMENDED_WEEKS);
  const [shift2Extra, setShift2Extra] = useState(1);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [generating, setGenerating] = useState(false);
  const [applying, setApplying] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ from: string; to: string } | null>(null);

  useEffect(() => setPreview(null), [start, weeks, shift2Extra]);

  if (loading && !data) return <Loading />;
  if (!data) return <Alert>{error}</Alert>;
  const shiftById = new Map(data.shifts.map((s) => [s.id, s]));
  const shiftName = (id: number | null) => (id === null ? 'Digilir Shift 1 / Shift 2' : (shiftById.get(id)?.name ?? '?'));

  async function saveRule() {
    if (!editing) return;
    setSavingRule(true);
    try {
      const { userId, fixedShiftId, offDays, noShift1Days, noShift2Days, active } = editing;
      await api.put(`/admin/roster/rules/${userId}`, { fixedShiftId, offDays, noShift1Days, noShift2Days, active });
      toast(`Aturan ${editing.fullName} disimpan`);
      setEditing(null);
      setPreview(null);
      reload();
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setSavingRule(false);
    }
  }

  async function generate() {
    setGenerating(true);
    setGenError(null);
    try {
      setPreview(await api.post<Preview>('/admin/roster/generate', { start, weeks, shift2Extra }));
    } catch (e) {
      setGenError(errMsg(e));
    } finally {
      setGenerating(false);
    }
  }

  async function apply() {
    if (!preview) return;
    const ok = await confirm({
      title: 'Simpan roster otomatis?',
      message: (
        <>
          Roster {fmtDate(preview.start, false)} – {fmtDate(preview.end, false)} untuk {preview.rows.length} orang akan disimpan.
          {preview.existingSchedules > 0 && (
            <>
              {' '}
              <b>{preview.existingSchedules} jadwal yang sudah ada di rentang ini akan ditimpa.</b>
            </>
          )}{' '}
          Setelah disimpan, Anda masih bisa mengubah sel tertentu di halaman Roster Shift.
        </>
      ),
      confirmLabel: 'Simpan ke Roster',
    });
    if (!ok) return;
    setApplying(true);
    try {
      const holidays = new Set(preview.holidays.map((h) => h.date));
      const entries = preview.rows.flatMap((r) =>
        preview.dates
          .map((date, i) => ({ date, v: r.cells[i] }))
          .filter(({ date, v }) => !holidays.has(date) && v !== null && date >= today)
          .map(({ date, v }) => ({ userId: r.userId, date, shiftId: typeof v === 'number' ? v : null, off: v === 'OFF' })),
      );
      await api.put('/admin/schedules', { entries });
      toast(`${entries.length} jadwal tersimpan ke Roster Shift`);
      setSaved({ from: preview.start, to: preview.end });
      setPreview(null);
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setApplying(false);
    }
  }

  const cellCls = (v: Cell) =>
    v === 'OFF'
      ? 'bg-slate-600 text-white'
      : v === data.shift1Id
        ? 'bg-sky-100 text-sky-800'
        : v === data.shift2Id
          ? 'bg-violet-100 text-violet-800'
          : v === null
            ? 'bg-white text-slate-300'
            : 'bg-teal-100 text-teal-800';
  const cellText = (v: Cell) => (v === 'OFF' ? 'Off' : v === data.shift1Id ? '1' : v === data.shift2Id ? '2' : v === null ? '·' : 'P');

  return (
    <>
      <PageHeader
        title="Roster Otomatis"
        subtitle="Buat roster beberapa minggu sekaligus (disarankan 7 minggu). Shift 1, Shift 2, dan hari Off dibagi rata sesuai aturan tiap karyawan."
        actions={
          <Link to="/app/roster">
            <Button variant="secondary" icon="calendar">
              Buka Roster Shift
            </Button>
          </Link>
        }
      />

      <div className="grid gap-4 xl:grid-cols-5">
        <Card
          className="xl:col-span-3"
          title="1. Aturan Karyawan"
          subtitle="Disimpan permanen dan dipakai untuk setiap periode berikutnya. Klik Ubah untuk mengatur."
        >
          <Table>
            <thead>
              <tr>
                <Th>Karyawan</Th>
                <Th>Shift</Th>
                <Th>Boleh Off</Th>
                <Th>Batasan</Th>
                <Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {data.rules.map((r) => (
                <tr key={r.userId} className={r.active ? '' : 'opacity-50'}>
                  <Td>
                    <div className="font-medium">{r.fullName}</div>
                    <div className="text-xs text-slate-400">
                      {r.role === 'KOORDINATOR' ? 'Koordinator' : r.nik}
                      {!r.active && ' · tidak ikut roster otomatis'}
                    </div>
                    {!r.saved && <Badge className="mt-1 bg-amber-100 text-amber-800">Aturan bawaan (belum diatur)</Badge>}
                  </Td>
                  <Td className="text-sm">{shiftName(r.fixedShiftId)}</Td>
                  <Td className="text-sm">{daysText(r.offDays)}</Td>
                  <Td className="text-xs">
                    {r.noShift1Days.length > 0 && <div className="text-sky-700">Tidak Shift 1: {daysText(r.noShift1Days)}</div>}
                    {r.noShift2Days.length > 0 && <div className="text-violet-700">Tidak Shift 2: {daysText(r.noShift2Days)}</div>}
                    {r.noShift1Days.length + r.noShift2Days.length === 0 && <span className="text-slate-400">—</span>}
                  </Td>
                  <Td>
                    <Button variant="ghost" onClick={() => setEditing({ ...r })}>
                      Ubah
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>

        <Card className="xl:col-span-2" title="2. Buat Roster" subtitle="Hasilnya berupa pratinjau dulu, belum tersimpan.">
          <div className="space-y-4">
            <Field label="Mulai tanggal" hint="Disarankan hari Senin supaya hitungan per minggu rapi">
              <input
                type="date"
                min={today}
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className="block w-full rounded-lg border-slate-300 text-sm shadow-sm focus:border-brand-500 focus:ring-brand-500"
              />
            </Field>
            <Field label="Lama periode" hint="7 minggu: setiap orang Off bergilir di semua hari Senin–Minggu dan pembagian shift paling rata">
              <Select value={weeks} onChange={(e) => setWeeks(Number(e.target.value))}>
                {Array.from({ length: 11 }, (_, i) => i + 3).map((w) => (
                  <option key={w} value={w}>
                    {w} minggu{w === RECOMMENDED_WEEKS ? ' — disarankan (paling rata)' : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Shift 2 lebih banyak dari Shift 1" hint="Selisih minimal jumlah orang Shift 2 dibanding Shift 1 setiap hari">
              <Select value={shift2Extra} onChange={(e) => setShift2Extra(Number(e.target.value))}>
                {[0, 1, 2, 3].map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? 'Sama banyak' : `+${n} orang`}
                  </option>
                ))}
              </Select>
            </Field>
            <p className="text-xs text-slate-500">
              Periode: {fmtDate(start, false)} – {fmtDate(addDays(start, weeks * 7 - 1), false)} · 1 hari Off per orang per minggu · Hari
              libur nasional dilewati.
            </p>
            {genError && <Alert>{genError}</Alert>}
            <Button className="w-full" onClick={generate} loading={generating}>
              Buat Pratinjau Roster
            </Button>
          </div>
        </Card>
      </div>

      {saved && !preview && (
        <Card
          className="mt-4"
          title="Roster tersimpan — siap dibagikan"
          subtitle={`${fmtDate(saved.from, false)} – ${fmtDate(saved.to, false)}. Unduh lalu kirim ke grup WhatsApp. Aturan internal karyawan tidak ikut dicetak.`}
          actions={<RosterDownloadButtons from={saved.from} to={saved.to} />}
        >
          <p className="text-sm text-slate-600">
            File berisi satu halaman per minggu (jadwal, jumlah orang per hari, dan keterangan semua simbol) serta rekap Shift 1, Shift 2, Shift Penuh, dan
            hari Off tiap karyawan. Jadwal juga bisa diunduh kapan saja dari halaman Roster Shift.
          </p>
        </Card>
      )}

      {preview && (
        <>
          <Card
            className="mt-4"
            title="3. Pratinjau Roster"
            subtitle={`${fmtDate(preview.start, false)} – ${fmtDate(preview.end, false)} · 1 = Shift 1, 2 = Shift 2, P = Shift Penuh, Off = libur pribadi`}
            actions={
              <div className="flex gap-2">
                <Button variant="secondary" onClick={generate} loading={generating}>
                  Buat Ulang
                </Button>
                <Button variant="success" icon="check" onClick={apply} loading={applying}>
                  Simpan ke Roster
                </Button>
              </div>
            }
          >
            <div className="mb-3">
              <Alert kind="success">
                Semua aturan karyawan terpenuhi (sudah dicek sistem per tanggal):
                <ul className="mt-1 list-disc pl-4">
                  {data.rules
                    .filter((r) => r.active && (r.fixedShiftId !== null || r.offDays.length < 7 || r.noShift1Days.length || r.noShift2Days.length))
                    .map((r) => (
                      <li key={r.userId}>
                        <b>{r.fullName}</b>:{' '}
                        {[
                          r.fixedShiftId !== null && `selalu ${shiftName(r.fixedShiftId)}`,
                          r.offDays.length < 7 && `Off hanya ${daysText(r.offDays)}`,
                          r.noShift1Days.length > 0 && `${daysText(r.noShift1Days)} tidak Shift 1`,
                          r.noShift2Days.length > 0 && `${daysText(r.noShift2Days)} tidak Shift 2`,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </li>
                    ))}
                </ul>
              </Alert>
            </div>
            {preview.warnings.length > 0 && (
              <div className="mb-3">
                <Alert kind="info">
                  <ul className="list-disc pl-4">
                    {preview.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </Alert>
              </div>
            )}
            <div className="-mx-4 overflow-x-auto sm:mx-0">
              <table className="text-xs">
                <thead>
                  <tr>
                    <th className="sticky left-0 z-10 bg-white px-2 py-1 text-left font-semibold text-slate-500">Karyawan</th>
                    {preview.dates.map((d) => {
                      const sd = shortDay(d);
                      const monday = new Date(`${d}T00:00:00Z`).getUTCDay() === 1;
                      return (
                        <th key={d} className={cx('px-0.5 py-1 text-center font-medium', sd.weekend ? 'text-rose-500' : 'text-slate-500', monday && 'border-l border-slate-200')}>
                          <div>{sd.day.slice(0, 2)}</div>
                          <div className="text-sm">{sd.num}</div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r) => (
                    <tr key={r.userId}>
                      <td className="sticky left-0 z-10 whitespace-nowrap bg-white px-2 py-0.5 font-medium">{r.fullName}</td>
                      {r.cells.map((v, i) => {
                        const monday = new Date(`${preview.dates[i]}T00:00:00Z`).getUTCDay() === 1;
                        return (
                          <td key={i} className={cx('p-0.5', monday && 'border-l border-slate-200')}>
                            <div className={cx('flex h-7 w-7 items-center justify-center rounded-md font-semibold', cellCls(v))}>{cellText(v)}</div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  <tr className="border-t border-slate-200 text-slate-500">
                    <td className="sticky left-0 bg-white px-2 py-1">Jumlah Shift 1 / Shift 2</td>
                    {preview.daily.map((d) => (
                      <td key={d.date} className="p-0.5 text-center text-[10px] leading-tight">
                        {d.shift1}/{d.shift2}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>

          <Card className="mt-4" title="Pemerataan per Karyawan" subtitle="Cek apakah pembagian sudah adil sebelum disimpan">
            <Table>
              <thead>
                <tr>
                  <Th>Karyawan</Th>
                  <Th className="text-center">Shift 1</Th>
                  <Th className="text-center">Shift 2</Th>
                  <Th className="text-center">Shift Penuh</Th>
                  <Th className="text-center">Off</Th>
                  <Th className="text-center">Off Sabtu/Minggu</Th>
                  <Th>Hari Off</Th>
                  <Th className="text-center">Off bareng orang yang sama</Th>
                  <Th className="text-center">Pulang malam → masuk pagi</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {preview.stats.map((s) => (
                  <tr key={s.userId}>
                    <Td className="font-medium">{s.name}</Td>
                    <Td className="text-center">{s.shift1 || '—'}</Td>
                    <Td className="text-center">{s.shift2 || '—'}</Td>
                    <Td className="text-center">{s.fixed || '—'}</Td>
                    <Td className="text-center">{s.off}</Td>
                    <Td className="text-center">{s.weekendOff}</Td>
                    <Td className="whitespace-nowrap text-xs">
                      {WEEK.filter((d) => s.offByWeekday[d]).map((d) => (
                        <span key={d} className={cx('mr-1', s.offByWeekday[d] > 1 && 'font-semibold text-amber-700')}>
                          {DAY_SHORT[d]}
                          {s.offByWeekday[d] > 1 && `×${s.offByWeekday[d]}`}
                        </span>
                      ))}
                    </Td>
                    <Td className="text-center">{s.maxSameMate > 0 ? `maks ${s.maxSameMate}×` : '—'}</Td>
                    <Td className="text-center">{s.shortRest > 0 ? <Badge className="bg-amber-100 text-amber-800">{s.shortRest}×</Badge> : '—'}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </>
      )}

      <Modal open={!!editing} title={editing ? `Aturan: ${editing.fullName}` : ''} onClose={() => setEditing(null)}>
        {editing && (
          <div className="space-y-4">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} />
              Ikut dibuatkan roster otomatis
            </label>
            <Field label="Shift">
              <Select
                value={editing.fixedShiftId ?? ''}
                onChange={(e) => setEditing({ ...editing, fixedShiftId: e.target.value ? Number(e.target.value) : null })}
              >
                <option value="">Digilir Shift 1 / Shift 2 (bergantian)</option>
                {data.shifts.map((s) => (
                  <option key={s.id} value={s.id}>
                    Selalu {s.name} ({s.startTime}–{s.endTime})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Hari yang boleh jadi hari Off" hint="Pilih satu hari saja jika Off-nya selalu tetap (mis. Koordinator: Senin)">
              <DayToggles value={editing.offDays} onChange={(v) => setEditing({ ...editing, offDays: v })} tone="bg-slate-600 text-white ring-slate-600" />
            </Field>
            {editing.fixedShiftId === null && (
              <>
                <Field label="Tidak bisa Shift 1 (pagi) pada hari" hint="Contoh: ibadah Minggu pagi">
                  <DayToggles value={editing.noShift1Days} onChange={(v) => setEditing({ ...editing, noShift1Days: v })} tone="bg-sky-600 text-white ring-sky-600" />
                </Field>
                <Field label="Tidak bisa Shift 2 (sore–malam) pada hari" hint="Contoh: kuliah malam Senin, Selasa, Rabu, Jumat">
                  <DayToggles value={editing.noShift2Days} onChange={(v) => setEditing({ ...editing, noShift2Days: v })} tone="bg-violet-600 text-white ring-violet-600" />
                </Field>
              </>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={() => setEditing(null)}>
                Batal
              </Button>
              <Button onClick={saveRule} loading={savingRule}>
                Simpan Aturan
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
