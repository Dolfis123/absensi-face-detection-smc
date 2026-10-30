/**
 * Penempatan (plotting) petugas ke pos jaga, digilir supaya setiap orang merata di semua pos.
 *
 * - Daftar pos disimpan di app_settings (bisa diubah Super Admin/Koordinator).
 * - Setiap hari, petugas satu shift dibagi ke pos sesuai urutan prioritas; bila orangnya lebih
 *   banyak dari jumlah pos, sisanya menjadi Cadangan. Koordinator tidak diplot.
 * - Pembagian memilih kombinasi dengan "biaya" terkecil: makin sering seseorang di pos itu,
 *   makin mahal; berada di pos yang sama dengan kemarin juga dihindari.
 */
import { Op } from 'sequelize';
import { AppSetting, EmployeeSchedule, ShiftChangeLog, User, sequelize } from '../models';
import { addDays } from '../utils/time';

export interface Post {
  code: string;
  area: string;
  name: string;
}
export const RESERVE: Post = { code: 'CAD', area: 'Cadangan', name: 'Cadangan (bantu pos ramai & gantikan saat istirahat)' };

const POSTS_KEY = 'rosterPosts';
export const DEFAULT_POSTS: Post[] = [
  { code: 'CK', area: 'Lobi Cendrawasih', name: 'Pintu Keluar' },
  { code: 'CM', area: 'Lobi Cendrawasih', name: 'Pintu Masuk' },
  { code: 'KK', area: 'Lobi Kasuari — Area Parkiran', name: 'Pintu Keluar' },
  { code: 'KM', area: 'Lobi Kasuari — Area Parkiran', name: 'Pintu Masuk' },
  { code: 'KL', area: 'Lobi Kasuari — Area Parkiran', name: 'Area Parkiran Lot' },
];

export async function getPosts(): Promise<Post[]> {
  const row = await AppSetting.findByPk(POSTS_KEY);
  if (!row) return DEFAULT_POSTS;
  try {
    const list = JSON.parse(row.value) as Post[];
    return Array.isArray(list) ? list : DEFAULT_POSTS;
  } catch {
    return DEFAULT_POSTS;
  }
}

export async function savePosts(posts: Post[], actorId: number) {
  const before = await getPosts();
  await sequelize.transaction(async (transaction) => {
    await AppSetting.upsert({ key: POSTS_KEY, value: JSON.stringify(posts) }, { transaction });
    await ShiftChangeLog.create({ actorId, target: 'Pos penempatan', before: { posts: before }, after: { posts } }, { transaction });
  });
}

/** Label lengkap untuk ditampilkan, mis. "Lobi Cendrawasih — Pintu Keluar". */
export function postLabel(posts: Post[], code: string | null | undefined): string | null {
  if (!code) return null;
  const p = code === RESERVE.code ? RESERVE : posts.find((x) => x.code === code);
  return p ? (p === RESERVE ? 'Cadangan' : `${p.area} — ${p.name}`) : code;
}

export type History = Map<number, Map<string, number>>;

/**
 * Membagi pos untuk satu kelompok (orang satu shift di satu hari) dengan biaya total terkecil.
 * Pencarian lengkap memakai DP bitmask (kelompok kecil, ≤ ±15 orang), jadi hasilnya optimal dan deterministik.
 */
export function assignGroup(people: number[], posts: string[], history: History, last: Map<number, string | null>): Map<number, string> {
  const n = people.length;
  const slots = [...posts.slice(0, n), ...Array.from({ length: Math.max(0, n - posts.length) }, () => RESERVE.code)];
  const cost = (p: number, slot: string) =>
    (history.get(p)?.get(slot) ?? 0) * 10 + (last.get(p) === slot ? 6 : 0) + ((p * 31 + slot.charCodeAt(0) * 7 + slot.charCodeAt(1)) % 13) / 100;
  // dp[mask] = biaya minimum menempatkan orang 0..popcount(mask)-1 pada slot di mask
  const size = 1 << n;
  const dp = new Float64Array(size).fill(Infinity);
  const choice = new Int8Array(size).fill(-1);
  dp[0] = 0;
  for (let mask = 0; mask < size; mask++) {
    if (dp[mask] === Infinity) continue;
    let i = 0;
    for (let m = mask; m; m &= m - 1) i++;
    if (i >= n) continue;
    for (let s = 0; s < n; s++) {
      if (mask & (1 << s)) continue;
      // Slot Cadangan identik: cukup isi yang pertama yang masih kosong
      if (slots[s] === RESERVE.code && s > 0 && slots[s - 1] === RESERVE.code && !(mask & (1 << (s - 1)))) continue;
      const next = mask | (1 << s);
      const c = dp[mask] + cost(people[i], slots[s]);
      if (c < dp[next]) {
        dp[next] = c;
        choice[next] = s;
      }
    }
  }
  const out = new Map<number, string>();
  let mask = size - 1;
  for (let i = n - 1; i >= 0; i--) {
    const s = choice[mask];
    out.set(people[i], slots[s]);
    mask &= ~(1 << s);
  }
  return out;
}

