import assert from "node:assert/strict";
import test from "node:test";
import { nextDayFile } from "./day-tape.ts";
import { EMPTY_BOOK, crossPnl, reduceAtm, type CrossTrade, type WaveLeg } from "./cross-math.ts";
import { niftyWeekday, pickExpiry } from "./week.ts";

/** Wednesday 21 Oct 2026, minute offset from 09:15 IST. */
function at(minute: number): number {
  return Date.UTC(2026, 9, 21, 3, 45 + minute, 0);
}

function leg(id: string, type: "CE" | "PE", strike: number, points: [number, number][]): WaveLeg {
  return {
    contract: { securityId: id, type, strike },
    ltp: points[points.length - 1]?.[1] ?? 0,
    bars: points.map(([t, c]) => ({ t, c })),
    prints: [],
  };
}

test("a one-rupee wiggle does not close the buy", () => {
  const book = reduceAtm(
    EMPTY_BOOK,
    [
      leg("c", "CE", 23000, [
        [at(0), 10],
        [at(1), 6],
        [at(2), 5.4],
        [at(3), 5.6],
      ]),
      leg("p", "PE", 23000, [
        [at(0), 6],
        [at(1), 10],
        [at(2), 6.4],
        [at(3), 6.2],
      ]),
    ],
    65,
    "2026-10-27",
    23000,
    at(4),
  );
  assert.equal(book.total, 1);
  assert.equal(book.trades[0]?.status, "open");
  assert.equal(book.trades[0]?.buy.type, "PE");
  assert.equal(book.trades[0]?.lots, 1);
});

test("the buy closes at the real high, not at the next circle", () => {
  const book = reduceAtm(
    EMPTY_BOOK,
    [
      leg("c", "CE", 23000, [
        [at(0), 10],
        [at(1), 6],
        [at(2), 4],
        [at(3), 2],
        [at(4), 5],
        [at(5), 12],
      ]),
      leg("p", "PE", 23000, [
        [at(0), 6],
        [at(1), 10],
        [at(2), 12],
        [at(3), 14],
        [at(4), 10],
        [at(5), 6],
      ]),
      leg("c2", "CE", 22950, [
        [at(0), 12],
        [at(1), 4],
      ]),
      leg("p2", "PE", 22950, [
        [at(0), 4],
        [at(1), 12],
      ]),
    ],
    65,
    "2026-10-27",
    23000,
    at(6),
  );
  assert.equal(book.total, 2);
  const closed = book.trades.find((trade) => trade.status === "closed");
  assert.equal(closed?.buy.type, "PE");
  assert.equal(closed?.buy.exit, 14);
  assert.equal(closed?.exitTs, at(3));
  assert.equal(book.trades.find((trade) => trade.status === "open")?.buy.type, "CE");
});

test("a failed circle closes when the other leg takes the lead, and does not switch", () => {
  const book = reduceAtm(
    EMPTY_BOOK,
    [
      leg("c", "CE", 23050, [
        [at(46), 150],
        [at(47), 167],
        [at(48), 160],
        [at(49), 142],
      ]),
      leg("p", "PE", 23050, [
        [at(46), 184],
        [at(47), 166],
        [at(48), 172],
        [at(49), 198],
      ]),
    ],
    65,
    "2026-10-27",
    23050,
    at(50),
  );
  assert.equal(book.total, 1);
  const trade = book.trades[0];
  assert.equal(trade?.status, "closed");
  assert.equal(trade?.buy.type, "CE");
  assert.equal(trade?.exitWhy, "flipped");
  assert.equal(trade?.buy.exit, 160);
  assert.equal(trade?.exitTs, at(48));
  assert.ok(crossPnl(trade!, trade!.buy.exit ?? 0, true) > (142 - 167) * 65);
  const again = reduceAtm(book, [
    leg("c", "CE", 23050, [
      [at(46), 150],
      [at(47), 167],
      [at(48), 160],
      [at(49), 142],
    ]),
    leg("p", "PE", 23050, [
      [at(46), 184],
      [at(47), 166],
      [at(48), 172],
      [at(49), 198],
    ]),
  ], 65, "2026-10-27", 23050, at(50));
  assert.equal(again.total, 1);
});

