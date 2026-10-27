import { env } from '../config/env';
import { parseEmbeddings, User } from '../models';
import { DISTANCE_WARN, minDistance } from '../utils/faceMath';
import { HttpError } from '../utils/http';
import { enrollFaces, EnrollResult } from './faceClient';

export interface EnrollOutcome extends EnrollResult {
  /** Peringatan non-fatal: wajah cukup mirip dengan karyawan lain. */
  warning: string | null;
}

/**
 * Ekstraksi wajah + cek wajah ganda terhadap SEMUA karyawan (termasuk yang nonaktif,
 * agar orang yang sama tidak bisa didaftarkan ulang dengan akun berbeda).
 */
export async function enrollWithDuplicateCheck(images: string[], excludeUserId?: number): Promise<EnrollOutcome> {
  const result = await enrollFaces(images);

  const others = await User.findAll({ where: { role: 'KARYAWAN' } });
  let nearest: { user: User; distance: number } | null = null;
  for (const other of others) {
    if (other.id === excludeUserId) continue;
    const known = parseEmbeddings(other.faceEmbedding);
    if (!known) continue;
    const distance = minDistance(result.embeddings, known);
    if (!nearest || distance < nearest.distance) nearest = { user: other, distance };
  }

  if (nearest && nearest.distance < env.faceDuplicateThreshold) {
    const { user, distance } = nearest;
    throw new HttpError(
      409,
      `Wajah ini sangat mirip dengan ${user.fullName} (NIK ${user.nik}, jarak ${distance.toFixed(2)}). ` +
        `Kemungkinan orang yang sama sudah terdaftar${user.isActive ? '' : ' (akun nonaktif)'}, ` +
        'atau keduanya terlalu mirip sehingga rawan tertukar saat absen.',
    );
  }

  const warning =
    nearest && nearest.distance < DISTANCE_WARN
      ? `Perhatian: wajah cukup mirip dengan ${nearest.user.fullName} (jarak ${nearest.distance.toFixed(2)}). ` +
        'Pantau apakah keduanya sering gagal absen.'
      : null;
  return { ...result, warning };
}
