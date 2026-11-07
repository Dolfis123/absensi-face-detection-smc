import { useState } from 'react';
import { useLoad } from '../../components/attendance';
import { useFeedback } from '../../components/feedback';
import { Alert, Badge, Button, Card, Empty, Loading, PageHeader, Table, Td, Th } from '../../components/ui';
import { api, errMsg } from '../../lib/api';

type Level = 'CRITICAL' | 'WARNING' | 'INFO';
interface SysAlert {
  id: number;
  key: string;
  level: Level;
  title: string;
  message: string;
  active: boolean;
  firstAt: string;
  resolvedAt: string | null;
  notifiedAt: string | null;
}
interface Chat {
  id: string;
  name: string;
}
interface Status {
  checks: {
    at: string;
    face: { ok: boolean; ms: number | null; error?: string };
    backup: { status: string; time: string | null; message: string | null; offsite: boolean };
    restoreTest: { status: string; time: string | null; message: string | null };
    disk: { usedPct: number; freeGb: number } | null;
    unreadLetters: number;
  };
  telegram: { configured: boolean; chats: Chat[] };
  active: SysAlert[];
  history: SysAlert[];
}

const LEVEL: Record<Level, { label: string; cls: string }> = {
  CRITICAL: { label: 'Kritis', cls: 'bg-rose-100 text-rose-800' },
  WARNING: { label: 'Perhatian', cls: 'bg-amber-100 text-amber-800' },
  INFO: { label: 'Info', cls: 'bg-slate-100 text-slate-700' },
};
const when = (iso: string | null) =>
  iso ? new Date(iso.includes('T') ? iso : iso.replace(' ', 'T').replace(/ ([+-]\d{2})(\d{2})$/, '$1:$2')).toLocaleString('id-ID', { timeZone: 'Asia/Jayapura', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

/** Kesehatan sistem & peringatan otomatis (Telegram) — khusus Super Admin. */
export default function Sistem() {
  const { toast } = useFeedback();
  const { data, error, loading, reload } = useLoad(() => api.get<Status>('/system/status'));
  const [busy, setBusy] = useState<string | null>(null);
  const [found, setFound] = useState<Chat[] | null>(null);

  async function act<T>(key: string, fn: () => Promise<T>, ok?: string) {
    setBusy(key);
    try {
      const r = await fn();
      if (ok) toast(ok);
      return r;
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(null);
    }
  }

  if (loading && !data) return <Loading />;
  if (!data) return <Alert>{error}</Alert>;
  const c = data.checks;
  const chats = data.telegram.chats;

  const tile = (title: string, ok: boolean | null, value: string, sub: string) => (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-slate-500">{title}</p>
        <span className={`h-2.5 w-2.5 rounded-full ${ok === null ? 'bg-slate-300' : ok ? 'bg-emerald-500' : 'bg-rose-500'}`} />
      </div>
      <p className="mt-1 text-lg font-bold text-slate-900">{value}</p>
      <p className="mt-0.5 text-xs text-slate-500">{sub}</p>
    </div>
  );
  const backupOk = c.backup.status === 'ok' ? c.backup.offsite : c.backup.status === 'tidak-dipantau' ? null : false;

  return (
    <>
      <PageHeader
        title="Kesehatan Sistem"
        subtitle="Diperiksa otomatis tiap 5 menit. Masalah dikirim ke Telegram Super Admin dan tampil di lonceng."
        actions={
          <Button variant="secondary" icon="activity" loading={busy === 'check'} onClick={() => act('check', () => api.post('/system/check-now').then(reload), 'Pemeriksaan selesai')}>
            Periksa sekarang
          </Button>
        }
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tile('Pengenalan wajah', c.face.ok, c.face.ok ? 'Normal' : 'Mati', c.face.ok ? `respons ${c.face.ms} ms` : (c.face.error ?? 'tidak merespons'))}
        {tile(
          'Backup harian',
          backupOk,
          c.backup.status === 'ok' ? (c.backup.offsite ? 'Lokal + Google Drive' : 'Lokal saja') : c.backup.status === 'tidak-dipantau' ? 'Tidak dipantau' : c.backup.status === 'gagal' ? 'Gagal' : 'Belum ada',
          c.backup.time ? `terakhir ${when(c.backup.time)} WIT` : c.backup.status === 'tidak-dipantau' ? 'hanya di server produksi' : '—',
        )}
        {tile(
          'Uji pemulihan',
          c.restoreTest.status === 'ok' ? true : c.restoreTest.status === 'gagal' ? false : null,
          c.restoreTest.status === 'ok' ? 'Berhasil' : c.restoreTest.status === 'gagal' ? 'Gagal' : 'Belum ada',
          c.restoreTest.time ? `${when(c.restoreTest.time)} WIT` : 'otomatis tiap bulan',
        )}
        {tile('Ruang disk', c.disk ? c.disk.usedPct < 90 : null, c.disk ? `${c.disk.usedPct}% terpakai` : '—', c.disk ? `sisa ${c.disk.freeGb} GB` : '')}
      </div>
      <p className="mt-2 text-xs text-slate-400">Diperiksa {when(c.at)} WIT · surat belum diterima petugas &gt; 3 hari: {c.unreadLetters}</p>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title={`Peringatan aktif (${data.active.length})`}>
          {data.active.length === 0 ? (
            <Empty icon="check" title="Semua normal" />
          ) : (
            <div className="space-y-2">
              {data.active.map((a) => (
                <div key={a.id} className="rounded-xl border border-slate-200 p-3">
                  <div className="flex items-center gap-2">
                    <Badge className={LEVEL[a.level].cls}>{LEVEL[a.level].label}</Badge>
                    <span className="font-semibold">{a.title}</span>
                  </div>
                  <p className="mt-1 whitespace-pre-line text-sm text-slate-600">{a.message}</p>
                  <p className="mt-1 text-xs text-slate-400">
                    Sejak {when(a.firstAt)} WIT · {a.notifiedAt ? 'terkirim ke Telegram' : 'belum terkirim ke Telegram'}
                  </p>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Penerima Telegram" subtitle="Peringatan sistem + ringkasan kehadiran kemarin setiap pukul 07.00 WIT">
          {!data.telegram.configured ? (
            <div className="space-y-2 text-sm text-slate-600">
              <Alert kind="info">Telegram belum dipasang. Peringatan tetap tampil di halaman ini dan di lonceng.</Alert>
              <ol className="list-decimal space-y-1 pl-5">
                <li>
                  Di Telegram, chat <b>@BotFather</b> → kirim <code>/newbot</code> → beri nama, mis. <i>SMC Absensi Bot</i> → salin <b>token</b> yang diberikan.
                </li>
                <li>
                  Di VPS: <code>nano /var/www/smc/backend/.env</code> → isi baris <code>TELEGRAM_BOT_TOKEN=token-tadi</code> → simpan.
                </li>
                <li>
                  <code>systemctl restart smc-backend</code>, lalu muat ulang halaman ini.
                </li>
              </ol>
            </div>
          ) : (
            <div className="space-y-3 text-sm">
              {chats.length ? (
                <ul className="space-y-1">
                  {chats.map((ch) => (
                    <li key={ch.id} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
                      <span>{ch.name}</span>
                      <Button
                        variant="ghost"
                        className="!px-2 !py-1 text-xs"
                        onClick={() => act('save', () => api.put('/system/telegram/chats', chats.filter((x) => x.id !== ch.id)).then(reload), 'Penerima dihapus')}
                      >
                        Hapus
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <Alert kind="info">Belum ada penerima.</Alert>
              )}
              <p className="text-slate-600">
                Menambah penerima: buka bot Anda di Telegram, kirim pesan <code>/start</code>, lalu tekan <b>Cari penerima</b>.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" loading={busy === 'find'} onClick={() => act('find', () => api.get<Chat[]>('/system/telegram/discover').then(setFound))}>
                  Cari penerima
                </Button>
                <Button variant="secondary" disabled={!chats.length} loading={busy === 'test'} onClick={() => act('test', () => api.post('/system/telegram/test', { kind: 'test' }), 'Pesan uji terkirim')}>
                  Kirim pesan uji
                </Button>
                <Button variant="secondary" disabled={!chats.length} loading={busy === 'sum'} onClick={() => act('sum', () => api.post('/system/telegram/test', { kind: 'summary' }), 'Ringkasan terkirim')}>
                  Kirim ringkasan sekarang
                </Button>
              </div>
              {found && (
                <div className="rounded-xl border border-slate-200 p-3">
                  {found.length === 0 ? (
                    <p className="text-slate-500">Belum ada yang mengirim pesan ke bot. Kirim /start ke bot, lalu cari lagi.</p>
                  ) : (
                    found.map((f) => (
                      <div key={f.id} className="flex items-center justify-between py-1">
                        <span>{f.name}</span>
                        {chats.some((x) => x.id === f.id) ? (
                          <Badge className="bg-emerald-100 text-emerald-800">Sudah penerima</Badge>
                        ) : (
                          <Button
                            className="!px-2 !py-1 text-xs"
                            onClick={() => act('save', () => api.put('/system/telegram/chats', [...chats, f]).then(reload), `${f.name} ditambahkan`)}
                          >
                            Jadikan penerima
                          </Button>
                        )}
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </Card>
      </div>

      <Card title="Riwayat peringatan" className="mt-4">
        {data.history.length === 0 ? (
          <Empty icon="check" title="Belum ada peringatan" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Waktu</Th>
                <Th>Tingkat</Th>
                <Th>Masalah</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {data.history.map((a) => (
                <tr key={a.id}>
                  <Td className="whitespace-nowrap text-xs">{when(a.firstAt)}</Td>
                  <Td>
                    <Badge className={LEVEL[a.level].cls}>{LEVEL[a.level].label}</Badge>
                  </Td>
                  <Td className="text-sm">{a.title}</Td>
                  <Td className="text-xs">{a.active ? <span className="font-semibold text-rose-700">Masih terjadi</span> : `Pulih ${when(a.resolvedAt)}`}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
