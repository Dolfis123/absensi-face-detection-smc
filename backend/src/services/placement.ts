/**
 * Penempatan (plotting) petugas ke pos jaga, digilir supaya setiap orang merata di semua pos.
 *
 * - Daftar pos disimpan di app_settings (bisa diubah Super Admin/Koordinator).
 * - Setiap hari, petugas satu shift mengisi pos pintu sesuai urutan prioritas; kelebihan orang
 *   ditempatkan di area parkiran (pos lot), TIDAK ada Cadangan. Koordinator tidak diplot.
 * - Petugas perempuan hanya di pos pintu (tidak di area parkiran). Petugas Shift Siang
 *   ditempatkan di area parkiran untuk membantu Shift 2 di jam ramai.
 * - Pembagian memilih kombinasi dengan "biaya" terkecil: makin sering seseorang di pos itu,
 *   makin mahal; berada di pos yang sama dengan kemarin juga dihindari.
 */
import { Op } from 'sequelize';
import { AppSetting, EmployeeSchedule, RosterRule, Shift, ShiftChangeLog, User, sequelize } from '../models';
import { addDays } from '../utils/time';

export interface Post {
  code: string;
  area: string;
  name: string;
  /** Area parkiran (lot): bisa diisi banyak orang sekaligus; bukan untuk petugas perempuan */
  lot?: boolean;
}
export const RESERVE: Post = { code: 'CAD', area: 'Cadangan', name: 'Cadangan (bantu pos ramai & gantikan saat istirahat)' };

const POSTS_KEY = 'rosterPosts';
const COORD_POST_KEY = 'rosterCoordinatorPost';
/** Bawaan: Pintu Masuk Kasuari (KM) dijaga Koordinator di pagi hari */
export const DEFAULT_COORDINATOR_POST = 'KM';
export const DEFAULT_POSTS: Post[] = [
  { code: 'CK', area: 'Lobi Cendrawasih', name: 'Pintu Keluar' },
  { code: 'CM', area: 'Lobi Cendrawasih', name: 'Pintu Masuk' },
  { code: 'KK', area: 'Lobi Kasuari — Area Parkiran', name: 'Pintu Keluar' },
  { code: 'KM', area: 'Lobi Kasuari — Area Parkiran', name: 'Pintu Masuk' },
  { code: 'KL', area: 'Lobi Kasuari — Area Parkiran', name: 'Area Parkiran Lot', lot: true },
];

/** Daftar lama belum punya tanda "lot": kenali dari kode KL / nama yang memuat "Lot". */
const withLot = (p: Post): Post => ({ ...p, lot: p.lot ?? (p.code === 'KL' || /\blot\b/i.test(p.name)) });

export async function getPosts(): Promise<Post[]> {
  const row = await AppSetting.findByPk(POSTS_KEY);
  if (!row) return DEFAULT_POSTS;
  try {
    const list = JSON.parse(row.value) as Post[];
    return Array.isArray(list) ? list.map(withLot) : DEFAULT_POSTS;
  } catch {
    return DEFAULT_POSTS;
  }
}

/**
 * Pos pintu yang dijaga Koordinator selama Shift 1 (pagi). Petugas Shift 1 tidak ditempatkan di pos itu;
 * Shift 2 tetap mengisinya. Hari Koordinator Off, pos itu kosong di pagi hari. null = tidak ada.
 */
export async function getCoordinatorPost(posts?: Post[]): Promise<string | null> {
  const list = posts ?? (await getPosts());
  const row = await AppSetting.findByPk(COORD_POST_KEY);
  const code = row ? (row.value === '' ? null : row.value) : DEFAULT_COORDINATOR_POST;
  // Hanya berlaku bila pos itu masih ada dan merupakan pos pintu (bukan area parkiran)
  return code && list.some((p) => p.code === code && !p.lot) ? code : null;
}

