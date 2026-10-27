import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

export interface CameraHandle {
  /** Mengambil frame saat ini sebagai data URL JPEG. */
  capture: () => string | null;
}

/** Pratinjau kamera depan dengan panduan oval posisi wajah. */
export const Camera = forwardRef<CameraHandle, { className?: string }>(function Camera({ className }, ref) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Browser tidak mendukung kamera. Gunakan Chrome/Safari terbaru melalui HTTPS.');
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 960 } }, audio: false })
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

  const capture = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return null;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')!.drawImage(video, 0, 0);
    return canvas.toDataURL('image/jpeg', 0.85);
  }, []);

  useImperativeHandle(ref, () => ({ capture }), [capture]);

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
            <div className="h-[62%] w-[58%] rounded-[50%] border-4 border-white/70 shadow-[0_0_0_9999px_rgba(15,23,42,0.45)]" />
          </div>
          {!ready && <div className="absolute inset-0 flex items-center justify-center text-sm text-white">Menyalakan kamera…</div>}
        </>
      )}
    </div>
  );
});
