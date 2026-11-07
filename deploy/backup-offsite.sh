#!/usr/bin/env bash
# Kirim backup terenkripsi ke luar server (Google Drive lewat rclone).
#   bash backup-offsite.sh <db-XXXX.sql.gz> <uploads-XXXX.tar.gz>
# Biasanya dipanggil otomatis oleh backup-db.sh.
set -euo pipefail
source "$(dirname "$0")/backup-lib.sh"

offsite_enabled || { echo "Backup luar server belum dipasang (setup-backup-offsite.sh)." >&2; exit 1; }
[[ $# -ge 1 ]] || { echo "Pemakaian: $0 <berkas-backup>..." >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
MONTH_DIR="$RCLONE_REMOTE/$(date +%Y-%m)"

for f in "$@"; do
  [[ -s "$f" ]] || { echo "Berkas kosong / tidak ada: $f" >&2; exit 1; }
  encrypt_file "$f" "$TMP/$(basename "$f").enc"
done

rclone copy "$TMP" "$MONTH_DIR" --retries 5 --low-level-retries 10
# Pastikan semua berkas sudah sampai dengan ukuran yang sama
rclone check "$TMP" "$MONTH_DIR" --one-way --size-only

# Hapus backup luar server yang lebih tua dari KEEP_REMOTE_DAYS hari
rclone delete "$RCLONE_REMOTE" --min-age "${KEEP_REMOTE_DAYS}d" || true
rclone rmdirs "$RCLONE_REMOTE" --leave-root || true

echo "$(date) backup luar server OK: $MONTH_DIR ($(ls "$TMP" | tr '\n' ' '))"
