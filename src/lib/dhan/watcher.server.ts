import { randomUUID } from "node:crypto";
import { setDefaultResultOrder } from "node:dns";
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { istDateKey } from "@/lib/market/hours";
import { niftyQuery } from "@/lib/nifty-db.server";
import { loadAltBook } from "./alt-load";
import { sendOrder } from "./board";
import { dhan, DhanError } from "./client";
import { crossPnl, EMPTY_BOOK, markTrades, reduceAtm, type BookSnap, type CrossTrade, type WaveLeg } from "./cross-math";
import { forgetAccessToken, mintAccessToken, readDhanEnv, type DhanEnv } from "./dhan-auth.server";
import { gateOrder, intentIsFresh, liveOrdersEnabled, nextIntent, orderIntents, orderTag, signedNet, type OrderIntent } from "./live-sync";
import { loadNiftyBook, type NiftyBook } from "./nifty";
import { keepTwoDays } from "./session-api";
import { deskPhase, msUntilSession, ordersAllowed, SERVER_CUT, type DeskPhase } from "./session-clock";
import { parseFeed, type FeedTick } from "./ticks";
import { contractIsLive } from "./week";

setDefaultResultOrder("ipv4first");

type Leg = WaveLeg & { kind: "FUT" | "CE" | "PE"; strike: number };
type Run = {
  symbol: "NIFTY" | "BANKNIFTY";
  lot: number;
  expiry: string;
  futureExpiry: string;
  futureId: string;
  legs: Map<string, Leg>;
  book: BookSnap;
};
type Fill = { buyOrderId?: string; sellOrderId?: string; error?: string; tries?: number };
type Creds = { clientId: string; accessToken: string };

const owner = randomUUID();
const claimed = new Set<string>();
const fills = new Map<string, Fill>();
const pending = new Map<string, OrderIntent>();
const draining = new Set<string>();
const flatWaits = new Map<string, number>();
const watched = new Map<string, Set<string>>();
const tickBuf: { day: string; t: number; securityId: string; kind: string; strike: number; ltp: number }[] = [];

let started = false;
let owns = false;
let acceptOrders = false;
let holdsLock = false;
let brokerSynced = false;
let note = "The phone is a mirror. The Mumbai login is not on this machine.";
let phase: DeskPhase = "sleep";
let niftyBook: BookSnap = freshBook();
let bankBook: BookSnap = freshBook();
let expiry = "";
let bankExpiry = "";

function watchId(symbol: string, securityId: string) {
  if (!securityId) return;
  const ids = watched.get(symbol) ?? new Set<string>();
  ids.add(securityId);
  watched.set(symbol, ids);
}

