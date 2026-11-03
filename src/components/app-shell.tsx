import { Link } from "@tanstack/react-router";
import { Bookmark } from "lucide-react";
import type { ReactNode } from "react";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { WatchlistBody } from "@/components/watchlist-panel";
import type { StockQuote } from "@/lib/market/types";

export function AppShell({
  children,
  sessionLabel,
  quotes,
}: {
  children: ReactNode;
  sessionLabel?: string;
  quotes?: StockQuote[];
}) {
  return (
    <div className="min-h-dvh bg-bg text-fg">
      <header className="sticky top-0 z-30 border-b border-border bg-bg">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4 sm:h-[4.5rem] sm:px-6">
          <Link to="/" className="min-w-0">
            <p className="font-display text-2xl leading-none tracking-tight text-fg">Artha</p>
            <p className="mt-1 hidden text-xs tracking-wide text-muted sm:block">Indian market advisor</p>
          </Link>
          <div className="flex items-center gap-2">
            {sessionLabel ? (
              <p className="hidden max-w-64 truncate text-right text-xs text-muted md:block">{sessionLabel}</p>
            ) : null}
            <Sheet>
              <SheetTrigger asChild>
                <button
                  type="button"
                  className="inline-flex h-11 items-center gap-2 rounded-md px-3 text-sm text-fg shadow-[var(--shadow-border)] hover:bg-surface-2 lg:hidden"
                >
                  <Bookmark className="size-4" />
                  Watch
                </button>
              </SheetTrigger>
              <SheetContent title="Watchlist">
                <WatchlistBody quotes={quotes ?? []} />
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </header>
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">{children}</div>
    </div>
  );
}
