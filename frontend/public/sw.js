// Service worker SMC-FaceAttend: membuat aplikasi bisa dipasang di layar HP (PWA).
// Sengaja TIDAK menyimpan cache file aplikasi maupun data API, supaya selalu memakai versi terbaru
// setelah update di server. Hanya menampilkan halaman "tidak ada internet" bila HP sedang offline.
const OFFLINE_HTML = `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tidak ada internet</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0c2b52;color:#fff;font-family:system-ui,sans-serif;text-align:center;padding:24px}
button{margin-top:16px;padding:12px 20px;border:0;border-radius:12px;background:#fff;color:#0c2b52;font-weight:700;font-size:15px}</style></head>
<body><div><div style="font-size:42px">📶</div><h2 style="margin:8px 0">Tidak ada koneksi internet</h2>
<p style="opacity:.8;margin:0">Absensi membutuhkan internet. Nyalakan data seluler / Wi-Fi lalu coba lagi.</p>
<button onclick="location.reload()">Coba lagi</button></div></body></html>`;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return; // file & API langsung ke server seperti biasa
  event.respondWith(
    fetch(event.request).catch(() => new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })),
  );
});
