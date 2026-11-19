import { istClock } from "../market/hours.ts";

/** Lightsail desk clock, IST, Monday to Friday.
 *  Wake early enough to load the chain. Orders wait until 09:15.
 *  15:20 flats anything open and blocks a new buy. 15:30 the feed stops. */
export const PREP_MINUTE = 9 * 60 + 8;
export const ARM_MINUTE = 9 * 60 + 14;
export const LIVE_MINUTE = 9 * 60 + 15;
export const FLAT_MINUTE = 15 * 60 + 20;
export const DOWN_MINUTE = 15 * 60 + 30;

export type DeskPhase = "sleep" | "arm" | "live" | "flatten" | "shutdown";

export type SessionCut = { lastEntry: number; flat: number };

/** Passed into the cross book. The ₹5 / ₹2 rules are untouched. */
export const SERVER_CUT: SessionCut = { lastEntry: FLAT_MINUTE, flat: FLAT_MINUTE };

export function deskPhase(now = new Date()): DeskPhase {
  const clock = istClock(now);
  if (clock.weekday === 0 || clock.weekday === 6) return "sleep";
  const minute = clock.minutes;
  if (minute < PREP_MINUTE || minute >= DOWN_MINUTE) return minute >= DOWN_MINUTE ? "shutdown" : "sleep";
  if (minute < LIVE_MINUTE) return "arm";
  if (minute < FLAT_MINUTE) return "live";
  return "flatten";
}

export function ordersAllowed(phase: DeskPhase, side: "BUY" | "SELL"): boolean {
  if (side === "BUY") return phase === "live";
  return phase === "live" || phase === "flatten";
}

/** Milliseconds until the desk should be awake. Zero while it is arming, live, or flattening. */
export function msUntilSession(now = new Date()): number {
  const phase = deskPhase(now);
  if (phase === "arm" || phase === "live" || phase === "flatten") return 0;
  const clock = istClock(now);
  const [year, month, day] = clock.date.split("-").map(Number);
  for (let add = 0; add < 8; add++) {
    const target = utcFromIst(year!, month!, day! + add, 9, 8);
    if (target.getTime() <= now.getTime()) continue;
    const weekday = istClock(target).weekday;
    if (weekday === 0 || weekday === 6) continue;
    return target.getTime() - now.getTime();
  }
  return 60 * 60 * 1000;
}

function utcFromIst(year: number, month: number, day: number, hour: number, minute: number): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0) - (5 * 60 + 30) * 60 * 1000);
}
