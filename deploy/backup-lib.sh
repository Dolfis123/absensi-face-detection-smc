#!/usr/bin/env bash
# Fungsi & pengaturan bersama untuk skrip backup SMC-FaceAttend (di-source, bukan dijalankan langsung).
# Semua path bisa ditimpa lewat variabel lingkungan (dipakai saat uji coba).

APP_DIR="${APP_DIR:-/var/www/smc}"
DB_NAME="${DB_NAME:-smc_faceattend}"
DEST="${DEST:-/var/backups/smc}"
SMC_ETC="${SMC_ETC:-/etc/smc}"
BACKUP_CONF="${BACKUP_CONF:-$SMC_ETC/backup.conf}"
BACKUP_KEY="${BACKUP_KEY:-$SMC_ETC/backup.key}"
STATUS_DIR="${STATUS_DIR:-/var/lib/smc}"

# Nilai bawaan; backup.conf (dibuat setup-backup-offsite.sh) boleh menimpanya
RCLONE_REMOTE="smc-gdrive:SMC-Backup"
KEEP_REMOTE_DAYS=90
# shellcheck disable=SC1090
[[ -f "$BACKUP_CONF" ]] && source "$BACKUP_CONF"

offsite_enabled() { [[ -f "$BACKUP_CONF" && -f "$BACKUP_KEY" ]]; }

# Catat hasil terakhir supaya bisa dicek (dan nanti dipakai peringatan otomatis): <jenis> <ok|gagal> <waktu> <pesan>
write_status() {
  mkdir -p "$STATUS_DIR"
  printf '%s|%s|%s\n' "$2" "$(date '+%Y-%m-%d %H:%M:%S %z')" "$3" > "$STATUS_DIR/$1.status"
}

# Enkripsi AES-256 dengan kunci di $BACKUP_KEY. Dekripsi: openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:KUNCI -in X.enc -out X
encrypt_file() { openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$BACKUP_KEY" -in "$1" -out "$2"; }
decrypt_file() { openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$BACKUP_KEY" -in "$1" -out "$2"; }
