import { randomUUID } from "node:crypto";
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { istDateKey } from "@/lib/market/hours";
import { niftyQuery } from "@/lib/nifty-db.server";
import { loadAltBook } from "./alt-load";
import { sendOrder } from "./board";
import { dhan, DhanError } from "./client";
import { crossPnl, EMPTY_BOOK, markTrades, reduceAtm, type BookSnap, type CrossTrade, type WaveLeg } from "./cross-math";
import { mintAccessToken, readDhanEnv, type DhanEnv } from "./dhan-auth.server";
import { intentIsFresh, liveOrdersEnabled, orderIntents, orderTag, type OrderIntent } from "./live-sync";
import { loadNiftyBook, type NiftyBook } from "./nifty";
import { applyTick } from "./reversal";
import { keepTwoDays } from "./session-api";
import { deskPhase, msUntilSession, ordersAllowed, SERVER_CUT, type DeskPhase } from "./session-clock";
import { parseFeed, type FeedTick } from "./ticks";

type Leg = WaveLeg & { kind: "FUT" | "CE" | "PE"; strike: number };
type Run = {
  symbol: "NIFTY" | "BANKNIFTY";
  lot: number;
  expiry: string;
  futureId: string;
  legs: Map<string, Leg>;
  book: BookSnap;
};
type Fill = { buyOrderId?: string; sellOrderId?: string; error?: string; tries?: number };
type Creds = { clientId: string; accessToken: string };

const owner = randomUUID();
const claimed = new Set<string>();
const fills = new Map<string, Fill>();
const tickBuf: { day: string; t: number; securityId: string; kind: string; strike: number; ltp: number }[] = [];

let started = false;
let owns = false;
let acceptOrders = false;
let holdsLock = false;
let note = "The phone is a mirror. The Mumbai login is not on this machine.";
let phase: DeskPhase = "sleep";
let niftyBook: BookSnap = freshBook();
let bankBook: BookSnap = freshBook();
let expiry = "";
let bankExpiry = "";

function freshBook(): BookSnap {
  return { trades: [], seen: [], total: 0, closedPnl: 0 };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function deskSnapshot(): {
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
  if (started) return;
  const env = readDhanEnv();
  if (!env) return;
  started = true;
  owns = true;
  note = "Lightsail owns the book. The feed wakes at 09:08 IST. Live orders start at 09:15.";
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
    }
    phase = deskPhase();
    if (phase === "shutdown" || phase === "sleep") continue;
    await sleep(2000);
  }
}

async function runSession(env: DhanEnv) {
  holdsLock = await tryLock();
  const token = await mintAccessToken(env);
  const creds = { clientId: env.clientId, accessToken: token };
  const chain = await loadNiftyBook(creds);
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
  if (liveOrdersEnabled() && holdsLock) {
    try {
      await syncBrokerTags(creds);
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
  return { symbol, lot: chain.lot, expiry: chain.expiry, futureId: chain.future.securityId, legs, book: freshBook() };
}

async function feed(env: DhanEnv, creds: Creds, runs: Run[]) {
  const url = `wss://api-feed.dhan.co?version=2&token=${encodeURIComponent(creds.accessToken)}&clientId=${encodeURIComponent(env.clientId)}&authType=2`;
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    let ending = false;
    const clock = setInterval(() => {
      phase = deskPhase();
      if (phase === "shutdown" || phase === "sleep") finish();
    }, 500);
    const beat = setInterval(() => {
      void tryLock().then((ok) => {
        holdsLock = ok;
        if (!ok) acceptOrders = false;
      });
    }, 10_000);
    const ticksFlush = setInterval(() => void flushTicks(), 250);
    const bookFlush = setInterval(() => void persistBooks(runs).catch(() => undefined), 2000);
    const stopTimers = () => {
      clearInterval(clock);
      clearInterval(beat);
      clearInterval(ticksFlush);
      clearInterval(bookFlush);
    };
    const finish = () => {
      if (ending) return;
      ending = true;
      stopTimers();
      socket.close();
      resolve();
    };
    socket.addEventListener("open", () => {
      const ids = [...new Set(runs.flatMap((run) => [...run.legs.keys()]))];
      const list = [
        { ExchangeSegment: "IDX_I", SecurityId: "13" },
        { ExchangeSegment: "IDX_I", SecurityId: "25" },
        ...ids.map((id) => ({ ExchangeSegment: "NSE_FNO", SecurityId: id })),
      ];
      socket.send(JSON.stringify({ RequestCode: 21, InstrumentCount: list.length, InstrumentList: list }));
      if (!note.startsWith("Live orders are paused") && !note.startsWith("Paper")) {
        note = acceptOrders ? "Mumbai feed is on. Market orders fire with the paper." : note;
      }
    });
    socket.addEventListener("message", (event) => {
      const data = event.data;
      if (!(data instanceof ArrayBuffer) || ending) return;
      onTicks(parseFeed(data), runs, env);
    });
    socket.addEventListener("close", () => {
      if (ending) return;
      ending = true;
      stopTimers();
      if (deskPhase() === "shutdown" || deskPhase() === "sleep") resolve();
      else reject(new Error("Dhan closed the Mumbai feed."));
    });
    socket.addEventListener("error", () => {
      if (ending) return;
      ending = true;
      stopTimers();
      reject(new Error("The Mumbai feed failed."));
    });
  });
}

