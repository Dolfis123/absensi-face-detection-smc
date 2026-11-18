import { useEffect, useState } from 'react';
import { useLoad } from '../../components/attendance';
import { useFeedback } from '../../components/feedback';
import { Badge, Button, Card, Field, Input, Select } from '../../components/ui';
import { api, errMsg, Role } from '../../lib/api';

interface NotifySettings {
  reminders: { enabled: boolean; beforeMinutes: number; lateWarnMinutes: number };
  group: { enabled: boolean; chatId: string; chatName: string; time: string };
}
interface NotifyData {
  configured: boolean;
  botUsername: string | null;
  seenCount: number;
  settings: NotifySettings;
  employees: { userId: number; fullName: string; role: Role; linked: boolean; chatName: string | null }[];
  groups: { id: string; name: string }[];
}

/** Pengaturan pengingat shift ke Telegram petugas & pengiriman jadwal besok ke grup. */
export function NotifyCard() {
  const { toast, confirm } = useFeedback();
  const { data, reload } = useLoad(() => api.get<NotifyData>('/system/notify'));
  const [s, setS] = useState<NotifySettings | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => setS(data?.settings ?? null), [data]);
  if (!data || !s) return null;

  const dirty = JSON.stringify(s) !== JSON.stringify(data.settings);
  const linked = data.employees.filter((e) => e.linked);
  async function act(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    try {
      await fn();
      toast(ok);
      reload();
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(null);
    }
  }
  const setR = (p: Partial<NotifySettings['reminders']>) => setS({ ...s, reminders: { ...s.reminders, ...p } });
  const setG = (p: Partial<NotifySettings['group']>) => setS({ ...s, group: { ...s.group, ...p } });

  return (
    <Card
      title="Pengingat petugas & jadwal grup (Telegram)"
      subtitle="Dikirim otomatis oleh bot Telegram yang sama dengan peringatan sistem."
      className="mt-4"
      actions={
        dirty ? (
          <Button loading={busy === 'save'} onClick={() => act('save', () => api.put('/system/notify', s), 'Pengaturan tersimpan')}>
            Simpan
          </Button>
        ) : undefined
      }
    >
      {!data.configured ? (
        <p className="text-sm text-slate-500">Pasang Telegram dulu (kartu Penerima Telegram di atas). Setelah itu pengingat dan jadwal grup bisa diaktifkan di sini.</p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Pengingat pribadi */}
          <div className="space-y-3">
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={s.reminders.enabled} onChange={(e) => setR({ enabled: e.target.checked })} />
              <span>
                <b>Pengingat pribadi ke petugas</b>
                <span className="block text-xs text-slate-500">Hanya untuk petugas yang sudah menekan “Sambungkan Telegram” di Beranda aplikasinya.</span>
              </span>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Sebelum shift (menit)" hint="Berisi shift, pos jaga, jam absen">
                <Input type="number" min={5} max={180} value={s.reminders.beforeMinutes} onChange={(e) => setR({ beforeMinutes: Math.max(5, Number(e.target.value) || 30) })} />
              </Field>
              <Field label="Sebelum batas terlambat (menit)" hint="Hanya bila belum absen masuk">
                <Input type="number" min={1} max={60} value={s.reminders.lateWarnMinutes} onChange={(e) => setR({ lateWarnMinutes: Math.max(1, Number(e.target.value) || 10) })} />
              </Field>
            </div>
            <div>
              <p className="mb-1.5 text-sm font-medium text-slate-700">
                Tersambung: {linked.length} dari {data.employees.length} petugas
              </p>
              <div className="max-h-56 space-y-1 overflow-y-auto rounded-xl border border-slate-200 p-2">
                {data.employees.map((e) => (
                  <div key={e.userId} className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate">
                      {e.fullName}
                      {e.role === 'KOORDINATOR' && <span className="text-xs text-slate-400"> · Koordinator</span>}
                    </span>
                    {e.linked ? (
                      <span className="flex shrink-0 items-center gap-1">
                        <Badge className="bg-emerald-100 text-emerald-800">Tersambung</Badge>
                        <button className="text-xs text-brand-700 underline" onClick={() => act(`t${e.userId}`, () => api.post(`/system/notify/test/${e.userId}`), `Contoh pengingat terkirim ke ${e.fullName}`)}>
                          contoh
                        </button>
                        <button
                          className="text-xs text-rose-600 underline"
                          onClick={async () => {
                            if (await confirm({ title: `Putuskan Telegram ${e.fullName}?`, message: 'Petugas tidak akan menerima pengingat sampai menyambungkan lagi.', confirmLabel: 'Putuskan', danger: true }))
                              act(`d${e.userId}`, () => api.del(`/system/notify/link/${e.userId}`), 'Sambungan diputus');
                          }}
                        >
                          putus
                        </button>
                      </span>
                    ) : (
                      <span className="shrink-0 text-xs text-slate-400">belum</span>
                    )}
                  </div>
                ))}
              </div>
              <p className="mt-1 text-xs text-slate-500">Minta petugas membuka aplikasi → Beranda → <b>Sambungkan Telegram</b> → tekan MULAI di Telegram.</p>
            </div>
          </div>

          {/* Jadwal ke grup */}
          <div className="space-y-3">
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={s.group.enabled} onChange={(e) => setG({ enabled: e.target.checked })} />
              <span>
                <b>Kirim jadwal besok ke grup setiap hari</b>
                <span className="block text-xs text-slate-500">Isi sama dengan teks WhatsApp roster (koordinator, shift, pos, off, aturan).</span>
              </span>
            </label>
            <div className="grid grid-cols-[1fr_auto] gap-3">
              <Field label="Grup Telegram tujuan">
                <Select
                  value={s.group.chatId}
                  onChange={(e) => setG({ chatId: e.target.value, chatName: data.groups.find((g) => g.id === e.target.value)?.name ?? '' })}
                >
                  <option value="">— pilih grup —</option>
                  {s.group.chatId && !data.groups.some((g) => g.id === s.group.chatId) && <option value={s.group.chatId}>{s.group.chatName || s.group.chatId}</option>}
                  {data.groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Jam kirim (WIT)">
                <Input type="time" value={s.group.time} onChange={(e) => e.target.value && setG({ time: e.target.value })} />
              </Field>
            </div>
            {data.groups.length === 0 && (
              <div className="space-y-2 rounded-xl bg-amber-50 px-3 py-2.5 text-xs text-amber-950">
                <p className="font-semibold">Grup belum ditemukan. Lakukan langkah ini:</p>
                <ol className="list-decimal space-y-1 pl-4">
                  <li>
                    Di Telegram buka grup petugas → Info grup → <b>Tambah anggota</b> → cari <b>{data.botUsername ? `@${data.botUsername}` : 'nama bot'}</b>.
                  </li>
                  <li>
                    Di grup itu kirim pesan persis seperti ini:{' '}
                    <code className="select-all rounded bg-white px-1.5 py-0.5 font-semibold ring-1 ring-amber-200">/start@{data.botUsername ?? 'nama_bot'}</code>
                    <span className="block text-amber-800">(pakai @nama bot, karena di grup bot hanya membaca perintah yang ditujukan kepadanya)</span>
                  </li>
                  <li>Bot membalas “Grup ini sudah terbaca”. Lalu tekan tombol <b>Cari grup</b> di bawah.</li>
                </ol>
              </div>
            )}
            <Button
              variant="secondary"
              loading={busy === 'find'}
              onClick={() =>
                act(
                  'find',
                  async () => {
                    const r = await api.post<{ groups: { id: string; name: string }[] }>('/system/notify/refresh');
                    if (!r.groups.length) throw new Error('Grup belum terbaca. Pastikan bot sudah menjadi anggota grup dan pesan /start@nama_bot sudah dikirim di grup.');
                  },
                  'Grup ditemukan, silakan pilih di daftar',
                )
              }
            >
              Cari grup
            </Button>
            <Button variant="secondary" disabled={!s.group.chatId || dirty} loading={busy === 'group'} onClick={() => act('group', () => api.post('/system/notify/group-now'), 'Jadwal besok terkirim ke grup')} title={dirty ? 'Simpan pengaturan dulu' : undefined}>
              Kirim jadwal besok sekarang
            </Button>
            <p className="text-xs text-slate-500">Bila roster besok masih kosong, jadwal tidak dikirim dan Super Admin mendapat peringatan di Telegram.</p>
          </div>
        </div>
      )}
    </Card>
  );
}
