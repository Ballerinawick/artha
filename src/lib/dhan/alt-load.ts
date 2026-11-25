import { cachedStale } from "@/lib/market/cache";
import { istClock, istDateKey } from "@/lib/market/hours";
import { altSpec, type AltSpec } from "./alt-spec";
import { dhan } from "./client";
import { inCashSession } from "./day-tape";
import type { NiftyBook, OptContract } from "./nifty";
import { paced } from "./pace";
import type { Bar5 } from "./reversal";
import type { DhanCreds } from "./types";
import { LOTS } from "./universe";
import { pickExpiry } from "./week";

export type AltBook = NiftyBook & { symbol: string; name: string };

type ChainLeg = {
  security_id?: string | number;
  securityId?: string | number;
  SecurityId?: string | number;
  last_price?: number;
};

type ChainRow = { ce?: ChainLeg; CE?: ChainLeg; pe?: ChainLeg; PE?: ChainLeg };

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function findId(leg: ChainLeg | undefined): string {
  if (!leg) return "";
  for (const key of ["security_id", "securityId", "SecurityId"] as const) {
    const value = String(leg[key] ?? "");
    if (/^\d+$/.test(value) && value !== "0") return value;
  }
  return "";
}

function contract(leg: ChainLeg | undefined, strike: number, type: string): OptContract | null {
  const securityId = findId(leg);
  if (!securityId) return null;
  return { securityId, strike, ltp: num(leg?.last_price), type, why: "" };
}

function rowAt(oc: Record<string, ChainRow>, strike: number): ChainRow | undefined {
  const key = Object.keys(oc).find((name) => Math.abs(Number(name) - strike) < 0.01);
  return key ? oc[key] : undefined;
}

function around(strikes: number[], atm: number): number[] {
  const idx = strikes.reduce((best, strike, i) => (Math.abs(strike - atm) < Math.abs(strikes[best]! - atm) ? i : best), 0);
  return [strikes[idx - 1], strikes[idx], strikes[idx + 1]].filter((strike): strike is number => strike != null);
}

function istStamp(d: Date, withTime: boolean): string {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  if (!withTime) return date;
  return `${date} ${new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(d)}`;
}

