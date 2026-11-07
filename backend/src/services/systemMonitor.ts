/**
 * Pemantau sistem untuk Super Admin: memeriksa server tiap 5 menit dan mengirim peringatan
 * (Telegram + lonceng di aplikasi) bila ada masalah, serta ringkasan harian pukul 07.00 WIT.
 *
 * Pemeriksaan: layanan wajah, hasil backup & uji pemulihan (berkas status dari skrip deploy),
 * sisa ruang disk, dan surat disiplin yang belum diterima petugas lebih dari 3 hari.
 * Bila backend sendiri mati, deploy/watchdog.sh yang mengirim peringatan.
 */
import fs from 'fs';
import path from 'path';
import { Op } from 'sequelize';
import { env } from '../config/env';
import { AlertLevel, AppSetting, AttendanceIssue, DisciplineLetter, DocumentReceipt, LeaveRequest, SystemAlert, User } from '../models';
import { overview as disciplineOverview } from '../routes/discipline';
import { LETTER_TITLE } from './discipline';
import { fmtLongDate } from './pdfReport';
import { buildRecap } from './recapService';
import { addDays, witNow } from '../utils/time';

const INTERVAL_MS = 5 * 60_000;
const REMIND_CRITICAL_MS = 6 * 3600_000;
const STATUS_DIR = process.env.BACKUP_STATUS_DIR ?? '/var/lib/smc';
const CHATS_KEY = 'alertChatIds';
const SUMMARY_KEY = 'alertLastSummary';

// ───────────── Telegram ─────────────
export interface AlertChat {
  id: string;
  name: string;
}
const token = () => process.env.TELEGRAM_BOT_TOKEN?.trim() || '';
export const telegramConfigured = () => !!token();

export async function getChats(): Promise<AlertChat[]> {
  const row = await AppSetting.findByPk(CHATS_KEY);
  try {
    return row ? (JSON.parse(row.value) as AlertChat[]) : [];
  } catch {
    return [];
  }
}
export async function saveChats(chats: AlertChat[]) {
  await AppSetting.upsert({ key: CHATS_KEY, value: JSON.stringify(chats) });
}

