#!/usr/bin/env bash
# Backup database + lampiran izin. Disimpan 14 hari di /var/backups/smc.
set -euo pipefail

APP_DIR="/var/www/smc"
DB_NAME="smc_faceattend"
DEST="/var/backups/smc"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$DEST"
chmod 700 "$DEST"
# root memakai auth_socket, tanpa password. --triggers ikut menyalin trigger anti-manipulasi.
mysqldump --single-transaction --triggers --routines "$DB_NAME" | gzip > "$DEST/db-$STAMP.sql.gz"
tar -czf "$DEST/uploads-$STAMP.tar.gz" -C "$APP_DIR/backend" uploads
find "$DEST" -type f -mtime +14 -delete
echo "$(date) backup OK: $DEST/db-$STAMP.sql.gz"
