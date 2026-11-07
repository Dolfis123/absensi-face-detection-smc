#!/usr/bin/env bash
# Pasang backup luar server (Google Drive) — SEKALI SAJA, sebagai root:
#   bash /var/www/smc/deploy/setup-backup-offsite.sh
# Aman dijalankan ulang. Kunci enkripsi yang sudah ada TIDAK pernah diganti.
set -euo pipefail
source "$(dirname "$0")/backup-lib.sh"

step() { echo -e "\n\033[1;34m==> $*\033[0m"; }
die() { echo -e "\033[1;31m$*\033[0m" >&2; exit 1; }
[[ $EUID -eq 0 || -n "${SMC_TEST:-}" ]] || die "Jalankan sebagai root."
CRON_DIR="${CRON_DIR:-/etc/cron.d}"
REMOTE_NAME="${RCLONE_REMOTE%%:*}"

step "1/5 Pasang rclone & openssl"
command -v rclone >/dev/null || { apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y rclone; }
command -v openssl >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y openssl
rclone version 2>/dev/null | sed -n 1p || true

step "2/5 Kunci enkripsi backup"
mkdir -p "$SMC_ETC" && chmod 700 "$SMC_ETC"
NEW_KEY=0
if [[ ! -s "$BACKUP_KEY" ]]; then
  ( umask 077; openssl rand -base64 36 | tr -d '\n' > "$BACKUP_KEY" )
  NEW_KEY=1
fi
chmod 600 "$BACKUP_KEY"
[[ -f "$BACKUP_CONF" ]] || cat > "$BACKUP_CONF" <<EOF
# Tujuan backup luar server (nama remote rclone:folder) dan lama penyimpanan di sana
RCLONE_REMOTE="$RCLONE_REMOTE"
KEEP_REMOTE_DAYS=$KEEP_REMOTE_DAYS
EOF
chmod 600 "$BACKUP_CONF"
if (( NEW_KEY )); then
  echo -e "\033[1;33m"
  echo "  ┌──────────────────────────────────────────────────────────────────┐"
  echo "  │  KUNCI BACKUP — SIMPAN DI TEMPAT AMAN DI LUAR SERVER INI         │"
  echo "  │  (catat di kertas / password manager / flashdisk).               │"
  echo "  │  Tanpa kunci ini, backup di Google Drive TIDAK BISA DIBUKA       │"
  echo "  │  bila server rusak.                                             │"
  echo "  └──────────────────────────────────────────────────────────────────┘"
  echo -e "\033[0m\n      $(cat "$BACKUP_KEY")\n"
  echo "  Kunci bisa dilihat lagi kapan saja: cat $BACKUP_KEY"
  read -r -p "  Tekan Enter setelah kunci disimpan… " _
else
  echo "Kunci sudah ada di $BACKUP_KEY (tidak diubah)."
fi

step "3/5 Sambungan Google Drive (remote rclone '$REMOTE_NAME')"
if ! rclone listremotes | grep -x "$REMOTE_NAME:" >/dev/null; then
  cat <<EOF
Remote '$REMOTE_NAME' belum ada. Buat sekarang (ikuti langkah ini):
  n  (New remote)  → name: $REMOTE_NAME
  Storage          → pilih "drive" (Google Drive)
  client_id / client_secret → kosongkan (Enter)
  scope            → 3  (drive.file: rclone hanya bisa melihat berkas buatannya sendiri)
  service_account_file → kosongkan
  Edit advanced config → n
  Use web browser to automatically authenticate → n   (server tanpa browser)
     Di PC Anda (yang ada browser), pasang rclone lalu jalankan perintah yang ditampilkan,
     mis.  rclone authorize "drive" "…"  → login akun Google pemilik backup → salin token
     yang muncul, tempel di sini.
  Configure as Shared Drive → n
  Keep this remote → y   lalu  q (Quit)
