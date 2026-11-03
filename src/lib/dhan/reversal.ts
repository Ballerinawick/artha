/** One-minute premium bars. A paper is allowed only when the swing can pay the round trip. */

export const BAR_MS = 60_000;
export const BROKERAGE = 40;
export const STT_RATE = 0.001;
const MIN_HOLD_MS = 5 * 60_000;
const COOLDOWN_MS = 5 * 60_000;

export type Bar5 = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  bid: number;
  ask: number;
};

export type SwingState = "warmup" | "up" | "down";
export type Bias = "up" | "down" | "flat";

export type SwingSnap = {
  state: SwingState;
  pivotHigh: number | null;
  pivotLow: number | null;
  emaFast: number | null;
  emaSlow: number | null;
  action: "enter" | "exit" | null;
  reason: string;
  target: number | null;
  breakLevel: number | null;
  cooldownUntil: number;
  bias: Bias;
};

export const EMPTY_SWING: SwingSnap = {
  state: "warmup",
  pivotHigh: null,
  pivotLow: null,
  emaFast: null,
  emaSlow: null,
  action: null,
  reason: "Waiting for 21 one-minute bars before a paper is allowed.",
  target: null,
  breakLevel: null,
  cooldownUntil: 0,
  bias: "flat",
};

type TickIn = { ts: number; ltp: number; bid: number; ask: number };

export function applyTick(bars: Bar5[], tick: TickIn): Bar5[] {
  if (!(tick.ltp > 0)) return bars;
  const bucket = Math.floor(tick.ts / BAR_MS) * BAR_MS;
  const last = bars[bars.length - 1];
  if (!last || last.t !== bucket) {
    bars.push({
      t: bucket,
      o: tick.ltp,
      h: tick.ltp,
      l: tick.ltp,
      c: tick.ltp,
      bid: tick.bid > 0 ? tick.bid : 0,
      ask: tick.ask > 0 ? tick.ask : 0,
    });
    if (bars.length > 400) bars.shift();
    return bars;
  }
  last.h = Math.max(last.h, tick.ltp);
  last.l = Math.min(last.l, tick.ltp);
  last.c = tick.ltp;
  if (tick.bid > 0) last.bid = tick.bid;
  if (tick.ask > 0) last.ask = tick.ask;
  return bars;
}

export function completedBars(bars: Bar5[], now: number): Bar5[] {
  if (!bars.length) return [];
  const forming = Math.floor(now / BAR_MS) * BAR_MS;
  if (bars[bars.length - 1]!.t === forming) return bars.slice(0, -1);
  return bars;
}

function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (const value of values.slice(period)) prev = value * k + prev * (1 - k);
  return prev;
}

export function spreadOk(bar: Bar5): boolean {
  if (!(bar.ask > 0) || !(bar.bid > 0) || bar.ask < bar.bid) return true;
  return bar.ask - bar.bid <= Math.max(1.5, bar.ask * 0.02);
}

export function entryPrice(bar: Bar5): number {
  return bar.ask > 0 ? bar.ask : bar.c;
}

export function exitPrice(bar: Bar5): number {
  return bar.bid > 0 ? bar.bid : bar.c;
}

/** Premium points needed so a win still pays ₹40, the spread, and the sell charge, twice. */
export function minPremiumMove(ask: number, bid: number, lot: number): number {
  const spread = ask > bid && bid > 0 ? ask - bid : 0;
  const unit = BROKERAGE / Math.max(lot, 1) + spread + Math.max(ask, bid, 1) * STT_RATE;
  return Math.max(unit * 2, 1);
}

export function targetHit(bid: number, target: number | null | undefined): boolean {
  return target != null && target > 0 && bid >= target;
}

export function sideAllowed(type: "CE" | "PE", bias: Bias): boolean {
  return type === "CE" ? bias === "up" : bias === "down";
}

function trendBias(fast: number | null, slow: number | null): Bias {
  if (fast == null || slow == null || fast === slow) return "flat";
  return fast > slow ? "up" : "down";
}

/**
 * Decide from closed one-minute bars only.
 * Entry needs two closes through the prior range and enough room to pay costs.
 * Exit is the target, or two closes back through the break after the position has been held.
 */
function decideSwing(
  prev: SwingSnap,
  closed: Bar5[],
  now: number,
  minMove: number,
  holding: boolean,
  heldMs: number,
): SwingSnap {
  if (closed.length < 13) {
    return {
      ...prev,
      state: "warmup",
      action: null,
      reason: `Warming up ${closed.length}/13 one-minute bars.`,
    };
  }
  const closes = closed.map((bar) => bar.c);
  const emaFast = ema(closes, 5);
  const emaSlow = ema(closes, 13);
  const last = closed[closed.length - 1]!;
  const prior = closed[closed.length - 2]!;
  const recent = closed.slice(-8);
  const rangeHigh = Math.max(...recent.map((bar) => bar.h));
  const rangeLow = Math.min(...recent.map((bar) => bar.l));
  const range = rangeHigh - rangeLow;
  const lifted = last.c - rangeLow;
  const trendUp = emaFast != null && emaSlow != null && emaFast > emaSlow;
  const failed = heldMs >= MIN_HOLD_MS && (!trendUp || (prev.breakLevel != null && last.c < prev.breakLevel && prior.c < prev.breakLevel));

  if (holding) {
    if (failed) {
      return {
        ...prev,
        state: "down",
        emaFast,
        emaSlow,
        pivotHigh: rangeHigh,
        pivotLow: rangeLow,
        action: "exit",
        reason: "Two one-minute closes lost the break. The paper is closed.",
        cooldownUntil: now + COOLDOWN_MS,
      };
    }
    return {
      ...prev,
      state: "up",
      emaFast,
      emaSlow,
      pivotHigh: rangeHigh,
      pivotLow: rangeLow,
      action: null,
      reason: "Holding while the state stays up.",
    };
  }

  const room = Math.max(minMove, range);
  const chase = lifted > Math.max(minMove * 6, 8);
  if (trendUp && lifted >= minMove * 0.35 && !chase && now >= prev.cooldownUntil) {
    if (!spreadOk(last)) {
      return {
        ...prev,
        state: "up",
        emaFast,
        emaSlow,
        pivotHigh: rangeHigh,
        pivotLow: rangeLow,
        action: null,
        reason: "State is up, but the bid-ask is too wide.",
      };
    }
    const entry = entryPrice(last);
    return {
      state: "up",
      emaFast,
      emaSlow,
      pivotHigh: rangeHigh,
      pivotLow: rangeLow,
      action: "enter",
      target: entry + room,
      breakLevel: rangeLow,
      cooldownUntil: prev.cooldownUntil,
      reason: "State turned up with room to pay the ₹40.",
      bias: "flat",
    };
  }

  return {
    ...prev,
    state: trendUp ? "up" : "down",
    emaFast,
    emaSlow,
    pivotHigh: rangeHigh,
    pivotLow: rangeLow,
    action: null,
    reason: now < prev.cooldownUntil ? "Cooling down after the last paper." : trendUp ? "State is up, but the move cannot pay the ₹40 yet." : "State is down.",
  };
}

export function stepSwing(
  prev: SwingSnap,
  closed: Bar5[],
  now: number,
  minMove: number,
  holding: boolean,
  heldMs: number,
): SwingSnap {
  const snap = decideSwing(prev, closed, now, minMove, holding, heldMs);
  const bias = snap.state === "warmup" ? "flat" : trendBias(snap.emaFast, snap.emaSlow);
  return { ...snap, bias };
}
