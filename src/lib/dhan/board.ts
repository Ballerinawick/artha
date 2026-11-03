import { diagnose, type Bar } from "./algo";
import { cachedStale } from "@/lib/market/cache";
import { formatIstStamp, marketSession } from "@/lib/market/hours";
import { dhan } from "./client";
import { paced } from "./pace";
import type { BoardSignal, DeskBook, DhanCreds, EngineRead, Funds, Holding, LivePosition, LiveTape, QuietName, SignalBoard, TapePoint } from "./types";
import { INDEXES, LOTS, NAMES, STOCKS } from "./universe";

type Creds = DhanCreds;

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function barsFrom(body: unknown): Bar[] {
  const root = (body ?? {}) as { data?: Record<string, unknown> } & Record<string, unknown>;
  const d = (root.data ?? root) as Record<string, unknown>;
  const ts = (d.timestamp ?? d.time ?? []) as unknown[];
  const open = (d.open ?? []) as unknown[];
  const high = (d.high ?? []) as unknown[];
  const low = (d.low ?? []) as unknown[];
  const close = (d.close ?? []) as unknown[];
  const volume = (d.volume ?? []) as unknown[];
  const bars: Bar[] = [];
  for (let i = 0; i < close.length; i++) {
    const c = num(close[i]);
    if (!c) continue;
    const raw = num(ts[i]);
    const t = raw > 1e12 ? raw : raw * 1000;
    bars.push({
      t,
      o: num(open[i]) || c,
      h: num(high[i]) || c,
      l: num(low[i]) || c,
      c,
      v: num(volume[i]),
    });
  }
  return bars;
}

