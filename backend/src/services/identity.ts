import bcrypt from 'bcryptjs';
import { Op } from 'sequelize';
import { User } from '../models';
import { HttpError } from '../utils/http';

export interface Ranked {
  id: number;
  distance: number;
}

// Dua kandidat dengan selisih jarak (cosine) di bawah ini dianggap tidak bisa dibedakan dari wajah saja
export const AMBIGUITY_MARGIN = 0.08;
// Karyawan ber-PIN tetap dianggap kandidat sedikit di atas toleransi, karena PIN yang memastikan
export const PIN_POOL_MARGIN = 0.1;

export type IdentityDecision =
  | { kind: 'match'; id: number; distance: number }
  | { kind: 'pin'; pool: Ranked[] } // wajah cocok dengan karyawan ber-PIN → minta PIN
  | { kind: 'ambiguous' } // mirip beberapa karyawan, tidak ada yang ber-PIN
  | { kind: 'unknown' };

/**
 * Menentukan siapa yang absen dari peringkat jarak wajah.
 * - Pemenang jelas & tidak ber-PIN → langsung cocok.
 * - Pemenang ber-PIN, atau ambigu dengan karyawan ber-PIN → verifikasi PIN di antara karyawan ber-PIN terdekat.
 * - Ambigu tanpa PIN → tolak (lebih baik ditolak daripada salah catat orang).
 */
export function decideIdentity(ranked: Ranked[], pinUserIds: Set<number>, tolerance: number): IdentityDecision {
  const [best, second] = ranked;
  if (!best) return { kind: 'unknown' };
  const pinPool = ranked.filter((r) => pinUserIds.has(r.id) && r.distance <= tolerance + PIN_POOL_MARGIN);
  const clear = best.distance <= tolerance && !(second && second.distance - best.distance < AMBIGUITY_MARGIN);

  if (clear && !pinUserIds.has(best.id)) return { kind: 'match', id: best.id, distance: best.distance };
  if (pinPool.length > 0 && (best.distance <= tolerance || pinUserIds.has(best.id))) return { kind: 'pin', pool: pinPool };
  if (best.distance <= tolerance) return { kind: 'ambiguous' };
  return { kind: 'unknown' };
}

export const PIN_RE = /^\d{4,6}$/;
export const hashPin = (pin: string) => bcrypt.hash(pin, 10);

/** PIN harus unik, supaya PIN selalu menunjuk satu orang. */
export async function assertPinAvailable(pin: string, excludeUserIds: number[]) {
  const others = await User.findAll({
    where: { pinHash: { [Op.ne]: null }, ...(excludeUserIds.length ? { id: { [Op.notIn]: excludeUserIds } } : {}) },
  });
  for (const u of others) {
    if (u.pinHash && (await bcrypt.compare(pin, u.pinHash))) {
      throw new HttpError(409, 'PIN ini sudah dipakai karyawan lain. Pilih PIN yang berbeda.');
    }
  }
}

/** Karyawan di `pool` yang PIN-nya cocok, atau null. */
export async function matchPin(pin: string, pool: User[]): Promise<User | null> {
  for (const u of pool) {
    if (u.pinHash && (await bcrypt.compare(pin, u.pinHash))) return u;
  }
  return null;
}
