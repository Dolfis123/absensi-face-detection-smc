"""
SMC-FaceAttend — Face Detection Engine (OpenCV YuNet + SFace)
Layanan internal (hanya dipanggil oleh backend Node.js, jangan dibuka ke internet).

POST /enroll    {images: [3..5 data URL]}   -> {model, embeddings, spread, quality}
POST /identify  {image, candidates}         -> {model, ranked: [{id, distance}] (maks. 5, terdekat dulu)}
POST /encode    {image}                     -> {model, embedding}   (satu foto, untuk debug)

Jarak = jarak cosine (1 - cosine similarity) antar embedding 128 dimensi yang dinormalisasi.
0 = identik; orang yang sama umumnya < 0.5; orang berbeda umumnya > 0.7.
Model: YuNet (deteksi + 5 titik wajah, lisensi MIT) dan SFace (pengenalan, lisensi Apache-2.0)
dari OpenCV Zoo. Unduh dulu dengan `python download_models.py`.
"""
import base64
import io
import math
import os
import threading
from pathlib import Path

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException
from PIL import Image, ImageOps
from pydantic import BaseModel, Field


def env_num(key: str, default: float) -> float:
    return float(os.getenv(key, str(default)))


MODEL_ID = "sface-2021dec"
MODEL_DIR = Path(__file__).resolve().parent / "models"
DET_PATH = MODEL_DIR / "face_detection_yunet_2023mar.onnx"
REC_PATH = MODEL_DIR / "face_recognition_sface_2021dec.onnx"

MAX_SIDE = int(env_num("FACE_MAX_SIDE", 960))
# Lebar kotak wajah minimal (piksel) agar orang benar-benar di depan kamera
MIN_FACE_PX = int(env_num("FACE_MIN_PX", 90))
# Keyakinan detektor: wajah tertutup tangan/masker/terpotong mendapat skor rendah
MIN_DET_SCORE_ENROLL = env_num("FACE_MIN_DET_SCORE", 0.88)

# ── Ambang kualitas pendaftaran (diukur pada wajah yang sudah diluruskan 112x112) ──
# Ketajaman = varians Laplacian. Makin kecil makin buram.
MIN_SHARPNESS = env_num("FACE_MIN_SHARPNESS", 25)
# Kecerahan diukur di area MATA & DAHI, bukan seluruh wajah, supaya kumis/jenggot tebal
# dan kulit gelap tidak membuat foto dianggap "terlalu gelap".
MIN_BRIGHTNESS = env_num("FACE_MIN_BRIGHTNESS", 40)
MAX_BRIGHTNESS = env_num("FACE_MAX_BRIGHTNESS", 230)
# Porsi piksel yang "terbakar" putih (silau / lampu langsung)
MAX_GLARE = env_num("FACE_MAX_GLARE", 0.20)
# Pose: yaw (toleh kiri/kanan) 0 = lurus; pitch = posisi hidung antara mata & mulut (≈0.55 lurus)
MAX_YAW = env_num("FACE_MAX_YAW", 0.5)
FRONTAL_YAW = env_num("FACE_FRONTAL_YAW", 0.15)
PITCH_RANGE = (env_num("FACE_MIN_PITCH", 0.25), env_num("FACE_MAX_PITCH", 0.85))
MAX_ROLL_DEG = env_num("FACE_MAX_ROLL", 25)
# Jarak cosine maksimum antar-foto milik orang yang sama saat pendaftaran
MAX_ENROLL_SPREAD = env_num("FACE_ENROLL_MAX_SPREAD", 0.55)

for p in (DET_PATH, REC_PATH):
    if not p.exists():
        raise RuntimeError(f"Model {p.name} belum ada. Jalankan: python download_models.py")

detector = cv2.FaceDetectorYN.create(str(DET_PATH), "", (320, 320), score_threshold=0.6, nms_threshold=0.3, top_k=20)
recognizer = cv2.FaceRecognizerSF.create(str(REC_PATH), "")
# Objek OpenCV tidak aman dipakai bersamaan oleh beberapa thread (endpoint sync FastAPI = threadpool)
engine_lock = threading.Lock()

app = FastAPI(title="SMC-FaceAttend Face Service", version="2.0.0")


