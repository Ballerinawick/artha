import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, MessageSquareText } from "lucide-react";
import { useState } from "react";
import { askAdvisor } from "@/lib/ai/advisor";
import { formatInr, formatPct, formatQty } from "@/lib/market/hours";
import { getStockDetail } from "@/lib/market/server";
import type { Horizon, StockDetail } from "@/lib/market/types";
import { HORIZONS } from "@/lib/market/universe";
import { AppShell } from "@/components/app-shell";
import { Delta } from "@/components/delta";
import { PinButton } from "@/components/pin-button";
import { PriceChart } from "@/components/price-chart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const RANGES = ["1D", "1M", "3M", "1Y"] as const;

export function StockView({ symbol, initial }: { symbol: string; initial?: StockDetail }) {
  const query = useQuery({
    queryKey: ["stock", symbol],
    queryFn: () => getStockDetail({ data: { symbol } }),
    initialData: initial,
    refetchInterval: (q) => (q.state.data?.session === "open" ? 60_000 : false),
  });

  const [range, setRange] = useState<(typeof RANGES)[number]>("3M");
  const [horizon, setHorizon] = useState<Horizon>("short");

  if (query.isError && !query.data) {
    return (
      <AppShell>
        <Link to="/" className="inline-flex h-11 items-center gap-2 text-sm text-muted hover:text-fg">
          <ArrowLeft className="size-4" />
          Board
        </Link>
        <h1 className="mt-6 font-display text-3xl">Name not on the tape</h1>
        <p className="mt-2 max-w-md text-sm text-muted">Artha covers NSE leaders. Pick another name from the board.</p>
      </AppShell>
    );
  }

  if (!query.data) {
    return (
      <AppShell>
        <Skeleton className="h-8 w-40" />
        <Skeleton className="mt-6 h-16 w-72" />
        <Skeleton className="mt-6 h-64 w-full rounded-xl" />
      </AppShell>
    );
  }

  const { quote: q, scores, series, actions, asOfLabel } = query.data;
  const pick = scores[horizon];
  const bars = range === "1D" ? series.intraday : series.daily;

  return (
    <AppShell sessionLabel={asOfLabel}>
      <Link to="/" className="inline-flex h-11 items-center gap-2 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" />
        Board
      </Link>

      <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.16em] text-muted">{q.sector}</p>
          <h1 className="mt-1 font-display text-4xl tracking-tight">{q.symbol}</h1>
          <p className="mt-1 text-sm text-muted">{q.name}</p>
        </div>
        <div className="flex items-start gap-2">
          <div className="text-right">
            <p className="font-display text-3xl tabular-nums tracking-tight">{formatInr(q.price)}</p>
            <Delta value={q.changePct} />
          </div>
          <PinButton symbol={q.symbol} />
        </div>
      </div>

      <div className="mt-6 rounded-xl bg-surface p-4 shadow-[var(--shadow-border)] sm:p-5">
        <div className="mb-3 flex gap-1">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={cn(
                "h-9 rounded-full px-3 text-xs font-medium",
                range === r ? "bg-accent text-accent-fg" : "text-muted hover:bg-surface-2 hover:text-fg",
              )}
            >
              {r}
            </button>
          ))}
        </div>
        <PriceChart bars={bars} range={range} />
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Volume" value={formatQty(q.volume)} />
        <Stat label="Day range" value={`${formatInr(q.dayLow, 1)} – ${formatInr(q.dayHigh, 1)}`} />
        <Stat label="52-week" value={`${formatInr(q.week52Low, 0)} – ${formatInr(q.week52High, 0)}`} />
        <Stat label="Rel volume" value={q.relVolume != null ? `${q.relVolume.toFixed(2)}×` : "—"} />
        <Stat label="RSI 14" value={q.rsi != null ? q.rsi.toFixed(1) : "—"} />
        <Stat label="20 / 50 DMA" value={`${fmtAvg(q.sma20)} / ${fmtAvg(q.sma50)}`} />
        <Stat label="200 DMA" value={fmtAvg(q.sma200)} />
        <Stat
          label="Yield"
          value={q.dividendYield != null ? formatPct(q.dividendYield * 100, 1).replace("+", "") : "—"}
        />
      </dl>

      <section className="mt-8">
        <h2 className="font-display text-2xl tracking-tight">Horizon scores</h2>
        <div className="mt-3 flex gap-1 overflow-x-auto">
          {HORIZONS.map((h) => (
            <button
              key={h.id}
              type="button"
              onClick={() => setHorizon(h.id)}
              className={cn(
                "h-11 shrink-0 rounded-full px-4 text-sm",
                horizon === h.id ? "bg-accent text-accent-fg" : "text-muted hover:bg-surface-2 hover:text-fg",
              )}
            >
              {h.label}
              <span className="ml-2 tabular-nums opacity-70">{scores[h.id].score}</span>
            </button>
          ))}
        </div>
        <div className="mt-4 rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
          <div className="flex items-center gap-2">
            <Badge variant={pick.action === "Accumulate" ? "up" : pick.action === "Avoid" ? "down" : "default"}>
              {pick.action}
            </Badge>
            <span className="text-sm text-muted">Score {pick.score}</span>
          </div>
          <ul className="mt-4 space-y-2">
            {pick.reasons.map((r) => (
              <li key={r} className="text-sm leading-relaxed text-fg/90">
                {r}
              </li>
            ))}
          </ul>
          <p className="mt-4 text-sm text-muted">{pick.risk}</p>
        </div>
      </section>

      {actions.length ? (
        <section className="mt-8">
          <h2 className="font-display text-2xl tracking-tight">Bonus & dividend tape</h2>
          <ul className="mt-3 divide-y divide-border rounded-xl bg-surface px-5 shadow-[var(--shadow-border)]">
            {actions.map((a) => (
              <li key={`${a.kind}-${a.date}`} className="flex items-center justify-between py-3">
                <span className="text-sm">{a.label}</span>
                <span className="text-xs tabular-nums text-muted">
                  {new Intl.DateTimeFormat("en-IN", {
                    timeZone: "Asia/Kolkata",
                    day: "2-digit",
                    month: "short",
                    year: "numeric",
                  }).format(a.date)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <StockAdvisor symbol={q.symbol} horizon={horizon} />
    </AppShell>
  );
}

function fmtAvg(n: number | null) {
  return n != null ? formatInr(n, 1) : "—";
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-surface px-4 py-3 shadow-[var(--shadow-border)]">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-1 text-sm tabular-nums">{value}</dd>
    </div>
  );
}

function StockAdvisor({ symbol, horizon }: { symbol: string; horizon: Horizon }) {
  const mutation = useMutation({
    mutationFn: () => askAdvisor({ data: { kind: "stock", symbol, horizon } }),
  });
  const text = mutation.data && mutation.data.ok ? mutation.data.text : "";
  const error = mutation.data && !mutation.data.ok ? mutation.data.error : mutation.error?.message;

  return (
    <section className="mt-8 rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <MessageSquareText className="size-4 text-muted" />
            <h2 className="font-display text-2xl tracking-tight">Ask Artha</h2>
          </div>
          <p className="mt-1 text-sm text-muted">A short {horizon} note on {symbol}, from this snapshot only.</p>
        </div>
        <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
          {mutation.isPending ? "Reading the tape…" : "Explain this pick"}
        </Button>
      </div>
      {error ? <p className="mt-4 text-sm text-down">{error}</p> : null}
      {text ? <div className="mt-5 whitespace-pre-wrap text-sm leading-relaxed">{text}</div> : null}
    </section>
  );
}
