export type Embedding = number[];

/** Jarak Euclidean dua face embedding (sama dengan face_recognition.face_distance). */
export function faceDistance(a: Embedding, b: Embedding): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

/** Jarak terdekat antara dua kumpulan foto (orang A vs orang B). */
export function minDistance(a: Embedding[], b: Embedding[]): number {
  let best = Infinity;
  for (const x of a) for (const y of b) best = Math.min(best, faceDistance(x, y));
  return best;
}

/** Jarak terjauh antar-foto milik satu orang (makin kecil makin konsisten). */
export function spread(set: Embedding[]): number {
  let worst = 0;
  for (let i = 0; i < set.length; i++) for (let j = i + 1; j < set.length; j++) worst = Math.max(worst, faceDistance(set[i], set[j]));
  return worst;
}

// Panduan membaca jarak antar dua orang BERBEDA (model dlib, toleransi absen 0.45)
export const DISTANCE_DANGER = 0.5; // bisa tertukar → pendaftaran ditolak
export const DISTANCE_WARN = 0.6; // cukup mirip → beri peringatan
