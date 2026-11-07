#!/usr/bin/env bash
# Watchdog SMC-FaceAttend (cron tiap 5 menit, dipasang otomatis oleh update.sh).
# Memeriksa hal yang TIDAK bisa dilaporkan aplikasi sendiri: backend mati, database mati, Nginx mati.
# Kirim Telegram ke penerima yang dipilih di menu "Kesehatan Sistem" (token dari backend/.env).
# Peringatan dikirim setelah 2 kali gagal berturut-turut (±10 menit), dan pesan "pulih" saat normal lagi.
set -uo pipefail

APP_DIR="${APP_DIR:-/var/www/smc}"
ENV_FILE="${ENV_FILE:-$APP_DIR/backend/.env}"
DB_NAME="${DB_NAME:-smc_faceattend}"
STATE_DIR="${STATE_DIR:-/var/lib/smc/watchdog}"
mkdir -p "$STATE_DIR"

TOKEN="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" 2>/dev/null | head -n1 | cut -d= -f2- | tr -d '"'"'"' \r')"
# Penerima disimpan aplikasi di app_settings (alertChatIds) — bila database mati, pakai salinan terakhir
CHATS_CACHE="$STATE_DIR/chats"
CHATS="$(mysql -N -B -e "SELECT value FROM app_settings WHERE \`key\`='alertChatIds'" "$DB_NAME" 2>/dev/null | grep -oE '"id":"-?[0-9]+"' | grep -oE -- '-?[0-9]+' | tr '\n' ' ')"
if [[ -n "$CHATS" ]]; then echo "$CHATS" > "$CHATS_CACHE"; else CHATS="$(cat "$CHATS_CACHE" 2>/dev/null || true)"; fi

send() {
  [[ -n "$TOKEN" && -n "$CHATS" ]] || return 0
  for c in $CHATS; do
    curl -fsS -m 15 "https://api.telegram.org/bot$TOKEN/sendMessage" \
      --data-urlencode "chat_id=$c" --data-urlencode "text=$1" -d parse_mode=HTML >/dev/null 2>&1 || true
  done
}

# check <kunci> <judul> <perintah cek...>
check() {
  local key="$1" title="$2"; shift 2
  local fails_file="$STATE_DIR/$key.fails" alerted_file="$STATE_DIR/$key.alerted"
  if "$@" >/dev/null 2>&1; then
    if [[ -f "$alerted_file" ]]; then
      send "✅ <b>Pulih: $title</b>
Sudah normal kembali ($(date '+%d-%m-%Y %H:%M') waktu server)."
      rm -f "$alerted_file"
    fi
    rm -f "$fails_file"
    return
  fi
  local n=$(( $(cat "$fails_file" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$fails_file"
  if (( n >= 2 )) && [[ ! -f "$alerted_file" ]]; then
    send "🔴 <b>$title</b>
Petugas kemungkinan tidak bisa absen. Coba di VPS:
systemctl restart smc-face smc-backend nginx
Status: systemctl status smc-backend smc-face nginx mysql"
    touch "$alerted_file"
  fi
}

check backend "Aplikasi absensi (backend) tidak merespons" curl -fsS -m 10 http://127.0.0.1:4000/api/health
check mysql "Database MySQL mati" mysqladmin ping --silent
check nginx "Web server (Nginx) mati — situs tidak bisa dibuka" systemctl is-active --quiet nginx
