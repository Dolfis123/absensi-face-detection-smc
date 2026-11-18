import { useEffect, useState } from 'react';
import { api, errMsg } from '../lib/api';
import { useFeedback } from './feedback';
import { Icon } from './icons';
import { Button } from './ui';

interface TgStatus {
  configured: boolean;
  linked: boolean;
  chatName: string | null;
}

/** Sambungkan Telegram pribadi untuk menerima pengingat shift & batas absen masuk. */
export function TelegramConnect() {
  const { toast, confirm } = useFeedback();
  const [st, setSt] = useState<TgStatus | null>(null);
  const [waiting, setWaiting] = useState(false);
  const load = () => api.get<TgStatus>('/me/telegram').then(setSt).catch(() => undefined);
  useEffect(() => {
    load();
  }, []);
  // Setelah membuka Telegram, cek berkala sampai tersambung (maks. 3 menit)
  useEffect(() => {
    if (!waiting) return;
    let n = 0;
    const id = setInterval(async () => {
      const s = await api.get<TgStatus>('/me/telegram').catch(() => null);
      if (s) setSt(s);
      if (s?.linked || ++n > 36) {
        setWaiting(false);
        if (s?.linked) toast('Telegram tersambung. Pengingat shift akan dikirim ke Telegram Anda.');
      }
    }, 5000);
    return () => clearInterval(id);
  }, [waiting, toast]);

  if (!st?.configured) return null;
  async function connect() {
    try {
      const { url } = await api.post<{ url: string }>('/me/telegram/link');
      window.open(url, '_blank');
      setWaiting(true);
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  }
  async function disconnect() {
    if (!(await confirm({ title: 'Putuskan Telegram?', message: 'Anda tidak akan menerima pengingat shift lagi.', confirmLabel: 'Putuskan', danger: true }))) return;
    await api.del('/me/telegram').catch((e) => toast(errMsg(e), 'error'));
    load();
  }

  if (st.linked)
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50/60 px-4 py-3 text-sm">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500 text-white">
          <Icon name="bell" className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1 basis-56 text-emerald-900">
          <b>Pengingat Telegram aktif</b>
          <span className="block text-xs text-emerald-800/80">Dikirim ke {st.chatName}: sebelum shift dan sebelum batas absen masuk.</span>
        </span>
        <button onClick={disconnect} className="text-xs font-medium text-emerald-800 underline">
          Putuskan
        </button>
      </div>
    );
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-sky-200 bg-sky-50/70 px-4 py-3 text-sm">
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-sky-500 text-white">
        <Icon name="bell" className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1 basis-56 text-sky-950">
        <b>Dapatkan pengingat shift di Telegram</b>
        <span className="block text-xs text-sky-900/80">30 menit sebelum shift dan sebelum batas absen masuk, supaya tidak tercatat Alfa.</span>
      </span>
      <Button className="!px-3 !py-1.5 text-xs" loading={waiting} onClick={connect}>
        {waiting ? 'Menunggu di Telegram…' : 'Sambungkan Telegram'}
      </Button>
      {waiting && <p className="w-full text-xs text-sky-900/80">Di Telegram tekan tombol <b>MULAI / START</b>. Halaman ini akan berubah sendiri setelah tersambung.</p>}
    </div>
  );
}

type PromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
let deferred: PromptEvent | null = null;
const listeners = new Set<() => void>();
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as PromptEvent;
    listeners.forEach((l) => l());
  });
}
const DISMISS_KEY = 'smc_install_dismissed';

/** Ajakan memasang aplikasi di layar HP (Android: tombol pasang; iPhone: petunjuk Bagikan → Tambah ke Layar Utama). */
export function InstallApp() {
  const [, force] = useState(0);
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (hidden || standalone || (!deferred && !ios)) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* abaikan */
    }
    setHidden(true);
  };
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-brand-200 bg-brand-50/70 px-4 py-3 text-sm">
      <img src="/icons/icon-192.png" alt="" className="h-9 w-9 rounded-xl" />
      <span className="min-w-0 flex-1 basis-56 text-brand-950">
        <b>Pasang aplikasi di layar HP</b>
        <span className="block text-xs text-brand-900/80">
          {deferred ? 'Buka lebih cepat langsung dari ikon SMC Absen, tanpa mengetik alamat.' : 'Di Safari tekan tombol Bagikan (kotak dengan panah ke atas), lalu pilih "Tambah ke Layar Utama".'}
        </span>
      </span>
      {deferred && (
        <Button
          className="!px-3 !py-1.5 text-xs"
          onClick={async () => {
            await deferred?.prompt();
            await deferred?.userChoice;
            deferred = null;
            force((n) => n + 1);
          }}
        >
          Pasang
        </Button>
      )}
      <button onClick={dismiss} className="text-xs text-brand-800 underline">
        Nanti
      </button>
    </div>
  );
}
