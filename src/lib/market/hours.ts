import type { SessionState } from "./types";

const IST = "Asia/Kolkata";

/** India has no daylight saving, so IST is always UTC+05:30. Plain arithmetic, no Intl.
 *  Building an Intl.DateTimeFormat per call cost ~110 µs and ~20 KB of off-heap ICU memory;
 *  the desk called this for every bar on every tick, which filled RAM and pinned the CPU. */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

function shifted(date: Date): Date {
  return new Date(date.getTime() + IST_OFFSET_MS);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function istNow(date = new Date()): Date {
  const d = shifted(date);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
}

let stampFormat: Intl.DateTimeFormat | null = null;

export function formatIstStamp(date = new Date()): string {
  stampFormat ??= new Intl.DateTimeFormat("en-IN", {
    timeZone: IST,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return stampFormat.format(date) + " IST";
}

export function istDateKey(date = new Date()): string {
  const d = shifted(date);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function istClock(date = new Date()): { date: string; minutes: number; weekday: number } {
  const d = shifted(date);
  return {
    date: `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`,
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    weekday: d.getUTCDay(),
  };
}

export function marketSession(date = new Date()): {
  session: SessionState;
  label: string;
} {
  const ist = istNow(date);
  const day = ist.getDay();
  const minutes = ist.getHours() * 60 + ist.getMinutes();
  const open = 9 * 60 + 15;
  const pre = 9 * 60;
  const close = 15 * 60 + 30;
  const post = 16 * 60;

  if (day === 0 || day === 6) {
    return { session: "closed", label: "Weekend · NSE closed" };
  }
  if (minutes >= pre && minutes < open) {
    return { session: "pre", label: "Pre-open · 9:00–9:15 IST" };
  }
  if (minutes >= open && minutes < close) {
    return { session: "open", label: "Live · NSE cash 9:15–15:30 IST" };
  }
  if (minutes >= close && minutes < post) {
    return { session: "post", label: "Post-close · auction / wrap" };
  }
  return { session: "closed", label: "NSE closed · next open 9:15 IST" };
}

export function formatInr(value: number, digits = 2): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);
}

export function formatQty(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e7) return `${(value / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${(value / 1e5).toFixed(2)} L`;
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(value);
}

export function formatPct(value: number, digits = 2): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}%`;
}
