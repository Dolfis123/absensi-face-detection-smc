import { ChangeEvent, useEffect, useState } from 'react';
import { useLoad } from '../../components/attendance';
import { useFeedback } from '../../components/feedback';
import { Alert, Button, Card, Field, Input, Loading, PageHeader } from '../../components/ui';
import { api, errMsg, tokenStore } from '../../lib/api';
import { refreshOrg } from '../../lib/org';

interface Org {
  companyName: string;
  companyAddress: string;
  companyContact: string;
  placeName: string;
  placeShort: string;
  cityRegion: string;
  signCity: string;
  hrdName: string;
  hrdTitle: string;
  coordinatorName: string;
  coordinatorTitle: string;
  managementName: string;
  managementTitle: string;
  showManagementSign: boolean;
  reportApproverName: string;
  reportApproverTitle: string;
  numberFormat: string;
  numberCode: string;
  warningCode: string;
  callCode: string;
  defaultReportPlace: string;
  hasLogo?: boolean;
  hasStamp?: boolean;
}
type TextKey = Exclude<keyof Org, 'showManagementSign' | 'hasLogo' | 'hasStamp'>;

/** Identitas pengelola, kop surat, nomor surat, dan penandatangan — dipakai semua dokumen PDF/Excel. */
export default function Identitas() {
  const { toast } = useFeedback();
  const { data, reload } = useLoad(() => api.get<Org>('/organization'));
  const [f, setF] = useState<Org | null>(null);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<{ warning: string; call: string } | null>(null);

  useEffect(() => {
    if (data) setF(data);
  }, [data]);

  // Contoh nomor surat mengikuti pola yang sedang diketik
  const fmt = f && `${f.numberFormat}|${f.numberCode}|${f.warningCode}|${f.callCode}`;
  useEffect(() => {
    if (!f) return;
    const t = setTimeout(() => {
      api
        .post<{ warning: string; call: string }>('/organization/number-preview', { numberFormat: f.numberFormat, numberCode: f.numberCode, warningCode: f.warningCode, callCode: f.callCode })
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fmt]);

  if (!f) return <Loading />;

  const field = (k: TextKey, label: string, hint?: string, placeholder?: string) => (
    <Field label={label} hint={hint}>
      <Input value={f[k]} placeholder={placeholder} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
    </Field>
  );

  async function save() {
    setSaving(true);
    try {
      const { hasLogo: _h, hasStamp: _s, ...body } = f!;
      setF(await api.put<Org>('/organization', body));
      refreshOrg();
      toast('Identitas & kop surat disimpan. Dokumen berikutnya memakai data baru.');
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Identitas & Kop Surat"
        subtitle="Dipakai di semua dokumen: surat peringatan/panggilan, rekap upah & slip, piagam, laporan bulanan, dan roster. Ubah di sini bila pengelola parkir berganti."
      />
      <div className="mb-4">
        <Alert kind="info">
          Perubahan hanya berlaku untuk dokumen yang dicetak <b>setelah</b> disimpan. Nomor surat yang sudah terbit tidak ikut berubah. Semua perubahan tercatat di riwayat.
        </Alert>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Perusahaan pengelola (kop surat)" subtitle="Tampil di bagian atas surat dan dokumen">
          <div className="space-y-3">
            {field('companyName', 'Nama perusahaan', undefined, 'mis. CV. DEVA JAYA')}
            {field('companyAddress', 'Alamat')}
            {field('companyContact', 'Kontak (opsional)', 'Telepon / email / NPWP — baris kecil di kop')}
            <ImageField kind="logo" label="Logo (opsional)" hint="PNG atau JPG, maks. 1 MB. Tampil di kiri kop surat dan di piagam." initial={!!data?.hasLogo} onChange={() => { refreshOrg(); reload(); }} />
          </div>
        </Card>

        <Card title="Lokasi yang dikelola" subtitle="Dipakai di judul aplikasi, laporan, roster, dan teks penugasan">
          <div className="space-y-3">
            {field('placeName', 'Nama tempat', `Contoh hasil: "Area Parkir ${f.placeName || '…'}"`, 'mis. Mall Sorong Modern City')}
            {field('placeShort', 'Singkatan (opsional)', 'Tampil di judul aplikasi, mis. "Pos Parkir SMC"', 'mis. SMC')}
            {field('cityRegion', 'Kota & provinsi', undefined, 'mis. Kota Sorong, Papua Barat Daya')}
            {field('signCity', 'Kota di tanda tangan', `Contoh: "${f.signCity || 'Sorong'}, 7 November 2026"`, 'mis. Sorong')}
            {field('defaultReportPlace', 'Tempat menghadap (surat panggilan)')}
          </div>
        </Card>

        <Card title="Penandatangan" subtitle="Kosongkan nama bila ingin ditulis tangan saat penandatanganan">
          <div className="space-y-3">
            <p className="rounded-lg bg-slate-50 p-2 text-xs text-slate-600">
              Surat peringatan & panggilan: satu tanda tangan di tengah — <b>{f.showManagementSign ? `"Mengetahui, ${f.managementTitle || '…'}"` : `"Hormat kami, ${f.companyName || '…'}"`}</b>, cap/stempel (bila diunggah), lalu nama & jabatan pihak perusahaan.
            </p>
            <div className="grid grid-cols-2 gap-2">
              {field('hrdName', 'Nama (pihak perusahaan)')}
              {field('hrdTitle', 'Jabatan', undefined, 'mis. HRD/Admin Manager')}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {field('coordinatorName', 'Nama Koordinator (mengetahui)')}
              {field('coordinatorTitle', 'Sebutan jabatan', undefined, 'mis. Koordinator Lapangan')}
            </div>
            <label className="flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" className="h-4 w-4 rounded border-slate-300" checked={f.showManagementSign} onChange={(e) => setF({ ...f, showManagementSign: e.target.checked })} />
              Tampilkan pemilik tempat sebagai "Mengetahui"
            </label>
            {f.showManagementSign && (
              <div className="grid grid-cols-2 gap-2">
                {field('managementName', 'Nama')}
                {field('managementTitle', 'Jabatan / instansi', undefined, 'mis. Manajemen Mall Sorong Modern City')}
              </div>
            )}
            <ImageField kind="stamp" label="Cap / stempel tanda tangan (opsional)" hint="PNG/JPG maks. 1 MB, sebaiknya latar transparan. Tampil di samping tanda tangan surat." initial={!!data?.hasStamp} onChange={reload} wide />
            <div className="grid grid-cols-2 gap-2">
              {field('reportApproverName', 'Pengesah laporan bulanan')}
              {field('reportApproverTitle', 'Jabatan pengesah', undefined, 'mis. Manager Mal SMC')}
            </div>
          </div>
        </Card>

        <Card title="Nomor surat" subtitle="Untuk Surat Peringatan & Surat Panggilan. Nomor urut berlanjut per tahun.">
          <div className="space-y-3">
            {field('numberFormat', 'Pola nomor', 'Token: {no} urut · {jenis} kode jenis · {kode} kode perusahaan · {bulan} romawi · {bulanAngka} 01–12 · {tahun}')}
            <div className="grid grid-cols-3 gap-2">
              {field('numberCode', 'Kode perusahaan', undefined, 'mis. DPM-SMC')}
              {field('warningCode', 'Kode peringatan', undefined, 'SP')}
              {field('callCode', 'Kode panggilan', undefined, 'SPG')}
            </div>
            <div className="rounded-xl bg-slate-50 p-3 text-sm">
              <div className="text-xs text-slate-500">Contoh hasil</div>
              {preview ? (
                <div className="mt-1 space-y-0.5 font-mono">
                  <div>Peringatan: {preview.warning}</div>
                  <div>Panggilan: {preview.call}</div>
                </div>
              ) : (
                <div className="mt-1 text-rose-700">Pola belum valid (wajib memuat {'{no}'})</div>
              )}
            </div>
          </div>
        </Card>

        <div className="flex justify-end lg:col-span-2">
          <Button onClick={save} loading={saving}>
            Simpan Identitas & Kop Surat
          </Button>
        </div>
      </div>
    </>
  );
}

/** Unggah / ganti / hapus gambar dokumen (logo kop atau cap tanda tangan). */
function ImageField({ kind, label, hint, initial, onChange, wide }: { kind: 'logo' | 'stamp'; label: string; hint: string; initial: boolean; onChange: () => void; wide?: boolean }) {
  const { toast } = useFeedback();
  const [ver, setVer] = useState(initial ? 1 : 0);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (initial && ver === 0) setVer(1);
  }, [initial, ver]);

  // Dimuat lewat fetch (bukan <img src>) supaya selalu versi terbaru
  useEffect(() => {
    if (ver === 0) return setUrl(null);
    let made: string | null = null;
    fetch(`/api/organization/image/${kind}?v=${ver}`, { headers: { Authorization: `Bearer ${tokenStore.get() ?? ''}` } })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        made = b ? URL.createObjectURL(b) : null;
        setUrl(made);
      });
    return () => {
      if (made) URL.revokeObjectURL(made);
    };
  }, [kind, ver]);

  async function upload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!/^image\/(png|jpeg)$/.test(file.type)) return toast('Gambar harus PNG atau JPG', 'error');
    if (file.size > 1_000_000) return toast('Ukuran gambar maksimal 1 MB', 'error');
    const image = await new Promise<string>((ok, fail) => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result));
      r.onerror = fail;
      r.readAsDataURL(file);
    });
    try {
      await api.put(`/organization/image/${kind}`, { image });
      setVer((v) => v + 1);
      onChange();
      toast(`${kind === 'logo' ? 'Logo' : 'Cap'} diperbarui`);
    } catch (err) {
      toast(errMsg(err), 'error');
    }
  }

  async function remove() {
    try {
      await api.del(`/organization/image/${kind}`);
      setVer(0);
      onChange();
      toast(`${kind === 'logo' ? 'Logo' : 'Cap'} dihapus`);
    } catch (err) {
      toast(errMsg(err), 'error');
    }
  }

  const box = wide ? 'h-14 w-36' : 'h-14 w-14';
  return (
    <Field label={label} hint={hint}>
      <div className="flex flex-wrap items-center gap-3">
        {url ? (
          <img src={url} alt={label} className={`${box} rounded-lg border border-slate-200 bg-white object-contain p-1`} />
        ) : (
          <div className={`${box} flex items-center justify-center rounded-lg border border-dashed border-slate-300 text-[10px] text-slate-400`}>Belum ada</div>
        )}
        <label className="cursor-pointer rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-50">
          {url ? 'Ganti' : 'Unggah'}
          <input type="file" accept="image/png,image/jpeg" className="hidden" onChange={upload} />
        </label>
        {url && (
          <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={remove}>
            Hapus
          </Button>
        )}
      </div>
    </Field>
  );
}
