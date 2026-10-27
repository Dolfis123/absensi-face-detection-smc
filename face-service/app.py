"""
SMC-FaceAttend — Face Detection Engine
Layanan internal (hanya dipanggil oleh backend Node.js, jangan dibuka ke internet).

POST /enroll    {images: [3..5 data URL]}        -> {embeddings, spread, quality}
POST /identify  {image, candidates, tolerance}   -> {match: {id, distance} | null}
POST /encode    {image}                          -> {embedding}   (satu foto, untuk debug)
"""
import base64
import io
import os

import face_recognition
import numpy as np
from fastapi import FastAPI, HTTPException
from PIL import Image, ImageOps
from pydantic import BaseModel, Field


def env_num(key: str, default: float) -> float:
    return float(os.getenv(key, str(default)))


MAX_SIDE = int(env_num("FACE_MAX_SIDE", 800))
# "hog" cepat di CPU; "cnn" lebih akurat tapi butuh GPU/dlib CUDA
DETECTION_MODEL = os.getenv("FACE_DETECTION_MODEL", "hog")
# Wajah minimal sekian piksel (sisi kotak) agar orang harus benar-benar di depan kamera
MIN_FACE_PX = int(env_num("FACE_MIN_PX", 120))

# ── Ambang kualitas foto pendaftaran (titik awal; sesuaikan setelah uji coba di lokasi) ──
# Ketajaman = varians Laplacian pada crop wajah 200x200 abu-abu. Makin kecil makin buram.
MIN_SHARPNESS = env_num("FACE_MIN_SHARPNESS", 40)
# Kecerahan rata-rata crop wajah (0-255)
MIN_BRIGHTNESS = env_num("FACE_MIN_BRIGHTNESS", 60)
MAX_BRIGHTNESS = env_num("FACE_MAX_BRIGHTNESS", 210)
# Kontras (simpangan baku piksel). Rendah = wajah "datar", biasanya karena cahaya dari belakang
MIN_CONTRAST = env_num("FACE_MIN_CONTRAST", 25)
# Rasio toleh (yaw): 0 = lurus, ±0.3 kira-kira menoleh ringan
MAX_YAW = env_num("FACE_MAX_YAW", 0.45)
FRONTAL_YAW = env_num("FACE_FRONTAL_YAW", 0.15)
# Jarak maksimum antar-foto milik orang yang sama saat pendaftaran
MAX_ENROLL_SPREAD = env_num("FACE_ENROLL_MAX_SPREAD", 0.55)
# Pendaftaran hanya sekali, jadi pakai jitter lebih banyak agar embedding lebih stabil
ENROLL_JITTERS = int(env_num("FACE_ENROLL_JITTERS", 10))

app = FastAPI(title="SMC-FaceAttend Face Service", version="1.1.0")


class EncodeRequest(BaseModel):
    image: str = Field(..., description="data URL base64 (data:image/jpeg;base64,...)")


class EnrollRequest(BaseModel):
    images: list[str] = Field(..., min_length=3, max_length=5)


Embedding = list[float]


class Candidate(BaseModel):
    id: int
    embeddings: list[Embedding] = Field(..., min_length=1)


class IdentifyRequest(EncodeRequest):
    candidates: list[Candidate]
    tolerance: float = Field(0.45, gt=0, lt=1)


def load_image(data_url: str) -> np.ndarray:
    try:
        payload = data_url.split(",", 1)[1] if "," in data_url else data_url
        img = Image.open(io.BytesIO(base64.b64decode(payload)))
        img = ImageOps.exif_transpose(img).convert("RGB")
    except Exception:
        raise HTTPException(status_code=422, detail="Foto tidak dapat dibaca")
    img.thumbnail((MAX_SIDE, MAX_SIDE))
    return np.asarray(img)


def detect_single_face(image: np.ndarray) -> tuple[int, int, int, int]:
    locations = face_recognition.face_locations(image, number_of_times_to_upsample=1, model=DETECTION_MODEL)
    if not locations:
        raise HTTPException(status_code=422, detail="Wajah tidak terdeteksi. Pastikan wajah menghadap kamera dengan cahaya cukup.")
    if len(locations) > 1:
        raise HTTPException(status_code=422, detail="Terdeteksi lebih dari satu wajah. Pastikan hanya satu orang di depan kamera.")
    top, right, bottom, left = locations[0]
    if min(bottom - top, right - left) < MIN_FACE_PX:
        raise HTTPException(status_code=422, detail="Wajah terlalu jauh dari kamera. Dekatkan wajah Anda.")
    return locations[0]


