import { istClock, istDateKey } from "../market/hours.ts";

/** The live Nifty expiry. An expired Tuesday is not used on Wednesday. A non-date list still returns a contract so the page can open. */
export function pickExpiry(list: string[], today = istDateKey()): string | null {
  const raw = list.map((item) => item.trim()).filter(Boolean);
  if (!raw.length) return null;
  const iso = raw.map((item) => item.slice(0, 10)).filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item));
  if (!iso.length) return raw[0]!.slice(0, 10);
  return iso.filter((item) => item >= today).sort()[0] ?? null;
}

/** Wednesday is day 1 of the Nifty week. Tuesday is expiry. A holiday does not move Tuesday. */
export function niftyWeekday(date = new Date()): string {
  const day = istClock(date).weekday;
  if (day === 3) return "Wednesday · day 1";
  if (day === 4) return "Thursday · day 2";
  if (day === 5) return "Friday · day 3";
  if (day === 1) return "Monday · day 4";
  if (day === 2) return "Tuesday · expiry";
  return "Weekend · closed";
}
