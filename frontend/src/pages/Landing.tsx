import { Link } from 'react-router-dom';

export default function Landing() {
  return (
    <div className="flex min-h-screen flex-col bg-gradient-to-b from-brand-900 via-brand-700 to-brand-600 px-5 text-white">
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center py-10">
        <div className="mb-10 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-white/15 text-3xl font-black">P</div>
          <h1 className="text-3xl font-extrabold tracking-tight">SMC-FaceAttend</h1>
          <p className="mt-2 text-sm text-brand-100">Sistem Absensi Wajah &amp; Geofencing</p>
          <p className="text-sm text-brand-100">Pos Parkir Mal SMC · Kota Sorong</p>
        </div>

        <div className="space-y-4">
          <Link
            to="/absen"
            className="block rounded-2xl bg-white p-6 text-center text-brand-900 shadow-xl transition active:scale-[0.98]"
          >
            <div className="text-2xl font-extrabold">Absen Sekarang</div>
            <div className="mt-1 text-sm text-slate-500">Verifikasi wajah + lokasi GPS, tanpa login</div>
          </Link>
          <Link
            to="/login"
            className="block rounded-2xl bg-white/10 p-5 text-center ring-1 ring-white/30 transition hover:bg-white/15 active:scale-[0.98]"
          >
            <div className="text-lg font-bold">Login</div>
            <div className="mt-1 text-sm text-brand-100">Rekap kehadiran, izin, monitoring &amp; administrasi</div>
          </Link>
        </div>
      </div>
      <p className="pb-6 text-center text-xs text-brand-100/70">Waktu absensi mengikuti jam server (WIT)</p>
    </div>
  );
}