export async function saveCoordinatorPost(code: string | null) {
  await AppSetting.upsert({ key: COORD_POST_KEY, value: code ?? '' });
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

export interface GroupRules {
  /** Petugas perempuan: hanya pos pintu */
  female: Set<number>;
  /** Kelompok Shift Siang: ke area parkiran */
  lotOnly?: boolean;
  /** Pos pintu yang tidak diisi kelompok ini (mis. dijaga Koordinator di pagi hari) */
  skip?: string | null;
}

/**
 * Membagi pos untuk satu kelompok (orang satu shift di satu hari) dengan biaya total terkecil.
 * Pos pintu diisi dulu (satu orang per pos), kelebihannya ke pos lot (boleh banyak orang).
 * Pencarian lengkap memakai DP bitmask (kelompok kecil, ≤ ±15 orang), jadi hasilnya optimal dan deterministik.
 */
export function assignGroup(people: number[], posts: Post[], history: History, last: Map<number, string | null>, rules: GroupRules = { female: new Set() }): Map<number, string> {
  const n = people.length;
  const gates = posts.filter((p) => !p.lot && p.code !== rules.skip).map((p) => p.code);
  const lots = posts.filter((p) => p.lot).map((p) => p.code);
  const extra = (k: number) => (lots.length ? lots[k % lots.length] : RESERVE.code);
  const slots =
    rules.lotOnly && lots.length
      ? Array.from({ length: n }, (_, k) => extra(k))
      : [...gates.slice(0, n), ...Array.from({ length: Math.max(0, n - gates.length) }, (_, k) => extra(k))];
  const isLot = (slot: string) => slot === RESERVE.code || lots.includes(slot);
  const cost = (p: number, slot: string) =>
    (rules.female.has(p) && isLot(slot) ? 1000 : 0) + // perempuan tidak di area parkiran
    (history.get(p)?.get(slot) ?? 0) * 10 +
    (last.get(p) === slot ? 6 : 0) +
    ((p * 31 + slot.charCodeAt(0) * 7 + slot.charCodeAt(1)) % 13) / 100;
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
      // Slot identik (mis. beberapa orang di pos lot yang sama): cukup isi yang pertama yang masih kosong
      if (s > 0 && slots[s] === slots[s - 1] && !(mask & (1 << (s - 1)))) continue;
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
  groups: { shiftId: number; ids: number[] }[];
}

export interface PlacementRules {
  female: Set<number>;
  siangId: number | null;
  /** Shift pagi tempat Koordinator menjaga pos `coordinatorPost` */
  shift1Id?: number | null;
  coordinatorPost?: string | null;
}

/** Membagi pos untuk beberapa hari berurutan; riwayat ikut diperbarui hari demi hari. */
export function assignPlacements(days: PlacementDay[], posts: Post[], history: History, last: Map<number, string | null>, rules: PlacementRules) {
  const result = new Map<string, string>(); // `${userId}|${date}` → kode pos
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  for (const day of sorted) {
    const today = new Map<number, string | null>();
    for (const group of day.groups) {
      const people = [...group.ids].sort((a, b) => a - b);
      const lotOnly = rules.siangId !== null && group.shiftId === rules.siangId;
      const skip = rules.shift1Id != null && group.shiftId === rules.shift1Id ? (rules.coordinatorPost ?? null) : null;
      for (const [p, code] of assignGroup(people, posts, history, last, { female: rules.female, lotOnly, skip })) {
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

/** Siapa saja yang tidak diplot (koordinator), siapa petugas perempuan, dan id Shift Siang. */
export async function placementRules() {
  const [coordinators, women, siang, shift1, coordinatorPost] = await Promise.all([
    User.findAll({ where: { role: 'KOORDINATOR' }, attributes: ['id'] }),
    RosterRule.findAll({ where: { female: true }, attributes: ['userId'] }),
    Shift.findOne({ where: { code: 'SHIFT_SIANG' } }),
    Shift.findOne({ where: { code: 'SHIFT_1' } }),
    getCoordinatorPost(),
  ]);
  const skip = new Set(coordinators.map((u) => u.id));
  return {
    plotted: (userId: number) => !skip.has(userId),
    /** Pos Koordinator pada hari ia bekerja (dicatat di roster supaya tampil di PDF & teks WhatsApp) */
    coordinatorPostOf: (shiftId: number | null) => (shiftId !== null ? coordinatorPost : null),
    rules: { female: new Set(women.map((r) => r.userId)), siangId: siang?.id ?? null, shift1Id: shift1?.id ?? null, coordinatorPost } as PlacementRules,
  };
}

/** Kelompokkan jadwal satu hari per shift (urut id shift supaya hasil stabil). */
export function groupsOf(entries: { userId: number; shiftId: number }[]) {
  const by = new Map<number, number[]>();
  for (const e of entries) by.set(e.shiftId, [...(by.get(e.shiftId) ?? []), e.userId]);
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([shiftId, ids]) => ({ shiftId, ids }));
}

/** Hitung ulang penempatan untuk roster tersimpan pada rentang tanggal (dipanggil setiap roster berubah). */
export async function rebalancePlacements(from: string, to: string) {
  const [posts, { plotted, rules, coordinatorPostOf }, schedules, start] = await Promise.all([
    getPosts(),
    placementRules(),
    EmployeeSchedule.findAll({ where: { date: { [Op.between]: [from, to] } } }),
    loadHistory(from),
  ]);
  const byDate = new Map<string, { userId: number; shiftId: number }[]>();
  for (const s of schedules) {
    if (s.shiftId === null || !plotted(s.userId)) continue;
    byDate.set(s.date, [...(byDate.get(s.date) ?? []), { userId: s.userId, shiftId: s.shiftId }]);
  }
  const days: PlacementDay[] = [...byDate].map(([date, entries]) => ({ date, groups: groupsOf(entries) }));
  const result = assignPlacements(days, posts, start.history, start.last, rules);
  await sequelize.transaction(async (transaction) => {
    for (const s of schedules) {
      const post = plotted(s.userId) ? (result.get(`${s.userId}|${s.date}`) ?? null) : coordinatorPostOf(s.shiftId);
      if (s.post !== post) await s.update({ post }, { transaction });
    }
  });
}
