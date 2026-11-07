# Deploy SMC-FaceAttend ke VPS (Ubuntu 24.04 + Nginx)

Target: `https://absensiparkirsmcsorong.pro` di VPS `72.60.232.3`.

```
Internet ──HTTPS──▶ Nginx :443 ──┬── /        → frontend/dist (file statis React)
                                 └── /api/    → backend Node.js 127.0.0.1:4000 ──▶ MySQL (lokal)
                                                                   └──▶ face-service Python 127.0.0.1:8001
```

Hanya port 22 (SSH), 80, dan 443 yang dibuka firewall. Backend, face-service, dan MySQL tidak bisa diakses dari luar.

## 1. Arahkan domain ke VPS (di panel penyedia domain)

| Tipe | Nama | Nilai |
|---|---|---|
| A | `@` | `72.60.232.3` |
| A | `www` | `72.60.232.3` |

Cek dari PC (tunggu sampai muncul `72.60.232.3`, bisa 5 menit sampai beberapa jam):

```
nslookup absensiparkirsmcsorong.pro
```

## 2. Clone repo ke VPS

```bash
ssh root@72.60.232.3
git clone https://github.com/Dolfis123/absensi-face-detection-smc.git /var/www/smc
```

Bila repo **private**, GitHub meminta username + **Personal Access Token** (bukan password akun):
GitHub → Settings → Developer settings → Personal access tokens → Fine-grained → akses *Contents: Read-only* ke repo ini.

## 3. Jalankan setup (sekali saja, ±10–15 menit)

```bash
bash /var/www/smc/deploy/setup-server.sh
```

Skrip ini memasang Nginx, MySQL 8, Node.js 22, Python venv + OpenCV (model wajah YuNet + SFace), membuat database & user MySQL dengan password acak,
membuat `backend/.env`, build backend & frontend, menyalakan service systemd, Nginx, firewall, dan backup harian.

Di tengah jalan skrip menanyakan data **Super Admin**. Isi dengan benar: akun ini permanen dan passwordnya tidak bisa diganti.

## 4. Pasang HTTPS (wajib, kamera & GPS di HP hanya jalan lewat HTTPS)

```bash
certbot --nginx -d absensiparkirsmcsorong.pro -d www.absensiparkirsmcsorong.pro --redirect
```

Certbot meminta email dan persetujuan syarat Let's Encrypt, lalu memperpanjang sertifikat otomatis.

## 5. Selesai — langkah pertama di aplikasi

1. Buka `https://absensiparkirsmcsorong.pro` → **Login** sebagai Super Admin.
2. **Geofence Pos**: berdiri di titik pos parkir, ambil lokasi, simpan (koordinat awal masih contoh).
3. **Pengaturan Shift**, **Data Pengguna** (+ wajah), **Roster Shift**, **Hari Libur** — lihat Buku Panduan.

## Update setelah ada perubahan kode

Di PC: commit & push ke GitHub. Lalu di VPS:

```bash
bash /var/www/smc/deploy/update.sh
```

Skrip ini membackup database dulu, menarik kode terbaru, build ulang, lalu me-restart service.

## Perintah berguna

| Keperluan | Perintah |
|---|---|
| Status service | `systemctl status smc-backend smc-face nginx mysql` |
| Log backend (live) | `journalctl -u smc-backend -f` |
| Log face-service | `journalctl -u smc-face -f` |
| Restart aplikasi | `systemctl restart smc-face smc-backend` |
| Backup manual | `bash /var/www/smc/deploy/backup-db.sh` (hasil di `/var/backups/smc`) |
| Restore database | `gunzip < /var/backups/smc/db-XXXX.sql.gz \| mysql smc_faceattend` |
| Cek kesehatan | `curl 127.0.0.1:4000/api/health` dan `curl 127.0.0.1:8001/health` |

## Memindahkan data dari laptop (opsional)

Bila karyawan & wajah sudah didaftarkan di laptop dan ingin dibawa ke server, lakukan **sebelum** login pertama di server:

