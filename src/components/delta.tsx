import { cn } from "@/lib/utils";
import { formatPct } from "@/lib/market/hours";

export function Delta({
  value,
  className,
  withSign = true,
}: {
  value: number;
  className?: string;
  withSign?: boolean;
}) {
  const up = value >= 0;
  return (
    <span
      className={cn(
        "tabular-nums",
        up ? "text-up" : "text-down",
        className,
      )}
    >
      {withSign ? formatPct(value) : `${value.toFixed(2)}%`}
    </span>
  );
}
