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