function freshBook(): BookSnap {
  return { trades: [], seen: [], total: 0, closedPnl: 0 };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type DeskSnap = {
  owns: boolean;
  note: string;
  phase: DeskPhase;
  live: boolean;
  book: BookSnap;
  expiry: string;
  bank: BookSnap;
  bankExpiry: string;
  orders: Record<string, Fill>;
};

/** The build bundles this file twice (the Nitro plugin chunk and the SSR chunk the page calls).
 *  Each copy has its own module state, so without this both started a desk in one process:
 *  two Dhan logins, two feeds, two lock owners, and the page read the copy that was not trading.
 *  The first copy to start registers here; every other copy only reads its snapshot. */
const deskGlobal = globalThis as typeof globalThis & { __arthaDesk?: { snapshot: () => DeskSnap } };

export function deskSnapshot(): DeskSnap {
  const running = deskGlobal.__arthaDesk;
  if (running && running.snapshot !== localSnapshot) return running.snapshot();
  return localSnapshot();
}

function localSnapshot(): {
  owns: boolean;
  note: string;
  phase: DeskPhase;
  live: boolean;
  book: BookSnap;
  expiry: string;
  bank: BookSnap;
  bankExpiry: string;
  orders: Record<string, Fill>;
} {
  phase = deskPhase();
  return {
    owns,
    note,
    phase,
    live: liveOrdersEnabled(),
    book: niftyBook,
    expiry,
    bank: bankBook,
    bankExpiry,
    orders: Object.fromEntries(fills),
  };
}

export function startDesk() {
  if (started || deskGlobal.__arthaDesk) return;
  const env = readDhanEnv();
  if (!env) return;
  deskGlobal.__arthaDesk = { snapshot: localSnapshot };
  started = true;
  owns = true;
  note = "Lightsail owns the book. The feed wakes at 09:08 IST. Live orders start at 09:15.";
  console.log(`[desk] started. live orders ${liveOrdersEnabled() ? "ON (ARTHA_LIVE=1)" : "OFF"}`);
  void main(env);
}

async function main(env: DhanEnv) {
  for (;;) {
    const wait = msUntilSession();
    phase = deskPhase();
    if (wait > 0) {
      acceptOrders = false;
      note = phase === "shutdown" ? "Lightsail is asleep until the next weekday 09:08 IST." : "Lightsail is asleep until 09:08 IST. No orders before 09:15.";
      await sleep(Math.min(wait, 30_000));
      continue;
    }
    try {
      await runSession(env);
    } catch (err) {
      acceptOrders = false;
      note = err instanceof Error ? err.message : "The Mumbai watcher stopped.";
      console.error("[desk] session stopped:", note);
    }
    phase = deskPhase();
    if (phase === "shutdown" || phase === "sleep") continue;
    const login = /login failed|too many attempts|every 2 minutes|access token/i.test(note);
    await sleep(login ? 130_000 : 2000);
  }
}

async function runSession(env: DhanEnv) {
  note = "Logging in to Dhan.";
  holdsLock = await within(tryLock(), 12_000, "The database");
  const token = await within(mintAccessToken(env), 20_000, "Dhan login");
  const creds = { clientId: env.clientId, accessToken: token };
  note = "Reading the Nifty chain.";
  const chain = await within(loadNiftyBook(creds), 90_000, "The Nifty chain");
  let bankChain: NiftyBook | null = null;
  try {
    bankChain = await loadAltBook(creds, "BANKNIFTY");
  } catch (err) {
    note = `Bank Nifty chain failed. Nifty is still on. ${err instanceof Error ? err.message : ""}`.trim();
  }
  const nifty = seedRun("NIFTY", chain);
  const bank = bankChain ? seedRun("BANKNIFTY", bankChain) : null;
  expiry = chain.expiry;
  bankExpiry = bankChain?.expiry ?? "";
  await restore(nifty, bank);
  niftyBook = nifty.book;
  if (bank) bankBook = bank.book;
  acceptOrders = false;
  brokerSynced = false;
  if (liveOrdersEnabled() && holdsLock) {
    try {
      await syncBrokerTags(creds);
      brokerSynced = true;
      acceptOrders = true;
      note = "Lightsail is live. Nifty and Bank Nifty market orders go out with the paper.";
    } catch {
      note = "Live orders are paused. Today's Dhan order list could not be read, so nothing will be sent twice.";
    }
  } else if (!liveOrdersEnabled()) {
    note = holdsLock
      ? "Paper is running on Lightsail. Set ARTHA_LIVE=1 to send the market orders."
      : "Paper only. This process does not hold the desk lock.";
  } else {
    note = "Another Lightsail process holds the desk. This one will not send orders.";
  }
  console.log(`[desk] session ready: ${note} (lock ${holdsLock ? "held" : "not held"})`);
  const runs = [nifty, bank].filter((run): run is Run => !!run);
  await feed(env, creds, runs);
  await flushTicks();
  await persistBooks(runs);
}

function seedRun(symbol: Run["symbol"], chain: NiftyBook): Run {
  const legs = new Map<string, Leg>();
  const seed = (contract: NiftyBook["future"], kind: Leg["kind"], bars: { t: number; c: number }[]) => {
    legs.set(contract.securityId, {
      kind,
      strike: contract.strike,
      contract: { securityId: contract.securityId, type: kind === "FUT" ? "FUT" : kind, strike: contract.strike },
      ltp: contract.ltp,
      bars: bars.map((bar) => ({ t: bar.t, c: bar.c })),
      prints: [],
    });
  };
  seed(chain.future, "FUT", chain.history.future);
  for (const contract of chain.ladder) seed(contract, contract.type === "PE" ? "PE" : "CE", chain.history.ladder[contract.securityId] ?? []);
  return { symbol, lot: chain.lot, expiry: chain.expiry, futureExpiry: chain.future.why, futureId: chain.future.securityId, legs, book: freshBook() };
}

function within<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not answer.`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function feed(env: DhanEnv, _creds: Creds, runs: Run[]) {
  await new Promise<void>((resolve) => {
    let stopped = false;
    let socket: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    let opening = false;
    let pause = 3000;
    const clock = setInterval(() => {
      phase = deskPhase();
      const today = istDateKey();
      const expired = runs.some((run) => !contractIsLive(run.expiry, today) || !contractIsLive(run.futureExpiry, today));
      if (expired) note = "The contract expired. Lightsail is loading the next one.";
      if (phase === "shutdown" || phase === "sleep" || expired) finish();
    }, 500);
    const beat = setInterval(() => {
      void tryLock().then((ok) => {
        holdsLock = ok;
        // One slow or failed heartbeat used to switch live orders off until the next
        // session while the paper kept trading. Come back once the lock is held again.
        acceptOrders = ok && brokerSynced && liveOrdersEnabled();
      });
    }, 10_000);
    const ticksFlush = setInterval(() => void flushTicks(), 250);
    const bookFlush = setInterval(() => void persistBooks(runs).catch(() => undefined), 2000);
    const finish = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(clock);
      clearInterval(beat);
      clearInterval(ticksFlush);
      clearInterval(bookFlush);
      if (reconnect) clearTimeout(reconnect);
      socket?.close();
      resolve();
    };
    const connect = () => {
      if (stopped || opening) return;
      opening = true;
      if (reconnect) {
        clearTimeout(reconnect);
        reconnect = null;
      }
      void mintAccessToken(env)
        .then((token) => {
          if (stopped) return;
          const previous = socket;
          if (previous && previous.readyState !== WebSocket.CLOSED) previous.close();
          const url = `wss://api-feed.dhan.co?version=2&token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(env.clientId)}&authType=2`;
          const next = new WebSocket(url);
          socket = next;
          next.binaryType = "arraybuffer";
          next.addEventListener("open", () => {
            if (stopped || next !== socket) return;
            opening = false;
            pause = 3000;
            const ids = [...new Set(runs.flatMap((run) => [...run.legs.keys()]))];
            const list = [
              { ExchangeSegment: "IDX_I", SecurityId: "13" },
              { ExchangeSegment: "IDX_I", SecurityId: "25" },
              ...ids.map((id) => ({ ExchangeSegment: "NSE_FNO", SecurityId: id })),
            ];
            next.send(JSON.stringify({ RequestCode: 21, InstrumentCount: list.length, InstrumentList: list }));
            if (!note.startsWith("Live orders are paused") && !note.startsWith("Paper")) {
              note = acceptOrders ? "Mumbai feed is on. Market orders fire with the paper." : "Mumbai feed is on. This process is not sending orders.";
            }
          });
          next.addEventListener("message", (event) => {
            const data = event.data;
            if (!(data instanceof ArrayBuffer) || stopped || next !== socket) return;
            onTicks(parseFeed(data), runs, env);
          });
          next.addEventListener("close", (event) => {
            opening = false;
            if (stopped || next !== socket) return;
            const why = event.reason ? ` ${event.reason}` : "";
            note = `Mumbai feed dropped (${event.code}${why}). Lightsail is reconnecting.`;
            if (reconnect) return;
            reconnect = setTimeout(() => {
              reconnect = null;
              connect();
            }, pause);
            pause = Math.min(pause * 2, 15_000);
          });
          next.addEventListener("error", () => {
            if (next.readyState === WebSocket.OPEN || next.readyState === WebSocket.CONNECTING) next.close();
          });
        })
        .catch((err) => {
          opening = false;
          if (stopped) return;
          note = err instanceof Error ? err.message : "The Mumbai feed could not reconnect.";
          if (reconnect) return;
          reconnect = setTimeout(() => {
            reconnect = null;
            connect();
          }, 60_000);
        });
    };
    connect();
  });
}

