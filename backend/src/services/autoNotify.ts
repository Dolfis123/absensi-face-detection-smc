/**
 * Pesan otomatis lewat Telegram (dicek tiap menit):
 *  1. Pengingat pribadi ke petugas yang sudah menyambungkan Telegram:
 *     - "sebelum shift" (bawaan 30 menit sebelum jam mulai), berisi shift, pos jaga, dan jam absen;
 *     - "belum absen masuk" (bawaan 10 menit sebelum batas terlambat), bila belum ada Absen Masuk.
 *  2. Jadwal besok ke grup Telegram setiap hari pada jam tertentu (bawaan 20.00 WIT).
 */
import { Op } from 'sequelize';
import { AppSetting, ATTENDEE_ROLES, Attendance, EmployeeSchedule, Holiday, LeaveRequest, ReminderLog, TelegramLink, User } from '../models';
import { activeMarks } from './notWorking';
import { getPosts, postLabel } from './placement';
import { buildWhatsappText } from './rosterExport';
import { loadShifts, slotDeadline } from './shiftService';
import { sendTo } from './telegramBot';
import { getTestAccountIds } from './testAccounts';
import { addDays, hhmmToMinutes, witNow } from '../utils/time';

export interface NotifySettings {
  reminders: { enabled: boolean; beforeMinutes: number; lateWarnMinutes: number };
  group: { enabled: boolean; chatId: string; chatName: string; time: string };
}
export const DEFAULT_NOTIFY: NotifySettings = {
  reminders: { enabled: true, beforeMinutes: 30, lateWarnMinutes: 10 },
  group: { enabled: false, chatId: '', chatName: '', time: '20:00' },
};
const KEY = 'autoNotifySettings';
const GROUP_SENT_KEY = 'groupScheduleLastSent';

export async function getNotifySettings(): Promise<NotifySettings> {
  const row = await AppSetting.findByPk(KEY);
  try {
    const v = row ? (JSON.parse(row.value) as Partial<NotifySettings>) : {};
    return { reminders: { ...DEFAULT_NOTIFY.reminders, ...v.reminders }, group: { ...DEFAULT_NOTIFY.group, ...v.group } };
  } catch {
    return DEFAULT_NOTIFY;
  }
}
export const saveNotifySettings = (s: NotifySettings) => AppSetting.upsert({ key: KEY, value: JSON.stringify(s) });

