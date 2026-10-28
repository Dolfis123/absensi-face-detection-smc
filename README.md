# SMC-FaceAttend

Sistem Absensi Wajah & Geofencing — Pos Parkir Mal SMC (Sorong Mega Mall), Kota Sorong, Papua Barat Daya.

```
smc-faceattend/
├── backend/        Node.js + Express + TypeScript + Sequelize (MySQL)  → port 4000
├── face-service/   Python + FastAPI + OpenCV (YuNet + SFace)          → port 8001 (internal)
└── frontend/       React + Vite + TypeScript + Tailwind CSS           → port 5173 (HTTPS)
```

```
HP / tablet ──HTTPS──▶ frontend (Vite) ──/api──▶ backend Express ──▶ MySQL
                                                     │
                                                     └──HTTP lokal──▶ face-service (Python)
```

## 1. Menjalankan secara lokal

Prasyarat: Node.js 20+, MySQL 8, Python 3.10–3.12.

### MySQL
```sql
CREATE DATABASE smc_faceattend CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```
User MySQL yang dipakai butuh hak `TRIGGER` (untuk trigger anti-manipulasi).

### Face service
```bash
cd face-service
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python download_models.py          # sekali: model YuNet & SFace (±38 MB) ke face-service/models
.venv\Scripts\python -m uvicorn app:app --host 127.0.0.1 --port 8001
```

### Backend
```bash
cd backend
cp .env.example .env              # lalu isi DB_*, JWT_SECRET, SUPER_ADMIN_*
npm install
npm run dev
```
Saat pertama kali jalan, backend otomatis membuat tabel, trigger MySQL, Shift 1 & Shift 2 beserta jendela absennya,
**satu-satunya** akun Super Admin (dari `.env`), dan titik geofence awal (placeholder).

### Frontend
```bash
cd frontend
npm install
npm run dev
```
Buka `https://localhost:5173`. Dari HP (satu Wi-Fi): `https://<IP-laptop>:5173` lalu terima peringatan sertifikat.
Kamera & GPS di browser HP **wajib HTTPS**.

### Langkah awal setelah login Super Admin
1. **Geofence Pos** → berdiri di titik pusat pos parkir, klik *Gunakan lokasi saya sekarang*, simpan.
2. **Data Pengguna** → tambah 14 Karyawan Parkir (ambil foto wajah) & Koordinator Lapangan.
3. **Roster Shift** → isi jadwal mingguan (atau *Isi yang kosong dari shift default*), lalu atur rotasi.
4. **Hari Libur** → tandai libur nasional / mal tutup.

## 2. Aturan bisnis yang diterapkan

| Aturan | Implementasi |
|---|---|
| Landing: *Absen Sekarang* vs *Login* | `/` → `/absen` (publik, tanpa login) atau `/login` |
| Role dipilih saat pendaftaran | Super Admin memilih Karyawan Parkir / Koordinator Lapangan; role Super Admin tidak bisa dipilih |
| Super Admin hanya 1 & permanen | Hook Sequelize **dan** trigger MySQL menolak INSERT Super Admin kedua, serta UPDATE/DELETE Super Admin |
| Shift dinamis | Tabel `employee_schedules` (user × tanggal × shift); slot aktif ditentukan dari roster hari ini |
| Shift 1 (3x absen) | Masuk 07:30–08:00 · Istirahat 12:00–13:00 · Pulang 16:00–16:30 WIT |
| Shift 2 (2x absen) | Masuk 15:30–16:00 · Pulang 23:00–23:30 WIT |
| Terlambat | Absen Masuk setelah jendela tutup masih diterima sebagai *Terlambat* sampai `LATE_TOLERANCE_MINUTES` (default 120); lewat dari itu = Alfa |
| Server-side timestamp | Jam absensi selalu `new Date()` di server, dikonversi ke WIT (UTC+9); jam HP diabaikan |
| Geofencing 5 m | Haversine dihitung di server; pembacaan GPS dengan akurasi lebih buruk dari batas ditolak |
| Wajah AI | Dicocokkan dengan seluruh karyawan aktif; ditolak bila tidak ada yang cocok, >1 wajah, wajah terlalu jauh, atau dua kandidat terlalu mirip |
| Izin/Sakit/Cuti | Login → ajukan (+lampiran) → *Pending* → Koordinator/Super Admin approve/reject → status tanggal terkunci, absen hari itu ditolak |
| Hari libur | Absensi ditolak & tidak dihitung Alfa |
| Log immutable | Hook Sequelize + trigger MySQL menolak UPDATE/DELETE `attendances`; satu-satunya jalur adalah **Koreksi & Audit** Super Admin (VOID + tambah pengganti, alasan wajib, tercatat di `audit_logs` yang juga terkunci) |
| Laporan | Detail harian (Koordinator & Admin) dan rekap bulanan resmi (Admin) dalam CSV siap Excel |

## 3. Ringkasan REST API