function onTicks(ticks: FeedTick[], runs: Run[], env: DhanEnv) {
  for (const tick of ticks) {
    if (!(tick.ltp > 0)) continue;
    for (const run of runs) {
      const leg = run.legs.get(tick.securityId);
      if (!leg) continue;
      leg.ltp = tick.ltp;
      const bucket = Math.floor((tick.ts || Date.now()) / 60_000) * 60_000;
      const last = leg.bars[leg.bars.length - 1];
      if (!last || last.t !== bucket) {
        leg.bars.push({ t: bucket, c: tick.ltp });
        if (leg.bars.length > 400) leg.bars.shift();
      } else {
        last.c = tick.ltp;
      }
      tickBuf.push({
        day: istDateKey(),
        t: tick.ts || Date.now(),
        securityId: leg.contract.securityId,
        kind: leg.kind,
        strike: leg.strike,
        ltp: tick.ltp,
      });
    }
  }
  if (tickBuf.length > 5000) tickBuf.splice(0, tickBuf.length - 5000);
  queueStep(runs, env);
}

let stepQueued = false;
function queueStep(runs: Run[], env: DhanEnv) {
  if (stepQueued) return;
  stepQueued = true;
  setImmediate(() => {
    stepQueued = false;
    phase = deskPhase();
    if (phase === "shutdown" || phase === "sleep") return;
    for (const run of runs) step(run, phase, env);
    const nifty = runs.find((run) => run.symbol === "NIFTY");
    const bank = runs.find((run) => run.symbol === "BANKNIFTY");
    if (nifty) niftyBook = nifty.book;
    if (bank) bankBook = bank.book;
  });
}

