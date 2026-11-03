/** ATM only. Buy the rising leg at the circle, one lot, on the 1-minute bar.
 *  Hold while that leg stays ahead. A ₹5 lead that gives back ₹2 closes at the high.
 *  If the other leg is ahead by ₹2 on a later minute, the idea is dead: get out, do not switch.
 *  Flat by 15:29. */

import { istClock } from "../market/hours.ts";
import { inCashSession } from "./day-tape.ts";

export const CROSS_BROKERAGE = 60;
const GAP_MS = 6 * 60 * 1000;
const MINUTE = 60_000;
const OPEN = 9 * 60 + 15;
const LAST_ENTRY = 15 * 60 + 20;
const FLAT = 15 * 60 + 29;
/** Our lead must open by at least this much before a turn is a real high. */
const REAL_EXPAND = 5;
/** Our lead must fall at least this far from that high before the buy is closed. */
const REAL_GIVE = 2;
/** The other leg this far ahead, on a minute after the entry, means the circle failed. */
const FLIP = 2;

export type ExitWhy = "turned" | "flipped" | "flat";

export type WaveLeg = {
  contract: { securityId: string; type: string; strike: number };
  ltp: number;
  bars: { t: number; c: number }[];
  prints: { t: number; c: number }[];
  seconds?: { t: number; c: number }[];
};

export type Hit = {
  id: string;
  t: number;
  ceId: string;
  peId: string;
  ceStrike: number;
  peStrike: number;
  ce: number;
  pe: number;
  ceDelta: number;
  peDelta: number;
};

export type CrossSide = {
  type: "CE" | "PE";
  strike: number;
  securityId: string;
  entry: number;
  exit?: number;
  mark: number;
};

export type CrossTrade = {
  id: string;
  pair: string;
  ceId: string;
  peId: string;
  entryTs: number;
  exitTs?: number;
  lots: number;
  lot: number;
  expiry: string;
  frame: "1m";
  reason: string;
  exitWhy?: ExitWhy;
  buy: CrossSide;
  status: "open" | "closed";
};

export type BookSnap = {
  trades: CrossTrade[];
  seen: string[];
  total: number;
  closedPnl: number;
};

export const EMPTY_BOOK: BookSnap = { trades: [], seen: [], total: 0, closedPnl: 0 };

type Point = { t: number; price: number };
type Quote = { t: number; ce: number; pe: number };

export function atmPair(legs: WaveLeg[], anchor: number): { ce: WaveLeg; pe: WaveLeg } | null {
  if (!(anchor > 0)) return null;
  const strikes = [...new Set(legs.map((leg) => leg.contract.strike))].filter((strike) => {
    return (
      legs.some((leg) => leg.contract.strike === strike && leg.contract.type === "CE") &&
      legs.some((leg) => leg.contract.strike === strike && leg.contract.type === "PE")
    );
  });
  if (!strikes.length) return null;
  const strike = strikes.reduce((best, next) => (Math.abs(next - anchor) < Math.abs(best - anchor) ? next : best));
  const ce = legs.find((leg) => leg.contract.type === "CE" && leg.contract.strike === strike);
  const pe = legs.find((leg) => leg.contract.type === "PE" && leg.contract.strike === strike);
  if (!ce || !pe) return null;
  return { ce, pe };
}

export function reduceAtm(
  book: BookSnap,
  legs: WaveLeg[],
  lot: number,
  expiry: string,
  anchor: number,
  now = Date.now(),
): BookSnap {
  const seen = new Set(book.seen);
  let trades = book.trades;
  let total = book.total;
  let closedPnl = book.closedPnl;
  let changed = false;
  let open = trades.find((trade) => trade.status === "open") ?? null;
  const pair = atmPair(legs, anchor);
  const cePts = pair ? samplesOf(pair.ce, now) : [];
  const pePts = pair ? samplesOf(pair.pe, now) : [];
  const hits = pair ? pairHits(pair.ce, cePts, pair.pe, pePts) : [];

  const closeOpen = (at: Quote, why: ExitWhy) => {
    if (!open) return;
    const closed = closeAt(open, at, why);
    closedPnl += crossPnl(closed, closed.buy.exit ?? closed.buy.entry, true);
    trades = trades.map((trade) => (trade.id === closed.id ? closed : trade));
    open = null;
    changed = true;
  };

  for (const hit of hits) {
    if (open && hit.ceId === open.ceId && hit.peId === open.peId) {
      const turn = turnOf(open, quotesOf(open, legs, now), hit.t);
      if (turn) closeOpen(turn.at, turn.why);
    }
    if (seen.has(hit.id)) continue;
    if (open) continue;
    seen.add(hit.id);
    changed = true;
    if (!canEnter(hit.t) || hit.t < latestTs(trades)) continue;
    const opened = openFrom(hit, lot, expiry);
    if (!opened) continue;
    total += 1;
    trades = [opened, ...trades];
    open = opened;
  }

  if (open) {
    const path = quotesOf(open, legs, now);
    const turn = turnOf(open, path, Number.POSITIVE_INFINITY);
    if (turn) closeOpen(turn.at, turn.why);
    else if (mustFlat(now)) {
      const last = [...path].reverse().find((point) => istClock(new Date(point.t)).minutes <= FLAT);
      if (last) closeOpen(last, "flat");
    }
  }

  if (!changed) return book;
  return { trades: trimTrades(trades), seen: trimSeen(seen), total, closedPnl };
}

