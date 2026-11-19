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

/** A market order is allowed only when the paper transition is this fresh. Older rows are history, not a new signal. */
export const FRESH_MS = 90_000;

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