function step(run: Run, nowPhase: DeskPhase, env: DhanEnv) {
  const now = Date.now();
  const anchor = run.legs.get(run.futureId)?.ltp || 0;
  const priceOf = (id: string) => run.legs.get(id)?.ltp;
  const marked = markTrades(run.book.trades, priceOf);
  const base = marked === run.book.trades ? run.book : { ...run.book, trades: marked };
  let next = reduceAtm(base, [...run.legs.values()], run.lot, run.expiry, anchor, now, SERVER_CUT);
  if (nowPhase === "flatten") next = clampFlat(next, priceOf, now);
  const raw = orderIntents(run.book, next, run.symbol);
  const buys = raw.filter((intent) => {
    if (!ordersAllowed(nowPhase, "BUY")) return false;
    const trade = next.trades.find((row) => row.id === intent.tradeId);
    return !!trade && intent.side === "BUY" && intentIsFresh(trade, "BUY", now);
  });
  const buyIds = new Set(buys.map((intent) => intent.tradeId));
  const sells = raw.filter((intent) => {
    if (intent.side !== "SELL" || !ordersAllowed(nowPhase, "SELL")) return false;
    const trade = next.trades.find((row) => row.id === intent.tradeId);
    if (!trade || !intentIsFresh(trade, "SELL", now)) return false;
    const buyTag = orderTag(intent.tradeId, "BUY");
    if (liveOrdersEnabled() && !claimed.has(buyTag) && !pending.has(buyTag) && !buyIds.has(intent.tradeId)) return false;
    return true;
  });
  const intents = [...buys, ...sells];
  run.book = next;
  if (!acceptOrders || !holdsLock) return;
  for (const intent of intents) {
    watchId(intent.symbol, intent.securityId);
    const tag = orderTag(intent.tradeId, intent.side);
    if (!claimed.has(tag)) pending.set(tag, intent);
  }
  if (pending.size) void drain(run.symbol, env);
}

function clampFlat(book: BookSnap, priceOf: (id: string) => number | undefined, now: number): BookSnap {
  const open = book.trades.find((trade) => trade.status === "open");
  if (!open) return book;
  const px = priceOf(open.buy.securityId);
  if (!(px && px > 0)) return book;
  const closed: CrossTrade = {
    ...open,
    status: "closed",
    exitTs: now,
    exitWhy: "flat",
    buy: { ...open.buy, exit: px, mark: px },
  };
  return {
    ...book,
    trades: book.trades.map((trade) => (trade.id === closed.id ? closed : trade)),
    closedPnl: book.closedPnl + crossPnl(closed, px, true),
  };
}

