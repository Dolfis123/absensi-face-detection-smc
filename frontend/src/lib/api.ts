export type Role = 'SUPER_ADMIN' | 'KOORDINATOR' | 'KARYAWAN';
// ISTIRAHAT = mulai istirahat, KEMBALI = selesai istirahat
export type SlotType = 'MASUK' | 'ISTIRAHAT' | 'KEMBALI' | 'PULANG';
// ABSEN_SEKALI = hadir tapi absennya tidak lengkap (hanya Masuk, atau tanpa Masuk)
export type DayStatus = 'TEPAT_WAKTU' | 'TERLAMBAT' | 'ABSEN_SEKALI' | 'ALFA' | 'IZIN' | 'SAKIT' | 'CUTI' | 'LIBUR' | 'OFF' | 'BELUM';

export interface PublicUser {
  id: number;
  fullName: string;
  nik: string;
  username: string;
  role: Role;
  phone: string;
  defaultShiftId: number | null;
  isActive: boolean;
  hasFace: boolean;
  faceCount: number;
  /** Data wajah dari mesin lama — wajib daftar ulang agar bisa absen. */
  faceOutdated: boolean;
  hasPin: boolean;
  immutable: boolean;
}

export interface Shift {
  id: number;
  code: string;
  name: string;
  startTime: string;
  endTime: string;
  slots: { id: number; type: SlotType; windowStart: string; windowEnd: string }[];
  breakConfig: BreakConfig | null;
}

/** Istirahat bergantian: mulai kapan saja di [windowStart, windowEnd], maks. maxMinutes + toleranceMinutes. */
export interface BreakConfig {
  enabled: boolean;
  windowStart: string;
  windowEnd: string;
  maxMinutes: number;
  toleranceMinutes: number;
}

export interface BreakInfo {
  start: string | null;
  end: string | null;
  minutes: number | null;
  over: boolean;
  missingReturn: boolean;
  onBreak: boolean;
}

export interface DayRecord {
  date: string;
  shiftId: number | null;
  shiftName: string | null;
  status: DayStatus;
  note: string | null;
  slots: Partial<Record<SlotType, { time: string; status: string; source: string }>>;
  break: BreakInfo | null;
}

export interface Summary {
  hadir: number;
  tepatWaktu: number;
  terlambat: number;
  /** Hadir tapi absen tidak lengkap (hanya masuk / tanpa masuk) */
  absenSekali: number;
  izin: number;
  sakit: number;
  cuti: number;
  alfa: number;
  libur: number;
  hariKerja: number;
  istirahatLebih: number;
  lupaKembali: number;
}

export interface EmployeeRecap {
  user: { id: number; fullName: string; nik: string; phone: string; role: Role };
  summary: Summary;
  days: DayRecord[];
}

export interface LeaveRequest {
  id: number;
  userId: number;
  type: 'IZIN' | 'SAKIT' | 'CUTI';
  startDate: string;
  endDate: string;
  reason: string;
  attachmentPath: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  reviewNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
  user?: { id: number; fullName: string; nik: string };
  reviewedBy?: { id: number; fullName: string } | null;
}

export interface AttendanceIssue {
  id: number;
  userId: number;
  date: string;
  description: string;
  status: 'OPEN' | 'REVIEWED' | 'ESCALATED' | 'RESOLVED' | 'REJECTED';
  reviewNote: string | null;
  createdAt: string;
  user?: { id: number; fullName: string; nik: string };
  reviewedBy?: { id: number; fullName: string } | null;
}

export interface Holiday {
  id: number;
  date: string;
  name: string;
}

export interface Geofence {
  name: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  maxAccuracyMeters: number;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Data tambahan dari server, mis. { needPin: true } atau { code: 'FACE_SIMILAR', similar: [...] } */
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface SimilarFaceInfo {
  id: number;
  fullName: string;
  nik: string;
  hasPin: boolean;
  distance: number;
}

const TOKEN_KEY = 'smc_token';
export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = tokenStore.get();
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`/api${url}`, { method, headers, body: payload });
  if (res.status === 401 && token && !url.startsWith('/auth/login')) onUnauthorized?.();
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const body = data as { message?: string; details?: Record<string, unknown> };
    throw new ApiError(res.status, body.message ?? `Error ${res.status}`, body.details);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body),
  put: <T>(url: string, body?: unknown) => request<T>('PUT', url, body),
  patch: <T>(url: string, body?: unknown) => request<T>('PATCH', url, body),
  del: <T>(url: string) => request<T>('DELETE', url),
};

/** Unduh file terproteksi (CSV / lampiran) dengan token. */
export async function downloadFile(url: string, filename: string) {
  const res = await fetch(`/api${url}`, { headers: { Authorization: `Bearer ${tokenStore.get() ?? ''}` } });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, (data as { message?: string }).message ?? 'Gagal mengunduh');
  }
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

export async function openProtectedFile(url: string) {
  const res = await fetch(`/api${url}`, { headers: { Authorization: `Bearer ${tokenStore.get() ?? ''}` } });
  if (!res.ok) throw new ApiError(res.status, 'Lampiran tidak dapat dibuka');
  window.open(URL.createObjectURL(await res.blob()), '_blank');
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Terjadi kesalahan');
