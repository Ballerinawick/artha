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