async function drain(symbol: OrderIntent["symbol"], env: DhanEnv) {
  if (draining.has(symbol)) return;
  draining.add(symbol);
  try {
    while (acceptOrders && holdsLock) {
      const phaseNow = deskPhase();
      const queued = [...pending.values()].filter((intent) => intent.symbol === symbol);
      if (!ordersAllowed(phaseNow, "BUY")) {
        for (const intent of queued) if (intent.side === "BUY") pending.delete(orderTag(intent.tradeId, "BUY"));
      }
      const intent = nextIntent(
        [...pending.values()].filter((row) => row.symbol === symbol),
        ordersAllowed(phaseNow, "BUY"),
        ordersAllowed(phaseNow, "SELL"),
      );
      if (!intent) break;
      const outcome = await send(intent, env);
      if (outcome === "wait") await sleep(300);
    }
  } finally {
    draining.delete(symbol);
  }
}

async function send(intent: OrderIntent, env: DhanEnv): Promise<"done" | "wait"> {
  const tag = orderTag(intent.tradeId, intent.side);
  if (!liveOrdersEnabled() || !acceptOrders || !holdsLock) return "wait";
  if (claimed.has(tag)) {
    pending.delete(tag);
    return "done";
  }
  if (!ordersAllowed(deskPhase(), intent.side)) return "wait";
  let token: string;
  try {
    token = await mintAccessToken(env);
  } catch (err) {
    note = `${intent.symbol} ${intent.side} is waiting for a Dhan login. ${err instanceof Error ? err.message : ""}`.trim();
    console.error("[desk] login before order failed:", note);
    await sleep(5000);
    return "wait";
  }
  const creds = { clientId: env.clientId, accessToken: token };
  const known = fills.get(intent.tradeId) ?? {};
  const existingId = intent.side === "BUY" ? known.buyOrderId : known.sellOrderId;
  if (existingId) {
    const state = await orderState(creds, existingId);
    if (state === "TRADED") {
      claimed.add(tag);
      pending.delete(tag);
      flatWaits.delete(tag);
      void remember(tag, intent, existingId);
      return "done";
    }
    if (state === "REJECTED" || state === "CANCELLED" || state === "EXPIRED") {
      if (intent.side === "BUY") known.buyOrderId = undefined;
      else known.sellOrderId = undefined;
      fills.set(intent.tradeId, known);
    } else {
      note = `${intent.symbol} ${intent.side} is still working at Dhan. The next lot waits.`;
      return "wait";
    }
  }
  let nets: { securityId: string; netQty: number }[] = [];
  try {
    nets = await indexNets(creds, intent.symbol);
  } catch {
    note = `${intent.symbol} position book could not be read. No order was sent.`;
    return "wait";
  }
  const gate = gateOrder({ side: intent.side, securityId: intent.securityId, qty: intent.qty, nets, busy: false });
  if (!gate.ok && gate.reason === "flat") {
    if (!claimed.has(orderTag(intent.tradeId, "BUY"))) {
      note = `${intent.symbol} sell is waiting until its buy is filled.`;
      return "wait";
    }
    const seen = (flatWaits.get(tag) ?? 0) + 1;
    flatWaits.set(tag, seen);
    if (seen < 6) {
      note = `${intent.symbol} sell is waiting for Dhan to show the long.`;
      return "wait";
    }
    claimed.add(tag);
    pending.delete(tag);
    note = `${intent.symbol} is already flat at Dhan. No short was opened.`;
    return "done";
  }
  if (!gate.ok) {
    note = `${intent.symbol} buy is waiting. The open lot has to be flat before the next ATM.`;
    return "wait";
  }
  try {
    const res = await sendOrder(creds, {
      securityId: intent.securityId,
      segment: "NSE_FNO",
      side: intent.side,
      qty: gate.qty,
      symbol: intent.symbol,
      correlationId: tag,
    });
    const fill = fills.get(intent.tradeId) ?? {};
    if (intent.side === "BUY") fill.buyOrderId = res.orderId;
    else fill.sellOrderId = res.orderId;
    delete fill.error;
    fills.set(intent.tradeId, fill);
    note = `${intent.symbol} ${intent.side} market ${gate.qty} · ${res.orderId}`;
    console.log("[desk] order sent:", tag, note);
    const state = await orderState(creds, res.orderId);
    if (state === "TRADED") {
      claimed.add(tag);
      pending.delete(tag);
      flatWaits.delete(tag);
      void remember(tag, { ...intent, qty: gate.qty }, res.orderId);
      return "done";
    }
    if (state === "REJECTED" || state === "CANCELLED" || state === "EXPIRED") {
      throw new Error(`Dhan ${state.toLowerCase()} the ${intent.side.toLowerCase()}.`);
    }
    note = `${intent.symbol} ${intent.side} is with Dhan. Nothing else is sent until it finishes.`;
    return "wait";
  } catch (err) {
    const message = err instanceof Error ? err.message : "Order failed.";
    const fill = fills.get(intent.tradeId) ?? {};
    fill.tries = (fill.tries ?? 0) + 1;
    fill.error = message;
    fills.set(intent.tradeId, fill);
    note = `${intent.symbol} ${intent.side} failed. ${message}`;
    console.error("[desk] order failed:", tag, intent.symbol, intent.side, intent.securityId, gate.qty, err instanceof DhanError ? err.status : "", message);
    if (err instanceof DhanError && err.status === 401) forgetAccessToken(token);
    try {
      const existing = await findOrder(creds, tag);
      if (existing) {
        if (intent.side === "BUY") fill.buyOrderId = existing;
        else fill.sellOrderId = existing;
        fills.set(intent.tradeId, fill);
        return "wait";
      }
    } catch {
      /* the next pass reads the book again */
    }
    const rejected = err instanceof DhanError && err.status >= 400 && err.status < 500 && err.status !== 429 && err.status !== 401;
    if (rejected || (fill.tries ?? 0) >= 5) {
      claimed.add(tag);
      pending.delete(tag);
    }
    return "wait";
  }
}

