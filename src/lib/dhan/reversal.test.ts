import assert from "node:assert/strict";
import test from "node:test";
import { parseFeed } from "./ticks.ts";
import {
  applyTick,
  completedBars,
  EMPTY_SWING,
  minPremiumMove,
  sideAllowed,
  stepSwing,
  type Bar5,
  type SwingSnap,
} from "./reversal.ts";

function bar(index: number, close: number, span = 0.3): Bar5 {
  return {
    t: index * 60_000,
    o: close,
    h: close + span,
    l: close - span,
    c: close,
    bid: close - 0.15,
    ask: close + 0.15,
  };
}

test("full packet exposes ltp, bid, and ask", () => {
  const size = 162;
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  view.setUint8(0, 8);
  view.setUint16(1, size, true);
  view.setUint8(3, 2);
  view.setInt32(4, 55123, true);
  view.setFloat32(8, 136, true);
  view.setInt32(14, 1_759_000_000, true);
  view.setInt32(22, 1200, true);
  view.setInt32(34, 40000, true);
  view.setFloat32(62 + 12, 135.5, true);
  view.setFloat32(62 + 16, 136.4, true);
  const [tick] = parseFeed(buffer);
  assert.equal(tick?.securityId, "55123");
  assert.equal(Math.round(tick?.ltp ?? 0), 136);
});

test("one minute of ticks stays one bar", () => {
  let bars = applyTick([], { ts: 60_000, ltp: 100, bid: 99.8, ask: 100.2 });
  bars = applyTick(bars, { ts: 75_000, ltp: 101, bid: 100.8, ask: 101.2 });
  bars = applyTick(bars, { ts: 120_000, ltp: 102, bid: 101.8, ask: 102.2 });
  assert.equal(bars.length, 2);
  assert.equal(completedBars(bars, 130_000).length, 1);
});

test("a tiny wiggle is refused because it cannot pay ₹40", () => {
  const bars = Array.from({ length: 30 }, (_, i) => bar(i, 100 + Math.sin(i) * 0.2, 0.1));
  const snap = stepSwing(EMPTY_SWING, bars, 30 * 60_000, minPremiumMove(100.2, 99.8, 65), false, 0);
  assert.equal(snap.action, null);
});

test("a real range break enters, and one red bar does not exit", () => {
  const base = Array.from({ length: 24 }, (_, i) => bar(i, 100 + (i % 4) * 0.15, 0.25));
  const burst = [bar(24, 102.2, 0.2), bar(25, 102.8, 0.2)];
  const dip = bar(26, 102.4, 0.2);
  let snap: SwingSnap = stepSwing(EMPTY_SWING, [...base, ...burst], 26 * 60_000, 1.2, false, 0);
  assert.equal(snap.action, "enter");
  assert.ok((snap.target ?? 0) > 103);
  snap = stepSwing({ ...snap, action: null }, [...base, ...burst, dip], 27 * 60_000, 1.2, true, 60_000);
  assert.equal(snap.action, null);
  assert.equal(snap.state, "up");
});

test("two closes back through the break exit only after the hold", () => {
  const entered: SwingSnap = {
    ...EMPTY_SWING,
    state: "up",
    breakLevel: 110,
    target: 120,
  };
  const bars = [
    ...Array.from({ length: 23 }, (_, i) => bar(i, 112, 0.2)),
    bar(23, 108, 0.2),
    bar(24, 107, 0.2),
  ];
  const early = stepSwing(entered, bars, 25 * 60_000, 2, true, 60_000);
  assert.equal(early.action, null);
  const late = stepSwing(entered, bars, 25 * 60_000, 2, true, 6 * 60_000);
  assert.equal(late.action, "exit");
});

test("the future decides which option side is allowed", () => {
  assert.equal(sideAllowed("CE", "up"), true);
  assert.equal(sideAllowed("CE", "down"), false);
  assert.equal(sideAllowed("PE", "down"), true);
  assert.equal(sideAllowed("PE", "flat"), false);
});
