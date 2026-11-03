import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Layers, Newspaper, RefreshCw, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { askAdvisor } from "@/lib/ai/advisor";
import { formatInr, formatQty } from "@/lib/market/hours";
import { getMarketBoard } from "@/lib/market/server";
import type { Horizon, HorizonPick, MarketBoard, StockQuote } from "@/lib/market/types";
import { HORIZONS } from "@/lib/market/universe";
import { AppShell } from "@/components/app-shell";
import { Delta } from "@/components/delta";
import { PinButton } from "@/components/pin-button";
import { Sparkline } from "@/components/sparkline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { WatchlistRail } from "@/components/watchlist-panel";
import { cn } from "@/lib/utils";

type Tab = Horizon | "sets";

const TABS: { id: Tab; label: string }[] = [
  ...HORIZONS.map((h) => ({ id: h.id as Tab, label: h.label })),
  { id: "sets", label: "Live sets" },
];

function sessionWord(session: MarketBoard["session"]) {
  if (session === "open") return "Live";
  if (session === "pre") return "Pre-open";
  if (session === "post") return "Post-close";
  return "Closed";
}

function sessionTone(session: MarketBoard["session"]) {
  if (session === "open") return "text-up";
  if (session === "pre" || session === "post") return "text-warn";
  return "text-muted";
}

function actionTone(action: HorizonPick["action"]) {
  if (action === "Accumulate") return "up" as const;
  if (action === "Avoid") return "down" as const;
  return "default" as const;
}

export function Dashboard({ initial }: { initial?: MarketBoard }) {
  const board = useQuery({
    queryKey: ["board"],
    queryFn: () => getMarketBoard(),
    initialData: initial,
    refetchInterval: (q) => (q.state.data?.session === "open" ? 60_000 : 5 * 60_000),
  });

  const data = board.data;
  const [tab, setTab] = useState<Tab>("intraday");
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return data.quotes;
    return data.quotes.filter(
      (s) =>
        s.symbol.toLowerCase().includes(needle) ||
        s.name.toLowerCase().includes(needle) ||
        s.sector.toLowerCase().includes(needle),
    );
  }, [data, q]);

  if (board.isError && !data) {
    return (
      <AppShell>
        <div className="rounded-xl bg-surface p-8 shadow-[var(--shadow-border)]">
          <h1 className="font-display text-3xl">Tape is quiet</h1>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-muted">
            The free NSE feed did not respond. Wait a moment and try again — Artha never invents prices.
          </p>
          <Button className="mt-6" onClick={() => board.refetch()}>
            Retry feed
          </Button>
        </div>
      </AppShell>
    );
  }

  if (!data) {
    return (
      <AppShell>
        <DashboardSkeleton />
      </AppShell>
    );
  }

  const horizon = tab === "sets" ? null : HORIZONS.find((h) => h.id === tab);

  return (
    <AppShell sessionLabel={data.sessionLabel} quotes={data.quotes}>
      <div className="grid gap-6 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-8 xl:col-span-9">
          <Masthead data={data} onRefresh={() => board.refetch()} refreshing={board.isFetching} />
          <IndexStrip data={data} />

          <div className="mt-8 flex max-w-full gap-1 overflow-x-auto pb-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={cn(
                  "h-11 shrink-0 rounded-full px-4 text-sm transition-colors duration-150",
                  tab === t.id ? "bg-accent text-accent-fg" : "text-muted hover:bg-surface-2 hover:text-fg",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          {horizon ? (
            <p className="mt-4 text-sm text-muted">{horizon.blurb}</p>
          ) : (
            <p className="mt-4 text-sm text-muted">Live baskets rebuilt from the same tape as the picks.</p>
          )}

          {tab === "sets" ? (
            <SetsGrid data={data} />
          ) : (
            <PicksGrid picks={data.picks[tab]} quotes={data.quotes} />
          )}

          {tab === "dividend" ? <ActionsList data={data} /> : null}

          <BriefingPanel />

          <section className="mt-10">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 className="font-display text-2xl tracking-tight">Universe</h2>
                <p className="mt-1 text-sm text-muted">NSE leaders Artha scores every session.</p>
              </div>
              <div className="relative w-full sm:w-72">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" />
                <Input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search name, symbol, sector"
                  className="pl-9"
                />
              </div>
            </div>
            <UniverseTable quotes={filtered} />
          </section>

          <p className="mt-10 max-w-2xl text-xs leading-relaxed text-subtle">
            Artha is an educational market companion. Picks are model scores from public Yahoo Finance data, not
            SEBI-registered advice. Markets can lose money. Do your own research. Source: {data.source}. As of{" "}
            {data.asOfLabel}.
          </p>
        </div>
        <WatchlistRail quotes={data.quotes} />
      </div>
    </AppShell>
  );
}

