/**
 * Bot Telegram dua arah: membaca pesan yang masuk ke bot (getUpdates tiap 15 detik) supaya
 * - petugas bisa menyambungkan akunnya sendiri (tombol "Sambungkan Telegram" → /start <kode>),
 * - Super Admin bisa memilih penerima peringatan & grup jadwal dari chat yang pernah menyapa bot.
 * Token bot diambil dari TELEGRAM_BOT_TOKEN (sama dengan peringatan sistem).
 */
import crypto from 'crypto';
import { AppSetting, TelegramLink, User } from '../models';

const token = () => process.env.TELEGRAM_BOT_TOKEN?.trim() || '';
export const botConfigured = () => !!token();
const OFFSET_KEY = 'tgUpdateOffset';
const SEEN_KEY = 'tgSeenChats';
const TOKENS_KEY = 'tgLinkTokens';
const LINK_TTL_MS = 30 * 60_000;

export async function tgApi<T>(method: string, body?: unknown): Promise<T> {
  const res = await fetch(`${process.env.TELEGRAM_API_BASE ?? 'https://api.telegram.org'}/bot${token()}/${method}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
  if (!data.ok) throw new Error(data.description ?? `Telegram ${res.status}`);
  return data.result as T;
}

/** Kirim ke satu chat. Markdown gagal (mis. karakter khusus di nama) → dikirim ulang sebagai teks biasa. */
export async function sendTo(chatId: string, text: string, parseMode: 'HTML' | 'Markdown' | null = 'HTML'): Promise<boolean> {
  if (!botConfigured()) return false;
  try {
    await tgApi('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true, ...(parseMode ? { parse_mode: parseMode } : {}) });
    return true;
  } catch (e) {
    if (parseMode) {
      try {
        await tgApi('sendMessage', { chat_id: chatId, text: parseMode === 'Markdown' ? text.replace(/[*_`]/g, '') : text.replace(/<[^>]+>/g, ''), disable_web_page_preview: true });
        return true;
      } catch {
        /* lanjut ke log */
      }
    }
    console.error(`Telegram ke ${chatId} gagal:`, (e as Error).message);
    return false;
  }
}

let username: string | null = null;
export async function botUsername() {
  if (!username) username = (await tgApi<{ username: string }>('getMe')).username;
  return username;
}

// ───────────── Chat yang pernah menyapa bot (pribadi & grup) ─────────────
export interface SeenChat {
  id: string;
  name: string;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  lastAt: string;
}
async function readJson<T>(key: string, empty: T): Promise<T> {
  const row = await AppSetting.findByPk(key);
  try {
    return row ? (JSON.parse(row.value) as T) : empty;
  } catch {
    return empty;
  }
}
const writeJson = (key: string, v: unknown) => AppSetting.upsert({ key, value: JSON.stringify(v) });

export const seenChats = () => readJson<SeenChat[]>(SEEN_KEY, []);

// ───────────── Sambungkan akun petugas ─────────────
/** Tautan sekali pakai (30 menit) yang membuka bot dengan kode akun petugas. */
export async function createLinkUrl(userId: number) {
  const tokens = await readJson<Record<string, { userId: number; exp: number }>>(TOKENS_KEY, {});
  const now = Date.now();
  for (const [k, v] of Object.entries(tokens)) if (v.exp < now || v.userId === userId) delete tokens[k];
  const code = crypto.randomBytes(12).toString('hex');
  tokens[code] = { userId, exp: now + LINK_TTL_MS };
  await writeJson(TOKENS_KEY, tokens);
  return `https://t.me/${await botUsername()}?start=${code}`;
}