export function crossPnl(trade: CrossTrade, buyPx: number, charge: boolean): number {
  const qty = trade.lots * trade.lot;
  const gross = (buyPx - trade.buy.entry) * qty;
  return gross - (charge ? CROSS_BROKERAGE : 0);
}

export function markTrades(trades: CrossTrade[], priceOf: (id: string) => number | undefined): CrossTrade[] {
  let changed = false;
  const next = trades.map((trade) => {
    if (trade.status !== "open") return trade;
    const buyPx = priceOf(trade.buy.securityId);
    if (!(buyPx && buyPx > 0) || buyPx === trade.buy.mark) return trade;
    changed = true;
    return { ...trade, buy: { ...trade.buy, mark: buyPx } };
  });
  return changed ? next : trades;
}

function openFrom(hit: Hit, lot: number, expiry: string): CrossTrade | null {
  const buyPut = hit.ceDelta < 0 && hit.peDelta > 0;
  const buyCall = hit.ceDelta > 0 && hit.peDelta < 0;
  if ((!buyPut && !buyCall) || !(lot > 0)) return null;
  const buyType = buyPut ? "PE" : "CE";
  return {
    id: hit.id,
    pair: `${hit.ceId}|${hit.peId}`,
    ceId: hit.ceId,
    peId: hit.peId,
    entryTs: hit.t,
    lots: 1,
    lot,
    expiry,
    frame: "1m",
    reason: buyCall ? "Call rising" : "Put rising",
    buy: side(buyType, hit),
    status: "open",
  };
}

function side(type: "CE" | "PE", hit: Hit): CrossSide {
  const call = type === "CE";
  const price = call ? hit.ce : hit.pe;
  return {
    type,
    strike: call ? hit.ceStrike : hit.peStrike,
    securityId: call ? hit.ceId : hit.peId,
    entry: price,
    mark: price,
  };
}

function closeAt(trade: CrossTrade, at: Quote, why: ExitWhy): CrossTrade {
  const buyExit = trade.buy.type === "CE" ? at.ce : at.pe;
  return {
    ...trade,
    status: "closed",
    exitTs: at.t,
    exitWhy: why,
    buy: { ...trade.buy, exit: buyExit, mark: buyExit },
  };
}

function latestTs(trades: CrossTrade[]): number {
  let last = 0;
  for (const trade of trades) last = Math.max(last, trade.exitTs ?? trade.entryTs);
  return last;
}

function quotesOf(trade: CrossTrade, legs: WaveLeg[], now: number): Quote[] {
  const ce = legs.find((leg) => leg.contract.securityId === trade.ceId);
  const pe = legs.find((leg) => leg.contract.securityId === trade.peId);
  if (!ce || !pe) return [];
  return align(samplesOf(ce, now), samplesOf(pe, now));
}

function leadOf(trade: CrossTrade, point: Quote): number {
  return trade.buy.type === "CE" ? point.ce - point.pe : point.pe - point.ce;
}

function turnOf(trade: CrossTrade, path: Quote[], until: number): { at: Quote; why: ExitWhy } | null {
  let peak = 0;
  let at: Quote | null = null;
  const entryMinute = Math.floor(trade.entryTs / MINUTE);
  for (const point of path) {
    if (point.t <= trade.entryTs || point.t >= until) continue;
    if (Math.floor(point.t / MINUTE) <= entryMinute) continue;
    const lead = leadOf(trade, point);
    if (lead > peak) {
      peak = lead;
      at = point;
      continue;
    }
    if (at && peak >= REAL_EXPAND && peak - lead >= REAL_GIVE) return { at, why: "turned" };
    if (lead <= -FLIP) return { at: point, why: "flipped" };
  }
  return null;
}

function canEnter(ts: number): boolean {
  const clock = istClock(new Date(ts));
  if (clock.weekday === 0 || clock.weekday === 6) return false;
  return clock.minutes >= OPEN && clock.minutes < LAST_ENTRY;
}

function mustFlat(now: number): boolean {
  const clock = istClock(new Date(now));
  if (clock.weekday === 0 || clock.weekday === 6) return true;
  return clock.minutes >= FLAT;
}

