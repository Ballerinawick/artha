import { createServerFn } from "@tanstack/react-start";
import { CROSS_BROKERAGE, type CrossTrade } from "./cross-math";

type CloseBar = { t: number; c: number };
type Book = { trades: CrossTrade[]; seen: string[]; total: number; closedPnl: number };

function dayOf(value: unknown): string {
  const day = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("Bad session day.");
  return day;
}

function barsOf(value: unknown): Record<string, CloseBar[]> {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const legs: Record<string, CloseBar[]> = {};
  for (const [id, rows] of Object.entries(source).slice(0, 40)) {
    if (!/^\d+$/.test(id) || !Array.isArray(rows)) continue;
    const clean: CloseBar[] = [];
    for (const row of rows.slice(-400)) {
      if (!row || typeof row !== "object") continue;
      const t = Number((row as { t?: unknown }).t);
      const c = Number((row as { c?: unknown }).c);
      if (t > 1_000_000_000_000 && c > 0) clean.push({ t, c });
    }
    if (clean.length) legs[id] = clean;
  }
  return legs;
}

function bookOf(value: unknown): Book {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const trades = Array.isArray(source.trades) ? source.trades.filter(isTrade).slice(0, 120) : [];
  const seen = Array.isArray(source.seen) ? source.seen.map(String).slice(-8000) : [];
  const total = Number(source.total);
  const closedPnl = Number(source.closedPnl);
  return {
    trades,
    seen,
    total: Number.isFinite(total) ? total : 0,
    closedPnl: Number.isFinite(closedPnl) ? closedPnl : 0,
  };
}

function isTrade(row: unknown): row is CrossTrade {
  if (!row || typeof row !== "object") return false;
  const trade = row as CrossTrade;
  return Boolean(trade.buy && trade.ceId && trade.peId) && (trade.status === "open" || trade.status === "closed");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export const loadNiftySession = createServerFn({ method: "POST" })
  .validator((input: { day?: string }) => ({ day: dayOf(input?.day) }))
  .handler(async ({ data }) => {
    try {
      const { niftyQuery } = await import("@/lib/nifty-db.server");
      const rows = await niftyQuery<{ expiry: string; legs: unknown; book: unknown }>(
        "select expiry, legs, book from nifty_session where day = $1",
        [data.day],
      );
      const row = rows[0];
      if (!row) return null;
      return { day: data.day, expiry: String(row.expiry), legs: barsOf(asRecord(row.legs) ?? row.legs), book: bookOf(asRecord(row.book) ?? row.book) };
    } catch {
      return null;
    }
  });

export const loadNiftyMinutes = createServerFn({ method: "POST" })
  .validator((input: { day?: string }) => ({ day: dayOf(input?.day) }))
  .handler(async ({ data }) => {
    try {
      const { niftyQuery } = await import("@/lib/nifty-db.server");
      const rows = await niftyQuery<{ security_id: string; t: number; c: number }>(
        `select distinct on (security_id, (ts / 60000) * 60000)
           security_id, (ts / 60000) * 60000 as t, ltp as c
         from nifty_tick
         where day = $1
         order by security_id, (ts / 60000) * 60000, ts desc`,
        [data.day],
      );
      const legs: Record<string, { t: number; c: number }[]> = {};
      for (const row of rows) {
        const id = String(row.security_id);
        const list = legs[id] ?? [];
        list.push({ t: Number(row.t), c: Number(row.c) });
        legs[id] = list;
      }
      return { day: data.day, legs };
    } catch {
      return { day: data.day, legs: {} as Record<string, { t: number; c: number }[]> };
    }
  });

type TickRow = { t?: unknown; securityId?: unknown; kind?: unknown; strike?: unknown; ltp?: unknown };

export const saveNiftyTicks = createServerFn({ method: "POST" })
  .validator((input: { day?: string; rows?: TickRow[] }) => {
    const day = dayOf(input?.day);
    const rows = (input?.rows ?? []).slice(0, 800).flatMap((row) => {
      const t = Number(row.t);
      const ltp = Number(row.ltp);
      const securityId = String(row.securityId ?? "");
      const kind = String(row.kind ?? "");
      const strike = Number(row.strike);
      if (!/^\d+$/.test(securityId) || !["FUT", "CE", "PE"].includes(kind)) return [];
      if (!(t > 1_000_000_000_000) || !(ltp > 0)) return [];
      return [{ t, securityId, kind, strike: Number.isFinite(strike) ? strike : 0, ltp }];
    });
    return { day, rows };
  })
  .handler(async ({ data }) => {
    if (!data.rows.length) return { ok: true as const, n: 0 };
    const { niftyQuery } = await import("@/lib/nifty-db.server");
    const days = data.rows.map(() => data.day);
    const ts = data.rows.map((row) => row.t);
    const ids = data.rows.map((row) => row.securityId);
    const kinds = data.rows.map((row) => row.kind);
    const strikes = data.rows.map((row) => row.strike);
    const ltps = data.rows.map((row) => row.ltp);
    await niftyQuery("delete from nifty_tick where day <> $1", [data.day]);
    await niftyQuery(
      `insert into nifty_tick (day, ts, security_id, kind, strike, ltp)
       select * from unnest($1::text[], $2::bigint[], $3::text[], $4::text[], $5::float8[], $6::float8[])`,
      [days, ts, ids, kinds, strikes, ltps],
    );
    return { ok: true as const, n: data.rows.length };
  });

export const saveNiftySession = createServerFn({ method: "POST" })
  .validator((input: { day?: string; expiry?: string; legs?: unknown; book?: unknown }) => {
    const day = dayOf(input?.day);
    const expiry = String(input?.expiry ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) throw new Error("Bad expiry.");
    return { day, expiry, legs: barsOf(input?.legs), book: bookOf(input?.book) };
  })
  .handler(async ({ data }) => {
    const { niftyQuery } = await import("@/lib/nifty-db.server");
    const legs = JSON.stringify(data.legs);
    const book = JSON.stringify(data.book);
    await niftyQuery("delete from nifty_session where day <> $1", [data.day]);
    await niftyQuery(
      `insert into nifty_session (day, expiry, legs, book)
       values ($1, $2, $3::jsonb, $4::jsonb)
       on conflict (day) do update
       set expiry = excluded.expiry, legs = excluded.legs, book = excluded.book, updated_at = now()`,
      [data.day, data.expiry, legs, book],
    );
    await niftyQuery("delete from nifty_trade where day <> $1", [data.day]);
    if (data.book.trades.length) {
      const trades = data.book.trades;
      await niftyQuery(
        `insert into nifty_trade
           (id, day, expiry, security_id, kind, strike, entry_ts, exit_ts, entry, exit, status, reason, exit_why, lots, lot, pnl)
         select * from unnest(
           $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::float8[],
           $7::bigint[], $8::bigint[], $9::float8[], $10::float8[], $11::text[], $12::text[],
           $13::text[], $14::int[], $15::int[], $16::float8[]
         )
         on conflict (id) do update set
           day = excluded.day, exit_ts = excluded.exit_ts, exit = excluded.exit, status = excluded.status,
           exit_why = excluded.exit_why, pnl = excluded.pnl, updated_at = now()`,
        [
          trades.map((trade) => trade.id),
          trades.map(() => data.day),
          trades.map(() => data.expiry),
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
              ? (trade.buy.exit - trade.buy.entry) * trade.lots * trade.lot - CROSS_BROKERAGE
              : null,
          ),
        ],
      );
    }
    return { ok: true as const };
  });
