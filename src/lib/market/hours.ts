import type { SessionState } from "./types";

const IST = "Asia/Kolkata";

export function istNow(date = new Date()): Date {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: IST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return new Date(
    Number(get("year")),
    Number(get("month")) - 1,
    Number(get("day")),
    Number(get("hour")),
    Number(get("minute")),
    Number(get("second")),
  );
}

export function formatIstStamp(date = new Date()): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: IST,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date) + " IST";
}

export function istDateKey(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: IST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function istClock(date = new Date()): { date: string; minutes: number; weekday: number } {
  const ist = istNow(date);
  return {
    date: istDateKey(date),
    minutes: ist.getHours() * 60 + ist.getMinutes(),
    weekday: ist.getDay(),
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