function onTicks(ticks: FeedTick[], runs: Run[], env: DhanEnv) {
  for (const tick of ticks) {
    if (!(tick.ltp > 0)) continue;
    for (const run of runs) {
      const leg = run.legs.get(tick.securityId);
      if (!leg) continue;
      leg.ltp = tick.ltp;
      leg.bars = applyTick(
        leg.bars.map((bar) => ({ t: bar.t, o: bar.c, h: bar.c, l: bar.c, c: bar.c, bid: 0, ask: 0 })),
        { ts: tick.ts || Date.now(), ltp: tick.ltp, bid: tick.bid, ask: tick.ask },
      ).map((bar) => ({ t: bar.t, c: bar.c }));
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
  phase = deskPhase();
  if (phase === "shutdown" || phase === "sleep") return;
  for (const run of runs) step(run, phase, env);
  const nifty = runs.find((run) => run.symbol === "NIFTY");
  const bank = runs.find((run) => run.symbol === "BANKNIFTY");
  if (nifty) niftyBook = nifty.book;
  if (bank) bankBook = bank.book;
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
    if (liveOrdersEnabled() && !claimed.has(orderTag(intent.tradeId, "BUY")) && !buyIds.has(intent.tradeId)) return false;
    return true;
  });
  const intents = [...buys, ...sells];
  run.book = next;
  if (acceptOrders && holdsLock && intents.length) void dispatch(intents, env);
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

async function dispatch(intents: OrderIntent[], env: DhanEnv) {
  const groups = new Map<string, OrderIntent[]>();
  for (const intent of intents) {
    const key = `${intent.symbol}:${intent.tradeId}`;
    groups.set(key, [...(groups.get(key) ?? []), intent]);
  }
  await Promise.all(
    [...groups.values()].map(async (group) => {
      const ordered = [...group.filter((intent) => intent.side === "BUY"), ...group.filter((intent) => intent.side === "SELL")];
      for (const intent of ordered) await send(intent, env);
    }),
  );
}

async function send(intent: OrderIntent, env: DhanEnv) {
  const tag = orderTag(intent.tradeId, intent.side);
  if (claimed.has(tag)) return;
  if (!ordersAllowed(deskPhase(), intent.side)) return;
  claimed.add(tag);
  if (!liveOrdersEnabled()) return;
  try {
    const token = await mintAccessToken(env);
    const creds = { clientId: env.clientId, accessToken: token };
    const res = await sendOrder(creds, {
      securityId: intent.securityId,
      segment: "NSE_FNO",
      side: intent.side,
      qty: intent.qty,
      symbol: intent.symbol,
      correlationId: tag,
    });
    const fill = fills.get(intent.tradeId) ?? {};
    if (intent.side === "BUY") fill.buyOrderId = res.orderId;
    else fill.sellOrderId = res.orderId;
    delete fill.error;
    fills.set(intent.tradeId, fill);
    note = `${intent.symbol} ${intent.side} market ${intent.qty} · ${res.orderId}`;
    void remember(tag, intent, res.orderId);
  } catch (err) {
    claimed.delete(tag);
    const message = err instanceof Error ? err.message : "Order failed.";
    const fill = fills.get(intent.tradeId) ?? {};
    fill.tries = (fill.tries ?? 0) + 1;
    fill.error = message;
    fills.set(intent.tradeId, fill);
    note = `${intent.symbol} ${intent.side} failed. ${message}`;
    const rejected = err instanceof DhanError && err.status >= 400 && err.status < 500 && err.status !== 429;
    const buyGaveUp = intent.side === "BUY" && (fill.tries ?? 0) >= 5;
    if (rejected || buyGaveUp || !ordersAllowed(deskPhase(), intent.side)) {
      claimed.add(tag);
      return;
    }
    try {
      const token = await mintAccessToken(env);
      const existing = await findOrder({ clientId: env.clientId, accessToken: token }, tag);
      if (existing) {
        claimed.add(tag);
        const known = fills.get(intent.tradeId) ?? {};
        if (intent.side === "BUY") known.buyOrderId = existing;
        else known.sellOrderId = existing;
        fills.set(intent.tradeId, known);
        void remember(tag, intent, existing);
        return;
      }
    } catch {
      /* the retry below is the only second chance */
    }
    setTimeout(() => void send(intent, env), intent.side === "SELL" ? 1500 : 800);
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
    const tags = await niftyQuery<{ tag: string }>("select tag from live_order where day = $1", [istDateKey()]);
    for (const tag of tags) claimed.add(tag.tag);
  } catch {
    /* a missing database still lets the paper run in memory */
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
