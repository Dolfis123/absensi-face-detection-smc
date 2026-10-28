export type Embedding = number[];

/**
 * Jarak cosine (1 - cosine similarity) dua face embedding SFace, sama dengan face-service.
 * 0 = identik; orang yang sama umumnya < 0.5; orang berbeda umumnya > 0.7.
 */
export function faceDistance(a: Embedding, b: Embedding): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return 1 - dot / (Math.sqrt(na * nb) || 1);
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

// Panduan membaca jarak antar dua orang BERBEDA (model SFace, jarak cosine)
export const DISTANCE_DANGER = 0.4; // kemungkinan orang yang sama / sangat mirip → pendaftaran butuh persetujuan
export const DISTANCE_WARN = 0.55; // cukup mirip → beri peringatan
