import { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { Icon, IconName } from './icons';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'success';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white shadow-sm hover:bg-brand-700 disabled:bg-brand-600/50',
  secondary: 'bg-white text-slate-700 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50 hover:ring-slate-300',
  danger: 'bg-rose-600 text-white shadow-sm hover:bg-rose-700 disabled:bg-rose-600/50',
  success: 'bg-emerald-600 text-white shadow-sm hover:bg-emerald-700 disabled:bg-emerald-600/50',
  ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
};

export function Button({
  variant = 'primary',
  className,
  loading,
  icon,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean; icon?: IconName }) {
  return (
    <button
      {...props}
      disabled={props.disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed',
        VARIANTS[variant],
        className,
      )}
    >
      {loading ? <Spinner /> : icon && <Icon name={icon} className="h-4 w-4" />}
      {children}
    </button>
  );
}

export const Spinner = ({ className }: { className?: string }) => (
  <span className={cx('inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent', className)} />
);

export function Card({
  children,
  className,
  title,
  subtitle,
  actions,
}: {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={cx('rounded-2xl border border-slate-200/80 bg-white p-4 shadow-card sm:p-5', className)}>
      {(title || actions) && (
        <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
          <div>
            {title && <h2 className="text-[15px] font-semibold text-slate-900">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}

export const PageHeader = ({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) => (
  <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
    <div>
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
      {subtitle && <p className="mt-1 max-w-3xl text-sm text-slate-500">{subtitle}</p>}
    </div>
    {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
  </div>
);

export const Badge = ({ children, className }: { children: ReactNode; className?: string }) => (
  <span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold', className)}>
    {children}
  </span>
);

export const Field = ({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) => (
  <label className="block">
    <span className="mb-1.5 block text-sm font-medium text-slate-700">{label}</span>
    {children}
    {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
  </label>
);

const inputCls =
  'w-full rounded-lg border-0 bg-white px-3 py-2 text-sm shadow-sm ring-1 ring-slate-200 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-slate-100';

export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cx(inputCls, p.className)} />;
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={cx(inputCls, p.className)} />;
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea {...p} className={cx(inputCls, p.className)} />
);

export function SearchInput({ value, onChange, placeholder = 'Cari…', className }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={cx('relative', className)}>
      <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cx(inputCls, 'pl-9')}
      />
    </div>
  );
}

const ALERT_STYLE = {
  error: { cls: 'bg-rose-50 text-rose-800 ring-rose-200', icon: 'alert' },
  success: { cls: 'bg-emerald-50 text-emerald-800 ring-emerald-200', icon: 'check' },
  info: { cls: 'bg-sky-50 text-sky-800 ring-sky-200', icon: 'info' },
} as const;

export const Alert = ({ kind = 'error', children }: { kind?: 'error' | 'success' | 'info'; children: ReactNode }) => (
  <div className={cx('flex items-start gap-2 rounded-lg px-3 py-2.5 text-sm ring-1', ALERT_STYLE[kind].cls)}>
    <Icon name={ALERT_STYLE[kind].icon} className="mt-0.5 h-4 w-4 shrink-0" />
    <div>{children}</div>
  </div>
);

export const Empty = ({ children, icon = 'inbox', title }: { children?: ReactNode; icon?: IconName; title?: string }) => (
  <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
    <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-400">
      <Icon name={icon} className="h-6 w-6" />
    </div>
    {title && <p className="text-sm font-semibold text-slate-700">{title}</p>}
    {children && <p className="mt-1 max-w-xs text-sm text-slate-500">{children}</p>}
  </div>
);

export const Skeleton = ({ className }: { className?: string }) => (
  <div className={cx('animate-pulse rounded-lg bg-slate-200/70', className)} />
);

export const Loading = () => (
  <div className="space-y-3 py-2" aria-label="Memuat">
    <Skeleton className="h-5 w-1/3" />
    <Skeleton className="h-10 w-full" />
    <Skeleton className="h-10 w-full" />
    <Skeleton className="h-10 w-5/6" />
  </div>
);

export function Modal({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  if (!open) return null;
  return (
    // Klik di luar kotak sengaja TIDAK menutup popup agar isian form (mis. PIN, foto wajah) tidak hilang
    // karena salah sentuh; tutup hanya lewat tombol ✕ atau tombol di dalam form.
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-0 backdrop-blur-[2px] sm:items-center sm:p-4">
      <div className="max-h-[92vh] w-full animate-slide-in overflow-y-auto rounded-t-2xl bg-white shadow-pop sm:max-w-lg sm:rounded-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-100 bg-white px-5 py-4">
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Tutup">
            <Icon name="x" className="h-4 w-4" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export const Table = ({ children }: { children: ReactNode }) => (
  <div className="-mx-4 overflow-x-auto sm:mx-0 sm:rounded-xl sm:border sm:border-slate-200">
    <table className="min-w-full divide-y divide-slate-200 text-sm [&_tbody_tr:hover]:bg-slate-50/80 [&_thead]:bg-slate-50">{children}</table>
  </div>
);
export const Th = ({ children, className }: { children?: ReactNode; className?: string }) => (
  <th className={cx('whitespace-nowrap px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500', className)}>
    {children}
  </th>
);
export const Td = ({ children, className }: { children?: ReactNode; className?: string }) => (
  <td className={cx('whitespace-nowrap px-4 py-3', className)}>{children}</td>
);

const AVATAR_COLORS = [
  'bg-brand-100 text-brand-700',
  'bg-emerald-100 text-emerald-700',
  'bg-amber-100 text-amber-800',
  'bg-violet-100 text-violet-700',
  'bg-sky-100 text-sky-700',
  'bg-rose-100 text-rose-700',
  'bg-teal-100 text-teal-700',
];

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');

/** Avatar inisial; warnanya tetap untuk nama yang sama. */
export function Avatar({ name, size = 'md', className }: { name: string; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const hash = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const sz = { sm: 'h-7 w-7 text-[11px]', md: 'h-9 w-9 text-xs', lg: 'h-11 w-11 text-sm' }[size];
  return (
    <span className={cx('inline-flex shrink-0 items-center justify-center rounded-full font-semibold', sz, AVATAR_COLORS[hash % AVATAR_COLORS.length], className)}>
      {initials(name)}
    </span>
  );
}

/** Nama + keterangan kecil di sebelah avatar (dipakai di banyak tabel). */
export const PersonCell = ({ name, sub }: { name: string; sub?: ReactNode }) => (
  <div className="flex items-center gap-3">
    <Avatar name={name} />
    <div className="min-w-0">
      <div className="truncate font-medium text-slate-900">{name}</div>
      {sub && <div className="truncate text-xs text-slate-500">{sub}</div>}
    </div>
  </div>
);

const TONES = {
  brand: 'bg-brand-50 text-brand-600',
  green: 'bg-emerald-50 text-emerald-600',
  amber: 'bg-amber-50 text-amber-600',
  rose: 'bg-rose-50 text-rose-600',
  violet: 'bg-violet-50 text-violet-600',
  slate: 'bg-slate-100 text-slate-600',
};

export function StatCard({
  label,
  value,
  sub,
  icon,
  tone = 'brand',
  progress,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon: IconName;
  tone?: keyof typeof TONES;
  progress?: number; // 0..1
}) {
  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-card sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-500">{label}</p>
          <p className="mt-1.5 text-3xl font-bold tracking-tight text-slate-900">{value}</p>
        </div>
        <span className={cx('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', TONES[tone])}>
          <Icon name={icon} />
        </span>
      </div>
      {progress !== undefined && (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100">
          <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${Math.min(100, progress * 100)}%` }} />
        </div>
      )}
      {sub && <p className="mt-2 text-xs text-slate-500">{sub}</p>}
    </div>
  );
}
