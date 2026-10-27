/**
 * Diagnosis data wajah terdaftar:  npm run check-faces
 *
 * 1. Per karyawan: jumlah foto & konsistensi antar-foto miliknya sendiri.
 * 2. Antar karyawan: pasangan dengan wajah paling mirip (rawan tertukar saat absen).
 * Hanya membaca database, tidak mengubah apa pun.
 */
import { env } from '../config/env';
import { parseEmbeddings, sequelize, User } from '../models';
import { DISTANCE_DANGER, DISTANCE_WARN, minDistance, spread } from '../utils/faceMath';

const SPREAD_WARN = 0.5;

async function main() {
  await sequelize.authenticate();
  const users = await User.findAll({ where: { role: 'KARYAWAN' }, order: [['fullName', 'ASC']] });
  const people = users
    .map((u) => ({ user: u, embeddings: parseEmbeddings(u.faceEmbedding) }))
    .filter((p): p is { user: User; embeddings: number[][] } => p.embeddings !== null);
  const missing = users.filter((u) => !parseEmbeddings(u.faceEmbedding));

  console.log(`\n=== Cek Data Wajah SMC-FaceAttend ===`);
  console.log(`Toleransi absen: ${env.faceTolerance} · ambang wajah ganda: ${env.faceDuplicateThreshold}\n`);

  // ── 1. Per karyawan ──
  console.log('1) Kualitas pendaftaran per karyawan');
  const perPerson = people.map(({ user, embeddings }) => {
    let nearest = { name: '-', distance: Infinity };
    for (const other of people) {
      if (other.user.id === user.id) continue;
      const d = minDistance(embeddings, other.embeddings);
      if (d < nearest.distance) nearest = { name: other.user.fullName, distance: d };
    }
    const s = spread(embeddings);
    const notes: string[] = [];
    if (!user.isActive) notes.push('nonaktif');
    if (embeddings.length < 3) notes.push('DAFTAR ULANG: baru 1 foto (format lama)');
    else if (s > SPREAD_WARN) notes.push('DAFTAR ULANG: foto tidak konsisten');
    if (nearest.distance < DISTANCE_DANGER) notes.push(`BAHAYA: mirip ${nearest.name}`);
    else if (nearest.distance < DISTANCE_WARN) notes.push(`perhatian: mirip ${nearest.name}`);
    return {
      Nama: user.fullName,
      NIK: user.nik,
      Foto: embeddings.length,
      'Sebaran foto': embeddings.length > 1 ? Number(s.toFixed(3)) : '-',
      'Wajah terdekat': nearest.name,
      Jarak: Number.isFinite(nearest.distance) ? Number(nearest.distance.toFixed(3)) : '-',
      Catatan: notes.join('; ') || 'OK',
    };
  });
  console.table(perPerson);
  if (missing.length) console.log(`Belum punya data wajah: ${missing.map((u) => u.fullName).join(', ')}`);

  // ── 2. Pasangan paling mirip ──
  const pairs: { a: string; b: string; distance: number }[] = [];
  for (let i = 0; i < people.length; i++) {
    for (let j = i + 1; j < people.length; j++) {
      pairs.push({
        a: people[i].user.fullName,
        b: people[j].user.fullName,
        distance: minDistance(people[i].embeddings, people[j].embeddings),
      });
    }
  }
  pairs.sort((x, y) => x.distance - y.distance);
  console.log('\n2) 10 pasangan karyawan dengan wajah paling mirip');
  console.table(
    pairs.slice(0, 10).map((p) => ({
      'Karyawan A': p.a,
      'Karyawan B': p.b,
      Jarak: Number(p.distance.toFixed(3)),
      Status: p.distance < DISTANCE_DANGER ? 'BAHAYA - bisa tertukar' : p.distance < DISTANCE_WARN ? 'Perhatian' : 'Aman',
    })),
  );

  const danger = pairs.filter((p) => p.distance < DISTANCE_DANGER).length;
  const redo = perPerson.filter((p) => p.Catatan.includes('DAFTAR ULANG')).length;
  console.log('\nRingkasan:');
  console.log(`- ${people.length} karyawan berwajah terdaftar, ${missing.length} belum`);
  console.log(`- ${redo} perlu daftar ulang wajah, ${danger} pasangan berbahaya (jarak < ${DISTANCE_DANGER})`);
  console.log('Cara baca jarak: < 0.50 bahaya · 0.50–0.60 perhatian · > 0.60 aman (dua orang berbeda).');
  console.log('Sebaran foto satu orang idealnya < 0.40; > 0.50 berarti fotonya kurang konsisten.\n');
}

main()
  .catch((err) => {
    console.error('Gagal:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