| Method & path | Akses |
|---|---|
| `POST /api/auth/login`, `GET /api/auth/me` | publik / login |
| `GET /api/attendance/geofence`, `GET /api/attendance/time`, `POST /api/attendance/check` | publik (rate-limited) |
| `GET /api/me/recap?month=`, `GET /api/me/schedule`, `GET/POST /api/me/leaves`, `GET/POST /api/me/issues` | Karyawan |
| `GET /api/monitor/today`, `GET /api/monitor/recap?from&to`, `GET /api/reports/detail.csv` | Koordinator, Admin |
| `GET /api/leaves`, `PATCH /api/leaves/:id`, `GET /api/issues`, `PATCH /api/issues/:id` | Koordinator, Admin |
| `GET /api/reports/monthly.csv?month=` | Admin |
| `/api/admin/users`, `/api/admin/users/:id/face`, `/api/admin/schedules`, `/api/admin/schedules/fill-default`, `/api/admin/holidays`, `/api/admin/geofence`, `/api/admin/corrections`, `/api/admin/audit-logs` | Admin |
| `GET /api/shifts`, `GET /api/holidays?year=`, `GET /api/leaves/:id/attachment` | semua yang login |

## 4. Pendaftaran wajah & cek akurasi

- Setiap Karyawan Parkir didaftarkan dengan **3–5 foto** (lurus, menoleh kiri, menoleh kanan, opsional mendongak/menunduk).
  Saat absen, wajah dibandingkan dengan semua foto itu dan diambil yang paling mirip.
- Mesin wajah: **YuNet** (deteksi + 5 titik wajah, tahan kumis/jenggot & pose) dan **SFace** (embedding 128 dimensi)
  dari OpenCV Zoo, lisensi MIT/Apache-2.0. Wajah diluruskan (alignment) sebelum dikenali; jarak = jarak cosine
  (orang yang sama umumnya < 0.5, orang berbeda umumnya > 0.7).
- Kamera mengambil 6 frame berturut-turut, menolak bila kamera/wajah bergerak, lalu mengirim frame paling tajam.
- Face-service menolak foto pendaftaran yang buram, area mata terlalu gelap/silau, terlalu menyamping/mendongak/miring,
  wajah tertutup, tanpa satu pun foto lurus, atau tidak konsisten. Kecerahan diukur di area mata & dahi (bukan seluruh
  wajah) agar kumis/jenggot dan kulit gelap tidak membuat foto ditolak.
- Pendaftaran butuh persetujuan Super Admin + PIN bila wajah baru berjarak < `FACE_DUPLICATE_DISTANCE` (0.4) dari
  karyawan lain; absen cocok bila jarak ≤ `FACE_MAX_DISTANCE` (0.55).
- Data wajah dari mesin lama (dlib) ditandai **Daftar ulang** di Data Pengguna dan tidak dipakai untuk absen.
- Ambang kualitas face-service (environment variable): `FACE_MIN_SHARPNESS` (25), `FACE_MIN_BRIGHTNESS` (40),
  `FACE_MAX_BRIGHTNESS` (230), `FACE_MAX_GLARE` (0.2), `FACE_MAX_YAW` (0.5), `FACE_MAX_ROLL` (25),
  `FACE_MIN_DET_SCORE` (0.88), `FACE_MIN_PX` (90), `FACE_ENROLL_MAX_SPREAD` (0.55).
- Diagnosis data wajah yang sudah terdaftar (hanya membaca database):
  ```bash
  cd backend
  npm run check-faces
  ```

## 5. Batasan yang perlu diketahui (penting sebelum produksi)

- **Radius 5 m vs akurasi GPS.** GPS HP biasa memiliki galat ±3–15 m, apalagi di dekat gedung. Lakukan uji coba di pos;
  bila banyak penolakan, naikkan radius (mis. 10–15 m) atau batas akurasi dari menu Geofence.
- **Fake GPS tidak bisa dideteksi 100% dari browser.** Server menolak koordinat di luar radius & akurasi buruk, tetapi aplikasi
  pemalsu lokasi yang memberi koordinat "tepat di pos" tidak bisa dibedakan dari web. Mitigasi kuat: pakai satu
  **perangkat kiosk milik perusahaan** di pos (HP/tablet terkunci) — wajah tetap mencegah titip absen.
- **Belum ada liveness detection.** Mesin wajah mencocokkan wajah tetapi tidak bisa membedakan wajah asli dari foto
  di layar HP lain. Untuk mencegahnya, tambahkan cek liveness (kedip/gerak kepala, atau model anti-spoofing) di face-service.
- `sequelize.sync()` dipakai untuk kemudahan; untuk produksi gunakan migrasi (`sequelize-cli`).
- Face-service jangan dibuka ke internet; hanya backend yang memanggilnya.
- Super Admin benar-benar tidak bisa diubah, termasuk password-nya. Pilih password kuat di `.env` **sebelum** start pertama.
