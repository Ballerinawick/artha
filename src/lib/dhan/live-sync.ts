import { createHash } from "node:crypto";
import type { BookSnap } from "./cross-math";

export type BookSymbol = "NIFTY" | "BANKNIFTY";

export type OrderIntent = {
  tradeId: string;
  side: "BUY" | "SELL";
  securityId: string;
  qty: number;
  symbol: BookSymbol;
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
    const buy: OrderIntent = { tradeId: trade.id, side: "BUY", securityId: trade.buy.securityId, qty, symbol };
    const sell: OrderIntent = { tradeId: trade.id, side: "SELL", securityId: trade.buy.securityId, qty, symbol };
    if (!old && trade.status === "open") intents.push(buy);
    else if (!old && trade.status === "closed") intents.push(buy, sell);
    else if (old?.status === "open" && trade.status === "closed") intents.push(sell);
  }
  return intents;
}
