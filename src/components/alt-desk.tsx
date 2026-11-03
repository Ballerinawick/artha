import { useEffect, useState } from "react";
import { Navigate } from "@tanstack/react-router";
import { DeskShell } from "@/components/desk-shell";
import { WaveChart } from "@/components/tick-wave";
import { Skeleton } from "@/components/ui/skeleton";
import { ALT_SPECS } from "@/lib/dhan/alt-spec";
import { useDhanCreds } from "@/lib/dhan/session";
import { useAltEngine, watchAlt } from "@/lib/dhan/use-alt-engine";
import { useAltTape } from "@/lib/dhan/alt-tape";
import { cn } from "@/lib/utils";

export function AltDesk({ symbol, symbols }: { symbol?: string; symbols?: string[] }) {
  const [ready, setReady] = useState(false);
  const [chartOn, setChartOn] = useState(false);
  const choices = symbols ?? (symbol ? [symbol] : []);
  const [picked, setPicked] = useState(choices[0] ?? "");
  useEffect(() => {
    setReady(true);
    const id = window.requestAnimationFrame(() => setChartOn(true));
    return () => window.cancelAnimationFrame(id);
  }, []);
  const creds = useDhanCreds();
  useAltEngine();
  const active = symbol ?? picked;
  const view = useAltTape((s) => s.views[active]);
  const note = useAltTape((s) => s.note);
  useEffect(() => {
    watchAlt(active);
    return () => watchAlt("");
  }, [active]);
  const spec = ALT_SPECS.find((item) => item.symbol === active);

  if (!ready) {
    return (
      <DeskShell>
        <Skeleton className="h-28 rounded-xl" />
      </DeskShell>
    );
  }
  if (!creds) return <Navigate to="/" />;

  const calls = (view?.ladder ?? []).filter((leg) => leg.contract.type === "CE").sort((a, b) => a.contract.strike - b.contract.strike);
  const puts = (view?.ladder ?? []).filter((leg) => leg.contract.type === "PE").sort((a, b) => a.contract.strike - b.contract.strike);

  return (
    <DeskShell>
      <div className="border-b border-border pb-3">
        <p className="text-xs font-medium text-muted">Same circle rule. Nifty is not changed.</p>
        <h1 className="font-display text-3xl tracking-tight">{spec?.name ?? active}</h1>
        <p className="mt-1 text-sm text-muted">{view?.note || note}</p>
      </div>
      {choices.length > 1 ? (
        <div className="mt-3 flex gap-2 overflow-auto">
          {choices.map((item) => {
            const name = ALT_SPECS.find((row) => row.symbol === item)?.name ?? item;
            return (
              <button
                key={item}
                type="button"
                className={cn("h-11 shrink-0 rounded-full px-4 text-sm", item === active ? "bg-accent text-accent-fg" : "bg-surface text-muted")}
                onClick={() => setPicked(item)}
              >
                {name}
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="mt-4">
        {chartOn && view?.future && calls.length > 0 && puts.length > 0 ? (
          <WaveChart future={view.future} calls={calls} puts={puts} spot={view.spot} />
        ) : (
          <Skeleton className="h-[28rem] rounded-xl sm:h-[32rem]" />
        )}
      </div>
    </DeskShell>
  );
}
