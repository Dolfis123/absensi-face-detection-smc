import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { api, AttendanceIssue, LeaveRequest, Role } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useServerClock } from '../lib/clock';
import { ROLE_LABEL } from '../lib/format';
import { Icon, IconName } from './icons';
import { Avatar, cx } from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  short?: string; // label pendek untuk navigasi bawah HP
}
interface NavGroup {
  title: string;
  items: NavItem[];
}

export const NAV_GROUPS: Record<Role, NavGroup[]> = {
  KARYAWAN: [
    {
      title: 'Utama',
      items: [
        { to: '/app/beranda', label: 'Beranda', icon: 'home', short: 'Beranda' },
        { to: '/app/rekap', label: 'Rekap Kehadiran', icon: 'chart', short: 'Rekap' },
        { to: '/app/jadwal', label: 'Jadwal Shift', icon: 'calendar', short: 'Jadwal' },
      ],
    },
    {
      title: 'Pengajuan',
      items: [
        { to: '/app/izin', label: 'Izin / Sakit / Cuti', icon: 'send', short: 'Izin' },
        { to: '/app/kendala', label: 'Lapor Kendala', icon: 'alert', short: 'Kendala' },
      ],
    },
  ],
  KOORDINATOR: [
    {
      title: 'Utama',
      items: [
        { to: '/app/beranda', label: 'Beranda', icon: 'home' },
        { to: '/app/monitoring', label: 'Monitoring Hari Ini', icon: 'activity' },
      ],
    },
    {
      title: 'Tinjauan',
      items: [
        { to: '/app/review-izin', label: 'Pengajuan Izin', icon: 'send' },
        { to: '/app/review-kendala', label: 'Laporan Kendala', icon: 'alert' },
      ],
    },
    { title: 'Laporan', items: [{ to: '/app/laporan', label: 'Rekap & Unduh', icon: 'download' }] },
  ],
  SUPER_ADMIN: [
    {
      title: 'Utama',
      items: [
        { to: '/app/beranda', label: 'Beranda', icon: 'home' },
        { to: '/app/monitoring', label: 'Monitoring Hari Ini', icon: 'activity' },
      ],
    },
    {
      title: 'Tinjauan',
      items: [
        { to: '/app/review-izin', label: 'Pengajuan Izin', icon: 'send' },
        { to: '/app/review-kendala', label: 'Laporan Kendala', icon: 'alert' },
        { to: '/app/koreksi', label: 'Koreksi & Audit', icon: 'shield' },
      ],
    },
    {
      title: 'Data Master',
      items: [
        { to: '/app/karyawan', label: 'Data Pengguna', icon: 'users' },
        { to: '/app/roster', label: 'Roster Shift', icon: 'calendar' },
        { to: '/app/libur', label: 'Hari Libur', icon: 'calendarX' },
      ],
    },
    {
      title: 'Pengaturan & Laporan',
      items: [
        { to: '/app/pengaturan-shift', label: 'Pengaturan Shift', icon: 'clock' },
        { to: '/app/geofence', label: 'Geofence Pos', icon: 'mapPin' },
        { to: '/app/laporan', label: 'Laporan', icon: 'download' },
      ],
    },
  ],
};

/** Halaman pertama setelah login. */
export const homePath = (_role: Role) => '/app/beranda';

function useCollapsed() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('smc_sidebar') === 'collapsed';
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem('smc_sidebar', c ? 'open' : 'collapsed');
      } catch {
        /* abaikan */
      }
      return !c;
    });
  return [collapsed, toggle] as const;
}

/** Jumlah izin & kendala yang menunggu tindakan (untuk lonceng notifikasi). */
function usePendingCounts(role: Role) {
  const [counts, setCounts] = useState<{ leaves: number; issues: number } | null>(null);
  const location = useLocation();
  useEffect(() => {
    if (role === 'KARYAWAN') return;
    const load = () =>
      Promise.all([api.get<LeaveRequest[]>('/leaves?status=PENDING'), api.get<AttendanceIssue[]>('/issues')])
        .then(([leaves, issues]) =>
          setCounts({
            leaves: leaves.length,
            issues: issues.filter((i) => i.status === 'OPEN' || (role === 'SUPER_ADMIN' && i.status === 'ESCALATED')).length,
          }),
        )
        .catch(() => undefined);
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
    // dimuat ulang saat pindah halaman agar angka langsung berkurang setelah ditinjau
  }, [role, location.pathname]);
  return counts;
}