async function frontFuture(spec: AltSpec): Promise<{ securityId: string; expiry: string; lot: number }> {
  const today = istStamp(new Date(), false);
  return cachedStale(`alt-fut:${spec.symbol}:${today}`, 60 * 60 * 1000, async () => {
    const res = await fetch("https://images.dhan.co/api-data/api-scrip-master.csv", { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`Could not read the ${spec.name} future.`);
    const lines = (await res.text()).split(/\r?\n/);
    const header = (lines[0] ?? "").split(",");
    const idAt = header.indexOf("SEM_SMST_SECURITY_ID");
    const symAt = header.indexOf("SEM_TRADING_SYMBOL");
    const expAt = header.indexOf("SEM_EXPIRY_DATE");
    const lotAt = header.indexOf("SEM_LOT_UNITS");
    let best: { securityId: string; expiry: string; lot: number } | null = null;
    for (const line of lines.slice(1)) {
      const col = line.split(",");
      const symbol = col[symAt] ?? "";
      if (!spec.fut.test(symbol)) continue;
      const expiry = (col[expAt] ?? "").slice(0, 10);
      const securityId = col[idAt] ?? "";
      const lot = Number(col[lotAt] ?? 0);
      if (!/^\d+$/.test(securityId) || expiry < today) continue;
      if (!best || expiry < best.expiry) best = { securityId, expiry, lot: lot > 0 ? lot : (LOTS[spec.symbol] ?? 0) };
    }
    if (!best) throw new Error(`No live ${spec.name} future was found.`);
    return best;
  });
}

async function minuteBars(creds: DhanCreds, securityId: string, instrument: AltSpec["optionInstrument"] | AltSpec["futureInstrument"]): Promise<Bar5[]> {
  const now = new Date();
  const from = new Date(now.getTime() - 2 * 86400000);
  const today = istDateKey(now);
  try {
    const data = await paced("data", () =>
      dhan<{ open?: number[]; high?: number[]; low?: number[]; close?: number[]; timestamp?: number[] }>(creds, "/charts/intraday", {
        method: "POST",
        retry429: true,
        body: {
          securityId,
          exchangeSegment: "NSE_FNO",
          instrument,
          interval: "1",
          oi: false,
          fromDate: `${istStamp(from, false)} 09:15:00`,
          toDate: istStamp(now, true),
        },
      }),
    );
    const closes = data.close ?? [];
    const todayBars: Bar5[] = [];
    const sessionBars: Bar5[] = [];
    for (let i = 0; i < closes.length; i++) {
      const close = closes[i] ?? 0;
      const ts = (data.timestamp?.[i] ?? 0) * 1000;
      if (!(close > 0) || ts < 1_000_000_000_000) continue;
      const t = Math.floor(ts / 60_000) * 60_000;
      if (!inCashSession(t)) continue;
      const bar: Bar5 = { t, o: data.open?.[i] || close, h: data.high?.[i] || close, l: data.low?.[i] || close, c: close, bid: 0, ask: 0 };
      sessionBars.push(bar);
      if (istClock(new Date(t)).date === today) todayBars.push(bar);
    }
    return todayBars.length ? todayBars : sessionBars.slice(-180);
  } catch {
    return [];
  }
}

export async function loadAltBook(creds: DhanCreds, symbol: string): Promise<AltBook> {
  const spec = altSpec(symbol);
  if (!spec) throw new Error("That book is not on the desk.");
  const [exp, futureMeta] = await Promise.all([
    paced("chain", () =>
      dhan<{ data?: string[] }>(creds, "/optionchain/expirylist", {
        method: "POST",
        retry429: true,
        body: { UnderlyingScrip: Number(spec.underlyingId), UnderlyingSeg: spec.segment },
      }),
    ),
    frontFuture(spec),
  ]);
  const expiry = pickExpiry(exp.data ?? []);
  if (!expiry) throw new Error(`${spec.name} has no listed expiry.`);
  const listed = await paced("chain", () =>
    dhan<{ data?: { last_price?: number; oc?: Record<string, ChainRow> } }>(creds, "/optionchain", {
      method: "POST",
      retry429: true,
      body: { UnderlyingScrip: Number(spec.underlyingId), UnderlyingSeg: spec.segment, Expiry: expiry },
    }),
  );
  const oc = listed.data?.oc ?? {};
  const strikes = Object.keys(oc).map(Number).filter((strike) => Number.isFinite(strike)).sort((a, b) => a - b);
  const spot = num(listed.data?.last_price);
  if (!strikes.length || !spot) throw new Error(`${spec.name} option chain came back empty.`);
  const futureBars = await minuteBars(creds, futureMeta.securityId, spec.futureInstrument);
  const futurePx = futureBars.length ? futureBars[futureBars.length - 1]!.c : 0;
  const anchor = futurePx > 0 ? futurePx : spot;
  const atm = strikes.reduce((best, strike) => (Math.abs(strike - anchor) < Math.abs(best - anchor) ? strike : best));
  const ladder: OptContract[] = [];
  for (const strike of around(strikes, atm)) {
    const row = rowAt(oc, strike);
    const call = contract(row?.ce ?? row?.CE, strike, "CE");
    const put = contract(row?.pe ?? row?.PE, strike, "PE");
    if (call) ladder.push({ ...call, why: strike < atm ? "in the money" : strike > atm ? "out of the money" : "at the money" });
    if (put) ladder.push({ ...put, why: strike > atm ? "in the money" : strike < atm ? "out of the money" : "at the money" });
  }
  const ce = ladder.find((leg) => leg.type === "CE" && leg.strike === atm) ?? null;
  const pe = ladder.find((leg) => leg.type === "PE" && leg.strike === atm) ?? null;
  if (!ce || !pe) throw new Error(`${spec.name} had no call and put at the money.`);
  const chain = strikes.flatMap((strike) => {
    const row = rowAt(oc, strike);
    const call = contract(row?.ce ?? row?.CE, strike, "CE");
    const put = contract(row?.pe ?? row?.PE, strike, "PE");
    if (!call || !put) return [];
    return [{ strike, ce: call.securityId, pe: put.securityId }];
  });
  const ladderBars: Record<string, Bar5[]> = {};
  for (const leg of ladder) ladderBars[leg.securityId] = await minuteBars(creds, leg.securityId, spec.optionInstrument);
  const lot = futureMeta.lot > 0 ? futureMeta.lot : (LOTS[spec.symbol] ?? 0);
  return {
    symbol: spec.symbol,
    name: spec.name,
    expiry,
    spot,
    lot,
    ce,
    pe,
    future: { securityId: futureMeta.securityId, strike: 0, ltp: futurePx, type: "FUT", why: futureMeta.expiry },
    ladder,
    chain,
    history: { future: futureBars, ce: ladderBars[ce.securityId] ?? [], pe: ladderBars[pe.securityId] ?? [], ladder: ladderBars },
  };
}

export async function loadAltMinutes(creds: DhanCreds, symbol: string, securityId: string): Promise<Bar5[]> {
  const spec = altSpec(symbol);
  if (!spec || !/^\d+$/.test(securityId)) return [];
  return minuteBars(creds, securityId, spec.optionInstrument);
}