class EncodeRequest(BaseModel):
    image: str = Field(..., description="data URL base64 (data:image/jpeg;base64,...)")


class EnrollRequest(BaseModel):
    images: list[str] = Field(..., min_length=3, max_length=5)


class Candidate(BaseModel):
    id: int
    embeddings: list[list[float]] = Field(..., min_length=1)


class IdentifyRequest(EncodeRequest):
    candidates: list[Candidate]


def reject(detail: str):
    raise HTTPException(status_code=422, detail=detail)


def load_image(data_url: str) -> np.ndarray:
    """Data URL → gambar BGR (format OpenCV), sisi terpanjang maks. MAX_SIDE."""
    try:
        payload = data_url.split(",", 1)[1] if "," in data_url else data_url
        img = Image.open(io.BytesIO(base64.b64decode(payload)))
        img = ImageOps.exif_transpose(img).convert("RGB")
    except Exception:
        reject("Foto tidak dapat dibaca")
    img.thumbnail((MAX_SIDE, MAX_SIDE))
    return cv2.cvtColor(np.asarray(img), cv2.COLOR_RGB2BGR)


def detect(image: np.ndarray) -> list[np.ndarray]:
    h, w = image.shape[:2]
    detector.setInputSize((w, h))
    _, faces = detector.detect(image)
    if faces is None:
        return []
    return sorted(faces, key=lambda f: f[2] * f[3], reverse=True)  # terbesar dulu


def pick_face(faces: list[np.ndarray], strict: bool) -> np.ndarray:
    if not faces:
        reject("Wajah tidak terdeteksi. Hadapkan wajah ke kamera dengan cahaya cukup.")
    if len(faces) > 1:
        big, second = faces[0], faces[1]
        # Saat absen, orang lain jauh di belakang masih ditoleransi; saat daftar harus satu wajah
        if strict or big[2] * big[3] < 1.8 * second[2] * second[3]:
            reject("Terdeteksi lebih dari satu wajah. Pastikan hanya satu orang di depan kamera.")
    face = faces[0]
    if face[2] < MIN_FACE_PX:
        reject("Wajah terlalu jauh dari kamera. Dekatkan wajah Anda.")
    return face


def geometry(face: np.ndarray) -> dict:
    """Pose kepala dari 5 titik wajah YuNet: mata kanan, mata kiri, hidung, sudut mulut kanan & kiri."""
    re, le, nose = face[4:6], face[6:8], face[8:10]
    mouth = (face[10:12] + face[12:14]) / 2
    eye_mid = (re + le) / 2
    eye_dist = float(np.linalg.norm(le - re)) or 1.0
    yaw = float((nose[0] - eye_mid[0]) / eye_dist)
    span = float(mouth[1] - eye_mid[1]) or 1.0
    pitch = float((nose[1] - eye_mid[1]) / span)
    roll = math.degrees(math.atan2(float(le[1] - re[1]), float(le[0] - re[0])))
    if roll > 90:
        roll -= 180
    elif roll < -90:
        roll += 180
    return {"yaw": round(yaw, 3), "pitch": round(pitch, 3), "roll": round(roll, 1), "score": round(float(face[14]), 3)}


def quality(aligned: np.ndarray) -> dict:
    gray = cv2.cvtColor(aligned, cv2.COLOR_BGR2GRAY)
    eyes = gray[24:64, 12:100]  # dahi & mata pada wajah 112x112 yang sudah diluruskan
    return {
        "sharpness": round(float(cv2.Laplacian(gray, cv2.CV_64F).var()), 1),
        "brightness": round(float(eyes.mean()), 1),
        "glare": round(float((gray >= 245).mean()), 3),
    }