async function indexNets(creds: Creds, symbol: OrderIntent["symbol"]): Promise<{ securityId: string; netQty: number }[]> {
  const body = await dhan<unknown>(creds, "/positions");
  const rows = Array.isArray(body) ? body : ((body as { data?: unknown }).data ?? []);
  if (!Array.isArray(rows)) throw new Error("Dhan positions were not readable.");
  const nets: { securityId: string; netQty: number }[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const rec = row as {
      securityId?: string | number;
      tradingSymbol?: string;
      exchangeSegment?: string;
      productType?: string;
      positionType?: string;
      netQty?: number;
    };
    if (String(rec.exchangeSegment ?? "") !== "NSE_FNO") continue;
    if (String(rec.productType ?? "") !== "INTRADAY") continue;
    const name = String(rec.tradingSymbol ?? "").toUpperCase();
    const id = String(rec.securityId ?? "");
    const named = symbol === "BANKNIFTY" ? name.startsWith("BANKNIFTY") : name.startsWith("NIFTY") && !name.startsWith("BANKNIFTY");
    if (!named && !(watched.get(symbol)?.has(id))) continue;
    const netQty = signedNet(String(rec.positionType ?? ""), Number(rec.netQty) || 0);
    if (netQty === 0) continue;
    nets.push({ securityId: String(rec.securityId ?? ""), netQty });
  }
  return nets;
}

async function orderState(creds: Creds, orderId: string): Promise<string> {
  try {
    const body = await dhan<unknown>(creds, `/orders/${encodeURIComponent(orderId)}`);
    const row = Array.isArray(body) ? body[0] : ((body as { data?: unknown }).data ?? body);
    const rec = (Array.isArray(row) ? row[0] : row) as { orderStatus?: string } | undefined;
    return String(rec?.orderStatus ?? "").toUpperCase();
  } catch {
    return "";
  }
}

async function findOrder(creds: Creds, tag: string): Promise<string | null> {
  const body = await dhan<unknown>(creds, "/orders");
  const rows = Array.isArray(body) ? body : ((body as { data?: unknown }).data ?? []);
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const rec = row as { correlationId?: string; orderId?: string };
    if (rec.correlationId === tag && rec.orderId) return String(rec.orderId);
  }
  return null;
}

