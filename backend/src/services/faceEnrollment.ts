import { env } from '../config/env';
import { parseEmbeddings, User } from '../models';
import { DISTANCE_WARN, minDistance } from '../utils/faceMath';
import { HttpError } from '../utils/http';
import { enrollFaces, EnrollResult } from './faceClient';

export interface SimilarFace {
  user: User;
  distance: number;
}

export interface EnrollOutcome extends EnrollResult {
  /** Peringatan non-fatal: wajah cukup mirip dengan karyawan lain. */
  warning: string | null;
  /** Karyawan lain yang wajahnya di bawah ambang wajah ganda (hanya terisi bila allowSimilar). */
  similar: SimilarFace[];
}

/**
 * Ekstraksi wajah + cek wajah ganda terhadap SEMUA karyawan (termasuk yang nonaktif,
 * agar orang yang sama tidak bisa didaftarkan ulang dengan akun berbeda).
 * allowSimilar = Super Admin sudah memastikan ini orang berbeda (mis. saudara); pemanggil
 * wajib memasang PIN untuk semua karyawan di `similar`.
 */
export async function enrollWithDuplicateCheck(
  images: string[],
  excludeUserId?: number,
  allowSimilar = false,
): Promise<EnrollOutcome> {
  const result = await enrollFaces(images);

  const scored: SimilarFace[] = [];
  for (const other of await User.findAll({ where: { role: 'KARYAWAN' } })) {
    if (other.id === excludeUserId) continue;
    const known = parseEmbeddings(other.faceEmbedding);
    if (known) scored.push({ user: other, distance: minDistance(result.embeddings, known) });
  }
  scored.sort((a, b) => a.distance - b.distance);
  const similar = scored.filter((s) => s.distance < env.faceDuplicateThreshold);

  if (similar.length > 0 && !allowSimilar) {
    const { user, distance } = similar[0];
    throw new HttpError(
      409,
      `Wajah ini sangat mirip dengan ${user.fullName} (NIK ${user.nik}, jarak ${distance.toFixed(2)}). ` +
        `Bila memang orang yang sama${user.isActive ? '' : ' (akun nonaktif)'}, jangan didaftarkan ulang. ` +
        'Bila orang berbeda (mis. saudara), Super Admin dapat tetap mendaftarkan dengan PIN absen.',
      {
        code: 'FACE_SIMILAR',
        similar: similar.map((s) => ({
          id: s.user.id,
          fullName: s.user.fullName,
          nik: s.user.nik,
          hasPin: !!s.user.pinHash,
          distance: Number(s.distance.toFixed(3)),
        })),
      },
    );
  }

  const nearest = scored[0];
  const warning =
    similar.length === 0 && nearest && nearest.distance < DISTANCE_WARN
      ? `Perhatian: wajah cukup mirip dengan ${nearest.user.fullName} (jarak ${nearest.distance.toFixed(2)}). ` +
        'Pantau apakah keduanya sering gagal absen; bila ya, pasang PIN absen untuk keduanya.'
      : null;
  return { ...result, warning, similar };
}
