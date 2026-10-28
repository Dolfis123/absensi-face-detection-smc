#!/usr/bin/env bash
# SMC-FaceAttend — rilis versi terbaru dari GitHub ke VPS (jalankan sebagai root):
#   bash /var/www/smc/deploy/update.sh
set -euo pipefail

APP_DIR="/var/www/smc"
step() { echo -e "\n\033[1;34m==> $*\033[0m"; }

cd "$APP_DIR"
step "Ambil kode terbaru"
git pull --ff-only

step "Backup database sebelum update"
bash "$APP_DIR/deploy/backup-db.sh"

step "Face-service"
cd "$APP_DIR/face-service"
.venv/bin/pip install -r requirements.txt
# Paket mesin lama (dlib) tidak dipakai lagi sejak pindah ke OpenCV YuNet + SFace
.venv/bin/pip uninstall -y face_recognition face_recognition_models dlib-bin dlib 2>/dev/null || true
.venv/bin/python download_models.py

step "Backend"
cd "$APP_DIR/backend" && npm ci && npm run build

step "Frontend"
cd "$APP_DIR/frontend" && npm ci && npm run build

step "Restart service"
cp "$APP_DIR"/deploy/systemd/*.service /etc/systemd/system/
systemctl daemon-reload
systemctl restart smc-face
sleep 5
systemctl restart smc-backend
sleep 5
systemctl reload nginx

curl -fsS http://127.0.0.1:8001/health && echo "  <- face-service"
curl -fsS http://127.0.0.1:4000/api/health && echo "  <- backend"
echo -e "\n\033[1;32mUpdate selesai.\033[0m"