async function syncBrokerTags(creds: Creds) {
  const body = await dhan<unknown>(creds, "/orders");
  const rows = Array.isArray(body) ? body : ((body as { data?: unknown }).data ?? []);
  if (!Array.isArray(rows)) throw new Error("Dhan order list was not readable.");
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const tag = String((row as { correlationId?: string }).correlationId ?? "");
    if (tag.length >= 8) claimed.add(tag);
  }
}

async function tryLock(): Promise<boolean> {
  try {
    const rows = await niftyQuery<{ owner: string }>(
      `update desk_lock set owner = $1, beat = now()
       where id = 1 and (owner = $1 or owner = '' or beat < now() - interval '20 seconds')
       returning owner`,
      [owner],
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function restore(nifty: Run, bank: Run | null) {
  try {
    const rows = await niftyQuery<{ book: unknown; bank_book: unknown; expiry: string; bank_expiry: string | null }>(
      "select book, bank_book, expiry, bank_expiry from nifty_session where day = $1",
      [istDateKey()],
    );
    const row = rows[0];
    if (row?.expiry === nifty.expiry) nifty.book = asBook(row.book);
    if (bank && row?.bank_expiry === bank.expiry) bank.book = asBook(row.bank_book);
  } catch {
    /* a missing database still lets the paper run in memory */
  }
  try {
    const tags = await niftyQuery<{ tag: string; symbol: string; security_id: string }>(
      "select tag, symbol, security_id from live_order where day = $1",
      [istDateKey()],
    );
    for (const tag of tags) {
      claimed.add(tag.tag);
      watchId(tag.symbol, tag.security_id);
    }
  } catch {
    /* no order tags yet */
  }
}

function asBook(value: unknown): BookSnap {
  let source = value;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source) as unknown;
    } catch {
      return freshBook();
    }
  }
  if (!source || typeof source !== "object") return freshBook();
  const row = source as BookSnap;
  return {
    trades: Array.isArray(row.trades) ? row.trades : [],
    seen: Array.isArray(row.seen) ? row.seen.map(String) : [],
    total: Number(row.total) || 0,
    closedPnl: Number(row.closedPnl) || 0,
  };
}

async function remember(tag: string, intent: OrderIntent, orderId: string) {
  try {
    await niftyQuery(
      `insert into live_order (tag, day, symbol, trade_id, side, security_id, qty, order_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (tag) do update set order_id = coalesce(excluded.order_id, live_order.order_id)`,
      [tag, istDateKey(), intent.symbol, intent.tradeId, intent.side, intent.securityId, intent.qty, orderId],
    );
  } catch {
    /* the in-memory claim still blocks a second send */
  }
}

async function flushTicks() {
  if (!tickBuf.length) return;
  const rows = tickBuf.splice(0, 800);
  try {
    await niftyQuery(
      `insert into nifty_tick (day, ts, security_id, kind, strike, ltp)
       select * from unnest($1::text[], $2::bigint[], $3::text[], $4::text[], $5::float8[], $6::float8[])`,
      [
        rows.map((row) => row.day),
        rows.map((row) => row.t),
        rows.map((row) => row.securityId),
        rows.map((row) => row.kind),
        rows.map((row) => row.strike),
        rows.map((row) => row.ltp),
      ],
    );
  } catch {
    tickBuf.unshift(...rows);
    if (tickBuf.length > 5000) tickBuf.splice(0, tickBuf.length - 5000);
  }
}

let savedMinute = new Set<string>();
let lastTrim = 0;