function Masthead({
  data,
  onRefresh,
  refreshing,
}: {
  data: MarketBoard;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <p className={cn("font-sans text-xs font-medium uppercase tracking-widest", sessionTone(data.session))}>
          {sessionWord(data.session)} · NSE
        </p>
        <h1 className="mt-2 font-display text-4xl tracking-tight sm:text-5xl">Today on Dalal Street</h1>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">
          Intraday, swing, long-term and income ideas from the free NSE feed — scored in the open, explained on demand.
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Badge>{data.asOfLabel}</Badge>
        <Button variant="secondary" size="icon" onClick={onRefresh} aria-label="Refresh tape">
          <RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
        </Button>
      </div>
    </div>
  );
}

function IndexStrip({ data }: { data: MarketBoard }) {
  return (
    <div className="mt-6 max-w-full overflow-x-auto rounded-xl bg-surface p-3 shadow-[var(--shadow-border)] sm:p-4">
      <div className="flex w-max gap-3">
        {data.indices.map((idx) => (
          <div key={idx.symbol} className="w-40 shrink-0 rounded-lg bg-surface-2 px-4 py-3">
            <p className="text-xs text-muted">{idx.name}</p>
            <p className="mt-1 text-lg tabular-nums tracking-tight">{idx.price.toLocaleString("en-IN")}</p>
            <Delta value={idx.changePct} className="text-xs" />
          </div>
        ))}
        <div className="w-40 shrink-0 rounded-lg bg-surface-2 px-4 py-3">
          <p className="text-xs text-muted">Breadth</p>
          <p className="mt-1 text-lg tabular-nums tracking-tight">
            {data.breadth.up}
            <span className="text-muted"> / </span>
            {data.breadth.down}
          </p>
          <p className="text-xs text-muted">advancers / decliners</p>
        </div>
      </div>
    </div>
  );
}

function PicksGrid({ picks, quotes }: { picks: HorizonPick[]; quotes: StockQuote[] }) {
  const bySym = new Map(quotes.map((q) => [q.symbol, q]));
  if (!picks.length) {
    return <p className="mt-6 text-sm text-muted">No ranked names yet — the feed is still filling.</p>;
  }
  return (
    <div className="mt-5 grid gap-3 sm:grid-cols-2">
      {picks.map((pick) => {
        const q = bySym.get(pick.symbol);
        if (!q) return null;
        return (
          <article
            key={pick.symbol}
            className="rise-in rounded-xl bg-surface p-4 shadow-[var(--shadow-border)] transition-[box-shadow] duration-150 hover:shadow-[var(--shadow-border-hover)]"
          >
            <Link to="/stock/$symbol" params={{ symbol: pick.symbol }} className="block">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs text-muted">{q.sector}</p>
                  <p className="truncate text-sm font-medium">{q.name}</p>
                  <p className="font-display text-2xl tracking-tight">{q.symbol}</p>
                </div>
                <div className="text-right">
                  <p className="text-sm tabular-nums">{formatInr(q.price)}</p>
                  <Delta value={q.changePct} className="text-xs" />
                  <Sparkline data={q.spark} className="mt-1 ml-auto" />
                </div>
              </div>
            </Link>
            <div className="mt-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Badge variant={actionTone(pick.action)}>{pick.action}</Badge>
                <span className="text-xs tabular-nums text-muted">Score {pick.score}</span>
              </div>
              <PinButton symbol={q.symbol} className="size-10" />
            </div>
            <ul className="mt-3 space-y-1.5">
              {pick.reasons.map((r) => (
                <li key={r} className="text-xs leading-relaxed text-muted">
                  {r}
                </li>
              ))}
            </ul>
          </article>
        );
      })}
    </div>
  );
}

function SetsGrid({ data }: { data: MarketBoard }) {
  const bySym = new Map(data.quotes.map((q) => [q.symbol, q]));
  return (
    <div className="mt-5 grid gap-3 sm:grid-cols-2">
      {data.sets.map((set) => (
        <article key={set.id} className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
          <div className="flex items-center gap-2">
            <Layers className="size-4 text-muted" />
            <h3 className="font-display text-xl tracking-tight">{set.title}</h3>
          </div>
          <p className="mt-1 text-xs text-muted">{set.blurb}</p>
          <ul className="mt-4 space-y-1">
            {set.symbols.length ? (
              set.symbols.map((symbol) => {
                const q = bySym.get(symbol);
                if (!q) return null;
                return (
                  <li key={symbol}>
                    <Link
                      to="/stock/$symbol"
                      params={{ symbol }}
                      className="flex items-center justify-between rounded-lg px-2 py-2 hover:bg-surface-2"
                    >
                      <span className="text-sm">{q.symbol}</span>
                      <span className="flex items-center gap-3">
                        <span className="text-sm tabular-nums text-muted">{formatInr(q.price)}</span>
                        <Delta value={q.changePct} className="text-xs" />
                      </span>
                    </Link>
                  </li>
                );
              })
            ) : (
              <li className="text-sm text-muted">No names qualified this session.</li>
            )}
          </ul>
        </article>
      ))}
    </div>
  );
}