const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}.${String(m % 60).padStart(2, '0')}`;
const dot = (t: string) => t.replace(':', '.');
const firstName = (n: string) => n.split(' ')[0];

/** Isi pengingat untuk satu petugas pada satu hari (dipakai juga untuk tombol "kirim contoh"). */
export async function reminderText(userId: number, date: string, kind: 'before' | 'late'): Promise<string | null> {
  const [user, sched, shifts, posts] = await Promise.all([User.findByPk(userId), EmployeeSchedule.findOne({ where: { userId, date } }), loadShifts(), getPosts()]);
  if (!user || !sched || sched.shiftId === null) return null;
  const sh = shifts.get(sched.shiftId);
  const masuk = sh?.slots.find((s) => s.type === 'MASUK');
  if (!sh || !masuk) return null;
  const deadline = hm(slotDeadline(masuk));
  if (kind === 'late') {
    const left = slotDeadline(masuk) - witNow().minutes;
    return `⚠️ <b>${firstName(user.fullName)}, Anda belum absen masuk</b>\n${sh.name} hari ini. Batas terlambat <b>${deadline} WIT</b>${left > 0 ? ` (${left} menit lagi)` : ''}.\nLewat dari itu tercatat <b>ALFA</b> dan absen pulang tidak bisa.`;
  }
  const shift2 = [...shifts.values()].find((s) => s.code === 'SHIFT_2');
  const post = postLabel(posts, sched.post);
  const coordNote = user.role === 'KOORDINATOR' && sched.post && shift2 ? ` (sampai ${dot(shift2.startTime)}, lalu awasi semua pos)` : '';
  return [
    `⏰ <b>Pengingat shift, ${firstName(user.fullName)}</b>`,
    `${sh.name} hari ini <b>${dot(sh.startTime)} – ${dot(sh.endTime)} WIT</b>`,
    post ? `📍 Pos jaga: <b>${post.replace(/\s*—\s*Area Parkiran/, '')}</b>${coordNote}` : null,
    `🕒 Absen masuk ${dot(masuk.windowStart)}–${dot(masuk.windowEnd)}, terlambat s.d. ${deadline} (lewat itu ALFA).`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Kirim pengingat yang jatuh tempo sekarang. Mengembalikan jumlah pesan terkirim. */
export async function runReminders(now = witNow()): Promise<number> {
  const s = await getNotifySettings();
  if (!s.reminders.enabled) return 0;
  const links = await TelegramLink.findAll();
  if (!links.length) return 0;
  const testIds = await getTestAccountIds();
  const ids = links.map((l) => l.userId).filter((id) => !testIds.has(id));
  const [users, schedules, shifts, holiday, leaves, marks, atts] = await Promise.all([
    User.findAll({ where: { id: ids.concat(0), role: [...ATTENDEE_ROLES], isActive: true }, attributes: ['id'] }),
    EmployeeSchedule.findAll({ where: { userId: ids.concat(0), date: now.date, shiftId: { [Op.ne]: null } } }),
    loadShifts(),
    Holiday.findOne({ where: { date: now.date } }),
    LeaveRequest.findAll({ where: { userId: ids.concat(0), status: 'APPROVED', startDate: { [Op.lte]: now.date }, endDate: { [Op.gte]: now.date } } }),
    activeMarks(now.date, now.date, ids.concat(0)),
    Attendance.findAll({ where: { userId: ids.concat(0), date: now.date, slotType: 'MASUK', active: true }, attributes: ['userId'] }),
  ]);
  if (holiday) return 0;
  const active = new Set(users.map((u) => u.id));
  const masukDone = new Set(atts.map((a) => a.userId));
  let sent = 0;
  for (const sc of schedules) {
    if (!active.has(sc.userId) || masukDone.has(sc.userId)) continue;
    if (leaves.some((l) => l.userId === sc.userId) || marks.has(`${sc.userId}|${now.date}`)) continue;
    const sh = shifts.get(sc.shiftId!);
    const masuk = sh?.slots.find((x) => x.type === 'MASUK');
    if (!sh || !masuk) continue;
    const start = hhmmToMinutes(sh.startTime);
    const deadline = slotDeadline(masuk);
    const due: ('before' | 'late')[] = [];
    // Jendela 15 menit supaya pengingat tetap terkirim walau server sempat restart
    const before = start - s.reminders.beforeMinutes;
    if (now.minutes >= before && now.minutes < before + 15) due.push('before');
    const late = deadline - s.reminders.lateWarnMinutes;
    if (now.minutes >= late && now.minutes < deadline) due.push('late');
    for (const kind of due) {
      const [, created] = await ReminderLog.findOrCreate({ where: { userId: sc.userId, date: now.date, kind }, defaults: { userId: sc.userId, date: now.date, kind, sentAt: new Date() } });
      if (!created) continue;
      const text = await reminderText(sc.userId, now.date, kind);
      const link = links.find((l) => l.userId === sc.userId)!;
      if (text && (await sendTo(link.chatId, text))) sent++;
    }
  }
  return sent;
}

/** Teks jadwal besok untuk grup; null bila belum ada jadwal. */
export async function groupScheduleText(date: string) {
  const text = await buildWhatsappText(date);
  return text.includes('Belum ada jadwal') ? null : `🗓️ *JADWAL BESOK*\n\n${text}`;
}

/** Kirim jadwal besok ke grup sekali sehari setelah jam yang diatur. */
export async function runGroupSchedule(now = witNow(), force = false): Promise<'sent' | 'skip' | 'empty' | 'failed'> {
  const s = await getNotifySettings();
  if (!force && (!s.group.enabled || !s.group.chatId || now.time.slice(0, 5) < s.group.time)) return 'skip';
  if (!s.group.chatId) return 'failed';
  if (!force) {
    const last = await AppSetting.findByPk(GROUP_SENT_KEY);
    if (last?.value === now.date) return 'skip';
    await AppSetting.upsert({ key: GROUP_SENT_KEY, value: now.date });
  }
  const text = await groupScheduleText(addDays(now.date, 1));
  if (!text) return 'empty';
  return (await sendTo(s.group.chatId, text, 'Markdown')) ? 'sent' : 'failed';
}

export function startAutoNotify() {
  if (process.env.AUTO_NOTIFY_DISABLED === '1') return;
  const tick = async () => {
    try {
      await runReminders();
      const r = await runGroupSchedule();
      if (r === 'empty') {
        const { sendTelegram } = await import('./systemMonitor');
        await sendTelegram('🟠 <b>Jadwal besok belum dibuat</b>\nJadwal belum terkirim ke grup karena roster besok masih kosong. Buat roster di menu Roster Shift.');
      }
    } catch (e) {
      console.error('Pesan otomatis:', (e as Error).message);
    }
  };
  setTimeout(tick, 40_000);
  setInterval(tick, 60_000).unref();
}