function istDate(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function istStamp(d: Date, withTime: boolean): string {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  if (!withTime) return date;
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(d);
  return `${date} ${time}`;
}

async function intraday(creds: Creds, securityId: string, segment: string, instrument: string) {
  const now = new Date();
  const from = new Date(now.getTime() - 3 * 86400000);
  return dhan(creds, "/charts/intraday", {
    method: "POST",
    body: {
      securityId,
      exchangeSegment: segment,
      instrument,
      interval: "5",
      oi: false,
      fromDate: `${istStamp(from, false)} 09:15:00`,
      toDate: istStamp(now, true),
    },
  });
}

async function daily(creds: Creds, securityId: string, segment: string, instrument: string) {
  const now = new Date();
  const from = new Date(now.getTime() - 70 * 86400000);
  const to = new Date(now.getTime() + 86400000);
  return dhan(creds, "/charts/historical", {
    method: "POST",
    body: {
      securityId,
      exchangeSegment: segment,
      instrument,
      oi: false,
      fromDate: istStamp(from, false),
      toDate: istStamp(to, false),
    },
  });
}

type QuoteRow = { last_price?: number; ohlc?: { open?: number; close?: number; high?: number; low?: number } };

function tapeFrom(map: Map<string, QuoteRow>, ids: { securityId: string; symbol: string; name: string }[]): TapePoint[] {
  return ids
    .map((n) => {
      const row = map.get(n.securityId);
      const ltp = num(row?.last_price);
      const prev = num(row?.ohlc?.close) || ltp;
      const changePct = prev ? ((ltp - prev) / prev) * 100 : 0;
      return { symbol: n.symbol, name: n.name, securityId: n.securityId, ltp, prev, changePct };
    })
    .filter((p) => p.ltp > 0);
}

export async function fetchTape(creds: Creds, fnoIds: string[] = []): Promise<LiveTape> {
  const body: Record<string, number[]> = { NSE_EQ: [], IDX_I: [], NSE_FNO: [] };
  for (const n of NAMES) body[n.segment]!.push(Number(n.securityId));
  for (const id of fnoIds) {
    if (/^\d+$/.test(id)) body.NSE_FNO!.push(Number(id));
  }
  const res = await paced("quote", () =>
    dhan<{ data?: Record<string, Record<string, QuoteRow>> }>(creds, "/marketfeed/ohlc", { method: "POST", body }),
  );
  const map = new Map<string, QuoteRow>();
  for (const seg of Object.values(res.data ?? {})) {
    for (const [id, row] of Object.entries(seg)) map.set(String(id), row);
  }
  const named = tapeFrom(map, NAMES);
  const extra = fnoIds
    .filter((id) => /^\d+$/.test(id) && !NAMES.some((n) => n.securityId === id))
    .map((id) => {
      const row = map.get(id);
      const ltp = num(row?.last_price);
      const prev = num(row?.ohlc?.close) || ltp;
      return {
        symbol: id,
        name: "Option",
        securityId: id,
        ltp,
        prev,
        changePct: prev ? ((ltp - prev) / prev) * 100 : 0,
      };
    })
    .filter((p) => p.ltp > 0);
  return { asOfLabel: formatIstStamp(), tape: [...named, ...extra] };
}

type Leg = {
  last_price?: number;
  oi?: number;
  previous_oi?: number;
  volume?: number;
  implied_volatility?: number;
  security_id?: string | number;
  securityId?: string | number;
  greeks?: { delta?: number };
};

function pickOption(
  underlying: string,
  underlyingId: string,
  side: "BUY" | "SELL",
  spot: number,
  chain: { last_price?: number; oc?: Record<string, { ce?: Leg; pe?: Leg }> },
  expiry: string,
): BoardSignal | null {
  const oc = chain.oc ?? {};
  const strikes = Object.keys(oc)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (!strikes.length || !spot) return null;
  const atm = strikes.reduce((best, s) => (Math.abs(s - spot) < Math.abs(best - spot) ? s : best), strikes[0]!);
  const type = side === "BUY" ? "CE" : "PE";
  const neighbors =
    type === "CE"
      ? strikes.filter((s) => s >= atm).slice(0, 2)
      : strikes.filter((s) => s <= atm).slice(-2);
  const pool = neighbors.length ? neighbors : [atm];
  let best: { strike: number; leg: Leg; score: number } | null = null;
  for (const strike of pool) {
    const leg = type === "CE" ? oc[String(strike)]?.ce : oc[String(strike)]?.pe;
    if (!leg || !num(leg.last_price)) continue;
    const oiChg = num(leg.oi) - num(leg.previous_oi);
    const score = oiChg + num(leg.volume) / 1000;
    if (!best || score > best.score) best = { strike, leg, score };
  }
  if (!best) return null;
  const premium = num(best.leg.last_price);
  const securityId = String(best.leg.security_id ?? best.leg.securityId ?? "");
  const lot = LOTS[underlying] ?? 1;
  return {
    id: `${istDate()}:${underlying}:${best.strike}${type}`,
    symbol: `${underlying} ${best.strike} ${type}`,
    name: `${underlying} ${expiry}`,
    securityId: securityId || `${underlyingId}:${best.strike}:${type}`,
    segment: "NSE_FNO",
    kind: "option",
    side: "BUY",
    entry: premium,
    target: Number((premium * 1.3).toFixed(2)),
    score: 0,
    ltp: premium,
    checks: [
      {
        name: "Index bias",
        pass: true,
        detail: `${underlying} ${side === "BUY" ? "through the opening range" : "under the opening range"}`,
      },
      {
        name: "Strike",
        pass: true,
        detail: `${type} ${best.strike} next to spot ${spot.toFixed(0)}`,
      },
    ],
    mode: "live",
    sessionDate: istDate(),
    squareOff: "15:10 IST",
    qty: lot,
    note: "Long premium only. No stop. Target is +30% on the premium, else square off at 15:10.",
    option: {
      underlying,
      strike: best.strike,
      type,
      expiry,
      iv: best.leg.implied_volatility ?? null,
      delta: best.leg.greeks?.delta ?? null,
      oiChange: num(best.leg.oi) - num(best.leg.previous_oi),
    },
  };
}

export async function buildSignalBoard(creds: Creds, symbols: string[]): Promise<SignalBoard> {
  const warnings: string[] = [];
  const session = marketSession();
  const wanted = new Set(symbols);
  const names = NAMES.filter((n) => wanted.has(n.symbol)).slice(0, 6);

  const packs: { n: (typeof NAMES)[number]; bars: Bar[]; daily: number[] }[] = [];
  for (const n of names) {
    try {
      const intra = await cachedStale(`dhan:intra:${n.securityId}:${istDate()}`, 70_000, () =>
        paced("data", () => intraday(creds, n.securityId, n.segment, n.instrument)),
      );
      const hist = await cachedStale(`dhan:day:${n.securityId}:${istDate()}`, 6 * 60 * 60 * 1000, () =>
        paced("data", () => daily(creds, n.securityId, n.segment, n.instrument)),
      );
      packs.push({ n, bars: barsFrom(intra), daily: barsFrom(hist).map((b) => b.c) });
    } catch (err) {
      warnings.push(`${n.symbol}: ${err instanceof Error ? err.message : "chart failed"}`);
      packs.push({ n, bars: [], daily: [] });
    }
  }

  const signals: BoardSignal[] = [];
  const quiet: QuietName[] = [];
  let reviews = 0;
  for (const pack of packs) {
    if (pack.n.instrument !== "EQUITY") continue;
    const read = diagnose(pack.bars, pack.daily);
    if (!read.setup) {
      quiet.push({ symbol: pack.n.symbol, name: pack.n.name, reason: read.reason });
      continue;
    }
    const ltp = pack.bars.length ? pack.bars[pack.bars.length - 1]!.c : read.setup.entry;
    if (read.setup.mode === "review") reviews += 1;
    signals.push({
      id: `${read.setup.sessionDate}:${pack.n.symbol}:${read.setup.side}`,
      symbol: pack.n.symbol,
      name: pack.n.name,
      securityId: pack.n.securityId,
      segment: "NSE_EQ",
      kind: "stock",
      side: read.setup.side,
      entry: read.setup.entry,
      target: read.setup.target,
      score: read.setup.score,
      ltp,
      checks: read.setup.checks,
      mode: read.setup.mode,
      sessionDate: read.setup.sessionDate,
      squareOff: "15:10 IST",
      qty: 1,
      note: "No stop. The paper print stays open until the target prints or 15:10 IST.",
    });
  }

  for (const index of INDEXES) {
    if (!wanted.has(index.symbol)) continue;
    const pack = packs.find((p) => p.n.symbol === index.symbol);
    const read = pack ? diagnose(pack.bars, pack.daily) : { setup: null, reason: "Index bars missing." };
    if (!read.setup) {
      quiet.push({ symbol: index.symbol, name: index.name, reason: read.reason });
      continue;
    }
    if (read.setup.mode !== "live") {
      quiet.push({
        symbol: index.symbol,
        name: index.name,
        reason: `Last session was ${read.setup.side}. Options stay off until today's range breaks.`,
      });
      continue;
    }
    try {
      const exp = await paced("chain", () =>
        dhan<{ data?: string[] }>(creds, "/optionchain/expirylist", {
          method: "POST",
          body: { UnderlyingScrip: Number(index.securityId), UnderlyingSeg: "IDX_I" },
        }),
      );
      const expiry = (exp.data ?? [])[0];
      if (!expiry) {
        quiet.push({ symbol: index.symbol, name: index.name, reason: "No listed expiry on the chain." });
        continue;
      }
      const chain = await paced("chain", () =>
        dhan<{ data?: { last_price?: number; oc?: Record<string, { ce?: Leg; pe?: Leg }> } }>(creds, "/optionchain", {
          method: "POST",
          body: { UnderlyingScrip: Number(index.securityId), UnderlyingSeg: "IDX_I", Expiry: expiry },
        }),
      );
      const spot = num(chain.data?.last_price) || 0;
      const opt = chain.data ? pickOption(index.symbol, index.securityId, read.setup.side, spot, chain.data, expiry) : null;
      if (opt) {
        opt.score = read.setup.score;
        opt.mode = "live";
        opt.sessionDate = read.setup.sessionDate;
        opt.checks = [...opt.checks, ...read.setup.checks.filter((c) => c.name === "VWAP" || c.name === "Volume")];
        signals.push(opt);
      } else {
        quiet.push({ symbol: index.symbol, name: index.name, reason: "Chain had no priced strike next to spot." });
      }
    } catch (err) {
      warnings.push(`${index.symbol} options: ${err instanceof Error ? err.message : "chain failed"}`);
    }
  }

  signals.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
  const live = signals.some((s) => s.mode === "live");
  const rateHits = warnings.filter((w) => /rate limit/i.test(w));
  const cleanWarnings = warnings.filter((w) => !/rate limit/i.test(w));
  if (rateHits.length) cleanWarnings.push("Dhan asked for a slower scan. This slice will retry on the next pass.");
  const engine: EngineRead = {
    scanned: names.length,
    livePrints: signals.filter((s) => s.mode === "live").length,
    reviews,
    quiet: quiet.length,
    phase: session.label,
  };
  return {
    asOfLabel: formatIstStamp(),
    sessionNote: live
      ? "Live prints are paper until you send them. No stop. Square-off is 15:10 IST."
      : session.session === "open"
        ? "Opening range is still forming. Live prints start after 9:30 IST."
        : "Market is shut. Reviews below are the last session. They are not paper orders.",
    tape: [],
    signals,
    quiet,
    engine,
    warnings: [...new Set(cleanWarnings)].slice(0, 4),
  };
}

function asArray(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body as Record<string, unknown>[];
  const data = (body as { data?: unknown })?.data;
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
}

export async function buildDesk(creds: Creds): Promise<DeskBook> {
  const warnings: string[] = [];
  let funds: Funds | null = null;
  try {
    const raw = await dhan<Record<string, unknown>>(creds, "/fundlimit");
    const src = (raw.data as Record<string, unknown> | undefined) ?? raw;
    funds = {
      available: num(src.availabelBalance ?? src.availableBalance),
      used: num(src.utilizedAmount),
      withdrawable: num(src.withdrawableBalance),
      collateral: num(src.collateralAmount),
      sod: num(src.sodLimit),
    };
  } catch (err) {
    warnings.push(err instanceof Error ? err.message : "Funds failed");
  }

  let holdings: Holding[] = [];
  try {
    holdings = asArray(await dhan(creds, "/holdings")).map((h) => ({
      symbol: String(h.tradingSymbol ?? h.symbol ?? ""),
      securityId: String(h.securityId ?? ""),
      qty: num(h.totalQty),
      avg: num(h.avgCostPrice),
    }));
  } catch (err) {
    warnings.push(err instanceof Error ? err.message : "Holdings failed");
  }

  let positions: LivePosition[] = [];
  try {
    positions = asArray(await dhan(creds, "/positions")).map((p) => ({
      symbol: String(p.tradingSymbol ?? ""),
      securityId: String(p.securityId ?? ""),
      segment: String(p.exchangeSegment ?? ""),
      product: String(p.productType ?? ""),
      side: String(p.positionType ?? ""),
      netQty: num(p.netQty),
      buyAvg: num(p.buyAvg),
      sellAvg: num(p.sellAvg),
      realized: num(p.realizedProfit),
      unrealized: num(p.unrealizedProfit),
    }));
  } catch (err) {
    warnings.push(err instanceof Error ? err.message : "Positions failed");
  }

  return { asOfLabel: formatIstStamp(), funds, holdings, positions, warnings };
}

export async function sendOrder(
  creds: Creds,
  order: {
    securityId: string;
    segment: "NSE_EQ" | "NSE_FNO";
    side: "BUY" | "SELL";
    qty: number;
    symbol: string;
  },
) {
  const res = await dhan<{ orderId?: string; data?: { orderId?: string } }>(creds, "/orders", {
    method: "POST",
    body: {
      dhanClientId: creds.clientId,
      correlationId: `artha${Date.now()}`.slice(0, 20),
      transactionType: order.side,
      exchangeSegment: order.segment,
      productType: "INTRADAY",
      orderType: "MARKET",
      validity: "DAY",
      securityId: order.securityId,
      quantity: order.qty,
      disclosedQuantity: 0,
      price: 0,
      triggerPrice: 0,
      afterMarketOrder: false,
    },
  });
  const orderId = res.orderId ?? res.data?.orderId;
  if (!orderId) throw new Error("Dhan accepted the call but did not return an order id.");
  return { orderId, symbol: order.symbol };
}

export const STOCK_IDS = STOCKS.map((s) => s.securityId);
