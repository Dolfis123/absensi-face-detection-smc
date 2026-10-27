import { ReactElement } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { homePath, Layout } from './components/Layout';
import { Loading } from './components/ui';
import { Role } from './lib/api';
import { useAuth } from './lib/auth';
import Absen from './pages/Absen';
import Landing from './pages/Landing';
import Login from './pages/Login';
import Geofence from './pages/admin/Geofence';
import Karyawan from './pages/admin/Karyawan';
import Koreksi from './pages/admin/Koreksi';
import Libur from './pages/admin/Libur';
import PengaturanShift from './pages/admin/PengaturanShift';
import Roster from './pages/admin/Roster';
import BerandaKaryawan from './pages/karyawan/Beranda';
import Izin from './pages/karyawan/Izin';
import Jadwal from './pages/karyawan/Jadwal';
import Kendala from './pages/karyawan/Kendala';
import Rekap from './pages/karyawan/Rekap';
import BerandaPengawas from './pages/shared/Beranda';
import Laporan from './pages/shared/Laporan';
import Monitoring from './pages/shared/Monitoring';
import ReviewIzin from './pages/shared/ReviewIzin';
import ReviewKendala from './pages/shared/ReviewKendala';

function Guard({ roles, children }: { roles?: Role[]; children: ReactElement }) {
  const { user, loading } = useAuth();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/app" replace />;
  return children;
}

function HomeRedirect() {
  const { user } = useAuth();
  return user ? <Navigate to={homePath(user.role)} replace /> : <Navigate to="/login" replace />;
}

function Beranda() {
  const { user } = useAuth();
  return user?.role === 'KARYAWAN' ? <BerandaKaryawan /> : <BerandaPengawas />;
}

const ADMIN: Role[] = ['SUPER_ADMIN'];
const REVIEWERS: Role[] = ['SUPER_ADMIN', 'KOORDINATOR'];
const EMPLOYEE: Role[] = ['KARYAWAN'];

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/absen" element={<Absen />} />
      <Route path="/login" element={<Login />} />
      <Route
        path="/app"
        element={
          <Guard>
            <Layout />
          </Guard>
        }
      >
        <Route index element={<HomeRedirect />} />
        <Route path="beranda" element={<Beranda />} />
        <Route path="rekap" element={<Guard roles={EMPLOYEE}><Rekap /></Guard>} />
        <Route path="jadwal" element={<Guard roles={EMPLOYEE}><Jadwal /></Guard>} />
        <Route path="izin" element={<Guard roles={EMPLOYEE}><Izin /></Guard>} />
        <Route path="kendala" element={<Guard roles={EMPLOYEE}><Kendala /></Guard>} />
        <Route path="monitoring" element={<Guard roles={REVIEWERS}><Monitoring /></Guard>} />
        <Route path="laporan" element={<Guard roles={REVIEWERS}><Laporan /></Guard>} />
        <Route path="review-izin" element={<Guard roles={REVIEWERS}><ReviewIzin /></Guard>} />
        <Route path="review-kendala" element={<Guard roles={REVIEWERS}><ReviewKendala /></Guard>} />
        <Route path="karyawan" element={<Guard roles={ADMIN}><Karyawan /></Guard>} />
        <Route path="roster" element={<Guard roles={ADMIN}><Roster /></Guard>} />
        <Route path="koreksi" element={<Guard roles={ADMIN}><Koreksi /></Guard>} />
        <Route path="libur" element={<Guard roles={ADMIN}><Libur /></Guard>} />
        <Route path="geofence" element={<Guard roles={ADMIN}><Geofence /></Guard>} />
        <Route path="pengaturan-shift" element={<Guard roles={ADMIN}><PengaturanShift /></Guard>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
