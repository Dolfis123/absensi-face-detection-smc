import { FormEvent, useRef, useState } from 'react';
import { useLoad } from '../../components/attendance';
import { Camera, CameraHandle } from '../../components/Camera';
import { useFeedback } from '../../components/feedback';
import { Alert, Badge, Button, Card, Empty, Field, Input, Loading, Modal, PageHeader, PersonCell, SearchInput, Select, Table, Td, Th } from '../../components/ui';
import { api, errMsg, PublicUser, Shift } from '../../lib/api';
import { ROLE_LABEL } from '../../lib/format';

type FormState = {
  fullName: string;
  nik: string;
  username: string;
  password: string;
  role: 'KARYAWAN' | 'KOORDINATOR';
  phone: string;
  defaultShiftId: number;
  isActive: boolean;
};

const blank = (shiftId: number): FormState => ({
  fullName: '',
  nik: '',
  username: '',
  password: '',
  role: 'KARYAWAN',
  phone: '',
  defaultShiftId: shiftId,
  isActive: true,
});

export const MIN_FACE_PHOTOS = 3;
const FACE_POSES = [
  'Menghadap lurus ke kamera',
  'Menoleh sedikit ke kiri',
  'Menoleh sedikit ke kanan',
  'Sedikit mendongak (opsional)',
  'Sedikit menunduk (opsional)',
];