def face_quality(image: np.ndarray, location: tuple[int, int, int, int]) -> dict:
    """Ketajaman, kecerahan, kontras, dan rasio toleh dari area wajah."""
    top, right, bottom, left = location
    crop = Image.fromarray(image[max(top, 0):bottom, max(left, 0):right]).convert("L").resize((200, 200))
    gray = np.asarray(crop, dtype=np.float32)
    laplacian = gray[1:-1, :-2] + gray[1:-1, 2:] + gray[:-2, 1:-1] + gray[2:, 1:-1] - 4 * gray[1:-1, 1:-1]

    yaw = 0.0
    landmarks = face_recognition.face_landmarks(image, [location], model="small")
    if landmarks:
        lm = landmarks[0]
        left_eye = np.mean(lm["left_eye"], axis=0)
        right_eye = np.mean(lm["right_eye"], axis=0)
        nose = np.array(lm["nose_tip"][0])
        eye_dist = float(np.linalg.norm(right_eye - left_eye)) or 1.0
        yaw = float((nose[0] - (left_eye[0] + right_eye[0]) / 2) / eye_dist)

    return {
        "sharpness": round(float(laplacian.var()), 1),
        "brightness": round(float(gray.mean()), 1),
        "contrast": round(float(gray.std()), 1),
        "yaw": round(yaw, 3),
    }


def quality_problem(q: dict) -> str | None:
    if q["sharpness"] < MIN_SHARPNESS:
        return f"foto buram (ketajaman {q['sharpness']}, min {MIN_SHARPNESS:g}). Tahan kamera stabil dan bersihkan lensa."
    if q["brightness"] < MIN_BRIGHTNESS:
        return f"wajah terlalu gelap (kecerahan {q['brightness']}). Tambah cahaya dari depan."
    if q["brightness"] > MAX_BRIGHTNESS:
        return f"wajah terlalu terang/silau (kecerahan {q['brightness']}). Hindari sinar langsung."
    if q["contrast"] < MIN_CONTRAST:
        return f"kontras wajah terlalu rendah ({q['contrast']}). Hindari cahaya dari belakang (membelakangi jendela/lampu)."
    if abs(q["yaw"]) > MAX_YAW:
        return "wajah terlalu menyamping. Cukup menoleh sedikit saja."
    return None


@app.get("/health")
def health():
    return {"ok": True, "model": DETECTION_MODEL}


@app.post("/encode")
def encode(req: EncodeRequest):
    image = load_image(req.image)
    location = detect_single_face(image)
    encoding = face_recognition.face_encodings(image, known_face_locations=[location], num_jitters=1)[0]
    return {"embedding": [round(float(v), 8) for v in encoding]}


@app.post("/enroll")
def enroll(req: EnrollRequest):
    """Pendaftaran wajah dari 3–5 foto: cek kualitas tiap foto lalu cek konsistensi antar-foto."""
    encodings: list[np.ndarray] = []
    qualities: list[dict] = []
    for i, data_url in enumerate(req.images, start=1):
        try:
            image = load_image(data_url)
            location = detect_single_face(image)
        except HTTPException as e:
            raise HTTPException(status_code=422, detail=f"Foto {i}: {e.detail}")
        q = face_quality(image, location)
        problem = quality_problem(q)
        if problem:
            raise HTTPException(status_code=422, detail=f"Foto {i}: {problem}")
        encodings.append(
            face_recognition.face_encodings(image, known_face_locations=[location], num_jitters=ENROLL_JITTERS)[0]
        )
        qualities.append(q)

    if min(abs(q["yaw"]) for q in qualities) > FRONTAL_YAW:
        raise HTTPException(status_code=422, detail="Minimal satu foto harus menghadap lurus ke kamera.")

    known = np.array(encodings)
    pairwise = np.array([face_recognition.face_distance(known, e) for e in known])
    spread = float(pairwise.max())
    if spread > MAX_ENROLL_SPREAD:
        # Foto dengan rata-rata jarak terbesar ke foto lain = yang paling "lain sendiri"
        worst = int(pairwise.mean(axis=1).argmax()) + 1
        raise HTTPException(
            status_code=422,
            detail=f"Foto {worst} tidak konsisten dengan foto lain (jarak {spread:.2f}). "
            "Pastikan semua foto adalah orang yang sama dengan cahaya serupa, lalu ambil ulang foto tersebut.",
        )

    return {
        "embeddings": [[round(float(v), 8) for v in e] for e in encodings],
        "spread": round(spread, 4),
        "quality": qualities,
    }


@app.post("/identify")
def identify(req: IdentifyRequest):
    if not req.candidates:
        return {"match": None}
    image = load_image(req.image)
    location = detect_single_face(image)
    probe = face_recognition.face_encodings(image, known_face_locations=[location], num_jitters=1)[0]
    # Jarak ke tiap karyawan = jarak terdekat ke salah satu foto terdaftarnya
    distances = np.array([float(face_recognition.face_distance(np.array(c.embeddings), probe).min()) for c in req.candidates])
    order = np.argsort(distances)
    best = int(order[0])
    best_distance = float(distances[best])
    if best_distance > req.tolerance:
        return {"match": None}
    # Tolak bila dua kandidat terlalu mirip (ambigu) agar tidak salah catat orang lain
    if len(order) > 1 and float(distances[int(order[1])]) - best_distance < 0.05:
        return {"match": None}
    return {"match": {"id": req.candidates[best].id, "distance": best_distance}}
