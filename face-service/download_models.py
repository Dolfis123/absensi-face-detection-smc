"""Unduh model wajah OpenCV Zoo ke folder models/ (sekali saja; aman dijalankan ulang).

YuNet  : deteksi wajah + 5 titik wajah  — lisensi MIT
SFace  : pengenalan wajah (embedding)   — lisensi Apache-2.0
"""
import sys
import urllib.request
from pathlib import Path

BASE = "https://github.com/opencv/opencv_zoo/raw/main/models"
MODELS = {
    "face_detection_yunet_2023mar.onnx": f"{BASE}/face_detection_yunet/face_detection_yunet_2023mar.onnx",
    "face_recognition_sface_2021dec.onnx": f"{BASE}/face_recognition_sface/face_recognition_sface_2021dec.onnx",
}
# File Git LFS yang gagal terunduh hanya berisi teks pointer ±130 byte
MIN_BYTES = 100_000

target = Path(__file__).resolve().parent / "models"
target.mkdir(exist_ok=True)

for name, url in MODELS.items():
    path = target / name
    if path.exists() and path.stat().st_size > MIN_BYTES:
        print(f"OK   {name} (sudah ada)")
        continue
    print(f"GET  {name} ...")
    tmp = path.with_suffix(".part")
    urllib.request.urlretrieve(url, tmp)
    if tmp.stat().st_size < MIN_BYTES:
        tmp.unlink()
        sys.exit(f"Gagal mengunduh {name}: file terlalu kecil. Coba lagi atau unduh manual dari {url}")
    tmp.replace(path)
    print(f"OK   {name} ({path.stat().st_size // 1024} KB)")