function ActionsList({ data }: { data: MarketBoard }) {
  if (!data.actions.length) return null;
  return (
    <section className="mt-8 rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
      <h3 className="font-display text-xl tracking-tight">Recent bonus & dividends</h3>
      <p className="mt-1 text-xs text-muted">Last recorded cash dividends and split/bonus prints on the public feed.</p>
      <ul className="mt-4 divide-y divide-border">
        {data.actions.slice(0, 10).map((a) => (
          <li key={`${a.symbol}-${a.kind}-${a.date}`} className="flex items-center justify-between gap-3 py-3">
            <div>
              <Link to="/stock/$symbol" params={{ symbol: a.symbol }} className="text-sm font-medium hover:text-accent">
                {a.symbol}
              </Link>
              <p className="text-xs text-muted">{a.detail}</p>
            </div>
            <div className="text-right">
              <p className="text-sm">{a.label}</p>
              <p className="text-xs tabular-nums text-muted">
                {new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" }).format(a.date)}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function BriefingPanel() {
  const mutation = useMutation({
    mutationFn: () => askAdvisor({ data: { kind: "briefing" } }),
  });
  const text = mutation.data && mutation.data.ok ? mutation.data.text : "";
  const error = mutation.data && !mutation.data.ok ? mutation.data.error : mutation.error?.message;

  return (
    <section className="mt-10 rounded-xl bg-surface p-5 shadow-[var(--shadow-border)] sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Newspaper className="size-4 text-muted" />
            <h2 className="font-display text-2xl tracking-tight">Ask Artha for the daily</h2>
          </div>
          <p className="mt-1 max-w-lg text-sm text-muted">
            One briefing from today's scores. User-started, cached for the IST day — never auto-fired.
          </p>
        </div>
        <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
          {mutation.isPending ? "Writing…" : text ? "Refresh briefing" : "Compose briefing"}
        </Button>
      </div>
      {error ? <p className="mt-4 text-sm text-down">{error}</p> : null}
      {text ? (
        <div className="mt-5 whitespace-pre-wrap text-sm leading-relaxed text-fg/90">{text}</div>
      ) : null}
    </section>
  );
}

function UniverseTable({ quotes }: { quotes: StockQuote[] }) {
  if (!quotes.length) {
    return <p className="text-sm text-muted">No names match that search.</p>;
  }
  return (
    <div className="max-w-full overflow-x-auto rounded-xl bg-surface shadow-[var(--shadow-border)]">
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase tracking-wide text-subtle">
          <tr className="border-b border-border">
            <th className="px-4 py-3 font-medium">Name</th>
            <th className="px-4 py-3 font-medium">Last</th>
            <th className="px-4 py-3 font-medium">Chg</th>
            <th className="hidden px-4 py-3 font-medium sm:table-cell">Volume</th>
            <th className="hidden px-4 py-3 font-medium md:table-cell">RSI</th>
            <th className="px-4 py-3 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {quotes.map((q) => (
            <tr key={q.symbol} className="border-b border-border last:border-0">
              <td className="px-4 py-3">
                <Link to="/stock/$symbol" params={{ symbol: q.symbol }} className="hover:text-accent">
                  <span className="block font-medium">{q.symbol}</span>
                  <span className="block text-xs text-muted">{q.name}</span>
                </Link>
              </td>
              <td className="px-4 py-3 tabular-nums">{formatInr(q.price)}</td>
              <td className="px-4 py-3">
                <Delta value={q.changePct} />
              </td>
              <td className="hidden px-4 py-3 tabular-nums text-muted sm:table-cell">{formatQty(q.volume)}</td>
              <td className="hidden px-4 py-3 tabular-nums text-muted md:table-cell">
                {q.rsi != null ? q.rsi.toFixed(0) : "—"}
              </td>
              <td className="px-2 py-2 text-right">
                <PinButton symbol={q.symbol} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-10 w-64" />
      <Skeleton className="h-24 w-full rounded-xl" />
      <div className="grid gap-3 sm:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-48 rounded-xl" />
        ))}
      </div>
    </div>
  );
}
