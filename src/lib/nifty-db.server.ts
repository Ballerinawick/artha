import { Pool, types } from "pg";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim() ?? "";
  if (!url) throw new Error("DATABASE_URL is not set.");
  return url;
}

const OID_INT8 = 20;
types.setTypeParser(OID_INT8, Number);

const globalRef = globalThis as typeof globalThis & { __niftyPool__?: Pool };

function pool(): Pool {
  globalRef.__niftyPool__ ??= new Pool({
    connectionString: databaseUrl(),
    ssl: { rejectUnauthorized: false },
    max: 3,
  });
  return globalRef.__niftyPool__;
}

const SCHEMA = `
create table if not exists nifty_session (
  day text primary key,
  expiry text not null,
  legs jsonb not null,
  book jsonb not null,
  updated_at timestamptz not null default now()
);
create table if not exists nifty_tick (
  day text not null,
  ts bigint not null,
  security_id text not null,
  kind text not null,
  strike double precision not null default 0,
  ltp double precision not null
);
create index if not exists nifty_tick_day_ts_idx on nifty_tick (day, ts);
create table if not exists nifty_trade (
  id text primary key,
  day text not null,
  expiry text not null,
  security_id text not null,
  kind text not null,
  strike double precision not null,
  entry_ts bigint not null,
  exit_ts bigint,
  entry double precision not null,
  exit double precision,
  status text not null,
  reason text not null,
  exit_why text,
  lots integer not null,
  lot integer not null,
  pnl double precision,
  updated_at timestamptz not null default now()
);
alter table nifty_session add column if not exists bank_expiry text;
alter table nifty_session add column if not exists bank_book jsonb;
alter table nifty_trade add column if not exists symbol text not null default 'NIFTY';
alter table nifty_trade add column if not exists buy_order_id text;
alter table nifty_trade add column if not exists sell_order_id text;
create table if not exists live_order (
  tag text primary key,
  day text not null,
  symbol text not null,
  trade_id text not null,
  side text not null,
  security_id text not null,
  qty integer not null,
  order_id text,
  created_at timestamptz not null default now()
);
create table if not exists desk_lock (
  id integer primary key,
  owner text not null,
  beat timestamptz not null default now()
);
insert into desk_lock (id, owner, beat) values (1, '', now()) on conflict (id) do nothing;
`;

let ready: Promise<void> | null = null;

export function niftyReady(): Promise<void> {
  ready ??= pool()
    .query(SCHEMA)
    .then(() => undefined)
    .catch((err) => {
      ready = null;
      throw err;
    });
  return ready;
}

export async function niftyQuery<T>(text: string, params: unknown[] = []): Promise<T[]> {
  await niftyReady();
  const result = await pool().query(text, params);
  return result.rows as T[];
}