1. Di laptop (phpMyAdmin XAMPP) → database `smc_faceattend` → Export → SQL.
2. Upload: `scp smc_faceattend.sql root@72.60.232.3:/root/`
3. Di VPS:
   ```bash
   systemctl stop smc-backend
   mysql -e "DROP DATABASE smc_faceattend; CREATE DATABASE smc_faceattend CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
   mysql smc_faceattend < /root/smc_faceattend.sql
   systemctl start smc-backend
   ```
   Super Admin yang dipakai adalah yang ada di data laptop (bukan yang diisi saat setup).

## Keamanan yang disarankan

- Login SSH memakai **SSH key**, lalu matikan login password (`PasswordAuthentication no` di `/etc/ssh/sshd_config`).
- Jalankan `apt upgrade` secara berkala; ada 30 update tertunda di VPS saat ini.
- Aktifkan **backup luar server** (bagian di bawah) supaya data tidak hilang bila VPS rusak.

## Backup luar server (Google Drive) — wajib

Backup harian lokal hanya disimpan di VPS yang sama. Bila VPS rusak/diretas, **data wajah semua karyawan** ikut hilang.
Skrip berikut mengirim salinan **terenkripsi** (AES-256) ke Google Drive setiap hari dan menguji pemulihannya tiap bulan.

### Pemasangan (sekali saja)

1. **Di PC Anda** (perlu browser): pasang rclone dari https://rclone.org/downloads/ lalu siapkan Command Prompt — dipakai di langkah 3.
2. **Di VPS**:
   ```bash
   bash /var/www/smc/deploy/setup-backup-offsite.sh
   ```
3. Skrip menampilkan **KUNCI BACKUP** → simpan di tempat aman di luar server (kertas, password manager, flashdisk).
   **Tanpa kunci ini backup tidak bisa dibuka.**
4. Skrip membuka `rclone config` → buat remote bernama `smc-gdrive`, jenis `drive`, scope `3` (drive.file),
   pilih **n** pada "Use web browser", lalu jalankan perintah `rclone authorize "drive" "…"` yang ditampilkan **di PC Anda**,
   login akun Google pemilik backup, dan tempel token yang muncul ke VPS.
5. Skrip mengirim backup pertama dan langsung menguji pemulihannya. Selesai bila muncul **UJI PEMULIHAN BERHASIL**.

### Sehari-hari

| Keperluan | Perintah |
|---|---|
| Hasil backup & uji pulih terakhir | `cat /var/lib/smc/*.status` |
| Log backup | `tail -50 /var/log/smc-backup.log` |
| Uji pemulihan manual | `bash /var/www/smc/deploy/restore-test.sh` |
| Lihat backup di Google Drive | `bash /var/www/smc/deploy/restore-offsite.sh` |

- Jadwal: backup tiap hari 02:30 WIT (lokal 14 hari, Google Drive 90 hari di folder `SMC-Backup/<tahun-bulan>`); uji pemulihan tanggal 1 tiap bulan.
- `update.sh` juga membackup (termasuk ke Google Drive) sebelum memperbarui aplikasi. Bila Google Drive sedang tidak bisa dihubungi, backup lokal tetap jalan dan update tidak terhenti.
- Uji pemulihan memakai database terpisah (`smc_restore_test`) yang langsung dihapus — data asli tidak disentuh.

### Pemulihan darurat (server baru)

1. Siapkan VPS baru dengan `setup-server.sh` seperti biasa.
2. Salin kunci backup: `mkdir -p /etc/smc && nano /etc/smc/backup.key` (tempel kunci, simpan), lalu `chmod 600 /etc/smc/backup.key`.
3. `bash /var/www/smc/deploy/setup-backup-offsite.sh` — sambungkan Google Drive lagi. Skrip mendeteksi server masih kosong dan **tidak** mengirim backup kosong.
4. `bash /var/www/smc/deploy/restore-offsite.sh terbaru` → ketik `PULIHKAN`. Database (termasuk data wajah) dan file upload kembali.
5. Jalankan `setup-backup-offsite.sh` sekali lagi untuk menyalakan backup harian.

Membuka backup langsung di PC (Git Bash), mis. untuk arsip:
```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:backup.key -in db-XXXX.sql.gz.enc -out db-XXXX.sql.gz
```

