import { useState } from 'react';
import { useLoad } from '../../components/attendance';
import { useFeedback } from '../../components/feedback';
import { Icon } from '../../components/icons';
import { Alert, Badge, Button, Card, Empty, Loading, PageHeader } from '../../components/ui';
import { api, downloadFile, errMsg } from '../../lib/api';
import { fmtDate } from '../../lib/format';

interface DocLetter {
  id: number;
  title: string;
  number: string;
  letterDate: string;
  openedAt: string | null;
  receivedAt: string | null;
}
interface DocSlip {
  month: string;
  monthLabel: string;
  version: number;
  takeHome: number;
  totalDeduction: number;
  totalBonus: number;
  alfa: number;
  rank: number | null;
  openedAt: string | null;
  receivedAt: string | null;
}
export interface MyDocuments {
  letters: DocLetter[];
  slips: DocSlip[];
  unread: number;
}

const rp = (n: number) => `Rp ${Math.round(n).toLocaleString('id-ID')}`;
const when = (iso: string) => new Date(iso).toLocaleString('id-ID', { timeZone: 'Asia/Jayapura', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Surat & slip upah milik petugas, dengan konfirmasi tanda terima digital. */
export default function Dokumen() {
  const { data, error, loading, reload } = useLoad(() => api.get<MyDocuments>('/me/documents'));
  if (loading && !data) return <Loading />;
  if (!data) return <Alert>{error}</Alert>;
  return (
    <>
      <PageHeader title="Surat & Slip Saya" subtitle="Buka dokumen, baca, lalu tekan “Saya sudah menerima”. Waktu konfirmasi tercatat sebagai tanda terima." />
      {data.unread > 0 && (
        <div className="mb-4">
          <Alert kind="info">
            Ada <b>{data.unread} dokumen</b> yang belum Anda konfirmasi. Buka dulu dokumennya, lalu tekan tombol konfirmasi.
          </Alert>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Surat dari Perusahaan" subtitle="Surat peringatan / panggilan">
          {data.letters.length === 0 ? (
            <Empty icon="check" title="Tidak ada surat untuk Anda" />
          ) : (
            <div className="space-y-3">
              {data.letters.map((l) => (
                <DocItem
                  key={l.id}
                  title={l.title}
                  sub={`Nomor ${l.number} · ${fmtDate(l.letterDate, false)}`}
                  urgent
                  openedAt={l.openedAt}
                  receivedAt={l.receivedAt}
                  pdf={`/me/letters/${l.id}/pdf`}
                  pdfName={`${l.number.replace(/\//g, '-')}.pdf`}
                  receive={`/me/letters/${l.id}/receive`}
                  confirmText="Saya sudah menerima dan membaca surat ini"
                  onDone={reload}
                />
              ))}
            </div>
          )}
        </Card>
        <Card title="Slip Upah" subtitle="Diterbitkan perusahaan setelah bulan selesai">
          {data.slips.length === 0 ? (
            <Empty icon="fileText" title="Belum ada slip yang diterbitkan" />
          ) : (
            <div className="space-y-3">
              {data.slips.map((s) => (
                <DocItem
                  key={`${s.month}-${s.version}`}
                  title={`Slip upah ${s.monthLabel}${s.version > 1 ? ` (perbaikan ke-${s.version - 1})` : ''}`}
                  sub={`Diterima ${rp(s.takeHome)}${s.totalDeduction ? ` · potongan ${rp(s.totalDeduction)}` : ''}${s.totalBonus ? ` · bonus ${rp(s.totalBonus)}` : ''}${s.rank ? ` · Petugas Terbaik #${s.rank}` : ''}`}
                  openedAt={s.openedAt}
                  receivedAt={s.receivedAt}
                  pdf={`/me/slips/${s.month}/pdf`}
                  pdfName={`slip-upah_${s.month}.pdf`}
                  receive={`/me/slips/${s.month}/receive`}
                  confirmText="Saya sudah menerima dan memeriksa slip ini"
                  onDone={reload}
                />
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

function DocItem(p: {
  title: string;
  sub: string;
  urgent?: boolean;
  openedAt: string | null;
  receivedAt: string | null;
  pdf: string;
  pdfName: string;
  receive: string;
  confirmText: string;
  onDone: () => void;
}) {
  const { toast } = useFeedback();
  const [busy, setBusy] = useState<'open' | 'receive' | null>(null);
  const [opened, setOpened] = useState(!!p.openedAt);

  async function open() {
    setBusy('open');
    try {
      await downloadFile(p.pdf, p.pdfName);
      setOpened(true);
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(null);
    }
  }
  async function receive() {
    setBusy('receive');
    try {
      await api.post(p.receive);
      toast('Terima kasih, tanda terima tercatat');
      p.onDone();
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={`rounded-xl border p-3 ${p.receivedAt ? 'border-slate-200' : p.urgent ? 'border-rose-200 bg-rose-50/40' : 'border-amber-200 bg-amber-50/40'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-slate-900">{p.title}</p>
          <p className="text-xs text-slate-500">{p.sub}</p>
        </div>
        {p.receivedAt ? <Badge className="bg-emerald-100 text-emerald-800">Diterima</Badge> : <Badge className="bg-amber-100 text-amber-800">Belum dikonfirmasi</Badge>}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="secondary" icon="download" className="!px-3 !py-1.5 text-xs" loading={busy === 'open'} onClick={open}>
          Buka PDF
        </Button>
        {p.receivedAt ? (
          <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
            <Icon name="check" className="h-3.5 w-3.5" />
            Dikonfirmasi {when(p.receivedAt)} WIT
          </span>
        ) : (
          <Button className="!px-3 !py-1.5 text-xs" disabled={!opened} loading={busy === 'receive'} onClick={receive} title={opened ? undefined : 'Buka PDF dulu'}>
            {p.confirmText}
          </Button>
        )}
      </div>
      {!p.receivedAt && !opened && <p className="mt-1 text-[11px] text-slate-500">Buka PDF dulu, baru tombol konfirmasi bisa ditekan.</p>}
    </div>
  );
}
