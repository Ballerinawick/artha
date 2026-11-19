import assert from "node:assert/strict";
import test from "node:test";
import { deskPhase, msUntilSession, ordersAllowed } from "./session-clock.ts";

/** Wednesday 21 Oct 2026. IST = UTC+5:30. */
const live = new Date(Date.UTC(2026, 9, 21, 4, 30, 0));
const arm = new Date(Date.UTC(2026, 9, 21, 3, 44, 0));
const before = new Date(Date.UTC(2026, 9, 21, 3, 30, 0));
const flat = new Date(Date.UTC(2026, 9, 21, 9, 50, 0));
const down = new Date(Date.UTC(2026, 9, 21, 10, 0, 0));
const saturday = new Date(Date.UTC(2026, 9, 24, 4, 30, 0));

test("weekday clock: asleep, armed by 09:14, live at 09:15, flat at 15:20, down at 15:30", () => {
  assert.equal(deskPhase(before), "sleep");
  assert.equal(deskPhase(arm), "arm");
  assert.equal(deskPhase(live), "live");
  assert.equal(deskPhase(flat), "flatten");
  assert.equal(deskPhase(down), "shutdown");
  assert.equal(deskPhase(saturday), "sleep");
});

test("buys stop at 15:20, sells still go out while the desk is flattening", () => {
  assert.equal(ordersAllowed("arm", "BUY"), false);
  assert.equal(ordersAllowed("live", "BUY"), true);
  assert.equal(ordersAllowed("flatten", "BUY"), false);
  assert.equal(ordersAllowed("flatten", "SELL"), true);
  assert.equal(ordersAllowed("shutdown", "SELL"), false);
});

test("the desk sleeps until the next weekday 09:08 and stays up through the session", () => {
  assert.equal(msUntilSession(live), 0);
  assert.equal(msUntilSession(flat), 0);
  assert.ok(msUntilSession(down) > 10 * 60 * 60 * 1000);
  assert.ok(msUntilSession(saturday) > 24 * 60 * 60 * 1000);
  assert.ok(msUntilSession(before) > 0);
  assert.ok(msUntilSession(before) < 40 * 60 * 1000);
});
