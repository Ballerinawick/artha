import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_BOOK, type BookSnap, type CrossTrade } from "./cross-math.ts";
import { gateOrder, nextIntent, orderIntents, orderTag, intentIsFresh, signedNet, type OrderIntent } from "./live-sync.ts";

function trade(id: string, status: "open" | "closed"): CrossTrade {
  return {
    id,
    pair: "c|p",
    ceId: "c",
    peId: "p",
    entryTs: 1,
    lots: 1,
    lot: 65,
    expiry: "2026-10-27",
    frame: "1m",
    reason: "Call rising",
    buy: { type: "CE", strike: 23000, securityId: "99", entry: 10, mark: 10 },
    status,
  };
}

function book(trades: CrossTrade[]): BookSnap {
  return { ...EMPTY_BOOK, trades, total: trades.length };
}

test("a new paper buys one lot, and the close of that paper sells it", () => {
  const opened = orderIntents(EMPTY_BOOK, book([trade("a", "open")]), "NIFTY");
  assert.deepEqual(opened.map((intent) => intent.side), ["BUY"]);
  assert.equal(opened[0]?.qty, 65);
  assert.equal(opened[0]?.securityId, "99");
  const closed = orderIntents(book([trade("a", "open")]), book([trade("a", "closed")]), "BANKNIFTY");
  assert.deepEqual(closed.map((intent) => intent.side), ["SELL"]);
  assert.equal(closed[0]?.symbol, "BANKNIFTY");
});

test("the same open paper does not send a second buy", () => {
  const held = book([trade("a", "open")]);
  assert.equal(orderIntents(held, held, "NIFTY").length, 0);
});

test("a paper that opens and closes in one step buys before it sells", () => {
  const intents = orderIntents(EMPTY_BOOK, book([trade("a", "closed")]), "NIFTY");
  assert.deepEqual(intents.map((intent) => intent.side), ["BUY", "SELL"]);
});

test("order tags are stable and differ by side", () => {
  assert.equal(orderTag("1m|c|p|1", "BUY"), orderTag("1m|c|p|1", "BUY"));
  assert.notEqual(orderTag("1m|c|p|1", "BUY"), orderTag("1m|c|p|1", "SELL"));
  assert.equal(orderTag("1m|c|p|1", "BUY").length, 19);
});

test("a restart does not treat an old paper as a new market order", () => {
  const now = 1_700_000_000_000;
  assert.equal(intentIsFresh({ entryTs: now - 1_000 }, "BUY", now), true);
  assert.equal(intentIsFresh({ entryTs: now - 120_000 }, "BUY", now), false);
  assert.equal(intentIsFresh({ entryTs: now - 120_000, exitTs: now - 500 }, "SELL", now), true);
});

test("a buy waits while any lot of that index is still open", () => {
  assert.equal(signedNet("LONG", 65), 65);
  assert.equal(signedNet("SHORT", 65), -65);
  assert.equal(signedNet("CLOSED", 65), 0);
  const flat = gateOrder({ side: "BUY", securityId: "99", qty: 65, nets: [], busy: false });
  assert.deepEqual(flat, { ok: true, qty: 65 });
  const same = gateOrder({ side: "BUY", securityId: "99", qty: 65, nets: [{ securityId: "99", netQty: 65 }], busy: false });
  assert.equal(same.ok, false);
  const other = gateOrder({ side: "BUY", securityId: "100", qty: 65, nets: [{ securityId: "99", netQty: 65 }], busy: false });
  assert.equal(other.ok, false);
  if (!other.ok) assert.equal(other.wait, true);
});

test("a sell flattens the long quantity and never opens a short", () => {
  const one = gateOrder({ side: "SELL", securityId: "99", qty: 65, nets: [{ securityId: "99", netQty: 65 }], busy: false });
  assert.deepEqual(one, { ok: true, qty: 65 });
  const extra = gateOrder({ side: "SELL", securityId: "99", qty: 65, nets: [{ securityId: "99", netQty: 130 }], busy: false });
  assert.deepEqual(extra, { ok: true, qty: 130 });
  const none = gateOrder({ side: "SELL", securityId: "99", qty: 65, nets: [], busy: false });
  assert.deepEqual(none, { ok: false, wait: false, reason: "flat" });
  const short = gateOrder({ side: "SELL", securityId: "99", qty: 65, nets: [{ securityId: "99", netQty: -65 }], busy: false });
  assert.equal(short.ok, false);
});

test("the old ATM is sold before the new buy, and a same-trade round trip buys first", () => {
  const sell = (id: string): OrderIntent => ({ tradeId: id, side: "SELL", securityId: "99", qty: 65, symbol: "NIFTY" });
  const buy = (id: string): OrderIntent => ({ tradeId: id, side: "BUY", securityId: "100", qty: 65, symbol: "NIFTY" });
  assert.equal(nextIntent([sell("old"), buy("new")], true, true)?.tradeId, "old");
  assert.equal(nextIntent([buy("same"), sell("same")], true, true)?.side, "BUY");
  assert.equal(nextIntent([sell("same")], true, true)?.side, "SELL");
  assert.equal(nextIntent([buy("new")], false, true), null);
});