function Bell({ role }: { role: Role }) {
  const counts = usePendingCounts(role);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  if (role === 'KARYAWAN') return null;
  const total = (counts?.leaves ?? 0) + (counts?.issues ?? 0);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
        aria-label={`Notifikasi, ${total} menunggu`}
      >
        <Icon name="bell" />
        {total > 0 && (
          <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">
            {total}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-72 animate-slide-in overflow-hidden rounded-xl border border-slate-200 bg-white shadow-pop">
          <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-900">Perlu tindakan</div>
          {[
            { to: '/app/review-izin', icon: 'send' as const, label: 'Pengajuan izin menunggu', n: counts?.leaves ?? 0 },
            {
              to: '/app/review-kendala',
              icon: 'alert' as const,
              label: role === 'SUPER_ADMIN' ? 'Laporan kendala baru / diteruskan' : 'Laporan kendala baru',
              n: counts?.issues ?? 0,
            },
          ].map((it) => (
            <Link key={it.to} to={it.to} onClick={() => setOpen(false)} className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-slate-50">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                <Icon name={it.icon} className="h-4 w-4" />
              </span>
              <span className="flex-1 text-slate-700">{it.label}</span>
              <span className={cx('rounded-full px-2 py-0.5 text-xs font-bold', it.n ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-500')}>
                {it.n}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function Clock() {
  const now = useServerClock();
  return (
    <div className="hidden items-center gap-2 rounded-lg bg-slate-100 px-3 py-1.5 text-sm text-slate-600 sm:flex" title="Jam server (WIT)">
      <Icon name="clock" className="h-4 w-4 text-slate-400" />
      <span className="font-mono font-semibold tabular-nums text-slate-800">{now.time}</span>
      <span className="text-xs">WIT</span>
    </div>
  );
}

export function Layout() {
  const { user, logout } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, toggleCollapsed] = useCollapsed();
  const { pathname } = useLocation();
  if (!user) return null;

  const groups = NAV_GROUPS[user.role];
  const items = groups.flatMap((g) => g.items.map((i) => ({ ...i, group: g.title })));
  const current = items.find((i) => pathname.startsWith(i.to));
  const isEmployee = user.role === 'KARYAWAN';
  const narrow = collapsed && !mobileOpen;

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className={cx('flex items-center gap-3 px-4 pb-6 pt-5', narrow && 'justify-center px-2')}>
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-lg shadow-brand-950/40">
          <Icon name="scan" className="h-5 w-5" />
        </div>
        {!narrow && (
          <div className="min-w-0">
            <div className="truncate text-[15px] font-bold leading-tight text-white">SMC-FaceAttend</div>
            <div className="truncate text-xs text-brand-200/70">Pos Parkir Mal SMC</div>
          </div>
        )}
      </div>

      <nav className="flex-1 space-y-6 overflow-y-auto px-3 pb-4">
        {groups.map((g) => (
          <div key={g.title}>
            {!narrow && <div className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-wider text-brand-200/50">{g.title}</div>}
            <div className="space-y-1">
              {g.items.map((it) => (
                <NavLink
                  key={it.to}
                  to={it.to}
                  title={narrow ? it.label : undefined}
                  onClick={() => setMobileOpen(false)}
                  className={({ isActive }) =>
                    cx(
                      'group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition',
                      narrow && 'justify-center px-0',
                      isActive ? 'bg-white/10 text-white' : 'text-brand-100/70 hover:bg-white/5 hover:text-white',
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      {isActive && <span className="absolute inset-y-1.5 left-0 w-1 rounded-r-full bg-brand-400" />}
                      <Icon name={it.icon} className={cx('h-5 w-5 shrink-0', isActive ? 'text-brand-300' : 'text-brand-200/60 group-hover:text-brand-200')} />
                      {!narrow && <span className="truncate">{it.label}</span>}
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t border-white/10 p-3">
        <div className={cx('flex items-center gap-3 rounded-xl p-2', narrow && 'justify-center')}>
          <Avatar name={user.fullName} className="!bg-white/15 !text-white" />
          {!narrow && (
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-white">{user.fullName}</div>
              <div className="truncate text-xs text-brand-200/70">{ROLE_LABEL[user.role]}</div>
            </div>
          )}
          {!narrow && (
            <button onClick={logout} className="rounded-lg p-2 text-brand-200/70 hover:bg-white/10 hover:text-white" title="Keluar" aria-label="Keluar">
              <Icon name="logout" className="h-4 w-4" />
            </button>
          )}
        </div>
        <button
          onClick={toggleCollapsed}
          className="mt-1 hidden w-full items-center justify-center gap-2 rounded-lg py-2 text-xs text-brand-200/60 hover:bg-white/5 hover:text-white lg:flex"
        >
          <Icon name="chevronsLeft" className={cx('h-4 w-4 transition', collapsed && 'rotate-180')} />
          {!collapsed && 'Ciutkan menu'}
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen lg:flex">
      <aside
        className={cx(
          'fixed inset-y-0 left-0 z-40 w-72 transform bg-gradient-to-b from-brand-900 to-brand-950 transition-all duration-200 lg:sticky lg:top-0 lg:h-screen lg:translate-x-0',
          collapsed ? 'lg:w-20' : 'lg:w-64',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        {sidebar}
      </aside>
      {mobileOpen && <div className="fixed inset-0 z-30 bg-slate-900/50 backdrop-blur-[2px] lg:hidden" onClick={() => setMobileOpen(false)} />}

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-slate-200/80 bg-white/85 px-4 backdrop-blur sm:px-6">
          {!isEmployee && (
            <button className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Buka menu">
              <Icon name="menu" />
            </button>
          )}
          {isEmployee && (
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-white lg:hidden">
              <Icon name="scan" className="h-4 w-4" />
            </div>
          )}
          <nav className="flex min-w-0 items-center gap-1.5 text-sm" aria-label="Breadcrumb">
            <span className="hidden text-slate-400 sm:inline">{current?.group ?? 'Menu'}</span>
            <Icon name="chevronRight" className="hidden h-4 w-4 text-slate-300 sm:inline" />
            <span className="truncate font-semibold text-slate-800">{current?.label ?? ''}</span>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Clock />
            <Bell role={user.role} />
            <div className="hidden h-8 w-px bg-slate-200 sm:block" />
            <div className="flex items-center gap-2.5">
              <Avatar name={user.fullName} size="sm" />
              <div className="hidden text-right leading-tight md:block">
                <div className="text-sm font-semibold text-slate-800">{user.fullName}</div>
                <div className="text-xs text-slate-500">{ROLE_LABEL[user.role]}</div>
              </div>
            </div>
            {isEmployee && (
              <button onClick={logout} className="rounded-lg p-2 text-slate-500 hover:bg-rose-50 hover:text-rose-600 lg:hidden" aria-label="Keluar">
                <Icon name="logout" />
              </button>
            )}
          </div>
        </header>

        <main className={cx('mx-auto max-w-7xl p-4 sm:p-6 lg:p-8', isEmployee && 'pb-24 lg:pb-8')}>
          <Outlet />
        </main>
      </div>

      {isEmployee && (
        <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
          <div className="grid grid-cols-5">
            {items.map((it) => (
              <NavLink
                key={it.to}
                to={it.to}
                className={({ isActive }) =>
                  cx('flex flex-col items-center gap-1 py-2 text-[11px] font-medium', isActive ? 'text-brand-600' : 'text-slate-500')
                }
              >
                <Icon name={it.icon} className="h-5 w-5" />
                {it.short ?? it.label}
              </NavLink>
            ))}
          </div>
        </nav>
      )}
    </div>
  );
}
