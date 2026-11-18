import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

export type StableCapture = { ok: true; image: string } | { ok: false; reason: string };

export interface CameraHandle {
  /** Mengambil frame saat ini sebagai data URL JPEG. */
  capture: () => string | null;
  /**
   * Mengambil beberapa frame berturut-turut (±0,7 detik), menolak bila kamera/wajah bergerak
   * atau terlalu gelap, lalu mengembalikan frame paling tajam.
   */
  captureStable: () => Promise<StableCapture>;
}

const BURST = 6;
const BURST_GAP_MS = 110;
// Rata-rata perubahan piksel antar-frame (0–255). Noise kamera biasa ±1–3.
const MAX_MOTION = 7;
const MIN_LUMA = 35;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ambil area tengah (tempat oval wajah) sebagai grayscale kecil untuk analisis cepat. */
function centerGray(source: HTMLCanvasElement, probe: HTMLCanvasElement): Float32Array {
  const w = (probe.width = 96);
  const h = (probe.height = 128);
  const ctx = probe.getContext('2d', { willReadFrequently: true })!;
  const sw = source.width * 0.6;
  const sh = source.height * 0.65;
  ctx.drawImage(source, (source.width - sw) / 2, (source.height - sh) / 2, sw, sh, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  return out;
}

/** Varians Laplacian: makin besar makin tajam. */
function sharpness(g: Float32Array, w = 96, h = 128) {
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = g[i - 1] + g[i + 1] + g[i - w] + g[i + w] - 4 * g[i];
      sum += lap;
      sum2 += lap * lap;
      n++;
    }
  }
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

const meanAbsDiff = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
};
const mean = (a: Float32Array) => a.reduce((s, v) => s + v, 0) / a.length;

/** Pratinjau kamera depan dengan panduan oval posisi wajah. */
export const Camera = forwardRef<CameraHandle, { className?: string }>(function Camera({ className }, ref) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Browser tidak mendukung kamera. Gunakan Chrome/Safari terbaru melalui HTTPS.');
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 1280 } }, audio: false })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        if (videoRef.current) videoRef.current.srcObject = s;
      })
      .catch(() => setError('Izin kamera ditolak atau kamera tidak tersedia. Aktifkan izin kamera di pengaturan browser.'));
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const grab = useCallback((): HTMLCanvasElement | null => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return null;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')!.drawImage(video, 0, 0);
    return canvas;
  }, []);

  const capture = useCallback(() => grab()?.toDataURL('image/jpeg', 0.9) ?? null, [grab]);

  const captureStable = useCallback(async (): Promise<StableCapture> => {
    setBusy(true);
    try {
      const probe = document.createElement('canvas');
      const frames: { canvas: HTMLCanvasElement; gray: Float32Array; sharp: number }[] = [];
      for (let i = 0; i < BURST; i++) {
        const canvas = grab();
        if (!canvas) return { ok: false, reason: 'Kamera belum siap' };
        const gray = centerGray(canvas, probe);
        frames.push({ canvas, gray, sharp: sharpness(gray) });
        if (i < BURST - 1) await sleep(BURST_GAP_MS);
      }
      const motion = Math.max(...frames.slice(1).map((f, i) => meanAbsDiff(f.gray, frames[i].gray)));
      if (motion > MAX_MOTION) return { ok: false, reason: 'Kamera atau wajah bergerak. Tahan HP dan kepala tetap diam, lalu coba lagi.' };
      const best = frames.reduce((a, b) => (b.sharp > a.sharp ? b : a));
      if (mean(best.gray) < MIN_LUMA) return { ok: false, reason: 'Terlalu gelap. Cari tempat yang lebih terang atau nyalakan lampu.' };
      return { ok: true, image: best.canvas.toDataURL('image/jpeg', 0.9) };
    } finally {
      setBusy(false);
    }
  }, [grab]);

  useImperativeHandle(ref, () => ({ capture, captureStable }), [capture, captureStable]);

  return (
    <div className={`relative overflow-hidden rounded-2xl bg-slate-900 ${className ?? ''}`}>
      {error ? (
        <div className="flex aspect-[3/4] items-center justify-center p-6 text-center text-sm text-rose-200">{error}</div>
      ) : (
        <>
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            onLoadedData={() => setReady(true)}
            className="aspect-[3/4] w-full -scale-x-100 object-cover"
          />
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div
              className={`h-[62%] w-[58%] rounded-[50%] border-4 shadow-[0_0_0_9999px_rgba(15,23,42,0.45)] transition ${
                busy ? 'border-emerald-400' : 'border-white/70'
              }`}
            />
          </div>
          {busy && (
            <div className="absolute inset-x-0 bottom-3 text-center text-sm font-semibold text-white drop-shadow">Tahan diam… memotret</div>
          )}
          {!ready && <div className="absolute inset-0 flex items-center justify-center text-sm text-white">Menyalakan kamera…</div>}
        </>
      )}
    </div>
  );
});
