import { useEffect, useState } from 'react';
import { api } from './api';

export interface ParkingSettings {
  karcisEnabled: boolean;
  kejadianEnabled: boolean;
  rateCar: number;
  rateMotor: number;
  ticketAt: 'MASUK' | 'KELUAR';
  carLots: number;
  motorLots: number;
}

export interface Mismatch {
  car: number;
  motor: number;
  any: boolean;
}

export interface HourlyRow {
  id: number;
  userId: number;
  date: string;
  hour: number;
  post: string | null;
  carIn: number;
  motorIn: number;
  carOut: number;
  motorOut: number;
  ticketCar: number;
  ticketMotor: number;
  rateCar: number;
  rateMotor: number;
  note: string | null;
  mismatch: Mismatch;
  revenue: number;
  fullName?: string;
  postLabel?: string | null;
}

export interface DepositRow {
  id: number;
  userId: number;
  date: string;
  amount: number;
  ticketCar: number;
  ticketMotor: number;
  expected: number;
  diff: number;
  hasPhoto: boolean;
  note: string | null;
  status: 'MENUNGGU' | 'DITERIMA' | 'SELISIH';
  reviewNote: string | null;
  reviewedBy: string | null;
  fullName: string;
  reportedRevenue?: number;
}

export interface HandoverRow {
  id: number;
  date: string;
  fromUserId: number;
  toUserId: number;
  fromName: string;
  toName: string;
  postLabel: string | null;
  remainingCar: number;
  remainingMotor: number;
  lastSerialCar: string | null;
  lastSerialMotor: string | null;
  voidNote: string | null;
  cashAmount: number;
  cashNote: string | null;
  equipment: string | null;
  pendingIssues: string | null;
  status: 'MENUNGGU' | 'DITERIMA' | 'DIKETAHUI';
  acknowledgedBy: string | null;
  createdAt: string;
}

export const INCIDENT_LABEL: Record<string, string> = {
  KEHILANGAN_KENDARAAN: 'Kehilangan kendaraan',
  KERUSAKAN_KENDARAAN: 'Kerusakan kendaraan',
  TABRAKAN: 'Tabrakan antarkendaraan',
  PENCURIAN: 'Pencurian / percobaan pencurian',
  KECELAKAAN_KERJA: 'Kecelakaan kerja petugas',
  PENGUNJUNG_SAKIT: 'Pengunjung sakit / pingsan',
  KELUHAN_PENGUNJUNG: 'Keluhan pengunjung',
  KARCIS_HILANG: 'Karcis hilang (pengunjung)',
  KENDARAAN_MENGINAP: 'Kendaraan menginap / ditinggal',
  BENDA_MENCURIGAKAN: 'Benda / kendaraan mencurigakan',
  GANGGUAN_KEAMANAN: 'Pengunjung mengamuk / mengancam',
  BENCANA_CUACA: 'Gempa / banjir / pohon tumbang',
  LISTRIK_PADAM: 'Listrik padam / lampu mati',
  LAINNYA: 'Lainnya',
};

export interface IncidentRow {
  id: number;
  reporterId: number;
  reporter: string;
  date: string;
  time: string;
  location: string;
  type: string;
  parties: string | null;
  plate: string | null;
  vehicle: string | null;
  ticketNo: string | null;
  chronology: string;
  actions: string | null;
  contacted: string | null;
  photoCount: number;
  status: 'BARU' | 'DITINDAKLANJUTI' | 'SELESAI';
  reviewNote: string | null;
  reviewedBy: string | null;
}

export const rupiah = (n: number) => `Rp ${n.toLocaleString('id-ID')}`;
export const hourLabel = (h: number) => `${String(h).padStart(2, '0')}.00–${String((h + 1) % 24).padStart(2, '0')}.00`;
/** "+2 mobil, −1 motor" untuk selisih karcis */
export const mismatchText = (m: Mismatch) =>
  [m.car && `${m.car > 0 ? '+' : '−'}${Math.abs(m.car)} mobil`, m.motor && `${m.motor > 0 ? '+' : '−'}${Math.abs(m.motor)} motor`].filter(Boolean).join(', ');

// Pengaturan modul dibaca sekali lalu dibagi ke semua komponen (menu & halaman)
let cache: ParkingSettings | null = null;
const listeners = new Set<(s: ParkingSettings) => void>();
export function setParkingSettingsCache(s: ParkingSettings) {
  cache = s;
  listeners.forEach((l) => l(s));
}
export function useParkingSettings() {
  const [s, setS] = useState<ParkingSettings | null>(cache);
  useEffect(() => {
    listeners.add(setS);
    if (!cache) api.get<ParkingSettings>('/parking/settings').then(setParkingSettingsCache).catch(() => undefined);
    return () => {
      listeners.delete(setS);
    };
  }, []);
  return s;
}
