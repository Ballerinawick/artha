import { createHash } from "node:crypto";
import type { BookSnap } from "./cross-math";

export type BookSymbol = "NIFTY" | "BANKNIFTY";

export type OrderIntent = {
  tradeId: string;
  side: "BUY" | "SELL";
  securityId: string;
  qty: number;
  symbol: BookSymbol;
  /** Paper time of this side (entryTs for a buy, exitTs for a sell). */
  ts?: number;
};

export type BrokerNet = { securityId: string; netQty: number };

export type GateDecision =
  | { ok: true; qty: number }
  | { ok: false; wait: boolean; reason: "busy" | "open" | "flat" | "qty" };

/** The paper clock is the bar time. The row is only created once that minute has closed, about two minutes later. */
export const FRESH_MS = 4 * 60 * 1000;

export function intentIsFresh(trade: { entryTs: number; exitTs?: number }, side: "BUY" | "SELL", now: number): boolean {
  const ts = side === "BUY" ? trade.entryTs : (trade.exitTs ?? 0);
  return ts > 0 && now - ts <= FRESH_MS;
}

export function orderTag(tradeId: string, side: "BUY" | "SELL"): string {
  const digest = createHash("sha256").update(`${side}\0${tradeId}`).digest("hex").slice(0, 18);
  return `${side === "BUY" ? "b" : "s"}${digest}`;
}

export function liveOrdersEnabled(): boolean {
  return process.env.ARTHA_LIVE === "1";
}

/** Long is positive, short is negative, closed is zero. Dhan sends both shapes. */
export function signedNet(positionType: string, netQty: number): number {
  const qty = Math.abs(netQty);
  const side = positionType.toUpperCase();
  if (!qty || side === "CLOSED") return 0;
  if (side === "SHORT") return -qty;
  if (side === "LONG") return qty;
  return netQty;
}

/**
 * One open lot per index. A new buy waits until every intraday contract of that index is flat.
 * A sell never exceeds the long quantity, and never opens a short.
 */
export function gateOrder(input: {
  side: "BUY" | "SELL";
  securityId: string;
  qty: number;
  nets: BrokerNet[];
  busy: boolean;
}): GateDecision {
  if (input.busy) return { ok: false, wait: true, reason: "busy" };
  const open = input.nets.filter((row) => row.netQty !== 0);
  const mine = open.find((row) => row.securityId === input.securityId)?.netQty ?? 0;
  if (input.side === "SELL") {
    if (mine > 0) return { ok: true, qty: mine };
    return { ok: false, wait: false, reason: "flat" };
  }
  if (mine !== 0 || open.length > 0) return { ok: false, wait: true, reason: "open" };
  if (!(input.qty > 0)) return { ok: false, wait: false, reason: "qty" };
  return { ok: true, qty: input.qty };
}

/** The old lot is sold before the new ATM buy. A trade that opens and closes together still buys first. */
export function nextIntent(pending: OrderIntent[], buysAllowed: boolean, sellsAllowed: boolean): OrderIntent | null {
  const buys = buysAllowed ? pending.filter((intent) => intent.side === "BUY") : [];
  const sells = sellsAllowed ? pending.filter((intent) => intent.side === "SELL") : [];
  const closing = sells.find((sell) => !buys.some((buy) => buy.tradeId === sell.tradeId));
  if (closing) return closing;
  return buys[0] ?? sells.find((sell) => !pending.some((intent) => intent.side === "BUY" && intent.tradeId === sell.tradeId)) ?? null;
}

/** Paper transitions that need a market order. A row that is born already closed sends buy then sell. */
export function orderIntents(prev: BookSnap, next: BookSnap, symbol: BookSymbol): OrderIntent[] {
  const before = new Map(prev.trades.map((trade) => [trade.id, trade]));
  const intents: OrderIntent[] = [];
  for (const trade of next.trades) {
    const qty = trade.lots * trade.lot;
    if (!(qty > 0) || !trade.buy.securityId) continue;
    const old = before.get(trade.id);
    const buy: OrderIntent = { tradeId: trade.id, side: "BUY", securityId: trade.buy.securityId, qty, symbol, ts: trade.entryTs };
    const sell: OrderIntent = { tradeId: trade.id, side: "SELL", securityId: trade.buy.securityId, qty, symbol, ts: trade.exitTs };
    if (!old && trade.status === "open") intents.push(buy);
    else if (!old && trade.status === "closed") intents.push(buy, sell);
    else if (old?.status === "open" && trade.status === "closed") intents.push(sell);
  }
  return intents;
}

