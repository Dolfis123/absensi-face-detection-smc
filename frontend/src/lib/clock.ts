import { useEffect, useState } from 'react';
import { api } from './api';

let offsetMs = 0;
let synced: Promise<void> | null = null;

/** Selisih jam perangkat vs jam server, diambil sekali per sesi. */
function syncOnce() {
  synced ??= api
    .get<{ instant: string }>('/attendance/time')
    .then((t) => {
      offsetMs = new Date(t.instant).getTime() - Date.now();
    })
    .catch(() => undefined);
  return synced;
}

export interface WitClock {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM:SS
  minutes: number; // menit sejak 00:00 WIT
}

const read = (): WitClock => {
  const iso = new Date(Date.now() + offsetMs + 9 * 3600_000).toISOString();
  const [h, m] = [Number(iso.slice(11, 13)), Number(iso.slice(14, 16))];
  return { date: iso.slice(0, 10), time: iso.slice(11, 19), minutes: h * 60 + m };
};

/** Jam server dalam WIT, berdetak tiap detik (atau tiap `everyMs`). */
export function useServerClock(everyMs = 1000): WitClock {
  const [now, setNow] = useState(read);
  useEffect(() => {
    syncOnce().then(() => setNow(read()));
    const id = setInterval(() => setNow(read()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}