type Chat = { id: number; type: SeenChat['type']; title?: string; first_name?: string; last_name?: string; username?: string };
type Update = { update_id: number; message?: { chat: Chat; text?: string }; my_chat_member?: { chat: Chat } };
const chatName = (c: Chat) => c.title ?? ([c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || String(c.id));

async function handle(updates: Update[]) {
  const seen = await seenChats();
  for (const u of updates) {
    const chat = u.message?.chat ?? u.my_chat_member?.chat;
    if (!chat) continue;
    const id = String(chat.id);
    const entry: SeenChat = { id, name: chatName(chat), type: chat.type, lastAt: new Date().toISOString() };
    const i = seen.findIndex((s) => s.id === id);
    if (i >= 0) seen[i] = entry;
    else seen.push(entry);

    const text = u.message?.text?.trim() ?? '';
    if ((chat.type === 'group' || chat.type === 'supergroup') && /^\/start(@\w+)?\b/.test(text)) {
      await sendTo(id, '✅ Grup ini sudah terbaca oleh bot SMC-FaceAttend. Super Admin sekarang bisa memilihnya untuk kiriman jadwal harian.');
      continue;
    }
    if (chat.type !== 'private' || !text.startsWith('/')) continue;
    const [rawCmd, arg] = text.split(/\s+/);
    const cmd = rawCmd.replace(/@\w+$/, '');
    if (cmd === '/start' && arg) {
      const tokens = await readJson<Record<string, { userId: number; exp: number }>>(TOKENS_KEY, {});
      const t = tokens[arg];
      if (!t || t.exp < Date.now()) {
        await sendTo(id, '⚠️ Kode sambungan sudah kedaluwarsa. Buka aplikasi SMC-FaceAttend → Beranda → <b>Sambungkan Telegram</b> lagi.');
        continue;
      }
      delete tokens[arg];
      await writeJson(TOKENS_KEY, tokens);
      const user = await User.findByPk(t.userId);
      if (!user) continue;
      await TelegramLink.upsert({ userId: user.id, chatId: id, chatName: chatName(chat), linkedAt: new Date() });
      await sendTo(id, `✅ Halo <b>${user.fullName}</b>, Telegram Anda sudah tersambung ke SMC-FaceAttend.\nAnda akan menerima pengingat sebelum shift dan sebelum batas absen masuk.\n\nKetik /berhenti untuk memutus sambungan.`);
    } else if (cmd === '/berhenti' || cmd === '/stop') {
      const n = await TelegramLink.destroy({ where: { chatId: id } });
      await sendTo(id, n ? '🔕 Sambungan diputus. Anda tidak akan menerima pengingat lagi.' : 'Chat ini belum tersambung ke akun mana pun.');
    } else if (cmd === '/start') {
      const linked = await TelegramLink.findOne({ where: { chatId: id } });
      await sendTo(
        id,
        linked
          ? '✅ Chat ini sudah tersambung. Pengingat shift akan dikirim ke sini.'
          : '👋 Ini bot SMC-FaceAttend.\nUntuk menerima pengingat shift, buka aplikasi → Beranda → <b>Sambungkan Telegram</b>.',
      );
    }
  }
  await writeJson(SEEN_KEY, seen.sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, 50));
}

let polling = false;
export const pollerActive = () => polling;

/** Ambil pesan baru yang masuk ke bot. Dipanggil berkala; aman dipanggil bila token belum diisi. */
export async function pollOnce() {
  if (!botConfigured()) return;
  const row = await AppSetting.findByPk(OFFSET_KEY);
  const offset = row ? Number(row.value) : 0;
  const updates = await tgApi<Update[]>('getUpdates', { offset, timeout: 0, allowed_updates: ['message', 'my_chat_member'] });
  if (!updates.length) return;
  await handle(updates);
  await AppSetting.upsert({ key: OFFSET_KEY, value: String(updates[updates.length - 1].update_id + 1) });
}

export function startTelegramPoller() {
  if (!botConfigured() || process.env.TELEGRAM_POLL_DISABLED === '1') return;
  polling = true;
  const tick = () => pollOnce().catch((e) => console.error('Telegram poll:', (e as Error).message));
  setTimeout(tick, 5_000);
  setInterval(tick, 15_000).unref();
}
