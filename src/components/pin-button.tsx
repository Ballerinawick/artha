import { Bookmark, BookmarkCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useWatchlist } from "@/lib/watchlist";

export function PinButton({ symbol, className }: { symbol: string; className?: string }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const stored = useWatchlist((s) => s.symbols.includes(symbol));
  const toggle = useWatchlist((s) => s.toggle);
  const has = mounted && stored;

  return (
    <button
      type="button"
      aria-label={has ? `Remove ${symbol} from watchlist` : `Watch ${symbol}`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle(symbol);
        toast(has ? `${symbol} off the watchlist` : `${symbol} pinned`);
      }}
      className={cn(
        "inline-flex size-11 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-fg",
        has && "text-accent",
        className,
      )}
    >
      {has ? <BookmarkCheck className="size-4" /> : <Bookmark className="size-4" />}
    </button>
  );
}
