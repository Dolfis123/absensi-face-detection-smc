import 'dotenv/config';

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Environment variable ${key} wajib diisi (lihat .env.example)`);
  return value;
}

const num = (key: string, fallback: number) => {
  const raw = process.env[key];
  return raw === undefined || raw === '' ? fallback : Number(raw);
};

export const env = {
  port: num('PORT', 4000),
  // Produksi: 127.0.0.1 agar API hanya bisa diakses lewat Nginx
  host: process.env.HOST ?? '0.0.0.0',
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  db: {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: num('DB_PORT', 3306),
    name: process.env.DB_NAME ?? 'smc_faceattend',
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? '',
  },
  jwtSecret: required('JWT_SECRET'),
  jwtExpires: process.env.JWT_EXPIRES ?? '12h',
  faceServiceUrl: process.env.FACE_SERVICE_URL ?? 'http://127.0.0.1:8001',
  // Jarak cosine maksimum agar wajah dianggap cocok saat absen (model SFace).
  // Nama variabel baru: nilai FACE_TOLERANCE lama (model dlib) tidak berlaku lagi.
  faceTolerance: num('FACE_MAX_DISTANCE', 0.55),
  // Pendaftaran butuh persetujuan Super Admin bila wajah baru sedekat ini dengan karyawan lain
  faceDuplicateThreshold: num('FACE_DUPLICATE_DISTANCE', 0.4),
  lateToleranceMin: num('LATE_TOLERANCE_MINUTES', 120),
  superAdmin: {
    username: process.env.SUPER_ADMIN_USERNAME ?? 'superadmin',
    password: process.env.SUPER_ADMIN_PASSWORD ?? '',
    fullName: process.env.SUPER_ADMIN_FULLNAME ?? 'Super Admin SMC',
    nik: process.env.SUPER_ADMIN_NIK ?? 'SMC-0001',
    phone: process.env.SUPER_ADMIN_PHONE ?? '-',
  },
  geofenceDefault: {
    latitude: num('GEOFENCE_LAT', -0.8768),
    longitude: num('GEOFENCE_LNG', 131.2558),
    radiusMeters: num('GEOFENCE_RADIUS_M', 5),
    maxAccuracyMeters: num('GEOFENCE_MAX_ACCURACY_M', 15),
  },
  uploadDir: process.env.UPLOAD_DIR ?? 'uploads',
};