async function tg<T>(method: string, body?: unknown): Promise<T> {
  const res = await fetch(`${process.env.TELEGRAM_API_BASE ?? 'https://api.telegram.org'}/bot${token()}/${method}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
  if (!data.ok) throw new Error(data.description ?? `Telegram ${res.status}`);
  return data.result as T;
}

/** Kirim ke semua chat penerima; mengembalikan jumlah yang berhasil. Tidak pernah melempar error. */
export async function sendTelegram(text: string): Promise<number> {
  if (!telegramConfigured()) return 0;
  let ok = 0;
  for (const c of await getChats()) {
    try {
      await tg('sendMessage', { chat_id: c.id, text, parse_mode: 'HTML', disable_web_page_preview: true });
      ok++;
    } catch (e) {
      console.error(`Telegram ke ${c.name} gagal:`, (e as Error).message);
    }
  }
  return ok;
}

/** Chat yang pernah mengirim pesan ke bot (untuk memilih penerima di aplikasi). */
export async function discoverChats(): Promise<AlertChat[]> {
  if (!telegramConfigured()) throw new Error('TELEGRAM_BOT_TOKEN belum diisi di backend/.env');
  type Upd = { message?: { chat: { id: number; title?: string; first_name?: string; last_name?: string; username?: string } } };
  const updates = await tg<Upd[]>('getUpdates');
  const seen = new Map<string, AlertChat>();
  for (const u of updates) {
    const c = u.message?.chat;
    if (!c) continue;
    const name = c.title ?? ([c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || String(c.id));
    seen.set(String(c.id), { id: String(c.id), name });
  }
  return [...seen.values()];
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ICON: Record<AlertLevel, string> = { CRITICAL: '🔴', WARNING: '🟠', INFO: 'ℹ️' };

// ───────────── Peringatan aktif ─────────────
async function raise(key: string, level: AlertLevel, title: string, message: string) {
  const now = new Date();
  const cur = await SystemAlert.findOne({ where: { key, active: true } });
  if (cur) {
    // Kirim lagi bila tingkatnya berubah (mis. WARNING → CRITICAL), atau pengingat tiap 6 jam untuk CRITICAL
    const levelChanged = cur.level !== level;
    const remind = level === 'CRITICAL' && !!cur.notifiedAt && now.getTime() - cur.notifiedAt.getTime() > REMIND_CRITICAL_MS;
    const neverSent = level !== 'INFO' && !cur.notifiedAt; // mis. Telegram baru dipasang
    await cur.update({ level, title, message, lastAt: now });
    if ((levelChanged && level !== 'INFO') || remind || neverSent) {
      if (await sendTelegram(`${ICON[level]} <b>${esc(title)}</b>${remind && !levelChanged ? ' (masih terjadi)' : ''}\n${esc(message)}`)) await cur.update({ notifiedAt: now });
    }
    return;
  }
  const a = await SystemAlert.create({ key, level, title, message, active: true, firstAt: now, lastAt: now, resolvedAt: null, notifiedAt: null });
  if (level !== 'INFO' && (await sendTelegram(`${ICON[level]} <b>${esc(title)}</b>\n${esc(message)}`))) await a.update({ notifiedAt: now });
}

async function resolve(key: string, okMessage: string) {
  const cur = await SystemAlert.findOne({ where: { key, active: true } });
  if (!cur) return;
  await cur.update({ active: false, resolvedAt: new Date() });
  if (cur.notifiedAt) await sendTelegram(`✅ <b>Pulih: ${esc(cur.title)}</b>\n${esc(okMessage)}`);
}

// ───────────── Pemeriksaan ─────────────
export interface CheckResult {
  at: string;
  face: { ok: boolean; ms: number | null; error?: string };
  backup: { status: 'ok' | 'gagal' | 'tidak-ada' | 'tidak-dipantau'; time: string | null; message: string | null; offsite: boolean };
  restoreTest: { status: 'ok' | 'gagal' | 'tidak-ada' | 'tidak-dipantau'; time: string | null; message: string | null };
  disk: { usedPct: number; freeGb: number } | null;
  unreadLetters: number;
}
let last: CheckResult | null = null;
let faceFails = 0;
export const lastResult = () => last;

function readStatus(name: string) {
  const p = path.join(STATUS_DIR, `${name}.status`);
  if (!fs.existsSync(STATUS_DIR)) return { status: 'tidak-dipantau' as const, time: null, message: null };
  if (!fs.existsSync(p)) return { status: 'tidak-ada' as const, time: null, message: null };
  const [status, time, message] = fs.readFileSync(p, 'utf8').trim().split('|');
  return { status: (status === 'ok' ? 'ok' : 'gagal') as 'ok' | 'gagal', time: time ?? null, message: message ?? null };
}
const ageHours = (t: string | null) => (t ? (Date.now() - new Date(t.replace(' ', 'T').replace(/ ([+-]\d{2})(\d{2})$/, '$1:$2')).getTime()) / 3600_000 : Infinity);

export async function runChecks(): Promise<CheckResult> {
  // 1) Layanan pengenalan wajah — petugas tidak bisa absen bila mati
  const t0 = Date.now();
  let face: CheckResult['face'];
  try {
    const r = await fetch(`${env.faceServiceUrl}/health`, { signal: AbortSignal.timeout(8000) });
    face = r.ok ? { ok: true, ms: Date.now() - t0 } : { ok: false, ms: null, error: `HTTP ${r.status}` };
  } catch (e) {
    face = { ok: false, ms: null, error: (e as Error).message };
  }
  faceFails = face.ok ? 0 : faceFails + 1;
  if (faceFails >= 2) await raise('face', 'CRITICAL', 'Layanan pengenalan wajah mati', `Petugas tidak bisa absen. Cek di VPS: systemctl status smc-face  (${face.error ?? ''})`);
  else if (face.ok) await resolve('face', 'Layanan pengenalan wajah kembali normal, petugas bisa absen lagi.');

  // 2) Backup harian & uji pemulihan (ditulis skrip deploy/backup-db.sh & restore-test.sh)
  const b = readStatus('backup');
  // "lokal + luar server (…)" = aktif; "lokal saja (backup luar server belum dipasang)" = belum
  const offsite = b.status === 'ok' && !!b.message?.startsWith('lokal + luar server');
  if (b.status !== 'tidak-dipantau') {
    if (b.status === 'gagal') await raise('backup', 'CRITICAL', 'Backup gagal', `${b.message ?? ''} (${b.time}). Lihat: tail -50 /var/log/smc-backup.log`);
    else if (b.status === 'tidak-ada' || ageHours(b.time) > 26) await raise('backup', 'CRITICAL', 'Backup tidak berjalan', `Backup terakhir: ${b.time ?? 'belum pernah'}. Cek cron & /var/log/smc-backup.log`);
    else if (!offsite) await raise('backup', 'WARNING', 'Backup luar server belum aktif', 'Backup hanya tersimpan di VPS. Jalankan: bash /var/www/smc/deploy/setup-backup-offsite.sh');
    else await resolve('backup', `Backup berjalan normal (${b.time}).`);
  }
  const rt = readStatus('restore-test');
  if (rt.status === 'gagal') await raise('restore-test', 'CRITICAL', 'Uji pemulihan backup GAGAL', `${rt.message ?? ''} (${rt.time}). Backup mungkin tidak bisa dipakai — jalankan: bash /var/www/smc/deploy/restore-test.sh`);
  else if (rt.status === 'ok' && ageHours(rt.time) > 40 * 24) await raise('restore-test', 'WARNING', 'Uji pemulihan sudah lama tidak berjalan', `Terakhir: ${rt.time}`);
  else if (rt.status === 'ok') await resolve('restore-test', `Uji pemulihan berhasil (${rt.time}).`);

  // 3) Sisa ruang disk (database, upload, backup lokal)
  let disk: CheckResult['disk'] = null;
  try {
    const st = await fs.promises.statfs(path.resolve(env.uploadDir, '..'));
    const usedPct = Math.round((1 - st.bavail / st.blocks) * 100);
    disk = { usedPct, freeGb: Math.round(((st.bavail * st.bsize) / 1e9) * 10) / 10 };
    if (usedPct >= 97) await raise('disk', 'CRITICAL', 'Disk server hampir penuh', `Terpakai ${usedPct}% (sisa ${disk.freeGb} GB). Database & backup bisa gagal.`);
    else if (usedPct >= 90) await raise('disk', 'WARNING', 'Disk server mulai penuh', `Terpakai ${usedPct}% (sisa ${disk.freeGb} GB).`);
    else await resolve('disk', `Ruang disk kembali cukup (terpakai ${usedPct}%).`);
  } catch {
    /* statfs tidak tersedia */
  }

  // 4) Surat disiplin yang belum diterima petugas > 3 hari
  const old = await DisciplineLetter.findAll({ where: { voidedAt: null, createdAt: { [Op.lt]: new Date(Date.now() - 3 * 24 * 3600_000) } } });
  const got = old.length ? await DocumentReceipt.findAll({ where: { kind: 'LETTER', refId: old.map((l) => l.id), receivedAt: { [Op.ne]: null } } }) : [];
  const unread = old.filter((l) => !got.some((r) => r.refId === l.id && r.userId === l.userId));
  if (unread.length) {
    const users = await User.findAll({ where: { id: unread.map((l) => l.userId) }, attributes: ['id', 'fullName'] });
    const list = unread.slice(0, 8).map((l) => `• ${users.find((u) => u.id === l.userId)?.fullName ?? '?'} — ${LETTER_TITLE[l.type]} ${l.number}`).join('\n');
    await raise('letters-unread', 'WARNING', `${unread.length} surat belum diterima petugas (> 3 hari)`, `${list}\nSampaikan langsung lewat Koordinator.`);
  } else await resolve('letters-unread', 'Semua surat sudah diterima petugas.');

  last = { at: new Date().toISOString(), face, backup: { ...b, offsite }, restoreTest: rt, disk, unreadLetters: unread.length };
  return last;
}

// ───────────── Ringkasan harian 07.00 WIT (kehadiran kemarin) ─────────────
export async function dailySummaryText(): Promise<string> {
  const now = witNow();
  const y = addDays(now.date, -1);
  const [recap, discipline, leaves, issues, alerts] = await Promise.all([
    buildRecap(y, y),
    disciplineOverview(),
    LeaveRequest.count({ where: { status: 'PENDING' } }),
    AttendanceIssue.count({ where: { status: ['OPEN', 'ESCALATED'] } }),
    SystemAlert.findAll({ where: { active: true } }),
  ]);
  const days = recap.map((r) => ({ name: r.user.fullName, d: r.days[0] })).filter((x) => x.d);
  const by = (s: string) => days.filter((x) => x.d.status === s).map((x) => x.name);
  const alfa = by('ALFA');
  const sekali = by('ABSEN_SEKALI');
  const late = by('TERLAMBAT');
  const working = days.filter((x) => !['OFF', 'DAY_OFF', 'LIBUR'].includes(x.d.status)).length;
  const need = discipline.filter((r) => r.recommendation).length;
  const lines = [
    `📋 <b>Ringkasan kehadiran ${esc(fmtLongDate(y))}</b>`,
    `Dijadwalkan ${working} · hadir tepat waktu ${by('TEPAT_WAKTU').length} · terlambat ${late.length} · absen sekali ${sekali.length} · alfa ${alfa.length}`,
  ];
  if (alfa.length) lines.push(`🔴 Alfa: ${esc(alfa.join(', '))}`);
  if (sekali.length) lines.push(`🟣 Absen sekali: ${esc(sekali.join(', '))}`);
  if (late.length) lines.push(`🟠 Terlambat: ${esc(late.join(', '))}`);
  const todo = [
    need && `${need} karyawan perlu surat disiplin`,
    leaves && `${leaves} pengajuan izin menunggu`,
    issues && `${issues} laporan kendala terbuka`,
    alerts.length && `${alerts.length} peringatan sistem aktif`,
  ].filter(Boolean);
  lines.push(todo.length ? `\n<b>Perlu tindakan:</b>\n• ${todo.join('\n• ')}` : '\n✅ Tidak ada yang perlu ditindaklanjuti.');
  return lines.join('\n');
}

async function maybeDailySummary() {
  const now = witNow();
  if (now.minutes < 7 * 60) return;
  const row = await AppSetting.findByPk(SUMMARY_KEY);
  if (row?.value === now.date) return;
  await AppSetting.upsert({ key: SUMMARY_KEY, value: now.date });
  await sendTelegram(await dailySummaryText());
}

export function startMonitor() {
  if (process.env.MONITOR_DISABLED === '1') return;
  const tick = () =>
    runChecks()
      .then(maybeDailySummary)
      .catch((e) => console.error('Pemantau sistem:', (e as Error).message));
  setTimeout(tick, 30_000); // beri waktu face-service menyala setelah restart
  setInterval(tick, INTERVAL_MS).unref();
}