test("a new circle after the exit can be bought, the flip itself cannot", () => {
  const book = reduceAtm(
    EMPTY_BOOK,
    [
      leg("c", "CE", 23050, [
        [at(46), 150],
        [at(47), 167],
        [at(48), 160],
        [at(49), 150],
        [at(52), 140],
        [at(53), 155],
      ]),
      leg("p", "PE", 23050, [
        [at(46), 184],
        [at(47), 166],
        [at(48), 172],
        [at(49), 180],
        [at(52), 170],
        [at(53), 150],
      ]),
    ],
    65,
    "2026-10-27",
    23050,
    at(54),
  );
  assert.equal(book.total, 2);
  const closed = book.trades.find((trade) => trade.status === "closed");
  const open = book.trades.find((trade) => trade.status === "open");
  assert.equal(closed?.exitWhy, "flipped");
  assert.equal(closed?.buy.exit, 160);
  assert.equal(open?.buy.type, "CE");
  assert.ok((open?.entryTs ?? 0) > (closed?.exitTs ?? 0));
});

test("a spike is not a cross and not the high", () => {
  const book = reduceAtm(
    EMPTY_BOOK,
    [
      leg("c", "CE", 23000, [
        [at(0), 10],
        [at(1), 10],
        [at(2), 10],
        [at(3), 10],
      ]),
      leg("p", "PE", 23000, [
        [at(0), 8],
        [at(1), 80],
        [at(2), 8],
        [at(3), 8],
      ]),
    ],
    65,
    "2026-10-27",
    23000,
    at(4),
  );
  assert.equal(book.total, 0);
});

test("nothing new opens after 15:20, and 15:29 flattens what is open", () => {
  const open = reduceAtm(
    EMPTY_BOOK,
    [
      leg("c", "CE", 23000, [
        [at(0), 10],
        [at(1), 6],
        [at(360), 5],
      ]),
      leg("p", "PE", 23000, [
        [at(0), 6],
        [at(1), 10],
        [at(360), 11],
      ]),
    ],
    65,
    "2026-10-27",
    23000,
    at(380),
  );
  assert.equal(open.trades.filter((trade) => trade.status === "open").length, 0);
  assert.equal(open.trades[0]?.status, "closed");
  assert.equal(open.trades[0]?.exitTs, at(360));
});

test("a desk cut flats at 15:20 without moving the cash-session default", () => {
  const cut = { lastEntry: 15 * 60 + 20, flat: 15 * 60 + 20 };
  const book = reduceAtm(
    EMPTY_BOOK,
    [
      leg("c", "CE", 23000, [
        [at(0), 10],
        [at(1), 6],
        [at(365), 5],
      ]),
      leg("p", "PE", 23000, [
        [at(0), 6],
        [at(1), 10],
        [at(365), 11],
      ]),
    ],
    65,
    "2026-10-27",
    23000,
    at(370),
    cut,
  );
  assert.equal(book.trades.filter((trade) => trade.status === "open").length, 0);
  assert.equal(book.trades[0]?.status, "closed");
  assert.equal(book.trades[0]?.exitWhy, "flat");
  assert.equal(book.trades[0]?.exitTs, at(365));
});

test("one lot profit is the premium move times 65, then sixty off", () => {
  const trade = { lots: 1, lot: 65, buy: { entry: 100, mark: 110 } } as CrossTrade;
  assert.equal(crossPnl(trade, 110, false), 650);
  assert.equal(crossPnl(trade, 110, true), 590);
});

test("Wednesday does not keep Tuesday's expiry, and the next day starts empty", () => {
  assert.equal(pickExpiry(["2026-10-20", "2026-10-27"], "2026-10-21"), "2026-10-27");
  assert.equal(pickExpiry(["2026-10-20"], "2026-10-20"), "2026-10-20");
  assert.equal(niftyWeekday(new Date(Date.UTC(2026, 9, 21, 4, 0))), "Wednesday · day 1");
  assert.equal(niftyWeekday(new Date(Date.UTC(2026, 9, 20, 4, 0))), "Tuesday · expiry");
  const rolled = nextDayFile(
    { date: "2026-10-20", expiry: "2026-10-20", legs: { c: [{ t: 1, c: 10 }] } },
    "2026-10-21",
    "2026-10-27",
  );
  assert.deepEqual(rolled.legs, {});
  assert.equal(rolled.expiry, "2026-10-27");
});
