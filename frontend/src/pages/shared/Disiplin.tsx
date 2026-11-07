import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLoad } from '../../components/attendance';
import { useFeedback } from '../../components/feedback';
import { Alert, Badge, Button, Card, Empty, Field, Input, Loading, Modal, PageHeader, PersonCell, Select, Table, Td, Textarea, Th } from '../../components/ui';
import { api, downloadFile, errMsg, Role } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { addDays, fmtDate, todayWIT } from '../../lib/format';
import { Tabs } from '../parkir/shared';

type LetterType = 'PERINGATAN_1' | 'PERINGATAN_2' | 'PANGGILAN_1' | 'PANGGILAN_2';
const TITLE: Record<LetterType, string> = {
  PERINGATAN_1: 'Surat Peringatan Pertama',
  PERINGATAN_2: 'Surat Peringatan Kedua',
  PANGGILAN_1: 'Surat Panggilan Pertama',
  PANGGILAN_2: 'Surat Panggilan Kedua',
};
const SHORT: Record<LetterType, string> = { PERINGATAN_1: 'Peringatan I', PERINGATAN_2: 'Peringatan II', PANGGILAN_1: 'Panggilan I', PANGGILAN_2: 'Panggilan II' };
const REC_CLS: Record<string, string> = {
  PERINGATAN_1: 'bg-amber-100 text-amber-800',
  PERINGATAN_2: 'bg-orange-100 text-orange-800',
  PANGGILAN_1: 'bg-rose-100 text-rose-800',
  PANGGILAN_2: 'bg-rose-200 text-rose-900',
  KEPUTUSAN_MANAJEMEN: 'bg-slate-800 text-white',
};

interface Row {
  user: { id: number; fullName: string; nik: string; role: Role; phone: string };
  streak: number;
  streakDates: string[];
  monthCount: number;
  monthDates: string[];
  recommendation: LetterType | 'KEPUTUSAN_MANAJEMEN' | null;
  letters: { id: number; type: LetterType; number: string; letterDate: string }[];
}
interface Letter {
  id: number;
  type: LetterType;
  number: string;
  letterDate: string;
  alfaDates: string[];
  reportDate: string | null;
  reportTime: string | null;
  employee: string;
  nik: string;
  createdBy: string;
  voidedAt: string | null;
  voidReason: string | null;
  openedAt: string | null;
  receivedAt: string | null;
}

