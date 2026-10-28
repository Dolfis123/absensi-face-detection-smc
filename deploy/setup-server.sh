#!/usr/bin/env bash
# SMC-FaceAttend — setup VPS SEKALI SAJA (Ubuntu 24.04, dijalankan sebagai root).
#   git clone https://github.com/Dolfis123/absensi-face-detection-smc.git /var/www/smc
#   bash /var/www/smc/deploy/setup-server.sh
# Aman dijalankan ulang: langkah yang sudah selesai akan dilewati / ditimpa dengan nilai yang sama.
set -euo pipefail

DOMAIN="absensiparkirsmcsorong.pro"
APP_DIR="/var/www/smc"
APP_USER="smc"
DB_NAME="smc_faceattend"
DB_USER="smc_app"
ENV_FILE="$APP_DIR/backend/.env"

step() { echo -e "\n\033[1;34m==> $*\033[0m"; }
fail() { echo -e "\033[1;31m$*\033[0m" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "Jalankan sebagai root."
[[ -d "$APP_DIR/backend" ]] || fail "Repo belum ada di $APP_DIR. Clone dulu (lihat komentar di atas)."

step "1/9 Paket sistem"
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  nginx mysql-server python3-venv python3-dev git curl ufw certbot python3-certbot-nginx

step "2/9 Node.js 22"
if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

step "3/9 User aplikasi '$APP_USER'"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
git config --global --add safe.directory "$APP_DIR"

step "4/9 MySQL"
cat > /etc/mysql/mysql.conf.d/smc.cnf <<'EOF'
[mysqld]
# Binary log aktif di MySQL 8: tanpa ini user aplikasi tidak boleh membuat trigger anti-manipulasi
log_bin_trust_function_creators = 1
EOF
systemctl restart mysql

if [[ -f "$ENV_FILE" ]]; then
  echo "backend/.env sudah ada — database & kredensial TIDAK diubah."
else
  DB_PASS="$(openssl rand -hex 24)"
  mysql <<SQL
CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';
ALTER USER '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'localhost';
FLUSH PRIVILEGES;
SQL

  echo
  echo "Data akun SUPER ADMIN (hanya satu, PERMANEN, password tidak bisa diganti setelah ini)."
  read -rp "  Username [superadmin]: " SA_USER; SA_USER=${SA_USER:-superadmin}
  read -rp "  Nama lengkap: " SA_NAME
  read -rp "  NIK: " SA_NIK
  read -rp "  No. HP (08xxx): " SA_PHONE
  # Tanda kutip tunggal akan merusak format .env
  SA_NAME="${SA_NAME//\'/}"
  SA_NIK="${SA_NIK//\'/}"
  while true; do
    read -rsp "  Password (min. 10 karakter, tanpa tanda kutip/spasi): " SA_PASS; echo
    read -rsp "  Ulangi password: " SA_PASS2; echo
    if [[ ${#SA_PASS} -lt 10 ]]; then echo "  Minimal 10 karakter."
    elif [[ "$SA_PASS" =~ [[:space:]] || "$SA_PASS" == *"'"* || "$SA_PASS" == *'"'* || "$SA_PASS" == *'\'* ]]; then
      echo "  Jangan pakai tanda kutip, backslash, atau spasi."
    elif [[ "$SA_PASS" != "$SA_PASS2" ]]; then echo "  Password tidak sama."
    else break; fi
  done

  cat > "$ENV_FILE" <<EOF
PORT=4000
HOST=127.0.0.1
CORS_ORIGIN=https://$DOMAIN,https://www.$DOMAIN

DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=$DB_NAME
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASS

JWT_SECRET=$(openssl rand -hex 48)
JWT_EXPIRES=12h

FACE_SERVICE_URL=http://127.0.0.1:8001
FACE_MAX_DISTANCE=0.55
FACE_DUPLICATE_DISTANCE=0.4
LATE_TOLERANCE_MINUTES=120

SUPER_ADMIN_USERNAME=$SA_USER
SUPER_ADMIN_PASSWORD='$SA_PASS'
SUPER_ADMIN_FULLNAME='$SA_NAME'
SUPER_ADMIN_NIK='$SA_NIK'
SUPER_ADMIN_PHONE=$SA_PHONE

# Placeholder — atur titik sebenarnya dari menu Geofence Pos setelah login
GEOFENCE_LAT=-0.876800
GEOFENCE_LNG=131.255800
GEOFENCE_RADIUS_M=5
GEOFENCE_MAX_ACCURACY_M=15

UPLOAD_DIR=$APP_DIR/backend/uploads
EOF
  echo "backend/.env dibuat (password database & JWT dibuat acak)."
fi
chown root:"$APP_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"
mkdir -p "$APP_DIR/backend/uploads"
chown -R "$APP_USER:$APP_USER" "$APP_DIR/backend/uploads"

step "5/9 Face-service (Python)"
cd "$APP_DIR/face-service"
[[ -d .venv ]] || python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt
.venv/bin/python download_models.py
.venv/bin/python -c "import cv2; print('OpenCV OK', cv2.__version__)"

step "6/9 Build backend & frontend"
cd "$APP_DIR/backend" && npm ci && npm run build
cd "$APP_DIR/frontend" && npm ci && npm run build

step "7/9 Service systemd"
cp "$APP_DIR/deploy/systemd/smc-face.service" "$APP_DIR/deploy/systemd/smc-backend.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now smc-face
sleep 5
systemctl enable --now smc-backend
sleep 5

step "8/9 Nginx & firewall"
cp "$APP_DIR/deploy/nginx/$DOMAIN.conf" "/etc/nginx/sites-available/$DOMAIN.conf"
ln -sf "/etc/nginx/sites-available/$DOMAIN.conf" "/etc/nginx/sites-enabled/$DOMAIN.conf"
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
SSH_PORT="$(sshd -T 2>/dev/null | awk '/^port /{print $2; exit}')"
ufw allow "${SSH_PORT:-22}/tcp"
ufw allow 'Nginx Full'
ufw --force enable

step "9/9 Backup database harian (02:30 WIT)"
chmod +x "$APP_DIR/deploy/backup-db.sh" "$APP_DIR/deploy/update.sh"
# Cron memakai zona waktu server. 02:30 WIT (UTC+9) = 17:30 UTC; sesuaikan jamnya bila server tidak UTC.
TZ_OFFSET_H=$(( $(date +%z | sed 's/^\([+-]\)0*\([0-9]*\)[0-9][0-9]$/\1\2/') + 0 ))
BACKUP_HOUR=$(( (2 - 9 + TZ_OFFSET_H + 24) % 24 ))
echo "30 $BACKUP_HOUR * * * root $APP_DIR/deploy/backup-db.sh >> /var/log/smc-backup.log 2>&1" > /etc/cron.d/smc-backup
echo "Backup terjadwal pukul $BACKUP_HOUR:30 waktu server (= 02:30 WIT)."

step "Cek kesehatan"
sleep 3
curl -fsS http://127.0.0.1:8001/health && echo "  <- face-service"
curl -fsS http://127.0.0.1:4000/api/health && echo "  <- backend"
curl -fsS -o /dev/null -w "%{http_code}" http://127.0.0.1/ -H "Host: $DOMAIN" && echo "  <- nginx (frontend)"

echo -e "\n\033[1;32mSelesai.\033[0m"
cat <<EOF
Langkah berikutnya (HTTPS, wajib untuk kamera & GPS):
  certbot --nginx -d $DOMAIN -d www.$DOMAIN --redirect
Lalu buka https://$DOMAIN dan login sebagai Super Admin.
Log: journalctl -u smc-backend -f   |   journalctl -u smc-face -f
EOF