EOF
  read -r -p "Tekan Enter untuk membuka rclone config… " _
  rclone config
  rclone listremotes | grep -x "$REMOTE_NAME:" >/dev/null || die "Remote '$REMOTE_NAME' belum dibuat. Jalankan ulang skrip ini."
fi
rclone mkdir "$RCLONE_REMOTE"
echo "tes $(date)" > /tmp/smc-backup-tes.txt
rclone copyto /tmp/smc-backup-tes.txt "$RCLONE_REMOTE/.tes-sambungan.txt"
rclone deletefile "$RCLONE_REMOTE/.tes-sambungan.txt"
rm -f /tmp/smc-backup-tes.txt
echo "Sambungan ke $RCLONE_REMOTE OK."

# Server baru untuk pemulihan (database kosong) sementara Google Drive sudah berisi backup:
# JANGAN kirim backup kosong (akan menjadi "terbaru"); langsung arahkan ke pemulihan.
LOCAL_FACES=$(mysql -N -B -e "SELECT COUNT(*) FROM users WHERE face_embedding IS NOT NULL AND face_embedding <> ''" "$DB_NAME" 2>/dev/null || echo 0)
REMOTE_DBS=$(rclone lsf "$RCLONE_REMOTE" -R --files-only 2>/dev/null | grep -c '/db-.*\.sql\.gz\.enc$' || true)
if [[ "${LOCAL_FACES:-0}" == 0 && "${REMOTE_DBS:-0}" -gt 0 ]]; then
  echo -e "
[1;33mDatabase server ini belum berisi data wajah, sedangkan Google Drive sudah berisi $REMOTE_DBS backup.[0m"
  echo "Backup TIDAK dikirim supaya backup lama tidak tertimpa data kosong. Untuk memulihkan data:"
  echo "  bash $APP_DIR/deploy/restore-offsite.sh          (lihat daftar)"
  echo "  bash $APP_DIR/deploy/restore-offsite.sh terbaru  (pulihkan yang terbaru)"
  echo "Setelah pulih, jalankan skrip ini sekali lagi untuk mengaktifkan backup & uji bulanan."
  exit 0
fi

step "4/5 Backup pertama ke Google Drive"
bash "$APP_DIR/deploy/backup-db.sh"
grep -q '^ok|' "$STATUS_DIR/backup.status" || die "Backup pertama gagal — lihat pesan di atas."
grep -q 'luar server' "$STATUS_DIR/backup.status" || die "Backup luar server belum berjalan."

step "5/5 Jadwal uji pemulihan (tanggal 1 tiap bulan, 03:30 WIT) & uji pertama"
chmod +x "$APP_DIR"/deploy/*.sh
TZ_OFFSET_H=$(( $(date +%z | sed 's/^\([+-]\)0*\([0-9]*\)[0-9][0-9]$/\1\2/') + 0 ))
TEST_HOUR=$(( (3 - 9 + TZ_OFFSET_H + 24) % 24 ))
# 03:30 WIT jatuh pada hari sebelumnya bila server UTC; tetap tanggal 1 waktu server (cukup sebulan sekali)
echo "30 $TEST_HOUR 1 * * root bash $APP_DIR/deploy/restore-test.sh >> /var/log/smc-backup.log 2>&1" > "$CRON_DIR/smc-restore-test"
bash "$APP_DIR/deploy/restore-test.sh"

echo -e "\n\033[1;32mBackup luar server aktif.\033[0m"
cat <<EOF
- Backup harian otomatis: lokal 14 hari + Google Drive ($RCLONE_REMOTE) $KEEP_REMOTE_DAYS hari, terenkripsi.
- Uji pemulihan otomatis tiap tanggal 1. Cek hasil terakhir:  cat $STATUS_DIR/*.status
- Log:  tail -50 /var/log/smc-backup.log
- Pemulihan darurat (VPS baru): pasang aplikasi, salin kunci ke $BACKUP_KEY, jalankan skrip ini,
  lalu:  bash $APP_DIR/deploy/restore-offsite.sh terbaru
EOF
