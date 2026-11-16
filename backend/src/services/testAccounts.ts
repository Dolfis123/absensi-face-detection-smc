/**
 * Akun uji coba (mis. "Testsatu", "Testdua"): tetap bisa login & absen untuk mencoba sistem,
 * tetapi tidak ikut laporan kehadiran, rekap upah, surat disiplin, monitoring, dan roster yang dibagikan.
 * Disimpan di app_settings (daftar id) supaya tabel users & data wajah tidak tersentuh.
 */
import { AppSetting } from '../models';

const KEY = 'testAccountIds';

export async function getTestAccountIds(): Promise<Set<number>> {
  const row = await AppSetting.findByPk(KEY);
  try {
    return new Set(row ? (JSON.parse(row.value) as number[]) : []);
  } catch {
    return new Set();
  }
}

export async function setTestAccount(userId: number, test: boolean) {
  const ids = await getTestAccountIds();
  if (test) ids.add(userId);
  else ids.delete(userId);
  await AppSetting.upsert({ key: KEY, value: JSON.stringify([...ids].sort((a, b) => a - b)) });
  return ids;
}
