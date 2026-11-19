import { Navigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { DeskShell } from "@/components/desk-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { useCrossBook, useDeskMirror } from "@/lib/dhan/cross-book";
import { CROSS_BROKERAGE, crossPnl, type CrossTrade } from "@/lib/dhan/cross-math";
import { useAltTape } from "@/lib/dhan/alt-tape";
import { useDhanCreds } from "@/lib/dhan/session";
import { usePremiumEngine } from "@/lib/dhan/use-premium-engine";
import { niftyWeekday } from "@/lib/dhan/week";
import { formatInr } from "@/lib/market/hours";

export function PositionBook() {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const creds = useDhanCreds();
  const engine = usePremiumEngine();
  const trades = useCrossBook((s) => s.trades);
  const total = useCrossBook((s) => s.total);
  const closedPnl = useCrossBook((s) => s.closedPnl);
  const altPapers = useAltTape((s) => s.papers);
  const altMarks = useAltTape((s) => s.marks);
  const mirror = useDeskMirror();

  if (!ready) {
    return (
      <DeskShell>
        <Skeleton className="h-28 rounded-xl" />
      </DeskShell>
    );
  }
  if (!creds) return <Navigate to="/" />;

  const niftyRows = trades.map((trade) => ({ symbol: "NIFTY", trade, px: livePx(trade, engine) }));
  const altRows = Object.entries(altPapers).flatMap(([symbol, book]) =>
    book.trades.map((trade) => ({ symbol, trade, px: altMarks[trade.buy.securityId] || trade.buy.mark })),
  );
  const rows = [...niftyRows, ...altRows];
  const open = rows.filter((row) => row.trade.status === "open").sort((a, b) => b.trade.entryTs - a.trade.entryTs);
  const closed = rows.filter((row) => row.trade.status === "closed").sort((a, b) => b.trade.entryTs - a.trade.entryTs);
  const altClosed = altRows.filter((row) => row.trade.status === "closed").reduce((sum, row) => sum + crossPnl(row.trade, row.trade.buy.exit ?? row.trade.buy.entry, true), 0);
  const net = closedPnl + altClosed;
  const counted = total + altRows.length;
  const openPnl = open.reduce((sum, row) => sum + crossPnl(row.trade, row.px, false), 0);

  return (
    <DeskShell>
      <div className="border-b border-border pb-3">
        <p className="text-xs font-medium text-muted">Cross papers</p>
        <h1 className="font-display text-3xl tracking-tight">Position</h1>
        <p className="mt-1 text-sm text-muted">
          1-minute ATM only. Buy the rising leg at the circle, one lot. No sell. The phone only mirrors Lightsail. Live market orders start at 09:15. An open buy is squared at 15:20 and nothing new is sent after that. The process sleeps at 15:30. {formatInr(CROSS_BROKERAGE, 0)} comes off when it closes. {niftyWeekday()}. {mirror.note || "Waiting for the Lightsail desk."}
        </p>
      </div>
      <LiveStrip engine={engine} />
      <dl className="mt-4 grid grid-cols-3 gap-2">
        <Stat label="Trades" value={String(counted)} />
        <Stat label="Open" value={String(open.length)} />
        <Stat label="Net" value={formatInr(net, 0)} tone={net} />
      </dl>
      {open.length > 0 ? (
        <p className={openPnl >= 0 ? "mt-2 text-sm tabular-nums text-up" : "mt-2 text-sm tabular-nums text-down"}>
          Open mark {formatInr(openPnl, 0)} before brokerage
        </p>
      ) : null}

      <section className="mt-4 rounded-xl bg-surface p-4 shadow-[var(--shadow-border)]">
        <h2 className="font-display text-xl tracking-tight">Open</h2>
        <p className="mt-1 text-xs text-muted">Live premium. Closes if the other leg takes the lead, or when our lead turns down from a real high. Brokerage is not taken yet.</p>
        {open.length === 0 ? <p className="mt-3 text-sm text-muted">No open buy.</p> : null}
        <ul className="mt-2 divide-y divide-border">
          {open.map(({ symbol, trade, px }) => (
            <Row
              key={`${symbol}-${trade.id}`}
              symbol={symbol}
              trade={trade}
              px={px}
              pnl={crossPnl(trade, px, false)}
              orderId={mirror.orders[trade.id]?.buyOrderId}
              orderError={mirror.orders[trade.id]?.error}
            />
          ))}
        </ul>
      </section>

      <section className="mt-3 rounded-xl bg-surface p-4 shadow-[var(--shadow-border)]">
        <h2 className="font-display text-xl tracking-tight">Closed</h2>
        <p className="mt-1 text-xs text-muted">After {formatInr(CROSS_BROKERAGE, 0)}. One lot.</p>
        {closed.length === 0 ? <p className="mt-3 text-sm text-muted">No closed buy yet.</p> : null}
        <ul className="mt-2 divide-y divide-border">
          {closed.map(({ symbol, trade }) => (
            <Row
              key={`${symbol}-${trade.id}`}
              symbol={symbol}
              trade={trade}
              pnl={crossPnl(trade, trade.buy.exit ?? trade.buy.entry, true)}
              orderId={mirror.orders[trade.id]?.sellOrderId ?? mirror.orders[trade.id]?.buyOrderId}
              orderError={mirror.orders[trade.id]?.error}
            />
          ))}
        </ul>
      </section>
    </DeskShell>
  );
}

function LiveStrip({ engine }: { engine: ReturnType<typeof usePremiumEngine> }) {
  const live = engine.status === "live";
  const row = (label: string, px?: number) => (
    <span className="tabular-nums">
      {label} {px && px > 0 ? px.toFixed(2) : "—"}
    </span>
  );
  return (
    <p className={`mt-3 text-sm ${live ? "text-fg" : "text-muted"}`}>
      {live ? "Live" : "Connecting"}
      {" · "}
      {row("FUT", engine.future?.ltp)}
      {" · "}
      {row("CE", engine.ce?.ltp)}
      {" · "}
      {row("PE", engine.pe?.ltp)}
    </p>
  );
}

function livePx(trade: CrossTrade, engine: ReturnType<typeof usePremiumEngine>): number {
  const id = trade.buy.securityId;
  const leg =
    engine.ladder.find((item) => item.contract.securityId === id) ??
    (engine.ce?.contract.securityId === id ? engine.ce : undefined) ??
    (engine.pe?.contract.securityId === id ? engine.pe : undefined);
  return leg && leg.ltp > 0 ? leg.ltp : trade.buy.mark;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: number }) {
  const color = tone == null ? "text-fg" : tone >= 0 ? "text-up" : "text-down";
  return (
    <div className="rounded-xl bg-surface px-3 py-2 shadow-[var(--shadow-border)]">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`mt-1 text-sm font-medium tabular-nums ${color}`}>{value}</dd>
    </div>
  );
}

