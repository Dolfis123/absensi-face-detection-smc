import { useEffect, useState } from 'react';

/** Identitas tempat & pengelola (diatur Super Admin di Identitas & Kop Surat). Dibaca sekali per muat halaman. */
export interface OrgPublic {
  companyName: string;
  placeName: string;
  placeShort: string;
  cityRegion: string;
  hasLogo: boolean;
}

const FALLBACK: OrgPublic = { companyName: '', placeName: 'Mall Sorong Modern City', placeShort: 'SMC', cityRegion: 'Kota Sorong, Papua Barat Daya', hasLogo: false };
let cache: OrgPublic | null = null;
let pending: Promise<OrgPublic> | null = null;
const listeners = new Set<(o: OrgPublic) => void>();

function load(force = false) {
  if (!force && (cache || pending)) return pending ?? Promise.resolve(cache!);
  pending = fetch('/api/organization/public')
    .then((r) => (r.ok ? (r.json() as Promise<OrgPublic>) : FALLBACK))
    .catch(() => FALLBACK)
    .then((o) => {
      cache = o;
      pending = null;
      document.title = `SMC-FaceAttend · ${postLabel(o)}`;
      listeners.forEach((l) => l(o));
      return o;
    });
  return pending;
}

/** Muat ulang setelah Super Admin menyimpan pengaturan. */
export const refreshOrg = () => load(true);

export function useOrg(): OrgPublic {
  const [org, setOrg] = useState<OrgPublic>(cache ?? FALLBACK);
  useEffect(() => {
    listeners.add(setOrg);
    load().then(setOrg);
    return () => {
      listeners.delete(setOrg);
    };
  }, []);
  return org;
}

/** Mis. "Pos Parkir SMC" (singkatan bila ada, selain itu nama tempat lengkap). */
export const postLabel = (o: OrgPublic) => `Pos Parkir ${o.placeShort || o.placeName}`;
