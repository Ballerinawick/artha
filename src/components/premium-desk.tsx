import { Navigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DeskShell } from "@/components/desk-shell";
import { WaveChart } from "@/components/tick-wave";
import { holdLabel, livePnl, tradePnl, useJournal, type PremiumTrade } from "@/lib/dhan/journal";
import { useDhanCreds } from "@/lib/dhan/session";
import { usePremiumEngine, type EngineView } from "@/lib/dhan/use-premium-engine";
import { niftyWeekday } from "@/lib/dhan/week";
import { formatInr } from "@/lib/market/hours";

export function PremiumDesk() {
  const [ready, setReady] = useState(false);
  const [chartOn, setChartOn] = useState(false);
  useEffect(() => {
    setReady(true);
    const id = window.requestAnimationFrame(() => setChartOn(true));
    return () => window.cancelAnimationFrame(id);
  }, []);
  const creds = useDhanCreds();
  const engine = usePremiumEngine();
  const trades = useJournal((s) => s.trades);

  if (!ready) {
    return (
      <DeskShell>
        <Skeleton className="h-28 rounded-xl" />
      </DeskShell>
    );
  }
  if (!creds) return <Navigate to="/" />;

  const closed = trades.filter((trade) => trade.status === "closed");
  const net = closed.reduce((sum, trade) => sum + tradePnl(trade), 0);
  const calls = (engine.ladder ?? [])
    .filter((leg) => leg.contract.type === "CE")
    .sort((a, b) => a.contract.strike - b.contract.strike);
  const puts = (engine.ladder ?? [])
    .filter((leg) => leg.contract.type === "PE")
    .sort((a, b) => a.contract.strike - b.contract.strike);

  return (
    <DeskShell>
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-3">
        <div>
          <p className="text-xs font-medium text-muted">Nifty options</p>
          <h1 className="font-display text-3xl tracking-tight tabular-nums">
            {engine.spot ? engine.spot.toLocaleString("en-IN", { maximumFractionDigits: 2 }) : "Nifty"}
          </h1>
        </div>
        <div className="text-right text-xs text-muted">
          <p>
            {engine.future
              ? `Future ${engine.future.ltp ? formatInr(engine.future.ltp) : "—"} · ${engine.future.swing.bias === "up" ? "rising, call only" : engine.future.swing.bias === "down" ? "falling, put only" : "not ready"}`
              : "Future not loaded"}
          </p>
          <p className="mt-1 text-subtle">
            {engine.book ? `${engine.book.expiry} · ${niftyWeekday()} · lot ${engine.book.lot}` : "Chain not loaded"} · paper only
          </p>
          <p className="mt-1 text-subtle">{engine.archive}</p>
        </div>
      </div>
      <p className="mt-2 text-sm text-muted">{engine.note}</p>
      {engine.status === "error" ? (
        <Button className="mt-3" variant="secondary" onClick={engine.retry}>
          Try the chain again
        </Button>
      ) : null}

      <div className="mt-4 grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="rounded-xl bg-surface p-3 shadow-[var(--shadow-border)] sm:p-4">
          {chartOn && engine.future && calls.length > 0 && puts.length > 0 ? (
            <WaveChart future={engine.future} calls={calls} puts={puts} spot={engine.spot} expiry={engine.book?.expiry} />
          ) : (
            <Skeleton className="h-[28rem] rounded-xl sm:h-[32rem]" />
          )}
        </div>
        <section className="rounded-xl bg-surface p-4 shadow-[var(--shadow-border)] lg:sticky lg:top-16">
          <div className="flex items-end justify-between gap-3">
            <h2 className="font-display text-xl tracking-tight">Paper book</h2>
            <p className={net >= 0 ? "text-sm tabular-nums text-up" : "text-sm tabular-nums text-down"}>
              {closed.length ? formatInr(net, 0) : "—"}
            </p>
          </div>
          <p className="mt-1 text-xs text-muted">After ₹40 and the sell charge. Held for the target.</p>
          {trades.length === 0 ? <p className="mt-3 text-sm text-muted">No option paper yet.</p> : null}
          <ul className="mt-3 max-h-[70vh] divide-y divide-border overflow-auto">
            {trades.slice(0, 16).map((trade) => (
              <li key={trade.id} className="flex items-start justify-between gap-3 py-2.5">
                <div>
                  <p className="text-sm font-medium">
                    {trade.type} {trade.strike} · {trade.status}
                  </p>
                  <p className="text-xs text-muted">
                    {formatInr(trade.entry)}
                    {trade.exit != null ? ` → ${formatInr(trade.exit)}` : ` · now ${formatInr(markOf(trade, engine))}`}
                    {" · "}
                    {holdLabel(trade)}
                  </p>
                </div>
                <p className={pnlClass(shownPnl(trade, engine))}>{formatInr(shownPnl(trade, engine), 0)}</p>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </DeskShell>
  );
}

function markOf(trade: PremiumTrade, engine: EngineView): number {
  const leg = [engine.ce, engine.pe].find((row) => row?.contract.securityId === trade.securityId);
  return leg?.bid || leg?.ltp || trade.entry;
}

function shownPnl(trade: PremiumTrade, engine: EngineView): number {
  if (trade.status === "closed") return tradePnl(trade);
  return livePnl(trade, markOf(trade, engine));
}

function pnlClass(value: number): string {
  return value >= 0 ? "text-sm tabular-nums text-up" : "text-sm tabular-nums text-down";
}
