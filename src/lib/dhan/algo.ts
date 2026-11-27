import { istClock } from "../market/hours.ts";
export type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };

export type Check = { name: string; pass: boolean; detail: string };

export type Diagnosis = { setup: Setup | null; reason: string };

export type Setup = {
  side: "BUY" | "SELL";
  entry: number;
  target: number;
  score: number;
  checks: Check[];
  atr: number;
  mode: "live" | "review";
  sessionDate: string;
};

export function istParts(epochMs: number) {
  // Per-bar call: plain IST arithmetic, not a new Intl.DateTimeFormat each time.
  const { date, minutes } = istClock(new Date(epochMs));
  return { date, minutes };
}

function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (const v of values.slice(period)) prev = v * k + prev * (1 - k);
  return prev;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function atr(bars: Bar[], period = 14): number {
  if (bars.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i]!;
    const prev = bars[i - 1]!;
    trs.push(Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c)));
  }
  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function vwap(bars: Bar[]): number | null {
  let pv = 0;
  let vol = 0;
  for (const b of bars) {
    const tp = (b.h + b.l + b.c) / 3;
    const v = b.v > 0 ? b.v : 1;
    pv += tp * v;
    vol += v;
  }
  return vol ? pv / vol : null;
}

function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function groupSessions(bars: Bar[]): Map<string, Bar[]> {
  const map = new Map<string, Bar[]>();
  for (const b of bars) {
    const { date, minutes } = istParts(b.t);
    if (minutes < 9 * 60 + 15 || minutes > 15 * 60 + 30) continue;
    const list = map.get(date) ?? [];
    list.push(b);
    map.set(date, list);
  }
  return map;
}

/**
 * Auction stack. A print needs the opening-range break held for two closes,
 * VWAP, a short EMA stack, and room left to the target — plus volume or the
 * daily trend. No stop is attached. Most names should stay quiet.
 */
export function diagnose(bars: Bar[], dailyCloses: number[], now = Date.now()): Diagnosis {
  const sessions = groupSessions(bars);
  const dates = [...sessions.keys()].sort();
  if (!dates.length) return { setup: null, reason: "No cash-session bars on the Dhan feed." };
  const today = istParts(now).date;
  const todayBars = sessions.get(today);
  const useLive = !!todayBars && todayBars.length >= 4 && istParts(now).minutes >= 9 * 60 + 30;
  const sessionDate = useLive ? today : dates[dates.length - 1]!;
  const session = sessions.get(sessionDate);
  if (!session || session.length < 4) return { setup: null, reason: "Not enough 5-minute bars in the session." };

  const orBars = session.filter((b) => {
    const m = istParts(b.t).minutes;
    return m >= 9 * 60 + 15 && m < 9 * 60 + 30;
  });
  if (orBars.length < 2) return { setup: null, reason: "Opening range is still incomplete." };
  const orHigh = Math.max(...orBars.map((b) => b.h));
  const orLow = Math.min(...orBars.map((b) => b.l));
  const last = session[session.length - 1]!;
  const prev = session[session.length - 2]!;
  const long = last.c > orHigh;
  const short = last.c < orLow;
  if (!long && !short) return { setup: null, reason: "Last close is still inside the 9:15–9:30 range." };
  const side: "BUY" | "SELL" = long ? "BUY" : "SELL";
  const held = long ? prev.c > orHigh : prev.c < orLow;
  if (!held) return { setup: null, reason: "The break is only one close. Waiting for a second." };

  const breakout = session.find((b) => (long ? b.c > orHigh : b.c < orLow));
  const vw = vwap(session);
  const closes = session.map((b) => b.c);
  const e9 = ema(closes, 5);
  const e21 = ema(closes, 8);
  const priorVol = session.slice(0, -1).map((b) => b.v).filter((v) => v > 0);
  const volBase = median(priorVol.slice(-12));
  const volOk = volBase > 0 && (breakout?.v ?? 0) >= volBase * 1.25;
  const dSma = sma(dailyCloses, 20);
  const trendOk =
    dSma == null
      ? null
      : long
        ? dailyCloses[dailyCloses.length - 1]! > dSma
        : dailyCloses[dailyCloses.length - 1]! < dSma;
  const range = atr(session);
  const width = Math.max(orHigh - orLow, last.c * 0.0015);
  const stretch = Math.abs(last.c - (long ? orHigh : orLow));
  const room = stretch <= width * 2;

  const checks: Check[] = [
    {
      name: "Range",
      pass: true,
      detail: long
        ? `Close ${last.c.toFixed(2)} is through ${orHigh.toFixed(2)}`
        : `Close ${last.c.toFixed(2)} is through ${orLow.toFixed(2)}`,
    },
    {
      name: "Held",
      pass: true,
      detail: "Two closes are outside the opening range",
    },
    {
      name: "VWAP",
      pass: vw != null && (long ? last.c > vw : last.c < vw),
      detail: vw == null ? "VWAP unavailable" : `VWAP ${vw.toFixed(2)}`,
    },
    {
      name: "EMA",
      pass: e9 != null && e21 != null && (long ? e9 > e21 : e9 < e21),
      detail: e9 != null && e21 != null ? `EMA5 ${e9.toFixed(2)} · EMA8 ${e21.toFixed(2)}` : "Needs a few more bars",
    },
    {
      name: "Room",
      pass: room,
      detail: `Move ${stretch.toFixed(2)} vs opening range ${width.toFixed(2)}`,
    },
    {
      name: "Volume",
      pass: volOk,
      detail: volBase
        ? `Breakout ${Math.round(breakout?.v ?? 0)} vs typical ${Math.round(volBase)}`
        : "Volume missing on this feed",
    },
  ];
  if (trendOk != null) {
    checks.push({
      name: "Daily",
      pass: trendOk,
      detail: `20-day average ${dSma!.toFixed(2)}`,
    });
  }

  const failed = checks.filter((c) => !c.pass && c.name !== "Volume" && c.name !== "Daily");
  if (failed.length) {
    return { setup: null, reason: `${failed.map((c) => c.name).join(" and ")} refused the break.` };
  }
  const extras = checks.filter((c) => (c.name === "Volume" || c.name === "Daily") && c.pass).length;
  if (extras < 1) return { setup: null, reason: "Volume and the 20-day trend both refused." };

  const passed = checks.filter((c) => c.pass).length;
  const pad = Math.max(range * 1.6, last.c * 0.004);
  const target = long ? last.c + pad : last.c - pad;

  return {
    setup: {
      side,
      entry: last.c,
      target: Number(target.toFixed(2)),
      score: Math.round((passed / checks.length) * 100),
      checks,
      atr: range,
      mode: useLive ? "live" : "review",
      sessionDate,
    },
    reason: "",
  };
}

export function readSetup(bars: Bar[], dailyCloses: number[], now = Date.now()): Setup | null {
  return diagnose(bars, dailyCloses, now).setup;
}

