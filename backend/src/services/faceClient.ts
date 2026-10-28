import { env } from '../config/env';
import { HttpError } from '../utils/http';

/** Klien HTTP ke Python face-service (face_recognition). */
async function call<T>(endpoint: string, body: unknown, timeoutMs = 20_000): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${env.faceServiceUrl}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new HttpError(503, 'Layanan pengenalan wajah tidak dapat dihubungi');
  }
  const data = (await res.json().catch(() => ({}))) as { detail?: string } & T;
  if (!res.ok) {
    throw new HttpError(res.status === 422 ? 422 : 502, data.detail ?? 'Gagal memproses wajah');
  }
  return data;
}

export interface FaceQuality {
  sharpness: number;
  brightness: number;
  contrast: number;
  yaw: number;
}

export interface EnrollResult {
  model: string;
  embeddings: number[][];
  spread: number; // jarak terjauh antar-foto orang yang sama
  quality: FaceQuality[];
}

/**
 * Pendaftaran wajah dari 3–5 foto. Face-service menolak foto buram/gelap/menyamping
 * dan foto yang tidak konsisten satu sama lain. Jitter tinggi → butuh waktu lebih lama.
 */
export function enrollFaces(images: string[]): Promise<EnrollResult> {
  return call<EnrollResult>('/enroll', { images }, 120_000);
}

export interface FaceCandidate {
  id: number;
  embeddings: number[][];
}

/** Peringkat karyawan terdekat dengan wajah live (maks. 5). Keputusan akhir di services/identity.ts. */
export async function rankFaces(image: string, candidates: FaceCandidate[]): Promise<{ id: number; distance: number }[]> {
  const result = await call<{ ranked: { id: number; distance: number }[] }>('/identify', { image, candidates });
  return result.ranked;
}
