import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_BOOK, type BookSnap, type CrossTrade } from "./cross-math.ts";
import {
  deskHoldings,
  exitTag,
  gateOrder,
  intentIsFresh,
  isDeskTag,
  nextIntent,
  orderIntents,
  orderTag,
  planExits,
  signedNet,
  symbolOfIndex,
  type OrderIntent,
 } from "./live-sync.ts";

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
  assert.equal(intentIsFresh({ entryTs: now - 2 * 60_000 }, "BUY", now), true);
  assert.equal(intentIsFresh({ entryTs: now - 5 * 60_000 }, "BUY", now), false);
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

test("index names match exactly: NIFTY is not NIFTYNXT50, FINNIFTY or BANKNIFTY", () => {
  assert.equal(symbolOfIndex("NIFTY", "NIFTY-Dec2026-24000-CE"), true);
  assert.equal(symbolOfIndex("NIFTY", "NIFTY 30 DEC 24000 CALL"), true);
  assert.equal(symbolOfIndex("NIFTY", "NIFTYNXT50-Dec2026-70000-CE"), false);
  assert.equal(symbolOfIndex("NIFTY", "BANKNIFTY-Dec2026-63500-CE"), false);
  assert.equal(symbolOfIndex("NIFTY", "FINNIFTY-Dec2026-27000-PE"), false);
  assert.equal(symbolOfIndex("BANKNIFTY", "BANKNIFTY 29 DEC 63500 CALL"), true);
  assert.equal(symbolOfIndex("BANKNIFTY", "BANKNIFTYX-Dec2026-1-CE"), false);
});

test("desk tags are recognised, manual orders are not", () => {
  assert.equal(isDeskTag(orderTag("t1", "BUY")), true);
  assert.equal(isDeskTag(orderTag("t1", "SELL")), true);
  assert.equal(isDeskTag(exitTag("58872", 1)), true);
  assert.equal(isDeskTag(""), false);
  assert.equal(isDeskTag("artha1764230000000"), false);
});

test("desk holdings come from filled desk orders only", () => {
  const held = deskHoldings([
    { correlationId: orderTag("t1", "BUY"), transactionType: "BUY", securityId: 111, orderStatus: "TRADED", filledQty: 30, quantity: 30 },
    { correlationId: exitTag("111", 5), transactionType: "SELL", securityId: "111", orderStatus: "PART_TRADED", filledQty: 10, quantity: 30 },
    { correlationId: orderTag("t2", "BUY"), transactionType: "BUY", securityId: "222", orderStatus: "REJECTED", filledQty: 0, quantity: 65 },
    { correlationId: "", transactionType: "BUY", securityId: "333", orderStatus: "TRADED", filledQty: 65, quantity: 65 },
    { correlationId: orderTag("t3", "BUY"), transactionType: "BUY", securityId: "444", orderStatus: "TRADED", quantity: 65 },
  ]);
  assert.equal(held.get("111"), 20);
  assert.equal(held.has("222"), false);
  assert.equal(held.has("333"), false);
  assert.equal(held.get("444"), 65);
});

test("a desk long that no open paper holds is sold, a held one is kept", () => {
  const desk = new Map([["111", 30], ["222", 65]]);
  const plan = planExits({
    nets: [{ securityId: "111", netQty: 30 }, { securityId: "222", netQty: 65 }],
    desk,
    held: new Set(["222"]),
    flattenUnknown: false,
  });
  assert.deepEqual(plan.sells, [{ securityId: "111", qty: 30, why: "desk" }]);
  assert.deepEqual(plan.unknown, []);
});

test("a manual long is reported, never sold, unless flattening unknowns is switched on", () => {
  const nets = [{ securityId: "555", netQty: 30 }];
  const off = planExits({ nets, desk: new Map(), held: new Set(), flattenUnknown: false });
  assert.deepEqual(off.sells, []);
  assert.deepEqual(off.unknown, [{ securityId: "555", netQty: 30 }]);
  const on = planExits({ nets, desk: new Map(), held: new Set(), flattenUnknown: true });
  assert.deepEqual(on.sells, [{ securityId: "555", qty: 30, why: "flatten-unknown" }]);
});

test("the desk sells only its own part of a mixed lot and never more than the broker long", () => {
  const mixed = planExits({ nets: [{ securityId: "111", netQty: 60 }], desk: new Map([["111", 30]]), held: new Set(), flattenUnknown: false });
  assert.deepEqual(mixed.sells, [{ securityId: "111", qty: 30, why: "desk" }]);
  assert.deepEqual(mixed.unknown, [{ securityId: "111", netQty: 30 }]);
  const small = planExits({ nets: [{ securityId: "111", netQty: 10 }], desk: new Map([["111", 30]]), held: new Set(), flattenUnknown: false });
  assert.deepEqual(small.sells, [{ securityId: "111", qty: 10, why: "desk" }]);
});

test("shorts are never bought back or added to", () => {
  const plan = planExits({ nets: [{ securityId: "111", netQty: -30 }], desk: new Map([["111", 30]]), held: new Set(), flattenUnknown: true });
  assert.deepEqual(plan.sells, []);
  assert.deepEqual(plan.shorts, [{ securityId: "111", netQty: -30 }]);
});

test("an exit after a restart: desk bought, paper book lost, the long is closed", () => {
  const orders = [{ correlationId: orderTag("lost", "BUY"), transactionType: "BUY", securityId: "58872", orderStatus: "TRADED", filledQty: 30 }];
  const plan = planExits({ nets: [{ securityId: "58872", netQty: 30 }], desk: deskHoldings(orders), held: new Set(), flattenUnknown: false });
  assert.deepEqual(plan.sells, [{ securityId: "58872", qty: 30, why: "desk" }]);
});

test("intents carry the paper time of their side", () => {
  const open = { ...trade("a", "open"), entryTs: 1000 };
  const closed = { ...open, status: "closed" as const, exitTs: 5000 };
  assert.equal(orderIntents(EMPTY_BOOK, book([open]), "NIFTY")[0]?.ts, 1000);
  assert.equal(orderIntents(book([open]), book([closed]), "NIFTY")[0]?.ts, 5000);
});
