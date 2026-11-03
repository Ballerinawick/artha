import { Navigate } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { Delta } from "@/components/delta";
import { DeskShell } from "@/components/desk-shell";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { getSignalBoard } from "@/lib/dhan/server";
import { useDhanCreds } from "@/lib/dhan/session";
import type { BoardSignal, SignalBoard as Board } from "@/lib/dhan/types";
import { useLiveTape } from "@/lib/dhan/use-tape";
import { NAMES, SCAN_GROUPS } from "@/lib/dhan/universe";
import { formatInr } from "@/lib/market/hours";
import { usePaper } from "@/lib/paper";
import { cn } from "@/lib/utils";

export function SignalBoard() {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const creds = useDhanCreds();
  const clientId = creds?.clientId ?? "";
  const accessToken = creds?.accessToken ?? "";
  const ensure = usePaper((s) => s.ensure);
  const [parts, setParts] = useState<Board[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState("");

  useEffect(() => {
    if (!ready || !clientId || !accessToken) return;
    let stop = false;
    const cred = { clientId, accessToken };
    async function run() {
      while (!stop) {
        setScanning(true);
        const acc: Board[] = [];
        for (const symbols of SCAN_GROUPS) {
          if (stop) return;
          try {
            const part = await getSignalBoard({ data: { ...cred, symbols } });
            acc.push(part);
            if (!stop) {
              setParts(acc.slice());
              setScanError("");
            }
          } catch (err) {
            if (!stop) setScanError(err instanceof Error ? err.message : "Scan failed");
          }
        }
        if (!stop) setScanning(false);
        await new Promise((r) => setTimeout(r, 90_000));
      }
    }
    void run();
    return () => {
      stop = true;
    };
  }, [ready, clientId, accessToken]);

  const signals = parts.flatMap((p) => p.signals);
  const quiet = parts.flatMap((p) => p.quiet);
  const signalKey = signals.map((s) => s.id).join("|");
  const fnoKey = signals
    .filter((s) => s.kind === "option" && /^\d+$/.test(s.securityId))
    .map((s) => s.securityId)
    .sort()
    .join(",");
  const tapeQuery = useLiveTape(fnoKey);
  const tape = tapeQuery.data?.tape ?? [];
  const byId = new Map(tape.map((t) => [t.securityId, t]));

  useEffect(() => {
    for (const signal of signals) ensure(signal);
    // signalKey changes only when the set of prints changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signalKey, ensure]);

  if (!ready) {
    return (
      <DeskShell>
        <Skeleton className="h-28 rounded-xl" />
      </DeskShell>
    );
  }
  if (!creds) return <Navigate to="/" />;

  const stocks = signals.filter((s) => s.kind === "stock");
  const options = signals.filter((s) => s.kind === "option");
  const scanned = parts.reduce((sum, p) => sum + p.engine.scanned, 0);
  const livePrints = signals.filter((s) => s.mode === "live").length;
  const reviews = signals.filter((s) => s.kind === "stock" && s.mode === "review").length;
  const warnings = [...new Set(parts.flatMap((p) => p.warnings))];
  const note = parts.at(-1)?.sessionNote;

  return (
    <DeskShell>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-muted">Auction stack</p>
          <h1 className="mt-1 font-display text-4xl tracking-tight">Signal board</h1>
        </div>
        <p className="max-w-sm text-sm text-muted">{note ?? "Prices update every few seconds. Charts are read more slowly so Dhan does not throttle."}</p>
      </div>
      <p className="mt-2 text-xs text-subtle">
        {tapeQuery.data ? `Live ${tapeQuery.data.asOfLabel}` : "Waiting for the live tape"}
        {scanning ? ` · reading charts ${scanned}/${NAMES.length}` : " · charts caught up"}
      </p>

      {tapeQuery.isError ? (
        <p className="mt-4 text-sm text-down">{tapeQuery.error instanceof Error ? tapeQuery.error.message : "Live prices failed"}</p>
      ) : null}
      {scanError ? <p className="mt-2 text-sm text-down">{scanError}</p> : null}
      {warnings.map((w) => (
        <p key={w} className="mt-2 text-xs text-warn">
          {w}
        </p>
      ))}

      <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Count label="Scanned" value={String(scanned)} />
        <Count label="Live prints" value={String(livePrints)} />
        <Count label="Reviews" value={String(reviews)} />
        <Count label="Quiet" value={String(quiet.length)} />
      </div>

      <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
        {tape
          .filter((t) => NAMES.some((n) => n.symbol === t.symbol))
          .map((t) => (
            <div key={t.symbol} className="w-36 shrink-0 rounded-lg bg-surface px-3 py-3 shadow-[var(--shadow-border)]">
              <p className="truncate text-xs text-muted">{t.symbol}</p>
              <p className="mt-1 text-sm tabular-nums">{formatInr(t.ltp)}</p>
              <Delta value={t.changePct} className="text-xs" />
            </div>
          ))}
      </div>

      {!parts.length && scanning ? (
        <div className="mt-6 grid gap-3">
          <Skeleton className="h-40 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
        </div>
      ) : null}

      <Section title="Stock prints" empty="No stock cleared the stack. Quiet names are listed below.">
        {stocks.map((s) => (
          <SignalCard key={s.id} signal={s} live={byId.get(s.securityId)?.ltp} />
        ))}
      </Section>
      <Section title="Option prints" empty="No live index bias, so no CE or PE is armed. Long premium only.">
        {options.map((s) => (
          <SignalCard key={s.id} signal={s} live={byId.get(s.securityId)?.ltp} />
        ))}
      </Section>

      <section className="mt-8">
        <h2 className="font-display text-2xl tracking-tight">Quiet tape</h2>
        <p className="mt-1 text-sm text-muted">These names were read and refused. They do not become paper trades.</p>
        {parts.length > 0 && quiet.length === 0 && !scanning ? (
          <p className="mt-2 text-sm text-muted">Nothing was refused.</p>
        ) : null}
        <ul className="mt-3 divide-y divide-border rounded-xl bg-surface px-4 shadow-[var(--shadow-border)]">
          {quiet.map((q) => (
            <li key={q.symbol} className="flex items-start justify-between gap-4 py-3">
              <span className="text-sm font-medium">{q.symbol}</span>
              <span className="max-w-xs text-right text-xs leading-relaxed text-muted">{q.reason}</span>
            </li>
          ))}
        </ul>
      </section>
    </DeskShell>
  );
}

function Count({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-surface px-3 py-3 shadow-[var(--shadow-border)]">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 font-display text-2xl tabular-nums tracking-tight">{value}</p>
    </div>
  );
}

function Section({ title, empty, children }: { title: string; empty: string; children: ReactNode }) {
  const list = Array.isArray(children) ? children.filter(Boolean) : children ? [children] : [];
  return (
    <section className="mt-8">
      <h2 className="font-display text-2xl tracking-tight">{title}</h2>
      {list.length === 0 ? <p className="mt-2 text-sm text-muted">{empty}</p> : <div className="mt-3 grid gap-3">{list}</div>}
    </section>
  );
}

function SignalCard({ signal, live }: { signal: BoardSignal; live?: number }) {
  const paper = usePaper((s) => s.trades.find((t) => t.id === signal.id));
  const entry = paper?.entry ?? signal.entry;
  const mark = live && live > 0 ? live : (paper?.mark ?? signal.ltp);
  return (
    <article className="rise-in rounded-xl bg-surface p-4 shadow-[var(--shadow-border)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-muted">
            {signal.kind === "option" ? "Long premium" : "Cash intraday"} · {signal.name}
          </p>
          <h3 className="truncate font-display text-2xl tracking-tight">{signal.symbol}</h3>
        </div>
        <div className="text-right">
          <Badge variant={signal.side === "BUY" ? "up" : "down"}>{signal.side}</Badge>
          <p className="mt-1 text-xs tabular-nums text-muted">Fit {signal.score}</p>
        </div>
      </div>
      <p className="mt-3 text-sm tabular-nums">
        {formatInr(entry)} <span className="text-muted">to</span> {formatInr(signal.target)}
        <span className="text-muted"> · mark {formatInr(mark)}</span>
      </p>
      <ul className="mt-3 flex flex-wrap gap-1.5">
        {signal.checks.map((c) => (
          <li
            key={c.name}
            title={c.detail}
            className={cn(
              "rounded-full bg-surface-2 px-2.5 py-1 text-xs",
              c.pass ? "text-up" : "text-down",
            )}
          >
            {c.name}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs leading-relaxed text-subtle">
        {signal.mode === "live" ? "Live print, paper by default" : "Last session review — not paper"} · square-off{" "}
        {signal.squareOff} · no stop
        {paper ? ` · blotter ${paper.status}` : ""}
        {signal.option?.oiChange != null ? ` · OI change ${Math.round(signal.option.oiChange).toLocaleString("en-IN")}` : ""}
      </p>
    </article>
  );
}
