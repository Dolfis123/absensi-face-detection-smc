#!/usr/bin/env bash
# Uji pemulihan backup luar server (otomatis tiap bulan, bisa juga manual):
#   bash /var/www/smc/deploy/restore-test.sh
# Mengunduh backup TERBARU dari Google Drive, mendekripsi, lalu memulihkannya ke database uji
# terpisah (smc_restore_test). Database asli TIDAK disentuh. Database uji dihapus setelah selesai.
set -euo pipefail
source "$(dirname "$0")/backup-lib.sh"

TEST_DB="${TEST_DB:-smc_restore_test}"
TMP="$(mktemp -d)"
cleanup() {
  mysql -e "DROP DATABASE IF EXISTS \`$TEST_DB\`" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT
fail() {
  write_status restore-test gagal "$1"
  echo "$(date) UJI PEMULIHAN GAGAL: $1" >&2
  exit 1
}

offsite_enabled || fail "backup luar server belum dipasang"

latest() { rclone lsf "$RCLONE_REMOTE" -R --files-only | grep -E "/$1-[0-9]{8}-[0-9]{6}\.$2\.enc$" | sort -t/ -k2 | tail -1; }
DB_REMOTE="$(latest db sql.gz)" || true
UP_REMOTE="$(latest uploads tar.gz)" || true
[[ -n "$DB_REMOTE" ]] || fail "tidak ada backup database di $RCLONE_REMOTE"
echo "Backup terbaru: $DB_REMOTE"

rclone copyto "$RCLONE_REMOTE/$DB_REMOTE" "$TMP/db.sql.gz.enc"
decrypt_file "$TMP/db.sql.gz.enc" "$TMP/db.sql.gz" || fail "dekripsi gagal (kunci backup salah?)"
gzip -t "$TMP/db.sql.gz" || fail "berkas database rusak"

mysql -e "DROP DATABASE IF EXISTS \`$TEST_DB\`; CREATE DATABASE \`$TEST_DB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
zcat "$TMP/db.sql.gz" | mysql "$TEST_DB" || fail "impor database gagal"

count() { mysql -N -B -e "$2" "$1"; }
Q_USERS="SELECT COUNT(*) FROM users"
Q_FACES="SELECT COUNT(*) FROM users WHERE face_embedding IS NOT NULL AND face_embedding <> ''"
Q_ATT="SELECT COUNT(*) FROM attendances"
Q_TRG="SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema = DATABASE()"
r_users=$(count "$TEST_DB" "$Q_USERS"); r_faces=$(count "$TEST_DB" "$Q_FACES"); r_att=$(count "$TEST_DB" "$Q_ATT"); r_trg=$(count "$TEST_DB" "$Q_TRG")
l_users=$(count "$DB_NAME" "$Q_USERS"); l_faces=$(count "$DB_NAME" "$Q_FACES"); l_att=$(count "$DB_NAME" "$Q_ATT")

printf '%-22s %10s %10s\n' '' 'Backup' 'Saat ini'
printf '%-22s %10s %10s\n' 'Pengguna' "$r_users" "$l_users"
printf '%-22s %10s %10s\n' 'Wajah terdaftar' "$r_faces" "$l_faces"
printf '%-22s %10s %10s\n' 'Catatan absensi' "$r_att" "$l_att"
printf '%-22s %10s\n' 'Trigger pengaman' "$r_trg"

(( r_users > 0 )) || fail "backup tidak berisi pengguna"
(( l_faces == 0 || r_faces > 0 )) || fail "backup tidak berisi data wajah"
(( r_trg > 0 )) || fail "trigger pengaman tidak ikut terbackup"

if [[ -n "$UP_REMOTE" ]]; then
  rclone copyto "$RCLONE_REMOTE/$UP_REMOTE" "$TMP/up.tar.gz.enc"
  decrypt_file "$TMP/up.tar.gz.enc" "$TMP/up.tar.gz" || fail "dekripsi berkas upload gagal"
  n_files=$(tar -tzf "$TMP/up.tar.gz" | grep -vc '/$' || true)
  echo "Berkas upload di backup: $n_files"
fi

write_status restore-test ok "$DB_REMOTE · $r_users pengguna, $r_faces wajah, $r_att absensi"
echo -e "\033[1;32m$(date) UJI PEMULIHAN BERHASIL\033[0m — backup bisa dipulihkan."