async function persistBooks(runs: Run[]) {
  const day = istDateKey();
  const nifty = runs.find((run) => run.symbol === "NIFTY");
  const bank = runs.find((run) => run.symbol === "BANKNIFTY");
  if (!nifty) return;
  const dir = process.env.ARTHA_DATA_DIR?.trim() || "/var/lib/artha";
  const rows = runs.flatMap((run) =>
    [...run.legs.values()].flatMap((leg) =>
      leg.bars.filter((bar) => bar.c > 0).map((bar) => ({
        t: bar.t,
        securityId: leg.contract.securityId,
        kind: leg.kind,
        strike: leg.strike,
        ltp: bar.c,
      })),
    ),
  );
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${day}.json`), JSON.stringify({ day, expiry: nifty.expiry, rows }));
    const names = (await readdir(dir)).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort();
    for (const name of names.slice(0, -2)) await unlink(join(dir, name));
  } catch {
    /* the database copy is the one the mirror reads */
  }
  await niftyQuery(
    `insert into nifty_session (day, expiry, legs, book, bank_expiry, bank_book)
     values ($1, $2, '{}'::jsonb, $3::jsonb, $4, $5::jsonb)
     on conflict (day) do update set
       expiry = excluded.expiry,
       book = excluded.book,
       bank_expiry = excluded.bank_expiry,
       bank_book = excluded.bank_book,
       updated_at = now()`,
    [day, nifty.expiry, JSON.stringify(nifty.book), bank?.expiry ?? null, JSON.stringify(bank?.book ?? EMPTY_BOOK)],
  );
  const trades = runs.flatMap((run) => run.book.trades.map((trade) => ({ symbol: run.symbol, expiry: run.expiry, trade })));
  if (trades.length) {
    await niftyQuery(
      `insert into nifty_trade
         (id, day, expiry, security_id, kind, strike, entry_ts, exit_ts, entry, exit, status, reason, exit_why, lots, lot, pnl, symbol, buy_order_id, sell_order_id)
       select * from unnest(
         $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::float8[],
         $7::bigint[], $8::bigint[], $9::float8[], $10::float8[], $11::text[], $12::text[],
         $13::text[], $14::int[], $15::int[], $16::float8[], $17::text[], $18::text[], $19::text[]
       )
       on conflict (id) do update set
         exit_ts = excluded.exit_ts, exit = excluded.exit, status = excluded.status,
         exit_why = excluded.exit_why, pnl = excluded.pnl, symbol = excluded.symbol,
         buy_order_id = coalesce(excluded.buy_order_id, nifty_trade.buy_order_id),
         sell_order_id = coalesce(excluded.sell_order_id, nifty_trade.sell_order_id),
         updated_at = now()`,
      [
        trades.map((row) => row.trade.id),
        trades.map(() => day),
        trades.map((row) => row.expiry),
        trades.map((row) => row.trade.buy.securityId),
        trades.map((row) => row.trade.buy.type),
        trades.map((row) => row.trade.buy.strike),
        trades.map((row) => row.trade.entryTs),
        trades.map((row) => row.trade.exitTs ?? null),
        trades.map((row) => row.trade.buy.entry),
        trades.map((row) => row.trade.buy.exit ?? null),
        trades.map((row) => row.trade.status),
        trades.map((row) => row.trade.reason),
        trades.map((row) => row.trade.exitWhy ?? null),
        trades.map((row) => row.trade.lots),
        trades.map((row) => row.trade.lot),
        trades.map((row) =>
          row.trade.status === "closed" && row.trade.buy.exit != null
            ? (row.trade.buy.exit - row.trade.buy.entry) * row.trade.lots * row.trade.lot - 60
            : null,
        ),
        trades.map((row) => row.symbol),
        trades.map((row) => fills.get(row.trade.id)?.buyOrderId ?? null),
        trades.map((row) => fills.get(row.trade.id)?.sellOrderId ?? null),
      ],
    );
  }
  const forming = Math.floor(Date.now() / 60_000) * 60_000;
  const fresh = rows.filter((row) => {
    if (row.t >= forming) return false;
    const key = `${row.securityId}:${row.t}`;
    if (savedMinute.has(key)) return false;
    savedMinute.add(key);
    return true;
  });
  if (fresh.length) {
    await niftyQuery(
      `insert into nifty_tick (day, ts, security_id, kind, strike, ltp)
       select * from unnest($1::text[], $2::bigint[], $3::text[], $4::text[], $5::float8[], $6::float8[])`,
      [fresh.map(() => day), fresh.map((row) => row.t), fresh.map((row) => row.securityId), fresh.map((row) => row.kind), fresh.map((row) => row.strike), fresh.map((row) => row.ltp)],
    );
  }
  if (Date.now() - lastTrim > 60_000) {
    lastTrim = Date.now();
    await keepTwoDays();
  }
}
