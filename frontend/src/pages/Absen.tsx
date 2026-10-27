import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Camera, CameraHandle } from '../components/Camera';
import { Button } from '../components/ui';
import { api, errMsg, Geofence } from '../lib/api';
import { haversine, SLOT_LABEL, STATUS_STYLE } from '../lib/format';

interface CheckResult {
  message: string;
  employee: { fullName: string; nik: string };
  shift: string;
  slotType: 'MASUK' | 'ISTIRAHAT' | 'PULANG';
  status: 'TEPAT_WAKTU' | 'TERLAMBAT';
  date: string;
  time: string;
  distanceMeters: number;
}

interface Position {
  latitude: number;
  longitude: number;
  accuracy: number;
}

function useServerClock() {
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    api
      .get<{ instant: string }>('/attendance/time')
      .then((t) => setOffset(new Date(t.instant).getTime() - Date.now()))
      .catch(() => undefined);
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return new Date(now + offset + 9 * 3600_000).toISOString().slice(11, 19);
}

export default function Absen() {
  const camera = useRef<CameraHandle>(null);
  const [geo, setGeo] = useState<Geofence | null>(null);
  const [pos, setPos] = useState<Position | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const clock = useServerClock();

  useEffect(() => {
    api.get<Geofence>('/attendance/geofence').then(setGeo).catch((e) => setGpsError(errMsg(e)));
    if (!navigator.geolocation) {
      setGpsError('Perangkat tidak mendukung GPS');
      return;
    }
    const id = navigator.geolocation.watchPosition(
      (p) => {
        setGpsError(null);
        setPos({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy });
      },
      (e) => setGpsError(e.code === e.PERMISSION_DENIED ? 'Izin lokasi ditolak. Aktifkan GPS & izin lokasi.' : 'Mencari sinyal GPS…'),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  // Kembali ke kamera otomatis agar karyawan berikutnya bisa langsung absen
  useEffect(() => {
    if (!result && !error) return;
    const t = setTimeout(() => {
      setResult(null);
      setError(null);
    }, result ? 6000 : 8000);
    return () => clearTimeout(t);
  }, [result, error]);

  const distance = geo && pos ? haversine(geo.latitude, geo.longitude, pos.latitude, pos.longitude) : null;
  const inside = distance !== null && geo !== null && distance <= geo.radiusMeters;
  const accurate = pos !== null && geo !== null && pos.accuracy <= geo.maxAccuracyMeters;

  async function submit() {
    if (!pos) return;
    const image = camera.current?.capture();
    if (!image) {
      setError('Kamera belum siap');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      setResult(await api.post<CheckResult>('/attendance/check', { image, ...pos }));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      <div className="mx-auto flex max-w-md flex-col gap-4 p-4">
        <div className="flex items-center justify-between">
          <Link to="/" className="rounded-lg px-2 py-1 text-sm text-slate-300 hover:bg-white/10">
            ← Kembali
          </Link>
          <div className="text-right">
            <div className="font-mono text-2xl font-bold tabular-nums">{clock}</div>
            <div className="text-[11px] text-slate-400">Jam server · WIT</div>
          </div>
        </div>

        <Camera ref={camera} />

        <div className="grid grid-cols-2 gap-2 text-sm">
          <div className={`rounded-xl p-3 ${inside ? 'bg-emerald-500/20 text-emerald-200' : 'bg-rose-500/20 text-rose-200'}`}>
            <div className="text-xs opacity-80">Jarak ke pos</div>
            <div className="text-lg font-bold">
              {distance === null ? '—' : `${distance.toFixed(1)} m`}
              <span className="ml-1 text-xs font-normal">/ maks {geo?.radiusMeters ?? '…'} m</span>
            </div>
          </div>
          <div className={`rounded-xl p-3 ${accurate ? 'bg-emerald-500/20 text-emerald-200' : 'bg-amber-500/20 text-amber-200'}`}>
            <div className="text-xs opacity-80">Akurasi GPS</div>
            <div className="text-lg font-bold">{pos ? `±${Math.round(pos.accuracy)} m` : '—'}</div>
          </div>
        </div>
        {gpsError && <p className="text-center text-sm text-amber-300">{gpsError}</p>}
        <p className="text-center text-xs text-slate-400">
          Posisikan wajah di dalam oval, lepaskan masker/kacamata hitam, pastikan hanya satu orang di depan kamera.
        </p>

        <Button className="py-4 text-lg" onClick={submit} loading={submitting} disabled={!pos || !geo}>
          {submitting ? 'Memverifikasi…' : 'Ambil Foto & Absen'}
        </Button>
        <p className="text-center text-[11px] text-slate-500">
          Lokasi & wajah divalidasi ulang di server. Indikator di atas hanya panduan.
        </p>
      </div>

      {(result || error) && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-6"
          onClick={() => {
            setResult(null);
            setError(null);
          }}
        >
          <div className="w-full max-w-sm rounded-3xl bg-white p-6 text-center text-slate-800 shadow-2xl">
            {result ? (
              <>
                <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 text-3xl text-emerald-600">
                  ✓
                </div>
                <div className="text-lg font-bold">{result.message}</div>
                <div className="mt-3 text-2xl font-extrabold">{result.employee.fullName}</div>
                <div className="text-sm text-slate-500">NIK {result.employee.nik}</div>
                <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
                  <div className="rounded-xl bg-slate-100 p-2">
                    <div className="text-xs text-slate-500">{result.shift}</div>
                    <div className="font-semibold">Absen {SLOT_LABEL[result.slotType]}</div>
                  </div>
                  <div className="rounded-xl bg-slate-100 p-2">
                    <div className="text-xs text-slate-500">Jam (WIT)</div>
                    <div className="font-mono font-semibold">{result.time}</div>
                  </div>
                </div>
                <div className={`mt-3 rounded-xl py-2 text-sm font-bold ${STATUS_STYLE[result.status].cls}`}>
                  {STATUS_STYLE[result.status].label}
                </div>
              </>
            ) : (
              <>
                <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-rose-100 text-3xl text-rose-600">
                  ✕
                </div>
                <div className="text-lg font-bold">Absensi Ditolak</div>
                <p className="mt-2 text-sm text-slate-600">{error}</p>
              </>
            )}
            <p className="mt-4 text-xs text-slate-400">Ketuk untuk menutup</p>
          </div>
        </div>
      )}
    </div>
  );
}