/** Pengambilan 3–5 foto wajah terpandu dengan pose berbeda. */
function FaceCapture({ photos, onChange }: { photos: string[]; onChange: (v: string[]) => void }) {
  const cam = useRef<CameraHandle>(null);
  const done = photos.length >= FACE_POSES.length;

  return (
    <div className="space-y-3">
      <ul className="list-disc space-y-0.5 pl-5 text-xs text-slate-600">
        <li>Cahaya terang dari depan, jangan membelakangi jendela/lampu.</li>
        <li>Tanpa masker, topi, atau kacamata hitam. Ekspresi biasa.</li>
        <li>Tahan kamera stabil agar foto tidak buram. Tiap pose cukup menoleh sedikit.</li>
      </ul>

      {!done && (
        <>
          <Camera ref={cam} className="mx-auto w-56" />
          <div className="text-center text-sm font-semibold text-brand-700">
            Foto {photos.length + 1}: {FACE_POSES[photos.length]}
          </div>
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            onClick={() => {
              const shot = cam.current?.capture();
              if (shot) onChange([...photos, shot]);
            }}
          >
            Ambil Foto {photos.length + 1}
          </Button>
        </>
      )}

      {photos.length > 0 && (
        <div className="grid grid-cols-5 gap-2">
          {photos.map((p, i) => (
            <div key={i} className="relative">
              <img src={p} alt={`Foto ${i + 1}`} className="aspect-[3/4] w-full rounded-lg object-cover" />
              <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] text-white">{i + 1}</span>
              <button
                type="button"
                onClick={() => onChange(photos.filter((_, j) => j !== i))}
                className="absolute right-1 top-1 rounded-full bg-rose-600 px-1.5 text-[10px] font-bold text-white"
                aria-label={`Hapus foto ${i + 1}`}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <p className="text-xs text-slate-500">
        {photos.length < MIN_FACE_PHOTOS
          ? `Minimal ${MIN_FACE_PHOTOS} foto (${photos.length}/${MIN_FACE_PHOTOS}).`
          : `${photos.length} foto siap. Tambah sampai 5 untuk hasil lebih akurat, atau langsung simpan.`}{' '}
        Bila server menolak salah satu foto, hapus foto bernomor tersebut lalu ambil ulang.
      </p>
    </div>
  );
}

export default function Karyawan() {
  const { data, error, loading, reload } = useLoad(() =>
    Promise.all([api.get<PublicUser[]>('/admin/users'), api.get<Shift[]>('/shifts')]),
  );
  const [mode, setMode] = useState<{ type: 'create' } | { type: 'edit'; user: PublicUser } | { type: 'face'; user: PublicUser } | null>(null);
  const [form, setForm] = useState<FormState>(blank(1));
  const [face, setFace] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const { toast, confirm } = useFeedback();

  if (loading && !data) return <Loading />;
  if (!data) return <Alert>{error}</Alert>;
  const [users, shifts] = data;
  const shiftName = (id: number | null) => shifts.find((s) => s.id === id)?.name ?? '—';
  const employees = users.filter((u) => u.role === 'KARYAWAN');
  const needle = q.trim().toLowerCase();
  const visible = users.filter(
    (u) => !needle || [u.fullName, u.nik, u.username].some((v) => v.toLowerCase().includes(needle)),
  );

  const open = (m: NonNullable<typeof mode>) => {
    setFormError(null);
    setFace([]);
    if (m.type === 'create') setForm(blank(shifts[0]?.id ?? 1));
    if (m.type === 'edit') {
      const u = m.user;
      setForm({
        fullName: u.fullName,
        nik: u.nik,
        username: u.username,
        password: '',
        role: u.role as FormState['role'],
        phone: u.phone,
        defaultShiftId: u.defaultShiftId ?? shifts[0]?.id ?? 1,
        isActive: u.isActive,
      });
    }
    setMode(m);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!mode) return;
    setSaving(true);
    setFormError(null);
    try {
      const needsFace = mode.type === 'face' || (mode.type === 'create' && form.role === 'KARYAWAN');
      if (needsFace && face.length < MIN_FACE_PHOTOS) throw new Error(`Ambil minimal ${MIN_FACE_PHOTOS} foto wajah terlebih dahulu`);
      let result: { warning?: string | null } | undefined;
      if (mode.type === 'create') {
        const { isActive: _ignored, ...payload } = form;
        result = await api.post('/admin/users', { ...payload, faceImages: needsFace ? face : undefined });
      } else if (mode.type === 'edit') {
        await api.put(`/admin/users/${mode.user.id}`, form);
      } else {
        result = await api.put(`/admin/users/${mode.user.id}/face`, { faceImages: face });
      }
      if (result?.warning) toast(result.warning, 'info');
      else toast(mode.type === 'face' ? 'Data wajah berhasil diperbarui.' : 'Data pengguna tersimpan.');
      setMode(null);
      reload();
    } catch (err) {
      setFormError(errMsg(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove(u: PublicUser) {
    const ok = await confirm({
      title: `Hapus ${u.fullName}?`,
      message: 'Pengguna yang sudah punya riwayat absensi tidak bisa dihapus, hanya bisa dinonaktifkan lewat Edit.',
      confirmLabel: 'Hapus',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/admin/users/${u.id}`);
      toast(`${u.fullName} dihapus.`);
      reload();
    } catch (err) {
      toast(errMsg(err), 'error');
    }
  }

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <>
      <PageHeader
        title="Data Pengguna"
        subtitle={`${employees.length} karyawan parkir · ${employees.filter((e) => e.hasFace).length} wajah terdaftar`}
        actions={
          <Button icon="plus" onClick={() => open({ type: 'create' })}>
            Tambah Pengguna
          </Button>
        }
      />
      <Card>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <SearchInput value={q} onChange={setQ} placeholder="Cari nama, NIK, atau username…" className="w-full sm:w-72" />
          <span className="text-sm text-slate-500">{visible.length} pengguna</span>
        </div>
        {visible.length === 0 ? (
          <Empty icon="search" title="Tidak ada pengguna yang cocok" />
        ) : (
        <Table>
          <thead>
            <tr>
              <Th>Nama / NIK</Th>
              <Th>Role</Th>
              <Th>Username</Th>
              <Th>No. HP</Th>
              <Th>Shift Default</Th>
              <Th>Wajah</Th>
              <Th>Status</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {visible.map((u) => (
              <tr key={u.id}>
                <Td>
                  <PersonCell name={u.fullName} sub={u.nik} />
                </Td>
                <Td>
                  <Badge
                    className={
                      u.role === 'SUPER_ADMIN'
                        ? 'bg-brand-900 text-white'
                        : u.role === 'KOORDINATOR'
                          ? 'bg-violet-50 text-violet-700 ring-1 ring-violet-600/15'
                          : 'bg-sky-50 text-sky-700 ring-1 ring-sky-600/15'
                    }
                  >
                    {ROLE_LABEL[u.role]}
                  </Badge>
                </Td>
                <Td className="font-mono text-xs">{u.username}</Td>
                <Td>{u.phone}</Td>
                <Td>{u.role === 'SUPER_ADMIN' ? '—' : shiftName(u.defaultShiftId)}</Td>
                <Td>
                  {u.role !== 'KARYAWAN' ? (
                    <span className="text-slate-300">—</span>
                  ) : !u.hasFace ? (
                    <Badge className="bg-rose-50 text-rose-700 ring-1 ring-rose-600/15">Belum ada</Badge>
                  ) : u.faceCount < MIN_FACE_PHOTOS ? (
                    <span title="Didaftarkan dengan format lama (1 foto). Sebaiknya daftar ulang.">
                      <Badge className="bg-amber-50 text-amber-800 ring-1 ring-amber-600/20">{u.faceCount} foto · daftar ulang</Badge>
                    </span>
                  ) : (
                    <Badge className="bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/15">{u.faceCount} foto</Badge>
                  )}
                </Td>
                <Td>
                  <span className="inline-flex items-center gap-1.5 text-sm">
                    <span className={`h-2 w-2 rounded-full ${u.isActive ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                    {u.isActive ? 'Aktif' : 'Nonaktif'}
                  </span>
                </Td>
                <Td>
                  {u.immutable ? (
                    <span className="text-xs text-slate-400">🔒 Permanen</span>
                  ) : (
                    <div className="flex gap-1">
                      <Button variant="ghost" onClick={() => open({ type: 'edit', user: u })}>
                        Edit
                      </Button>
                      {u.role === 'KARYAWAN' && (
                        <Button variant="ghost" onClick={() => open({ type: 'face', user: u })}>
                          Wajah
                        </Button>
                      )}
                      <Button variant="ghost" className="text-rose-600" onClick={() => remove(u)}>
                        Hapus
                      </Button>
                    </div>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
        )}
      </Card>

      <Modal
        open={!!mode}
        onClose={() => setMode(null)}
        title={mode?.type === 'create' ? 'Tambah Pengguna' : mode?.type === 'edit' ? 'Edit Pengguna' : `Perbarui Wajah · ${mode?.type === 'face' ? mode.user.fullName : ''}`}
      >
        <form onSubmit={submit} className="space-y-3">
          {formError && <Alert>{formError}</Alert>}
          {mode?.type !== 'face' && (
            <>
              <Field label="Role">
                <Select value={form.role} onChange={(e) => set('role', e.target.value as FormState['role'])}>
                  <option value="KARYAWAN">Karyawan Parkir</option>
                  <option value="KOORDINATOR">Koordinator Lapangan</option>
                </Select>
              </Field>
              <Field label="Nama Lengkap">
                <Input value={form.fullName} onChange={(e) => set('fullName', e.target.value)} required />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="NIK (Nomor Induk Karyawan)">
                  <Input value={form.nik} onChange={(e) => set('nik', e.target.value)} required />
                </Field>
                <Field label="No. HP / WhatsApp">
                  <Input type="tel" value={form.phone} onChange={(e) => set('phone', e.target.value)} placeholder="08xxxxxxxxxx" required />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Username">
                  <Input value={form.username} autoComplete="off" onChange={(e) => set('username', e.target.value)} required />
                </Field>
                <Field label="Password" hint={mode?.type === 'edit' ? 'Kosongkan jika tidak diubah' : 'Minimal 8 karakter'}>
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={form.password}
                    onChange={(e) => set('password', e.target.value)}
                    required={mode?.type === 'create'}
                    minLength={8}
                  />
                </Field>
              </div>
              <Field label="Shift Kerja Default Awal" hint="Acuan awal sebelum diatur di roster dinamis">
                <Select value={form.defaultShiftId} onChange={(e) => set('defaultShiftId', Number(e.target.value))}>
                  {shifts.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.startTime}–{s.endTime})
                    </option>
                  ))}
                </Select>
              </Field>
              {mode?.type === 'edit' && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={form.isActive} onChange={(e) => set('isActive', e.target.checked)} />
                  Akun aktif
                </label>
              )}
            </>
          )}
          {(mode?.type === 'face' || (mode?.type === 'create' && form.role === 'KARYAWAN')) && (
            <Field label="Data Wajah (Face Embedding · 3–5 foto)">
              <FaceCapture photos={face} onChange={setFace} />
            </Field>
          )}
          <Button type="submit" className="w-full" loading={saving}>
            {saving && face.length ? 'Memproses wajah… (±10–30 detik)' : 'Simpan'}
          </Button>
        </form>
      </Modal>
    </>
  );
}