const when = (iso: string) => new Date(iso).toLocaleString('id-ID', { timeZone: 'Asia/Jayapura', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const short = (d: string) => fmtDate(d, false).replace(/ \d{4}$/, '');
const pdfName = (l: { number: string }) => `${l.number.replace(/\//g, '-')}.pdf`;

/** Peringatan disiplin kehadiran (mangkir) sesuai PKWT Pasal 8. */
export default function Disiplin() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'SUPER_ADMIN';
  const [tab, setTab] = useState<'tindakan' | 'surat' | 'pengaturan'>('tindakan');
  return (
    <>
      <PageHeader title="Peringatan Disiplin" subtitle="Karyawan yang tercatat Alfa (mangkir) beserta tindakan sesuai PKWT Pasal 8" />
      <Tabs
        tabs={[
          { key: 'tindakan', label: 'Perlu Tindakan' },
          { key: 'surat', label: 'Surat Terbit' },
          ...(isAdmin ? [{ key: 'pengaturan' as const, label: 'Pengaturan Surat' }] : []),
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'tindakan' && <Tindakan />}
      {tab === 'surat' && <SuratTerbit isAdmin={isAdmin} />}
      {tab === 'pengaturan' && isAdmin && <Pengaturan />}
    </>
  );
}

function Tindakan() {
  const { toast } = useFeedback();
  const { data, error, loading, reload } = useLoad(() => api.get<{ rows: Row[]; needAction: number }>('/discipline/overview'));
  const [target, setTarget] = useState<Row | null>(null);

  if (loading && !data) return <Loading />;
  if (!data) return <Alert>{error}</Alert>;
  return (
    <>
      <div className="mb-4">
        <Alert kind="info">
          Ketentuan PKWT Pasal 8 (dihitung per hari kerja terjadwal; hari Off dan libur dilewati): mangkir <b>1–2 hari</b> → Peringatan Pertama,{' '}
          <b>3–4 hari</b> → Peringatan Kedua tertulis, <b>≥ 5 hari berturut-turut</b> → dipanggil 2 kali secara tertulis. Upah hari mangkir tidak dibayarkan (no
          work no pay).
        </Alert>
      </div>
      <Card title={`Karyawan tercatat Alfa · ${data.needAction} perlu tindakan`} subtitle="Data 45 hari terakhir dari absensi online; diperbarui setiap halaman dibuka">
        {data.rows.length === 0 ? (
          <Empty icon="check" title="Tidak ada karyawan yang Alfa" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Karyawan</Th>
                <Th className="text-center">Berturut-turut</Th>
                <Th className="text-center">Bulan ini</Th>
                <Th>Tanggal Alfa</Th>
                <Th>Saran</Th>
                <Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {data.rows.map((r) => (
                <tr key={r.user.id}>
                  <Td>
                    <PersonCell name={r.user.fullName} sub={r.user.role === 'KOORDINATOR' ? `${r.user.nik} · Koordinator` : r.user.nik} />
                  </Td>
                  <Td className="text-center">
                    <span className={r.streak >= 5 ? 'font-bold text-rose-700' : ''}>{r.streak} hari</span>
                  </Td>
                  <Td className="text-center">{r.monthCount} hari</Td>
                  <Td className="max-w-xs text-xs text-slate-600">
                    {(r.streak >= 5 ? r.streakDates : r.monthDates).map(short).join(', ')}
                    {r.letters.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {r.letters.map((l) => (
                          <Badge key={l.id} className="bg-slate-100 text-slate-700">
                            {SHORT[l.type]} · {short(l.letterDate)}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </Td>
                  <Td>
                    {r.recommendation ? (
                      <Badge className={REC_CLS[r.recommendation]}>{r.recommendation === 'KEPUTUSAN_MANAJEMEN' ? 'Keputusan Manajemen' : SHORT[r.recommendation]}</Badge>
                    ) : (
                      <span className="text-xs text-slate-400">Sudah ditindaklanjuti</span>
                    )}
                    {r.recommendation === 'KEPUTUSAN_MANAJEMEN' && (
                      <div className="mt-1 max-w-[14rem] text-xs text-slate-600">
                        Panggilan I & II sudah terbit. Bila tetap tanpa alasan sah, karyawan dikualifikasikan mengundurkan diri (diputuskan HRD/Manajemen).
                      </div>
                    )}
                  </Td>
                  <Td>
                    <Button variant={r.recommendation && r.recommendation !== 'KEPUTUSAN_MANAJEMEN' ? 'primary' : 'secondary'} className="!px-3 !py-1.5 text-xs" onClick={() => setTarget(r)}>
                      Buat Surat
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {target && (
        <CreateLetter
          row={target}
          onClose={() => setTarget(null)}
          onCreated={async (l) => {
            setTarget(null);
            toast(`${TITLE[l.type]} ${l.number} diterbitkan`);
            reload();
            try {
              await downloadFile(`/discipline/letters/${l.id}/pdf`, pdfName(l));
            } catch (e) {
              toast(errMsg(e), 'error');
            }
          }}
        />
      )}
    </>
  );
}

function CreateLetter({ row, onClose, onCreated }: { row: Row; onClose: () => void; onCreated: (l: Letter) => void }) {
  const { toast } = useFeedback();
  const today = todayWIT();
  const initial: LetterType = row.recommendation && row.recommendation !== 'KEPUTUSAN_MANAJEMEN' ? row.recommendation : 'PERINGATAN_1';
  const [form, setForm] = useState({ type: initial, letterDate: today, reportDate: addDays(today, 2), reportTime: '10:00', reportPlace: '', note: '' });
  const [saving, setSaving] = useState(false);
  const isCall = form.type.startsWith('PANGGILAN');
  const dates = isCall ? row.streakDates : row.monthDates;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const l = await api.post<Letter>('/discipline/letters', {
        userId: row.user.id,
        type: form.type,
        letterDate: form.letterDate,
        ...(isCall ? { reportDate: form.reportDate, reportTime: form.reportTime, reportPlace: form.reportPlace || undefined } : {}),
        note: form.note || undefined,
      });
      onCreated(l);
    } catch (err) {
      toast(errMsg(err), 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open title={`Buat Surat · ${row.user.fullName}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Jenis surat">
          <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as LetterType })}>
            {(Object.keys(TITLE) as LetterType[]).map((t) => (
              <option key={t} value={t}>
                {TITLE[t]}
                {t === row.recommendation ? ' (disarankan)' : ''}
              </option>
            ))}
          </Select>
        </Field>
        <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-700 ring-1 ring-slate-200">
          Tanggal mangkir yang dicantumkan ({dates.length} hari, dari catatan absensi):
          <div className="mt-1 text-xs">{dates.length ? dates.map((d) => fmtDate(d)).join(' · ') : '— tidak ada —'}</div>
        </div>
        <Field label="Tanggal surat">
          <Input type="date" max={today} value={form.letterDate} onChange={(e) => setForm({ ...form, letterDate: e.target.value })} required />
        </Field>
        {isCall && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Tanggal menghadap">
                <Input type="date" min={form.letterDate} value={form.reportDate} onChange={(e) => setForm({ ...form, reportDate: e.target.value })} required />
              </Field>
              <Field label="Jam (WIT)">
                <Input type="time" value={form.reportTime} onChange={(e) => setForm({ ...form, reportTime: e.target.value })} required />
              </Field>
            </div>
            <Field label="Tempat menghadap" hint="Kosongkan untuk memakai tempat bawaan di Pengaturan Surat">
              <Input value={form.reportPlace} onChange={(e) => setForm({ ...form, reportPlace: e.target.value })} maxLength={150} />
            </Field>
          </>
        )}
        <Field label="Catatan tambahan di surat (opsional)">
          <Textarea rows={2} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} maxLength={500} />
        </Field>
        <p className="text-xs text-slate-500">Nomor surat dibuat otomatis. Surat yang sudah terbit tidak bisa diubah; bila salah, Super Admin membatalkannya lalu buat surat baru.</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Batal
          </Button>
          <Button type="submit" loading={saving}>
            Terbitkan & Unduh PDF
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function SuratTerbit({ isAdmin }: { isAdmin: boolean }) {
  const { toast } = useFeedback();
  const { data, reload } = useLoad(() => api.get<Letter[]>('/discipline/letters'));
  const [voiding, setVoiding] = useState<Letter | null>(null);
  const [reason, setReason] = useState('');

  async function doVoid() {
    if (!voiding) return;
    try {
      await api.patch(`/discipline/letters/${voiding.id}/void`, { reason });
      toast('Surat dibatalkan');
      setVoiding(null);
      setReason('');
      reload();
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  }

  if (!data) return <Loading />;
  return (
    <Card title="Surat yang Sudah Diterbitkan" subtitle="Cetak, tandatangani, lalu serahkan kepada karyawan dan minta tanda terima">
      {data.length === 0 ? (
        <Empty title="Belum ada surat" />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Nomor</Th>
              <Th>Jenis</Th>
              <Th>Karyawan</Th>
              <Th>Tanggal</Th>
              <Th>Dibuat oleh</Th>
              <Th>Diterima petugas</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {data.map((l) => (
              <tr key={l.id} className={l.voidedAt ? 'opacity-60' : ''}>
                <Td className="whitespace-nowrap font-mono text-xs">{l.number}</Td>
                <Td>
                  {TITLE[l.type]}
                  {l.voidedAt && <div className="text-xs font-semibold text-rose-700">Dibatalkan: {l.voidReason}</div>}
                </Td>
                <Td>
                  <PersonCell name={l.employee} sub={l.nik} />
                </Td>
                <Td className="whitespace-nowrap">
                  {fmtDate(l.letterDate, false)}
                  {l.reportDate && <div className="text-xs text-slate-500">Menghadap {short(l.reportDate)} {l.reportTime ?? ''}</div>}
                </Td>
                <Td className="text-sm">{l.createdBy}</Td>
                <Td className="whitespace-nowrap text-xs">
                  {l.receivedAt ? (
                    <span className="font-medium text-emerald-700">✓ {when(l.receivedAt)}</span>
                  ) : l.openedAt ? (
                    <span className="text-amber-700">Dibuka {when(l.openedAt)}, belum dikonfirmasi</span>
                  ) : l.voidedAt ? (
                    '—'
                  ) : (
                    <span className="text-rose-700">Belum dibuka</span>
                  )}
                </Td>
                <Td className="whitespace-nowrap">
                  <Button variant="secondary" icon="download" className="!px-2 !py-1 text-xs" onClick={() => downloadFile(`/discipline/letters/${l.id}/pdf`, pdfName(l)).catch((e) => toast(errMsg(e), 'error'))}>
                    PDF
                  </Button>
                  {isAdmin && !l.voidedAt && (
                    <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => setVoiding(l)}>
                      Batalkan
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Modal open={!!voiding} title="Batalkan Surat" onClose={() => setVoiding(null)}>
        <div className="space-y-3">
          <p className="text-sm">
            {voiding && `${TITLE[voiding.type]} ${voiding.number} untuk ${voiding.employee}`} akan ditandai DIBATALKAN. Nomornya tidak dipakai ulang dan riwayatnya tetap
            tersimpan.
          </p>
          <Field label="Alasan pembatalan">
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} minLength={5} maxLength={300} />
          </Field>
          <div className="flex justify-end">
            <Button variant="danger" onClick={doVoid} disabled={reason.trim().length < 5}>
              Batalkan Surat
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}

/** Kop surat, nomor surat, dan penandatangan kini diatur di satu tempat untuk semua dokumen. */
function Pengaturan() {
  return (
    <Card title="Kop surat, nomor surat & penandatangan">
      <p className="text-sm text-slate-600">
        Pengaturan ini sekarang berlaku untuk semua dokumen (surat disiplin, rekap upah, piagam, laporan, roster) dan diubah di satu tempat.
      </p>
      <Link to="/app/identitas" className="mt-3 inline-flex rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">
        Buka Identitas & Kop Surat
      </Link>
    </Card>
  );
}
