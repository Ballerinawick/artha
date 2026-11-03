import { Link } from "@tanstack/react-router";
import { Bookmark } from "lucide-react";
import { useEffect, useState } from "react";
import { Delta } from "@/components/delta";
import { formatInr } from "@/lib/market/hours";
import type { StockQuote } from "@/lib/market/types";
import { useWatchlist } from "@/lib/watchlist";

export function WatchlistBody({ quotes }: { quotes: StockQuote[] }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const symbols = useWatchlist((s) => s.symbols);
  const bySym = new Map(quotes.map((q) => [q.symbol, q]));

  if (!mounted) {
    return <p className="text-sm text-muted">Loading pins…</p>;
  }

  if (!symbols.length) {
    return (
      <p className="text-sm leading-relaxed text-muted">
        Pin names from the board. They stay on this device and refresh with the tape.
      </p>
    );
  }

  return (
    <ul className="space-y-1">
      {symbols.map((symbol) => {
        const q = bySym.get(symbol);
        return (
          <li key={symbol}>
            <Link
              to="/stock/$symbol"
              params={{ symbol }}
              className="flex items-center justify-between gap-3 rounded-lg px-2 py-2 hover:bg-surface-2"
            >
              <span>
                <span className="block text-sm font-medium">{symbol}</span>
                <span className="block text-xs text-muted">{q?.name ?? "On the board"}</span>
              </span>
              {q ? (
                <span className="text-right">
                  <span className="block text-sm tabular-nums">{formatInr(q.price)}</span>
                  <Delta value={q.changePct} className="text-xs" />
                </span>
              ) : (
                <span className="text-xs text-subtle">—</span>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function WatchlistRail({ quotes }: { quotes: StockQuote[] }) {
  return (
    <aside className="hidden min-w-0 rounded-xl bg-surface p-5 shadow-[var(--shadow-border)] lg:col-span-4 lg:block xl:col-span-3">
      <div className="mb-4 flex items-center gap-2">
        <Bookmark className="size-4 text-muted" />
        <h2 className="text-sm font-medium">Watchlist</h2>
      </div>
      <WatchlistBody quotes={quotes} />
    </aside>
  );
}