function align(ce: Point[], pe: Point[]): Quote[] {
  if (!ce.length || !pe.length) return [];
  const times = [...new Set([...ce.map((point) => point.t), ...pe.map((point) => point.t)])].sort((a, b) => a - b);
  const out: Quote[] = [];
  for (const t of times) {
    const call = valueAt(ce, t);
    const put = valueAt(pe, t);
    if (call == null || put == null) continue;
    out.push({ t, ce: call, pe: put });
  }
  return out;
}

function valueAt(points: Point[], t: number): number | null {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last || t < first.t || t > last.t) return null;
  for (let i = 0; i < points.length; i++) {
    const point = points[i]!;
    if (point.t === t) return point.price;
    const next = points[i + 1];
    if (next && point.t < t && t < next.t) return lerp(point.t, point.price, next.t, next.price, t);
  }
  return null;
}

function trimTrades(trades: CrossTrade[]): CrossTrade[] {
  const open = trades.filter((trade) => trade.status === "open");
  const closed = trades.filter((trade) => trade.status === "closed").slice(0, 120);
  return [...open, ...closed];
}

function trimSeen(seen: Set<string>): string[] {
  const ids = [...seen];
  return ids.length > 8000 ? ids.slice(-8000) : ids;
}

function pairHits(call: WaveLeg, cePts: Point[], put: WaveLeg, pePts: Point[]): Hit[] {
  const hits: Hit[] = [];
  let i = 0;
  let j = 0;
  while (i < cePts.length - 1 && j < pePts.length - 1) {
    const hit = segmentHit(call, cePts[i]!, cePts[i + 1]!, put, pePts[j]!, pePts[j + 1]!);
    if (hit) hits.push(hit);
    if (cePts[i + 1]!.t <= pePts[j + 1]!.t) i += 1;
    else j += 1;
  }
  return hits;
}

function segmentHit(call: WaveLeg, a0: Point, a1: Point, put: WaveLeg, b0: Point, b1: Point): Hit | null {
  if (call.contract.strike !== put.contract.strike) return null;
  if (a1.t - a0.t > GAP_MS || b1.t - b0.t > GAP_MS) return null;
  const t0 = Math.max(a0.t, b0.t);
  const t1 = Math.min(a1.t, b1.t);
  if (!(t1 > t0) || t1 - t0 > GAP_MS) return null;
  const ya0 = lerp(a0.t, a0.price, a1.t, a1.price, t0);
  const ya1 = lerp(a0.t, a0.price, a1.t, a1.price, t1);
  const yb0 = lerp(b0.t, b0.price, b1.t, b1.price, t0);
  const yb1 = lerp(b0.t, b0.price, b1.t, b1.price, t1);
  const d0 = ya0 - yb0;
  const d1 = ya1 - yb1;
  if (!(d0 * d1 < 0)) return null;
  const u = d0 / (d0 - d1);
  const t = t0 + u * (t1 - t0);
  const ce = ya0 + u * (ya1 - ya0);
  const pe = yb0 + u * (yb1 - yb0);
  if (!(ce > 0) || !(pe > 0)) return null;
  const bucket = Math.floor(t / MINUTE) * MINUTE;
  return {
    id: `1m|${call.contract.securityId}|${put.contract.securityId}|${bucket}`,
    t,
    ceId: call.contract.securityId,
    peId: put.contract.securityId,
    ceStrike: call.contract.strike,
    peStrike: put.contract.strike,
    ce,
    pe,
    ceDelta: a1.price - a0.price,
    peDelta: b1.price - b0.price,
  };
}

function samplesOf(leg: WaveLeg, now: number): Point[] {
  const forming = Math.floor(now / 60_000) * 60_000;
  const day = istClock(new Date(now)).date;
  const map = new Map<number, number>();
  for (const bar of leg.bars) {
    if (!(bar.c > 0) || bar.t >= forming || !inCashSession(bar.t)) continue;
    if (istClock(new Date(bar.t)).date !== day) continue;
    map.set(bar.t, bar.c);
  }
  const points = despike(
    [...map.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([t, price]) => ({ t, price })),
  );
  if (points.length < 2) return points;
  const end = points[points.length - 1]!.t;
  return points.filter((point) => point.t >= end - 7 * 60 * 60 * 1000);
}

/** A print that leaves and comes straight back is not a price. The vertical line at 11:20 was one of these. */
function despike(points: Point[]): Point[] {
  if (points.length < 3) return points;
  const kept: Point[] = [points[0]!];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = kept[kept.length - 1]!;
    const cur = points[i]!;
    const next = points[i + 1]!;
    const jump = Math.abs(cur.price - prev.price) / prev.price;
    const back = Math.abs(next.price - prev.price) / prev.price;
    if (jump > 0.4 && back < 0.15) continue;
    kept.push(cur);
  }
  kept.push(points[points.length - 1]!);
  return kept;
}

function lerp(t0: number, v0: number, t1: number, v1: number, t: number): number {
  if (t1 === t0) return v0;
  return v0 + ((t - t0) / (t1 - t0)) * (v1 - v0);
}
