import { cachedStale } from "@/lib/market/cache";
import { istClock, istDateKey } from "@/lib/market/hours";
import { dhan } from "./client";
import { inCashSession } from "./day-tape";
import { paced } from "./pace";
import type { Bar5 } from "./reversal";
import type { DhanCreds } from "./types";
import { LOTS } from "./universe";
import { pickExpiry } from "./week";

type ChainLeg = {
  security_id?: string | number;
  securityId?: string | number;
  SecurityId?: string | number;
  last_price?: number;
  top_bid_price?: number;
  top_ask_price?: number;
  volume?: number;
  greeks?: { delta?: number };
};

type ChainRow = { ce?: ChainLeg; CE?: ChainLeg; pe?: ChainLeg; PE?: ChainLeg };

export type OptContract = {
  securityId: string;
  strike: number;
  ltp: number;
  type: string;
  why: string;
};

export type NiftyBook = {
  expiry: string;
  spot: number;
  lot: number;
  ce: OptContract;
  pe: OptContract;
  future: OptContract;
  ladder: OptContract[];
  /** Strike ids only. The socket follows the one nearest the future. No history. */
  chain: { strike: number; ce: string; pe: string }[];
  history: { ce: Bar5[]; pe: Bar5[]; future: Bar5[]; ladder: Record<string, Bar5[]> };
};

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

/** ATM, the strike below, and the strike above. */
function centeredStrikes(strikes: number[], atm: number): number[] {
  if (!strikes.length) return [];
  const idx = strikes.reduce((best, strike, i) => (Math.abs(strike - atm) < Math.abs(strikes[best]! - atm) ? i : best), 0);
  const picked = [strikes[idx - 1], strikes[idx], strikes[idx + 1]].filter((strike): strike is number => strike != null);
  return picked;
}

function istStamp(d: Date, withTime: boolean): string {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  if (!withTime) return date;
  return `${date} ${new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(d)}`;
}