/** Exact index match on Dhan's trading symbol. "NIFTY" must not catch NIFTYNXT50 or BANKNIFTY. */
export function symbolOfIndex(symbol: BookSymbol, tradingSymbol: string): boolean {
  const name = tradingSymbol.trim().toUpperCase();
  const re = symbol === "BANKNIFTY" ? /^BANKNIFTY(?![A-Z0-9])/ : /^NIFTY(?![A-Z0-9])/;
  return re.test(name);
}

/** Tags this desk writes: b… entry buy, s… paper-exit sell (older builds), x… exit sell. */
export function isDeskTag(tag: string): boolean {
  return /^[bsx][0-9a-f]{18}$/.test(tag);
}

export function exitTag(securityId: string, now: number): string {
  const digest = createHash("sha256").update(`EXIT\0${securityId}\0${now}`).digest("hex").slice(0, 18);
  return `x${digest}`;
}

export type BrokerOrder = {
  correlationId?: string;
  transactionType?: string;
  securityId?: string | number;
  orderStatus?: string;
  filledQty?: number | string;
  quantity?: number | string;
};

/** Quantity this desk still holds per contract, from today's Dhan order book: filled desk buys minus filled desk sells.
 *  Read from Dhan, so it survives a restart, a lost database, or a book that was not restored. */
export function deskHoldings(orders: BrokerOrder[]): Map<string, number> {
  const held = new Map<string, number>();
  for (const row of orders) {
    if (!row || !isDeskTag(String(row.correlationId ?? ""))) continue;
    const status = String(row.orderStatus ?? "").toUpperCase();
    let filled = Number(row.filledQty);
    if (!Number.isFinite(filled) || filled < 0) filled = 0;
    if (!filled && status === "TRADED") filled = Number(row.quantity) || 0;
    if (!filled) continue;
    const id = String(row.securityId ?? "");
    if (!id) continue;
    const side = String(row.transactionType ?? "").toUpperCase();
    const sign = side === "BUY" ? 1 : side === "SELL" ? -1 : 0;
    held.set(id, (held.get(id) ?? 0) + sign * filled);
  }
  return held;
}

export type ExitPlan = {
  sells: { securityId: string; qty: number; why: "desk" | "flatten-unknown" }[];
  unknown: { securityId: string; netQty: number }[];
  shorts: { securityId: string; netQty: number }[];
};

/**
 * What the broker must sell so it matches the paper book.
 * - A long the desk bought that no open paper holds is sold now (paper exit, flatten, or an orphan after a restart).
 * - Never more than the broker long, never more than the desk bought: a manual lot in the same contract is left alone.
 * - A long the desk did not buy is only reported, unless flattenUnknown is set (then it is sold, used at 15:20 only).
 * - Shorts are never touched.
 */
export function planExits(input: {
  nets: BrokerNet[];
  desk: Map<string, number>;
  held: Set<string>;
  flattenUnknown: boolean;
}): ExitPlan {
  const plan: ExitPlan = { sells: [], unknown: [], shorts: [] };
  for (const row of input.nets) {
    if (row.netQty < 0) {
      plan.shorts.push({ securityId: row.securityId, netQty: row.netQty });
      continue;
    }
    if (row.netQty === 0 || input.held.has(row.securityId)) continue;
    const mine = Math.max(0, input.desk.get(row.securityId) ?? 0);
    const deskQty = Math.min(row.netQty, mine);
    const rest = row.netQty - deskQty;
    if (rest > 0 && input.flattenUnknown) {
      plan.sells.push({ securityId: row.securityId, qty: row.netQty, why: "flatten-unknown" });
      continue;
    }
    if (deskQty > 0) plan.sells.push({ securityId: row.securityId, qty: deskQty, why: "desk" });
    if (rest > 0) plan.unknown.push({ securityId: row.securityId, netQty: rest });
  }
  return plan;
}
