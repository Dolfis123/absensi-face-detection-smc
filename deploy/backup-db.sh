#!/usr/bin/env bash
# Backup database (termasuk data wajah karyawan) + file upload (lampiran izin, foto parkir, logo & cap).
# Salinan lokal disimpan 14 hari di /var/backups/smc. Bila backup luar server sudah dipasang
# (setup-backup-offsite.sh), salinan terenkripsi juga dikirim ke Google Drive.
set -euo pipefail
source "$(dirname "$0")/backup-lib.sh"

STAMP="$(date +%Y%m%d-%H%M%S)"
DB_FILE="$DEST/db-$STAMP.sql.gz"
UP_FILE="$DEST/uploads-$STAMP.tar.gz"

mkdir -p "$DEST"
chmod 700 "$DEST"
# root memakai auth_socket, tanpa password. --triggers ikut menyalin trigger anti-manipulasi.
if ! mysqldump --single-transaction --triggers --routines "$DB_NAME" | gzip > "$DB_FILE"; then
  rm -f "$DB_FILE"
  write_status backup gagal "mysqldump gagal"
  echo "$(date) BACKUP GAGAL: mysqldump" >&2
  exit 1
fi
# Pastikan berkas tidak rusak dan benar-benar berisi data wajah karyawan
gzip -t "$DB_FILE"
zgrep -q "INSERT INTO \`users\`" "$DB_FILE" || { rm -f "$DB_FILE"; write_status backup gagal "dump tanpa data users"; echo "Dump tidak berisi data users" >&2; exit 1; }
tar -czf "$UP_FILE" -C "$APP_DIR/backend" uploads
find "$DEST" -maxdepth 1 -type f -mtime +14 -delete
echo "$(date) backup lokal OK: $DB_FILE"

if offsite_enabled; then
  # Gagal kirim ke luar server tidak membatalkan backup lokal / update aplikasi
  if bash "$(dirname "$0")/backup-offsite.sh" "$DB_FILE" "$UP_FILE"; then
    write_status backup ok "lokal + luar server ($RCLONE_REMOTE)"
  else
    write_status backup gagal "lokal OK, kirim ke luar server GAGAL"
    echo "⚠️  Backup lokal OK, tetapi pengiriman ke luar server GAGAL (lihat /var/log/smc-backup.log)" >&2
  fi
else
  write_status backup ok "lokal saja (backup luar server belum dipasang)"
  echo "ℹ️  Backup luar server belum dipasang. Jalankan: bash $APP_DIR/deploy/setup-backup-offsite.sh"
fi
