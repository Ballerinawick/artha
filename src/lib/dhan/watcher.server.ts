import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { istDateKey } from "@/lib/market/hours";
import { applyTick } from "./reversal";
import { EMPTY_BOOK, markTrades, reduceAtm, type BookSnap, type WaveLeg } from "./cross-math";
import { loadNiftyBook, type NiftyBook } from "./nifty";
import { parseFeed } from "./ticks";
import { mintAccessToken, readDhanEnv } from "./dhan-auth.server";
import { keepTwoDays } from "./session-api";

type Leg = WaveLeg & { kind: "FUT" | "CE" | "PE"; strike: number };

let started = false;
let owns = false;
let note = "The phone still decides. The Mumbai login is not on this machine.";
let book: BookSnap = { ...EMPTY_BOOK, trades: [], seen: [] };
let expiry = "";

export function deskSnapshot(): { owns: boolean; note: string; book: BookSnap; expiry: string } {
  return { owns, note, book, expiry };
}

export function startDesk() {
  if (started) return;
  const env = readDhanEnv();
  if (!env) return;
  started = true;
  void run(env).catch((err: unknown) => {
    owns = false;
    note = err instanceof Error ? err.message : "The Mumbai watcher stopped.";
    started = false;
    setTimeout(startDesk, 60_000);
  });
}

async function run(env: NonNullable<ReturnType<typeof readDhanEnv>>) {
  const token = await mintAccessToken(env);
  const chain = await loadNiftyBook({ clientId: env.clientId, accessToken: token });
  expiry = chain.expiry;
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
  for (const contract of chain.ladder) {
    const kind = contract.type === "PE" ? "PE" : "CE";
    seed(contract, kind, chain.history.ladder[contract.securityId] ?? []);
  }
  owns = true;
  note = "Mumbai is watching. The phone only shows this book.";
  const url = `wss://api-feed.dhan.co?version=2&token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(env.clientId)}&authType=2`;
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    let timer = 0;
    const scan = () => {
      const now = Date.now();
      const list = [...legs.values()];
      const anchor = legs.get(chain.future.securityId)?.ltp || chain.spot;
      const priceOf = (id: string) => legs.get(id)?.ltp;
      const marked = markTrades(book.trades, priceOf);
      const base = marked === book.trades ? book : { ...book, trades: marked };
      book = reduceAtm(base, list, chain.lot, chain.expiry, anchor, now);
    };
    socket.addEventListener("open", () => {
      const ids = [...legs.keys()];
      const list = [
        { ExchangeSegment: "IDX_I", SecurityId: "13" },
        ...ids.map((id) => ({ ExchangeSegment: "NSE_FNO", SecurityId: id })),
      ];
      socket.send(JSON.stringify({ RequestCode: 21, InstrumentCount: list.length, InstrumentList: list }));
      timer = setInterval(() => {
        scan();
        void persist(chain, legs).catch(() => {});
      }, 5000) as unknown as number;
    });
    socket.addEventListener("message", (event) => {
      const data = event.data;
      if (!(data instanceof ArrayBuffer)) return;
      for (const tick of parseFeed(data)) {
        const leg = legs.get(tick.securityId);
        if (!leg || !(tick.ltp > 0)) continue;
        leg.ltp = tick.ltp;
        leg.bars = applyTick(
          leg.bars.map((bar) => ({ t: bar.t, o: bar.c, h: bar.c, l: bar.c, c: bar.c, bid: 0, ask: 0 })),
          { ts: tick.ts || Date.now(), ltp: tick.ltp, bid: tick.bid, ask: tick.ask },
        ).map((bar) => ({ t: bar.t, c: bar.c }));
      }
    });
    socket.addEventListener("close", () => {
      clearInterval(timer);
      reject(new Error("Dhan closed the Mumbai feed."));
    });
    socket.addEventListener("error", () => {
      clearInterval(timer);
      reject(new Error("The Mumbai feed failed."));
    });
  });
}

let savedMinute = new Set<string>();

async function persist(chain: NiftyBook, legs: Map<string, Leg>) {
  const day = istDateKey();
  const dir = process.env.ARTHA_DATA_DIR?.trim() || "/var/lib/artha";
  const rows = [...legs.values()].flatMap((leg) =>
    leg.bars.filter((bar) => bar.c > 0).map((bar) => ({
      t: bar.t,
      securityId: leg.contract.securityId,
      kind: leg.kind,
      strike: leg.strike,
      ltp: bar.c,
    })),
  );
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${day}.json`), JSON.stringify({ day, expiry: chain.expiry, rows }));
    const names = (await readdir(dir)).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort();
    for (const name of names.slice(0, -2)) await unlink(join(dir, name));
  } catch {
    /* the database copy below is the one the chart reads */
  }
  if (!rows.length) return;
  const { niftyQuery } = await import("@/lib/nifty-db.server");
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) latest.set(`${row.securityId}:${row.t}`, row);
  const forming = Math.floor(Date.now() / 60_000) * 60_000;
  const fresh = [...latest.values()].filter((row) => {
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
      [
        fresh.map(() => day),
        fresh.map((row) => row.t),
        fresh.map((row) => row.securityId),
        fresh.map((row) => row.kind),
        fresh.map((row) => row.strike),
        fresh.map((row) => row.ltp),
      ],
    );
  }
  await niftyQuery(
    `insert into nifty_session (day, expiry, legs, book)
     values ($1, $2, '{}'::jsonb, $3::jsonb)
     on conflict (day) do update set expiry = excluded.expiry, book = excluded.book, updated_at = now()`,
    [day, chain.expiry, JSON.stringify(book)],
  );
  if (book.trades.length) {
    const trades = book.trades;
    await niftyQuery(
      `insert into nifty_trade
         (id, day, expiry, security_id, kind, strike, entry_ts, exit_ts, entry, exit, status, reason, exit_why, lots, lot, pnl)
       select * from unnest(
         $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::float8[],
         $7::bigint[], $8::bigint[], $9::float8[], $10::float8[], $11::text[], $12::text[],
         $13::text[], $14::int[], $15::int[], $16::float8[]
       )
       on conflict (id) do update set
         exit_ts = excluded.exit_ts, exit = excluded.exit, status = excluded.status,
         exit_why = excluded.exit_why, pnl = excluded.pnl, updated_at = now()`,
      [
        trades.map((trade) => trade.id),
        trades.map(() => day),
        trades.map(() => chain.expiry),
        trades.map((trade) => trade.buy.securityId),
        trades.map((trade) => trade.buy.type),
        trades.map((trade) => trade.buy.strike),
        trades.map((trade) => trade.entryTs),
        trades.map((trade) => trade.exitTs ?? null),
        trades.map((trade) => trade.buy.entry),
        trades.map((trade) => trade.buy.exit ?? null),
        trades.map((trade) => trade.status),
        trades.map((trade) => trade.reason),
        trades.map((trade) => trade.exitWhy ?? null),
        trades.map((trade) => trade.lots),
        trades.map((trade) => trade.lot),
        trades.map((trade) =>
          trade.status === "closed" && trade.buy.exit != null
            ? (trade.buy.exit - trade.buy.entry) * trade.lots * trade.lot - 60
            : null,
        ),
      ],
    );
  }
  await keepTwoDays();
}
