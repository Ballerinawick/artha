import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ChartNeedsBrowser, DeskShell } from "@/components/desk-shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getDeskBook } from "@/lib/dhan/server";
import { useDhanCreds } from "@/lib/dhan/session";
import { useLiveTape } from "@/lib/dhan/use-tape";
import { formatInr } from "@/lib/market/hours";
import { paperPnl, usePaper } from "@/lib/paper";

export function DeskView() {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const creds = useDhanCreds();
  const trades = usePaper((s) => s.trades);
  const fnoKey = trades
    .filter((t) => t.segment === "NSE_FNO" && /^\d+$/.test(t.securityId))
    .map((t) => t.securityId)
    .sort()
    .join(",");
  useLiveTape(fnoKey);
  const setQty = usePaper((s) => s.setQty);
  const square = usePaper((s) => s.square);

  const query = useQuery({
    queryKey: ["desk", creds?.clientId],
    enabled: ready && !!creds,
    queryFn: () => getDeskBook({ data: creds! }),
    refetchInterval: 30_000,
  });

  if (!ready) {
    return (
      <DeskShell>
        <Skeleton className="h-24 rounded-xl" />
      </DeskShell>
    );
  }
  if (!creds) return <ChartNeedsBrowser />;

  const book = query.data;
  const openPnl = trades.filter((t) => t.status === "open" || t.status === "target").reduce((a, t) => a + paperPnl(t), 0);

  return (
    <DeskShell>
      <p className="text-xs font-medium text-muted">Book</p>
      <h1 className="mt-1 font-display text-4xl tracking-tight">Funds and positions</h1>
      <p className="mt-2 max-w-xl text-sm text-muted">
        Live Dhan funds and positions. Option papers are on Signals. The stock rows below are an old blotter, not the
        Nifty book. This phone cannot send an order.
      </p>
      {book ? <p className="mt-1 text-xs text-subtle">As of {book.asOfLabel}</p> : null}
      {query.isError ? (
        <p className="mt-3 text-sm text-down">{query.error instanceof Error ? query.error.message : "Desk failed"}</p>
      ) : null}
      {book?.warnings.map((w) => (
        <p key={w} className="mt-2 text-xs text-warn">
          {w}
        </p>
      ))}

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <Stat label="Available" value={book?.funds ? formatInr(book.funds.available, 0) : "—"} />
        <Stat label="Used today" value={book?.funds ? formatInr(book.funds.used, 0) : "—"} />
        <Stat label="Paper open" value={formatInr(openPnl, 0)} tone={openPnl >= 0 ? "up" : "down"} />
      </div>

      <section className="mt-8">
        <h2 className="font-display text-2xl">Live positions</h2>
        {!book && query.isFetching ? <Skeleton className="mt-3 h-20 rounded-xl" /> : null}
        {book && book.positions.length === 0 ? <p className="mt-2 text-sm text-muted">No open Dhan position.</p> : null}
        <ul className="mt-3 divide-y divide-border rounded-xl bg-surface px-4 shadow-[var(--shadow-border)]">
          {book?.positions.map((p) => (
            <li key={`${p.securityId}-${p.product}`} className="flex items-center justify-between gap-3 py-3">
              <div>
                <p className="text-sm font-medium">{p.symbol || p.securityId}</p>
                <p className="text-xs text-muted">
                  {p.side} · {p.product} · net {p.netQty}
                </p>
              </div>
              <p className={p.unrealized >= 0 ? "text-sm tabular-nums text-up" : "text-sm tabular-nums text-down"}>
                {formatInr(p.unrealized, 0)}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-8">
        <h2 className="font-display text-2xl">Holdings</h2>
        {book && book.holdings.length === 0 ? <p className="mt-2 text-sm text-muted">Demat book is empty on this token.</p> : null}
        <ul className="mt-3 divide-y divide-border rounded-xl bg-surface px-4 shadow-[var(--shadow-border)]">
          {book?.holdings.map((h) => (
            <li key={h.securityId || h.symbol} className="flex items-center justify-between py-3">
              <span className="text-sm">{h.symbol}</span>
              <span className="text-xs tabular-nums text-muted">
                {h.qty} @ {formatInr(h.avg, 1)}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-8">
        <h2 className="font-display text-2xl">Paper blotter</h2>
        {trades.length === 0 ? (
          <p className="mt-2 text-sm text-muted">Live prints land here on their own. Review cards from a closed session do not.</p>
        ) : null}
        <div className="mt-3 grid gap-3">
          {trades.map((t) => (
            <article key={t.id} className="rounded-xl bg-surface p-4 shadow-[var(--shadow-border)]">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">
                    {t.side} {t.symbol}
                  </p>
                  <p className="text-xs text-muted">
                    {t.qty} @ {formatInr(t.entry)} · target {formatInr(t.target)} · {t.status}
                  </p>
                </div>
                <p className={paperPnl(t) >= 0 ? "text-sm tabular-nums text-up" : "text-sm tabular-nums text-down"}>
                  {formatInr(paperPnl(t), 0)}
                </p>
              </div>
              {t.status === "open" ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <label className="text-xs text-muted" htmlFor={`qty-${t.id}`}>
                    Qty
                  </label>
                  <input
                    id={`qty-${t.id}`}
                    type="number"
                    min={1}
                    value={t.qty}
                    onChange={(e) => setQty(t.id, Math.max(1, Math.floor(Number(e.target.value) || 1)))}
                    className="h-11 w-24 rounded-md bg-surface-2 px-3 text-sm tabular-nums shadow-[var(--shadow-border)]"
                  />
                  <Button variant="secondary" onClick={() => square(t.id)}>
                    Square paper
                  </Button>
                  <p className="text-xs text-muted">Lightsail sends the market order with this paper. This phone cannot.</p>
                </div>
              ) : null}
              {t.orderId ? <p className="mt-2 text-xs text-muted">Dhan order {t.orderId}</p> : null}
            </article>
          ))}
        </div>
      </section>
    </DeskShell>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  return (
    <div className="rounded-xl bg-surface px-4 py-3 shadow-[var(--shadow-border)]">
      <p className="text-xs text-muted">{label}</p>
      <p className={tone === "up" ? "mt-1 text-lg tabular-nums text-up" : tone === "down" ? "mt-1 text-lg tabular-nums text-down" : "mt-1 text-lg tabular-nums"}>
        {value}
      </p>
    </div>
  );
}