function Row({
  symbol,
  trade,
  pnl,
  px,
  orderId,
  orderError,
}: {
  symbol: string;
  trade: CrossTrade;
  pnl: number;
  px?: number;
  orderId?: string;
  orderError?: string;
}) {
  const mark = px ?? trade.buy.exit ?? trade.buy.entry;
  return (
    <li className="flex items-start justify-between gap-3 py-3">
      <div>
        <LegLine symbol={symbol} leg={{ ...trade.buy, mark }} live={trade.status === "open"} />
        <p className="mt-1 text-xs text-muted">
          {clock(trade.entryTs)}
          {trade.exitTs ? ` – ${clock(trade.exitTs)}` : ""} · 1 × {trade.lot} · {trade.frame} · {trade.reason}
          {trade.exitWhy ? ` · ${exitLabel(trade.exitWhy)}` : ""}
          {orderId ? ` · Dhan ${orderId}` : ""}
        </p>
        {orderError ? <p className="mt-1 text-xs text-down">{orderError}</p> : null}
      </div>
      <p className={pnl >= 0 ? "text-sm tabular-nums text-up" : "text-sm tabular-nums text-down"}>{formatInr(pnl, 0)}</p>
    </li>
  );
}

function LegLine({ symbol, leg, live }: { symbol: string; leg: CrossTrade["buy"]; live: boolean }) {
  const tone = leg.type === "CE" ? "text-up" : "text-down";
  return (
    <p className={`text-sm ${tone}`}>
      Buy {symbol} {formatStrike(leg.strike)} {leg.type} {leg.entry.toFixed(2)}
      {live ? ` · now ${leg.mark.toFixed(2)}` : leg.exit != null ? ` → ${leg.exit.toFixed(2)}` : ""}
    </p>
  );
}

function exitLabel(why: CrossTrade["exitWhy"]): string {
  if (why === "flipped") return "other side took the lead";
  if (why === "flat") return "flat 15:20";
  return "gap turned";
}

function formatStrike(strike: number): string {
  return Number.isInteger(strike) ? String(strike) : strike.toFixed(2);
}

function clock(ts: number): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(ts);
}
