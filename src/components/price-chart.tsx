import { useMemo } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Bar } from "@/lib/market/types";
import { formatInr } from "@/lib/market/hours";

export function PriceChart({ bars, range }: { bars: Bar[]; range: "1D" | "1M" | "3M" | "1Y" }) {
  const data = useMemo(() => {
    if (range === "1D") return bars;
    const now = bars.at(-1)?.t ?? Date.now();
    const days = range === "1M" ? 32 : range === "3M" ? 95 : 400;
    const cut = now - days * 86400000;
    return bars.filter((b) => b.t >= cut);
  }, [bars, range]);

  if (data.length < 2) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg bg-surface-2 text-sm text-muted">
        Not enough prints for this range
      </div>
    );
  }

  const up = data[data.length - 1]!.c >= data[0]!.c;
  const stroke = up ? "var(--color-up)" : "var(--color-down)";
  const fillId = up ? "arthaUp" : "arthaDown";

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="arthaUp" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-up)" stopOpacity={0.28} />
              <stop offset="100%" stopColor="var(--color-up)" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="arthaDown" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-down)" stopOpacity={0.28} />
              <stop offset="100%" stopColor="var(--color-down)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="t" hide />
          <YAxis domain={["auto", "auto"]} hide />
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.[0]) return null;
              const bar = payload[0].payload as Bar;
              const when = new Intl.DateTimeFormat("en-IN", {
                timeZone: "Asia/Kolkata",
                day: "2-digit",
                month: "short",
                hour: range === "1D" ? "2-digit" : undefined,
                minute: range === "1D" ? "2-digit" : undefined,
              }).format(bar.t);
              return (
                <div className="rounded-md bg-fg px-3 py-2 text-xs text-accent-fg">
                  <p>{when}</p>
                  <p className="mt-1 tabular-nums">{formatInr(bar.c)}</p>
                </div>
              );
            }}
          />
          <Area
            type="monotone"
            dataKey="c"
            stroke={stroke}
            strokeWidth={1.6}
            fill={`url(#${fillId})`}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
