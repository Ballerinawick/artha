import { istClock, istDateKey } from "../market/hours.ts";

const OPEN = 9 * 60 + 15;
const CLOSE = 15 * 60 + 30;

export type CloseBar = { t: number; c: number };
export type DayFile = { date: string; expiry: string; legs: Record<string, CloseBar[]> };

let file: DayFile = { date: "", expiry: "", legs: {} };

export function inCashSession(ts: number): boolean {
  const clock = istClock(new Date(ts));
  if (clock.weekday === 0 || clock.weekday === 6) return false;
  return clock.minutes >= OPEN && clock.minutes <= CLOSE;
}

/** A new date or a new expiry throws yesterday away. Wednesday never keeps Tuesday's contract. */
export function nextDayFile(prev: DayFile | null, today: string, expiry: string): DayFile {
  if (prev && prev.date === today && prev.expiry === expiry) return prev;
  return { date: today, expiry, legs: {} };
}

export function mergeCloses(primary: CloseBar[], extra: CloseBar[]): CloseBar[] {
  const map = new Map<number, number>();
  for (const row of extra) {
    if (row.c > 0 && inCashSession(row.t)) map.set(row.t, row.c);
  }
  for (const row of primary) {
    if (row.c > 0 && inCashSession(row.t)) map.set(row.t, row.c);
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, c]) => ({ t, c }));
}

export function currentDay(): DayFile {
  return file;
}

export function adoptDay(next: DayFile) {
  file = next;
}

export function prepareDay(expiry: string) {
  file = nextDayFile(file.date ? file : null, istDateKey(), expiry);
}

export function barsFor(id: string): CloseBar[] {
  return file.legs[id] ?? [];
}

export function rememberLegs(expiry: string, legs: { id: string; bars: CloseBar[] }[]): boolean {
  const today = istDateKey();
  const forming = Math.floor(Date.now() / 60_000) * 60_000;
  file = nextDayFile(file.date ? file : null, today, expiry);
  if (file.date !== today || file.expiry !== expiry) return false;
  let changed = false;
  for (const leg of legs) {
    const closed = leg.bars.filter((bar) => bar.t < forming);
    const rows = mergeCloses(closed, file.legs[leg.id] ?? []).slice(-400);
    const prev = file.legs[leg.id] ?? [];
    if (rows.length === prev.length && rows.every((row, index) => row.t === prev[index]?.t && row.c === prev[index]?.c)) continue;
    file.legs[leg.id] = rows;
    changed = true;
  }
  return changed;
}