export interface PlacementDay {
  date: string;
  /** Kelompok per shift: daftar userId yang diplot (tanpa koordinator) */
  groups: number[][];
}

/** Membagi pos untuk beberapa hari berurutan; riwayat ikut diperbarui hari demi hari. */
export function assignPlacements(days: PlacementDay[], posts: string[], history: History, last: Map<number, string | null>) {
  const result = new Map<string, string>(); // `${userId}|${date}` → kode pos
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  for (const day of sorted) {
    const today = new Map<number, string | null>();
    for (const group of day.groups) {
      const people = [...group].sort((a, b) => a - b);
      for (const [p, code] of assignGroup(people, posts, history, last)) {
        result.set(`${p}|${day.date}`, code);
        const h = history.get(p) ?? new Map<string, number>();
        h.set(code, (h.get(code) ?? 0) + 1);
        history.set(p, h);
        today.set(p, code);
      }
    }
    // Yang tidak bekerja hari ini (Off) mulai "segar" lagi besoknya
    for (const p of last.keys()) if (!today.has(p)) last.set(p, null);
    for (const [p, code] of today) last.set(p, code);
  }
  return result;
}

const HISTORY_DAYS = 56;

/** Riwayat pos 8 minggu sebelum `from` + pos terakhir tiap orang, sebagai titik awal penggiliran. */
export async function loadHistory(from: string) {
  const rows = await EmployeeSchedule.findAll({
    where: { date: { [Op.between]: [addDays(from, -HISTORY_DAYS), addDays(from, -1)] }, post: { [Op.ne]: null } },
    order: [['date', 'ASC']],
  });
  const history: History = new Map();
  const last = new Map<number, string | null>();
  const yesterday = addDays(from, -1);
  for (const r of rows) {
    const h = history.get(r.userId) ?? new Map<string, number>();
    h.set(r.post!, (h.get(r.post!) ?? 0) + 1);
    history.set(r.userId, h);
    if (r.date === yesterday) last.set(r.userId, r.post);
  }
  return { history, last };
}

/** Siapa saja yang tidak diplot (koordinator). */
export async function plottedUserFilter() {
  const coordinators = await User.findAll({ where: { role: 'KOORDINATOR' }, attributes: ['id'] });
  const skip = new Set(coordinators.map((u) => u.id));
  return (userId: number) => !skip.has(userId);
}

/** Hitung ulang penempatan untuk roster tersimpan pada rentang tanggal (dipanggil setiap roster berubah). */
export async function rebalancePlacements(from: string, to: string) {
  const [posts, plotted, schedules, start] = await Promise.all([
    getPosts(),
    plottedUserFilter(),
    EmployeeSchedule.findAll({ where: { date: { [Op.between]: [from, to] } } }),
    loadHistory(from),
  ]);
  const byDate = new Map<string, Map<number, number[]>>();
  for (const s of schedules) {
    if (s.shiftId === null || !plotted(s.userId)) continue;
    const day = byDate.get(s.date) ?? new Map<number, number[]>();
    day.set(s.shiftId, [...(day.get(s.shiftId) ?? []), s.userId]);
    byDate.set(s.date, day);
  }
  const days: PlacementDay[] = [...byDate].map(([date, groups]) => ({ date, groups: [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, ids]) => ids) }));
  const result = assignPlacements(days, posts.map((p) => p.code), start.history, start.last);
  await sequelize.transaction(async (transaction) => {
    for (const s of schedules) {
      const post = result.get(`${s.userId}|${s.date}`) ?? null;
      if (s.post !== post) await s.update({ post }, { transaction });
    }
  });
}