def problem(geo: dict, q: dict, strict: bool) -> str | None:
    # Saat absen ambangnya dilonggarkan: yang penting identitas bisa dipastikan
    k = 1.0 if strict else 0.5
    if strict and geo["score"] < MIN_DET_SCORE_ENROLL:
        return "wajah kurang jelas (tertutup, terpotong, atau kurang cahaya). Lepas masker/topi dan hadap kamera."
    if q["sharpness"] < MIN_SHARPNESS * k:
        return f"foto buram (ketajaman {q['sharpness']}). Tahan HP tetap diam dan bersihkan lensa kamera."
    if q["brightness"] < MIN_BRIGHTNESS * k:
        return f"area mata terlalu gelap (kecerahan {q['brightness']}). Cari cahaya dari depan wajah."
    if q["brightness"] > MAX_BRIGHTNESS + (0 if strict else 15) or q["glare"] > MAX_GLARE * (1 if strict else 1.5):
        return "wajah terlalu terang/silau. Hindari lampu atau matahari langsung ke wajah."
    if abs(geo["yaw"]) > MAX_YAW * (1 if strict else 1.2):
        return "wajah terlalu menyamping. Cukup menoleh sedikit saja."
    if strict and not (PITCH_RANGE[0] <= geo["pitch"] <= PITCH_RANGE[1]):
        return "kepala terlalu mendongak atau menunduk."
    if abs(geo["roll"]) > MAX_ROLL_DEG * (1 if strict else 1.4):
        return "kepala terlalu miring. Tegakkan kepala."
    return None


def analyze(data_url: str, strict: bool) -> tuple[np.ndarray, dict]:
    """Deteksi → luruskan wajah → cek kualitas → embedding (dinormalisasi)."""
    image = load_image(data_url)
    with engine_lock:
        face = pick_face(detect(image), strict)
        aligned = recognizer.alignCrop(image, face)
        geo = geometry(face)
        q = quality(aligned)
        issue = problem(geo, q, strict)
        if issue:
            reject(issue[0].upper() + issue[1:])
        # Rata-rata dengan versi cermin: embedding lebih stabil terhadap sedikit perbedaan pose/cahaya
        feat = recognizer.feature(aligned).flatten() + recognizer.feature(cv2.flip(aligned, 1)).flatten()
    vec = feat / (np.linalg.norm(feat) or 1.0)
    return vec, {**geo, **q}


def cosine_distance_matrix(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    a = a / np.linalg.norm(a, axis=1, keepdims=True)
    b = b / np.linalg.norm(b, axis=1, keepdims=True)
    return 1.0 - a @ b.T


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_ID}


@app.post("/encode")
def encode(req: EncodeRequest):
    vec, info = analyze(req.image, strict=False)
    return {"model": MODEL_ID, "embedding": [round(float(v), 7) for v in vec], "quality": info}


@app.post("/enroll")
def enroll(req: EnrollRequest):
    """Pendaftaran dari 3–5 foto: cek kualitas tiap foto, lalu cek konsistensi antar-foto."""
    vectors, infos = [], []
    for i, data_url in enumerate(req.images, start=1):
        try:
            vec, info = analyze(data_url, strict=True)
        except HTTPException as e:
            raise HTTPException(status_code=422, detail=f"Foto {i}: {e.detail}")
        vectors.append(vec)
        infos.append(info)

    if min(abs(q["yaw"]) for q in infos) > FRONTAL_YAW:
        reject("Minimal satu foto harus menghadap lurus ke kamera.")

    known = np.array(vectors)
    pairwise = cosine_distance_matrix(known, known)
    spread = float(pairwise.max())
    if spread > MAX_ENROLL_SPREAD:
        worst = int(pairwise.mean(axis=1).argmax()) + 1
        reject(
            f"Foto {worst} tidak konsisten dengan foto lain (jarak {spread:.2f}). "
            "Pastikan semua foto orang yang sama dengan cahaya serupa, lalu ambil ulang foto tersebut."
        )
    return {
        "model": MODEL_ID,
        "embeddings": [[round(float(v), 7) for v in vec] for vec in vectors],
        "spread": round(spread, 4),
        "quality": infos,
    }


@app.post("/identify")
def identify(req: IdentifyRequest):
    """5 karyawan terdekat. Keputusan siapa orangnya (termasuk PIN) dilakukan di backend."""
    if not req.candidates:
        return {"model": MODEL_ID, "ranked": []}
    probe, _ = analyze(req.image, strict=False)
    distances = np.array([float(cosine_distance_matrix(np.array(c.embeddings), probe[None, :]).min()) for c in req.candidates])
    order = np.argsort(distances)[:5]
    return {"model": MODEL_ID, "ranked": [{"id": req.candidates[int(i)].id, "distance": round(float(distances[int(i)]), 4)} for i in order]}
