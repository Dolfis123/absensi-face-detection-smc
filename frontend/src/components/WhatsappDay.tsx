import { useState } from 'react';
import { api, errMsg } from '../lib/api';
import { fmtDate } from '../lib/format';
import { useFeedback } from './feedback';
import { Button, Modal } from './ui';

/** Tombol kecil di kepala kolom tanggal: buka teks jadwal hari itu, siap ditempel ke grup WhatsApp. */
export function WhatsappDayButton({ date }: { date: string }) {
  const { toast } = useFeedback();
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const open = async () => {
    setLoading(true);
    try {
      setText((await api.get<{ text: string }>(`/admin/roster/whatsapp?date=${date}`)).text);
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setLoading(false);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text ?? '');
      toast('Teks disalin. Tempel di grup WhatsApp.');
    } catch {
      toast('Tidak bisa menyalin otomatis. Blok teksnya lalu salin manual.', 'error');
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={open}
        disabled={loading}
        title="Teks jadwal hari ini untuk grup WhatsApp"
        className="mt-1 rounded-md bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
      >
        {loading ? '…' : 'WA'}
      </button>
      <Modal open={text !== null} title={`Teks WhatsApp · ${fmtDate(date)}`} onClose={() => setText(null)}>
        <textarea readOnly value={text ?? ''} className="h-96 w-full rounded-lg border-slate-300 font-mono text-xs" />
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setText(null)}>
            Tutup
          </Button>
          <Button variant="success" icon="send" onClick={copy}>
            Salin Teks
          </Button>
        </div>
      </Modal>
    </>
  );
}