async function nearestFuture(): Promise<OptContract> {
  const today = istStamp(new Date(), false);
  return cachedStale(`nifty-fut-front:${today}`, 60 * 60 * 1000, async () => {
    const res = await fetch("https://images.dhan.co/api-data/api-scrip-master.csv", { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error("Could not read the Nifty future from Dhan's scrip list.");
    const lines = (await res.text()).split(/\r?\n/);
    const header = (lines[0] ?? "").split(",");
    const idAt = header.indexOf("SEM_SMST_SECURITY_ID");
    const symAt = header.indexOf("SEM_TRADING_SYMBOL");
    const expAt = header.indexOf("SEM_EXPIRY_DATE");
    let best: { id: string; expiry: string } | null = null;
    for (const line of lines.slice(1)) {
      const col = line.split(",");
      const symbol = col[symAt] ?? "";
      if (!/^NIFTY-[A-Za-z]{3}\d{4}-FUT$/.test(symbol)) continue;
      const expiry = (col[expAt] ?? "").slice(0, 10);
      const id = col[idAt] ?? "";
      if (!/^\d+$/.test(id) || expiry < today) continue;
      if (!best || expiry < best.expiry) best = { id, expiry };
    }
    if (!best) throw new Error("No live Nifty future contract was found.");
    return { securityId: best.id, strike: 0, ltp: 0, type: "FUT", why: best.expiry };
  });
}

async function minuteBars(creds: DhanCreds, securityId: string, instrument: "OPTIDX" | "FUTIDX"): Promise<Bar5[]> {
  const now = new Date();
  const from = new Date(now.getTime() - 2 * 86400000);
  const today = istDateKey(now);
  try {
    const data = await dhan<{ open?: number[]; high?: number[]; low?: number[]; close?: number[]; timestamp?: number[] }>(
      creds,
      "/charts/intraday",
      {
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
      },
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
      const bar: Bar5 = {
        t,
        o: data.open?.[i] || close,
        h: data.high?.[i] || close,
        l: data.low?.[i] || close,
        c: close,
        bid: 0,
        ask: 0,
      };
      sessionBars.push(bar);
      if (istClock(new Date(t)).date === today) todayBars.push(bar);
    }
    return todayBars.length ? todayBars : sessionBars.slice(-180);
  } catch {
    return [];
  }
}

const inflight = new Map<string, Promise<NiftyBook>>();

async function fetchNiftyBook(creds: DhanCreds): Promise<NiftyBook> {
  const [exp, future] = await Promise.all([
    dhan<{ data?: string[] }>(creds, "/optionchain/expirylist", {
      method: "POST",
      retry429: true,
      body: { UnderlyingScrip: 13, UnderlyingSeg: "IDX_I" },
    }),
    nearestFuture(),
  ]);
  const expiry = pickExpiry(exp.data ?? []);
  if (!expiry) throw new Error("Nifty has no listed expiry on Dhan.");
  await new Promise((resolve) => setTimeout(resolve, 3200));
  const listed = await dhan<{ data?: { last_price?: number; oc?: Record<string, ChainRow> } }>(creds, "/optionchain", {
    method: "POST",
    retry429: true,
    body: { UnderlyingScrip: 13, UnderlyingSeg: "IDX_I", Expiry: expiry },
  });
  const oc = listed.data?.oc ?? {};
  const strikes = Object.keys(oc)
    .map(Number)
    .filter((strike) => Number.isFinite(strike))
    .sort((a, b) => a - b);
  const spot = num(listed.data?.last_price);
  if (!strikes.length || !spot) throw new Error("Nifty option chain came back empty.");
  const futureBars = await minuteBars(creds, future.securityId, "FUTIDX");
  const futurePx = futureBars.length ? futureBars[futureBars.length - 1]!.c : 0;
  const anchor = futurePx > 0 ? futurePx : spot;
  const atm = strikes.reduce((best, strike) => (Math.abs(strike - anchor) < Math.abs(best - anchor) ? strike : best));
  const windowStrikes = centeredStrikes(strikes, atm);
  const ladder: OptContract[] = [];
  for (const strike of windowStrikes) {
    const row = rowAt(oc, strike);
    const call = contract(row?.ce ?? row?.CE, strike, "CE");
    const put = contract(row?.pe ?? row?.PE, strike, "PE");
    const callWhy = strike < atm ? "in the money" : strike > atm ? "out of the money" : "at the money";
    const putWhy = strike > atm ? "in the money" : strike < atm ? "out of the money" : "at the money";
    if (call) ladder.push({ ...call, why: callWhy });
    if (put) ladder.push({ ...put, why: putWhy });
  }
  const ce = ladder.find((leg) => leg.type === "CE" && leg.strike === atm) ?? null;
  const pe = ladder.find((leg) => leg.type === "PE" && leg.strike === atm) ?? null;
  if (!ce || !pe) throw new Error("No liquid call or put had a Dhan contract id.");
  const chain = strikes.flatMap((strike) => {
    const row = rowAt(oc, strike);
    const call = contract(row?.ce ?? row?.CE, strike, "CE");
    const put = contract(row?.pe ?? row?.PE, strike, "PE");
    if (!call || !put) return [];
    return [{ strike, ce: call.securityId, pe: put.securityId }];
  });
  const ladderBars: Record<string, Bar5[]> = {};
  for (const leg of ladder) {
    ladderBars[leg.securityId] = await paced("data", () => minuteBars(creds, leg.securityId, "OPTIDX"));
  }
  return {
    expiry,
    spot,
    lot: LOTS.NIFTY ?? 65,
    ce,
    pe,
    future,
    ladder,
    chain,
    history: {
      future: futureBars,
      ce: ladderBars[ce.securityId] ?? [],
      pe: ladderBars[pe.securityId] ?? [],
      ladder: ladderBars,
    },
  };
}

export async function loadOptionMinutes(creds: DhanCreds, securityId: string): Promise<Bar5[]> {
  if (!/^\d+$/.test(securityId)) return [];
  return paced("data", () => minuteBars(creds, securityId, "OPTIDX"));
}

export function loadNiftyBook(creds: DhanCreds): Promise<NiftyBook> {
  const pending = inflight.get(creds.clientId);
  if (pending) return pending;
  const job = cachedStale(`niftybook:v8:${creds.clientId}`, 120_000, () => fetchNiftyBook(creds)).finally(() => {
    inflight.delete(creds.clientId);
  });
  inflight.set(creds.clientId, job);
  return job;
}
