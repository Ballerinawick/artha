import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_BOOK, type BookSnap, type CrossTrade } from "./cross-math.ts";
import { orderIntents, orderTag, intentIsFresh } from "./live-sync.ts";

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
