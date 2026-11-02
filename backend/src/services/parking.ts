/**
 * Operasional parkir: pengaturan modul, perhitungan pendapatan, selisih karcis, dan ringkasan harian.
 * Perhitungan dibuat murni (tanpa database) supaya bisa diuji; route yang mengambil datanya.
 */
import { AppSetting, sequelize, ShiftChangeLog } from '../models';

export interface ParkingSettings {
  /** Laporan per jam, stok karcis, setoran, dan serah terima shift */
  karcisEnabled: boolean;
  /** Laporan kejadian (tidak bergantung pada karcis) */
  kejadianEnabled: boolean;
  rateCar: number; // Rupiah per mobil
  rateMotor: number; // Rupiah per motor
  /** Karcis diterbitkan saat kendaraan MASUK atau saat KELUAR — dasar pencocokan selisih */
  ticketAt: 'MASUK' | 'KELUAR';
  carLots: number;
  motorLots: number;
}

export const DEFAULT_PARKING: ParkingSettings = {
  karcisEnabled: false,
  kejadianEnabled: false,
  rateCar: 0,
  rateMotor: 0,
  ticketAt: 'MASUK',
  carLots: 345,
  motorLots: 200,
};

const KEY = 'parkingSettings';

export async function getParkingSettings(): Promise<ParkingSettings> {
  const row = await AppSetting.findByPk(KEY);
  if (!row) return DEFAULT_PARKING;
  try {
    return { ...DEFAULT_PARKING, ...(JSON.parse(row.value) as Partial<ParkingSettings>) };
  } catch {
    return DEFAULT_PARKING;
  }
}

export async function saveParkingSettings(next: ParkingSettings, actorId: number) {
  const before = await getParkingSettings();
  await sequelize.transaction(async (transaction) => {
    await AppSetting.upsert({ key: KEY, value: JSON.stringify(next) }, { transaction });
    await ShiftChangeLog.create({ actorId, target: 'Pengaturan parkir', before, after: next }, { transaction });
  });
}

/** Pendapatan seharusnya = karcis terpakai × tarif. */
export const revenueOf = (ticketCar: number, ticketMotor: number, rateCar: number, rateMotor: number) =>
  ticketCar * rateCar + ticketMotor * rateMotor;

export interface CountRow {
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
}

/**
 * Selisih karcis per jenis: jumlah kendaraan (masuk atau keluar, sesuai titik penerbitan karcis)
 * dikurangi karcis terpakai. Positif = ada kendaraan tanpa karcis; negatif = karcis lebih banyak.
 */
export function mismatchOf(r: CountRow, ticketAt: ParkingSettings['ticketAt']) {
  const car = (ticketAt === 'MASUK' ? r.carIn : r.carOut) - r.ticketCar;
  const motor = (ticketAt === 'MASUK' ? r.motorIn : r.motorOut) - r.ticketMotor;
  return { car, motor, any: car !== 0 || motor !== 0 };
}

const sum = (rows: CountRow[], k: keyof Omit<CountRow, 'post'>) => rows.reduce((a, r) => a + (r[k] as number), 0);

/** Ringkasan satu hari: total, blok 3 jam (SOP 6.1), per pos, dan perkiraan lot terisi per jam. */
export function summarizeDay(rows: CountRow[], s: ParkingSettings) {
  const totals = {
    carIn: sum(rows, 'carIn'),
    motorIn: sum(rows, 'motorIn'),
    carOut: sum(rows, 'carOut'),
    motorOut: sum(rows, 'motorOut'),
    ticketCar: sum(rows, 'ticketCar'),
    ticketMotor: sum(rows, 'ticketMotor'),
    revenue: rows.reduce((a, r) => a + revenueOf(r.ticketCar, r.ticketMotor, r.rateCar, r.rateMotor), 0),
  };
  const mismatch = mismatchOf({ hour: 0, post: null, ...totals, rateCar: 0, rateMotor: 0 }, s.ticketAt);

  // Perkiraan kendaraan di dalam area = kumulatif masuk − keluar sejak awal hari (tidak pernah < 0)
  const hours = [...new Set(rows.map((r) => r.hour))].sort((a, b) => a - b);
  let carInside = 0;
  let motorInside = 0;
  const hourly = hours.map((hour) => {
    const h = rows.filter((r) => r.hour === hour);
    carInside = Math.max(0, carInside + sum(h, 'carIn') - sum(h, 'carOut'));
    motorInside = Math.max(0, motorInside + sum(h, 'motorIn') - sum(h, 'motorOut'));
    return {
      hour,
      carIn: sum(h, 'carIn'),
      motorIn: sum(h, 'motorIn'),
      carOut: sum(h, 'carOut'),
      motorOut: sum(h, 'motorOut'),
      ticketCar: sum(h, 'ticketCar'),
      ticketMotor: sum(h, 'ticketMotor'),
      carInside,
      motorInside,
      carFree: Math.max(0, s.carLots - carInside),
      motorFree: Math.max(0, s.motorLots - motorInside),
    };
  });

  // Blok 3 jam untuk laporan kondisi parkir (mis. 08–11, 11–14, …), mulai dari jam laporan pertama
  const blocks: { from: number; to: number; carIn: number; motorIn: number; carOut: number; motorOut: number; carFree: number; motorFree: number }[] = [];
  if (hours.length) {
    for (let from = hours[0]; from <= hours[hours.length - 1]; from += 3) {
      const inBlock = hourly.filter((h) => h.hour >= from && h.hour < from + 3);
      if (!inBlock.length) continue;
      const last = inBlock[inBlock.length - 1];
      blocks.push({
        from,
        to: Math.min(24, from + 3),
        carIn: inBlock.reduce((a, h) => a + h.carIn, 0),
        motorIn: inBlock.reduce((a, h) => a + h.motorIn, 0),
        carOut: inBlock.reduce((a, h) => a + h.carOut, 0),
        motorOut: inBlock.reduce((a, h) => a + h.motorOut, 0),
        carFree: last.carFree,
        motorFree: last.motorFree,
      });
    }
  }

  const posts = [...new Set(rows.map((r) => r.post ?? '—'))].sort();
  const perPost = posts.map((post) => {
    const p = rows.filter((r) => (r.post ?? '—') === post);
    return {
      post,
      carIn: sum(p, 'carIn'),
      motorIn: sum(p, 'motorIn'),
      ticketCar: sum(p, 'ticketCar'),
      ticketMotor: sum(p, 'ticketMotor'),
      revenue: p.reduce((a, r) => a + revenueOf(r.ticketCar, r.ticketMotor, r.rateCar, r.rateMotor), 0),
    };
  });

  return { totals, mismatch, hourly, blocks, perPost };
}

/** Jam-jam laporan yang wajib diisi petugas: dari jam mulai shift sampai jam yang sudah lewat. */
export function expectedHours(startTime: string, endTime: string, nowMinutes: number): number[] {
  const start = Number(startTime.slice(0, 2));
  const end = Number(endTime.slice(0, 2)) + (endTime.slice(3, 5) !== '00' ? 1 : 0);
  const out: number[] = [];
  // Laporan jam H wajib bila jam H sudah selesai (sekarang ≥ H+1:00)
  for (let h = start; h < end; h++) if (nowMinutes >= (h + 1) * 60) out.push(h);
  return out;
}
