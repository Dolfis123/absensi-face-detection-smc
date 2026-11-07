#!/usr/bin/env bash
# PEMULIHAN DARURAT dari backup luar server (mis. VPS baru setelah server lama rusak).
#   bash /var/www/smc/deploy/restore-offsite.sh            → daftar backup yang tersedia
#   bash /var/www/smc/deploy/restore-offsite.sh terbaru    → pulihkan backup terbaru
#   bash /var/www/smc/deploy/restore-offsite.sh 2026-11/db-20261107-023000.sql.gz.enc
# Database & folder upload yang sekarang dibackup dulu ke /var/backups/smc sebelum ditimpa.
set -euo pipefail
source "$(dirname "$0")/backup-lib.sh"

[[ $EUID -eq 0 || -n "${SMC_TEST:-}" ]] || { echo "Jalankan sebagai root." >&2; exit 1; }
offsite_enabled || { echo "Pasang dulu kunci & rclone: bash $APP_DIR/deploy/setup-backup-offsite.sh" >&2; exit 1; }

list() { rclone lsf "$RCLONE_REMOTE" -R --files-only | grep -E '/db-[0-9]{8}-[0-9]{6}\.sql\.gz\.enc$' | sort -t/ -k2; }

if [[ $# -eq 0 ]]; then
  echo "Backup database di $RCLONE_REMOTE:"
  list | tail -30
  echo -e "\nPulihkan: bash $0 terbaru   (atau sebutkan nama berkasnya)"
  exit 0
fi

DB_REMOTE="$1"
[[ "$DB_REMOTE" == terbaru ]] && DB_REMOTE="$(list | tail -1)"
[[ -n "$DB_REMOTE" ]] || { echo "Tidak ada backup di $RCLONE_REMOTE" >&2; exit 1; }
UP_REMOTE="${DB_REMOTE/db-/uploads-}"
UP_REMOTE="${UP_REMOTE/.sql.gz.enc/.tar.gz.enc}"

echo -e "\033[1;31mPERHATIAN:\033[0m database '$DB_NAME' dan folder upload akan DIGANTI dengan isi backup:"
echo "  $DB_REMOTE"
read -r -p "Ketik PULIHKAN untuk melanjutkan: " ans
[[ "$ans" == PULIHKAN ]] || { echo "Dibatalkan."; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
rclone copyto "$RCLONE_REMOTE/$DB_REMOTE" "$TMP/db.sql.gz.enc"
decrypt_file "$TMP/db.sql.gz.enc" "$TMP/db.sql.gz"
gzip -t "$TMP/db.sql.gz"
HAS_UP=0
if rclone copyto "$RCLONE_REMOTE/$UP_REMOTE" "$TMP/up.tar.gz.enc" 2>/dev/null; then
  decrypt_file "$TMP/up.tar.gz.enc" "$TMP/up.tar.gz" && tar -tzf "$TMP/up.tar.gz" >/dev/null && HAS_UP=1
fi

# Simpan kondisi sekarang dulu (bila database sudah ada)
mkdir -p "$DEST"
STAMP="$(date +%Y%m%d-%H%M%S)"
if mysql -e "USE \`$DB_NAME\`" 2>/dev/null; then
  mysqldump --single-transaction --triggers --routines "$DB_NAME" | gzip > "$DEST/sebelum-pulih-$STAMP.sql.gz"
fi
[[ -d "$APP_DIR/backend/uploads" ]] && tar -czf "$DEST/sebelum-pulih-uploads-$STAMP.tar.gz" -C "$APP_DIR/backend" uploads

systemctl stop smc-backend || true
mysql -e "DROP DATABASE IF EXISTS \`$DB_NAME\`; CREATE DATABASE \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
zcat "$TMP/db.sql.gz" | mysql "$DB_NAME"
# Hak akses user aplikasi tetap berlaku setelah database dibuat ulang
mysql -e "GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO 'smc_app'@'localhost'; FLUSH PRIVILEGES;" 2>/dev/null || true
if (( HAS_UP )); then
  rm -rf "$APP_DIR/backend/uploads"
  tar -xzf "$TMP/up.tar.gz" -C "$APP_DIR/backend"
  chown -R smc:smc "$APP_DIR/backend/uploads" 2>/dev/null || true
else
  echo "⚠️  Berkas upload untuk backup ini tidak ditemukan — hanya database yang dipulihkan."
fi
systemctl start smc-backend || true

faces=$(mysql -N -B -e "SELECT COUNT(*) FROM users WHERE face_embedding IS NOT NULL AND face_embedding <> ''" "$DB_NAME")
echo -e "\033[1;32mPemulihan selesai.\033[0m $faces wajah karyawan terpulihkan. Kondisi sebelumnya tersimpan di $DEST/sebelum-pulih-$STAMP.*"
