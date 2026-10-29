import { useState } from 'react';
import { downloadFile, errMsg } from '../lib/api';
import { useFeedback } from './feedback';
import { Button } from './ui';

/** Tombol unduh roster tersimpan (PDF untuk grup WhatsApp, Excel untuk diolah). */
export function RosterDownloadButtons({ from, to }: { from: string; to: string }) {
  const { toast } = useFeedback();
  const [busy, setBusy] = useState<'pdf' | 'xlsx' | null>(null);
  const download = async (ext: 'pdf' | 'xlsx') => {
    setBusy(ext);
    try {
      await downloadFile(`/admin/roster/export.${ext}?from=${from}&to=${to}`, `roster-shift-SMC_${from}_${to}.${ext}`);
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex flex-wrap gap-2">
      <Button icon="download" onClick={() => download('pdf')} loading={busy === 'pdf'}>
        Unduh PDF
      </Button>
      <Button variant="secondary" icon="download" onClick={() => download('xlsx')} loading={busy === 'xlsx'}>
        Unduh Excel
      </Button>
    </div>
  );
}
