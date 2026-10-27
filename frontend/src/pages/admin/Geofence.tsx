import { FormEvent, useEffect, useState } from 'react';
import { useLoad } from '../../components/attendance';
import { Alert, Button, Card, Field, Input, Loading, PageHeader } from '../../components/ui';
import { api, errMsg, Geofence as GeofenceT } from '../../lib/api';

export default function Geofence() {
  const { data, error, loading } = useLoad(() => api.get<GeofenceT>('/admin/geofence'));
  const [form, setForm] = useState<GeofenceT | null>(null);
  const [saving, setSaving] = useState(false);
  const [locating, setLocating] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success' | 'info'; text: string } | null>(null);

  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  if (loading || !form) return error ? <Alert>{error}</Alert> : <Loading />;

  /** Ambil rata-rata beberapa pembacaan GPS agar titik pusat lebih stabil. */
  function captureCurrentLocation() {
    if (!navigator.geolocation) return setMsg({ kind: 'error', text: 'GPS tidak tersedia' });
    setLocating(true);
    setMsg({ kind: 'info', text: 'Mengumpulkan 10 pembacaan GPS… tetap diam di titik pusat pos parkir.' });
    const samples: GeolocationCoordinates[] = [];
    const id = navigator.geolocation.watchPosition(
      (p) => {
        samples.push(p.coords);
        if (samples.length >= 10) {
          navigator.geolocation.clearWatch(id);
          const avg = (f: (c: GeolocationCoordinates) => number) => samples.reduce((s, c) => s + f(c), 0) / samples.length;
          setForm((f) => f && { ...f, latitude: Number(avg((c) => c.latitude).toFixed(7)), longitude: Number(avg((c) => c.longitude).toFixed(7)) });
          setMsg({ kind: 'success', text: `Titik diambil (rata-rata akurasi ±${avg((c) => c.accuracy).toFixed(1)} m). Klik Simpan.` });
          setLocating(false);
        }
      },
      (e) => {
        navigator.geolocation.clearWatch(id);
        setLocating(false);
        setMsg({ kind: 'error', text: e.message });
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    setSaving(true);
    try {
      const { name, latitude, longitude, radiusMeters, maxAccuracyMeters } = form;
      await api.put('/admin/geofence', { name, latitude, longitude, radiusMeters, maxAccuracyMeters });
      setMsg({ kind: 'success', text: 'Titik geofence tersimpan dan langsung berlaku.' });
    } catch (err) {
      setMsg({ kind: 'error', text: errMsg(err) });
    } finally {
      setSaving(false);
    }
  }

  const num = (k: keyof GeofenceT) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: Number(e.target.value) });

  return (
    <>
      <PageHeader title="Geofence Pos Parkir" subtitle="Titik pusat & radius validasi lokasi absensi (dihitung di server dengan rumus Haversine)" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <form onSubmit={submit} className="space-y-3">
            {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
            <Field label="Nama lokasi">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Latitude">
                <Input type="number" step="0.0000001" value={form.latitude} onChange={num('latitude')} required />
              </Field>
              <Field label="Longitude">
                <Input type="number" step="0.0000001" value={form.longitude} onChange={num('longitude')} required />
              </Field>
            </div>
            <Button type="button" variant="secondary" className="w-full" onClick={captureCurrentLocation} loading={locating}>
              Gunakan lokasi saya sekarang (berdiri di titik pusat pos)
            </Button>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Radius (meter)">
                <Input type="number" step="0.5" min={1} value={form.radiusMeters} onChange={num('radiusMeters')} required />
              </Field>
              <Field label="Maks. akurasi GPS (m)" hint="Pembacaan GPS yang lebih kasar ditolak">
                <Input type="number" step="1" min={1} value={form.maxAccuracyMeters} onChange={num('maxAccuracyMeters')} required />
              </Field>
            </div>
            <Button type="submit" className="w-full" loading={saving}>
              Simpan
            </Button>
          </form>
        </Card>
        <Card>
          <h2 className="mb-2 font-semibold">Catatan penting</h2>
          <ul className="list-disc space-y-2 pl-5 text-sm text-slate-600">
            <li>
              GPS HP umumnya memiliki galat ±3–15 m, terlebih di dekat gedung beton. Dengan radius 5 m, karyawan yang benar-benar berada di pos
              bisa saja tertolak. Uji coba langsung di pos pada jam shift sebelum digunakan resmi.
            </li>
            <li>Ambil titik pusat di area terbuka pos parkir, bukan di dalam gedung mal.</li>
            <li>
              <a
                className="text-brand-600 hover:underline"
                href={`https://www.google.com/maps?q=${form.latitude},${form.longitude}`}
                target="_blank"
                rel="noreferrer"
              >
                Lihat titik saat ini di Google Maps ↗
              </a>
            </li>
          </ul>
        </Card>
      </div>
    </>
  );
}
