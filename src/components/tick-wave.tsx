import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { LegView } from "@/lib/dhan/use-premium-engine";

const GAP_MS = 6 * 60 * 1000;
const WINDOW_MS = 7 * 60 * 60 * 1000;
const LABEL_SPAN_MS = 20 * 60 * 1000;

type Kind = "FUT" | "CE" | "PE";

type Sample = { t: number; price: number };

type Series = {
  key: string;
  kind: Kind;
  strike: number;
  name: string;
  color: string;
  width: number;
  opacity: number;
  points: Sample[];
};

type PlotPoint = { t: number; plot: number; real: number; x: number; y: number };

type Cross = {
  t: number;
  x: number;
  y: number;
  a: string;
  b: string;
  priceA: string;
  priceB: string;
};

type View = { t0: number; t1: number; y0: number; y1: number };

type Box = { plotL: number; plotR: number; plotT: number; plotB: number; domain: View; frame: View };

export function WaveChart({
  future,
  calls,
  puts,
  spot,
}: {
  future: LegView;
  calls: LegView[];
  puts: LegView[];
  spot: number;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [off, setOff] = useState<string[]>([]);
  const [view, setView] = useState<View | null>(null);
  const [fitted, setFitted] = useState(false);
  const [moving, setMoving] = useState(false);
  const follow = useRef(true);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pending = useRef<View | null>(null);
  const rafId = useRef(0);
  const tap = useRef<{ t: number; x: number; y: number } | null>(null);
  const gesture = useRef<
    | { mode: "pan"; view: View; x: number; y: number; axis: "x" | "y" | "both" }
    | { mode: "pinch"; view: View; dx: number; dy: number }
    | null
  >(null);
  const clipId = `waves${useId().replace(/:/g, "")}`;
  const space = useRef<Box>({
    plotL: 48,
    plotR: 220,
    plotT: 12,
    plotB: 360,
    domain: emptyView(),
    frame: emptyView(),
  });

  useEffect(() => {
    const node = frame.current;
    if (!node) return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      setSize({ w: Math.round(rect.width), h: Math.round(rect.height) });
    };
    measure();
    const watcher = new ResizeObserver(measure);
    watcher.observe(node);
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = space.current;
      if (!(box.domain.t1 > box.domain.t0)) return;
      const rect = node.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const dy = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      const factor = Math.exp(dy * 0.0016);
      const where = x < box.plotL ? "y" : y > box.plotB ? "x" : event.shiftKey ? "y" : event.ctrlKey ? "both" : "x";
      const anchor = dataAt(box.frame, x, y, box);
      const next = zoomView(
        box.frame,
        where === "y" ? 1 : factor,
        where === "x" ? 1 : factor,
        anchor.t,
        anchor.y,
        box.domain,
      );
      follow.current = where === "y" ? follow.current : next.t1 >= box.domain.t1 - 2000;
      setFitted(false);
      setView(next);
    };
    const blockTouch = (event: TouchEvent) => event.preventDefault();
    node.addEventListener("wheel", onWheel, { passive: false });
    node.addEventListener("touchmove", blockTouch, { passive: false });
    return () => {
      watcher.disconnect();
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("touchmove", blockTouch);
      cancelAnimationFrame(rafId.current);
    };
  }, []);

  const hidden = new Set(off);
  const stamp = [future, ...calls, ...puts].map(barStamp).join(";");
  const atm = nearestStrike(calls, spot);
  const viewKey = view ? `${view.t0}|${view.t1}|${view.y0}|${view.y1}` : "";
  const liveKey = `${future.ltp}|${calls.map((leg) => leg.ltp).join(",")}|${puts.map((leg) => leg.ltp).join(",")}`;
  const base = useMemo(
    () => (size.w > 40 ? layout(size.w, size.h, future, calls, puts, spot, hidden, view, fitted, !moving) : null),
    [size.w, size.h, stamp, off.join(","), viewKey, fitted, moving, atm],
  );
  const drawn = useMemo(() => {
    if (!base) return null;
    const nudged = nudgeLive(base, future, calls, puts);
    return nudged ?? layout(size.w, size.h, future, calls, puts, spot, hidden, view, fitted, !moving);
  }, [base, liveKey]);
  if (drawn) {
    space.current = {
      plotL: drawn.plotL,
      plotR: drawn.plotR,
      plotT: drawn.plotT,
      plotB: drawn.plotB,
      domain: drawn.domain,
      frame: drawn.frame,
    };
  }

  useEffect(() => {
    const end = drawn?.domain.t1;
    if (end == null || !follow.current) return;
    setView((current) => {
      if (!current) return current;
      const span = current.t1 - current.t0;
      if (Math.abs(current.t1 - end) < 1500) return current;
      return clampView({ ...current, t0: end - span, t1: end }, space.current.domain);
    });
  }, [drawn?.domain.t1]);

  function commit(next: View) {
    pending.current = next;
    if (rafId.current) return;
    rafId.current = requestAnimationFrame(() => {
      rafId.current = 0;
      const value = pending.current;
      pending.current = null;
      if (value) {
        setFitted(false);
        setView(value);
      }
    });
  }

  function zoomBy(axis: "x" | "y", factor: number) {
    const box = space.current;
    if (!drawn) return;
    const current = pending.current ?? box.frame;
    const cx = (current.t0 + current.t1) / 2;
    const cy = (current.y0 + current.y1) / 2;
    const xSpan = (current.t1 - current.t0) * factor;
    const ySpan = (current.y1 - current.y0) * factor;
    const next = clampView(
      {
        t0: axis === "y" ? current.t0 : follow.current ? box.domain.t1 - xSpan : cx - xSpan / 2,
        t1: axis === "y" ? current.t1 : follow.current ? box.domain.t1 : cx + xSpan / 2,
        y0: axis === "x" ? current.y0 : cy - ySpan / 2,
        y1: axis === "x" ? current.y1 : cy + ySpan / 2,
      },
      box.domain,
    );
    if (axis === "x") follow.current = next.t1 >= box.domain.t1 - 2000;
    setFitted(false);
    setView(next);
  }

  function toggle(id: string) {
    setOff((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  }

  function toggleSide(kind: "CE" | "PE") {
    const ids = (kind === "CE" ? calls : puts).map((leg) => leg.contract.securityId);
    setOff((prev) => {
      const allOff = ids.every((id) => prev.includes(id));
      const rest = prev.filter((id) => !ids.includes(id));
      return allOff ? rest : [...rest, ...ids];
    });
  }

  function shownView() {
    return pending.current ?? space.current.frame;
  }

  function localPoint(event: React.PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function axisAt(point: { x: number; y: number }): "x" | "y" | "both" {
    const box = space.current;
    if (point.y > box.plotB) return "x";
    if (point.x < box.plotL) return "y";
    return "both";
  }

  function onPointerDown(event: React.PointerEvent<SVGSVGElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = localPoint(event);
    pointers.current.set(event.pointerId, point);
    const current = shownView();
    if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      setMoving(true);
      gesture.current = {
        mode: "pinch",
        view: current,
        dx: Math.abs((a?.x ?? 0) - (b?.x ?? 0)),
        dy: Math.abs((a?.y ?? 0) - (b?.y ?? 0)),
      };
      return;
    }
    gesture.current = { mode: "pan", view: current, x: point.x, y: point.y, axis: axisAt(point) };
  }

  function onPointerMove(event: React.PointerEvent<SVGSVGElement>) {
    if (!pointers.current.has(event.pointerId)) return;
    const point = localPoint(event);
    pointers.current.set(event.pointerId, point);
    const active = gesture.current;
    const box = space.current;
    if (!active) return;
    if (active.mode === "pan" && pointers.current.size === 1) {
      if (Math.hypot(point.x - active.x, point.y - active.y) > 6) setMoving(true);
      const next =
        active.axis === "both"
          ? panView(active.view, point.x - active.x, point.y - active.y, box, "both")
          : zoomDrag(active.view, point.x - active.x, point.y - active.y, active.axis, box.domain);
      follow.current = next.t1 >= box.domain.t1 - 2000;
      commit(next);
      return;
    }
    if (active.mode === "pinch" && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      if (!a || !b) return;
      const dx = Math.abs(a.x - b.x);
      const dy = Math.abs(a.y - b.y);
      const factorX = active.dx > 16 ? active.dx / Math.max(16, dx) : 1;
      const factorY = active.dy > 16 ? active.dy / Math.max(16, dy) : 1;
      const anchor = dataAt(active.view, (a.x + b.x) / 2, (a.y + b.y) / 2, box);
      const next = zoomView(active.view, factorX, factorY, anchor.t, anchor.y, box.domain);
      follow.current = false;
      commit(next);
    }
  }

  function onPointerUp(event: React.PointerEvent<SVGSVGElement>) {
    const point = localPoint(event);
    const active = gesture.current;
    pointers.current.delete(event.pointerId);
    if (pointers.current.size === 1) {
      const rest = [...pointers.current.values()][0];
      if (rest) gesture.current = { mode: "pan", view: shownView(), x: rest.x, y: rest.y, axis: "both" };
      return;
    }
    gesture.current = null;
    setMoving(false);
    if (!active || active.mode !== "pan" || pointers.current.size > 0) return;
    const moved = Math.hypot(point.x - active.x, point.y - active.y);
    if (moved > 8) return;
    const now = Date.now();
    const prev = tap.current;
    if (prev && now - prev.t < 320 && Math.hypot(point.x - prev.x, point.y - prev.y) < 28) {
      tap.current = null;
      const anchor = dataAt(active.view, point.x, point.y, space.current);
      const factor = 0.55;
      const next = zoomView(
        active.view,
        active.axis === "y" ? 1 : factor,
        active.axis === "x" ? 1 : factor,
        anchor.t,
        anchor.y,
        space.current.domain,
      );
      follow.current = false;
      setFitted(false);
      setView(next);
      return;
    }
    tap.current = { t: now, x: point.x, y: point.y };
  }

  const callIds = calls.map((leg) => leg.contract.securityId);
  const putIds = puts.map((leg) => leg.contract.securityId);
  const callsOn = callIds.some((id) => !hidden.has(id));
  const putsOn = putIds.some((id) => !hidden.has(id));

  return (
    <div>
      <div className="mb-2 flex gap-1.5 overflow-x-auto pb-1">
        <ToggleChip
          label="Future"
          kind="FUT"
          on={!hidden.has(future.contract.securityId)}
          onClick={() => toggle(future.contract.securityId)}
        />
        <ToggleChip label="All calls" kind="CE" on={callsOn} onClick={() => toggleSide("CE")} />
        {calls.map((leg) => (
          <ToggleChip
            key={leg.contract.securityId}
            label={`${formatStrike(leg.contract.strike)} CE`}
            kind="CE"
            on={!hidden.has(leg.contract.securityId)}
            onClick={() => toggle(leg.contract.securityId)}
          />
        ))}
      </div>
      <div className="mb-2 flex gap-1.5 overflow-x-auto pb-1">
        <ToggleChip label="All puts" kind="PE" on={putsOn} onClick={() => toggleSide("PE")} />
        {puts.map((leg) => (
          <ToggleChip
            key={leg.contract.securityId}
            label={`${formatStrike(leg.contract.strike)} PE`}
            kind="PE"
            on={!hidden.has(leg.contract.securityId)}
            onClick={() => toggle(leg.contract.securityId)}
          />
        ))}
      </div>
      <div className="mb-2 flex gap-1.5">
        <AxisButton label="X −" detail="Zoom out time" onClick={() => zoomBy("x", 1.6)} />
        <AxisButton label="X +" detail="Zoom in time" onClick={() => zoomBy("x", 0.62)} />
        <AxisButton label="Y −" detail="Zoom out premium" onClick={() => zoomBy("y", 1.6)} />
        <AxisButton label="Y +" detail="Zoom in premium" onClick={() => zoomBy("y", 0.62)} />
        <AxisButton
          label="All"
          detail="Show the full window"
          onClick={() => {
            follow.current = true;
            pending.current = null;
            setView(null);
            setFitted(true);
          }}
        />
      </div>
      <p className="mb-2 text-xs text-subtle">
        ATM, one in the money and one out, taken from the future. All three are kept from 09:15. A paper buys the ATM pair only. 1-minute bars. The last point is the live tick. Drag to move, X and Y to zoom. All shows the session.
      </p>
      <div ref={frame} className="relative h-[28rem] w-full touch-none select-none overscroll-none sm:h-[32rem]">
        {drawn ? (
          <svg
            viewBox={`0 0 ${size.w} ${size.h}`}
            className="h-full w-full cursor-grab font-sans active:cursor-grabbing"
            role="img"
            aria-label="Nifty future and option premium waves. Drag to move, pinch to zoom."
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <rect x={0} y={0} width={drawn.plotL} height={size.h} fill="var(--color-fg)" fillOpacity="0.05" />
            <rect
              x={0}
              y={drawn.plotB}
              width={size.w}
              height={Math.max(0, size.h - drawn.plotB)}
              fill="var(--color-fg)"
              fillOpacity="0.05"
            />
            <clipPath id={clipId}>
              <rect x={drawn.plotL} y={drawn.plotT} width={drawn.plotR - drawn.plotL} height={drawn.plotB - drawn.plotT} />
            </clipPath>
            {drawn.grid.map((row, index) => (
              <g key={`${row.label}-${index}`}>
                <line x1={drawn.plotL} x2={drawn.plotR} y1={row.y} y2={row.y} stroke="var(--color-border)" strokeWidth="1" />
                <text x={drawn.plotL - 6} y={row.y + 3} textAnchor="end" fill="var(--color-subtle)" fontSize="10">
                  {row.label}
                </text>
              </g>
            ))}
            <g clipPath={`url(#${clipId})`}>
              {drawn.series.map((row, seriesIndex) =>
                row.paths.map((path, pathIndex) => (
                  <polyline
                    key={`${seriesIndex}-${pathIndex}`}
                    points={path}
                    fill="none"
                    stroke={row.color}
                    strokeWidth={row.width}
                    strokeOpacity={row.opacity}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                )),
              )}
              {drawn.crosses.map((cross, index) => (
                <circle
                  key={`${index}-${cross.t}-${cross.a}`}
                  cx={cross.x}
                  cy={cross.y}
                  r="3.25"
                  fill="none"
                  stroke="var(--color-fg)"
                  strokeWidth="1.25"
                />
              ))}
              {drawn.labels.map((label, index) => (
                <text key={`${index}-${label.x}-${label.y}`} x={label.x} y={label.y} fill="var(--color-fg)" fontSize="10">
                  {label.lines.map((line, lineIndex) => (
                    <tspan key={`${lineIndex}-${line}`} x={label.x} dy={lineIndex === 0 ? 0 : 12}>
                      {line}
                    </tspan>
                  ))}
                </text>
              ))}
            </g>
            {drawn.ends.map((end) => (
              <g key={end.name}>
                {Math.abs(end.anchor - end.y) > 10 ? (
                  <line x1={drawn.plotR} x2={drawn.plotR + 6} y1={end.anchor} y2={end.y - 3} stroke={end.color} strokeWidth="1" />
                ) : null}
                <text x={drawn.plotR + 8} y={end.y} fill={end.color} fontSize="11">
                  {end.name}
                </text>
              </g>
            ))}
            {drawn.times.map((stamp) => (
              <text key={`${stamp.anchor}-${stamp.label}`} x={stamp.x} y={size.h - 6} textAnchor={stamp.anchor} fill="var(--color-subtle)" fontSize="10">
                {stamp.label}
              </text>
            ))}
          </svg>
        ) : null}
      </div>
    </div>
  );
}

function ToggleChip({ label, kind, on, onClick }: { label: string; kind: Kind; on: boolean; onClick: () => void }) {
  const tone = kind === "CE" ? "text-up" : kind === "PE" ? "text-down" : "text-fg";
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`h-11 shrink-0 rounded-full border px-3 text-xs ${on ? `border-current bg-surface-2 ${tone}` : "border-border text-subtle line-through"}`}
    >
      {label}
    </button>
  );
}

function AxisButton({ label, detail, onClick }: { label: string; detail: string; onClick: () => void }) {
  return (
    <button type="button" aria-label={detail} onClick={onClick} className="h-11 min-w-0 flex-1 rounded-full bg-surface-2 text-xs text-fg">
      {label}
    </button>
  );
}

function emptyView(): View {
  return { t0: 0, t1: 1, y0: 0, y1: 1 };
}

function trailing(domain: View): View {
  const span = Math.min(35 * 60 * 1000, domain.t1 - domain.t0);
  return { t0: domain.t1 - span, t1: domain.t1, y0: domain.y0, y1: domain.y1 };
}

function clampView(next: View, domain: View): View {
  const maxT = Math.max(1000, domain.t1 - domain.t0);
  const maxY = Math.max(0.5, domain.y1 - domain.y0);
  const tSpan = Math.min(Math.max(next.t1 - next.t0, Math.min(60_000, maxT)), maxT);
  const ySpan = Math.min(Math.max(next.y1 - next.y0, Math.min(1, maxY)), maxY);
  let t0 = next.t0;
  let y0 = next.y0;
  if (t0 < domain.t0) t0 = domain.t0;
  if (t0 + tSpan > domain.t1) t0 = domain.t1 - tSpan;
  if (y0 < domain.y0) y0 = domain.y0;
  if (y0 + ySpan > domain.y1) y0 = domain.y1 - ySpan;
  return { t0, t1: t0 + tSpan, y0, y1: y0 + ySpan };
}

function panView(
  start: View,
  dx: number,
  dy: number,
  box: { plotL: number; plotR: number; plotT: number; plotB: number; domain: View },
  axis: "x" | "y" | "both",
): View {
  const plotW = Math.max(1, box.plotR - box.plotL);
  const plotH = Math.max(1, box.plotB - box.plotT);
  const tSpan = start.t1 - start.t0;
  const ySpan = start.y1 - start.y0;
  const dt = axis === "y" ? 0 : (-dx / plotW) * tSpan;
  const dPrice = axis === "x" ? 0 : (dy / plotH) * ySpan;
  return clampView({ t0: start.t0 + dt, t1: start.t1 + dt, y0: start.y0 + dPrice, y1: start.y1 + dPrice }, box.domain);
}

function zoomDrag(start: View, dx: number, dy: number, axis: "x" | "y", domain: View): View {
  if (axis === "x") {
    const factor = Math.exp(-dx / 140);
    const span = (start.t1 - start.t0) * factor;
    const mid = (start.t0 + start.t1) / 2;
    const anchorRight = start.t1 >= domain.t1 - 2000;
    return clampView(
      anchorRight
        ? { t0: domain.t1 - span, t1: domain.t1, y0: start.y0, y1: start.y1 }
        : { t0: mid - span / 2, t1: mid + span / 2, y0: start.y0, y1: start.y1 },
      domain,
    );
  }
  const factor = Math.exp(dy / 140);
  const span = (start.y1 - start.y0) * factor;
  const mid = (start.y0 + start.y1) / 2;
  return clampView({ t0: start.t0, t1: start.t1, y0: mid - span / 2, y1: mid + span / 2 }, domain);
}

function dataAt(frame: View, x: number, y: number, box: { plotL: number; plotR: number; plotT: number; plotB: number }) {
  const tx = (x - box.plotL) / Math.max(1, box.plotR - box.plotL);
  const ty = (y - box.plotT) / Math.max(1, box.plotB - box.plotT);
  return {
    t: frame.t0 + tx * (frame.t1 - frame.t0),
    y: frame.y1 - ty * (frame.y1 - frame.y0),
  };
}

function zoomView(start: View, factorX: number, factorY: number, anchorT: number, anchorY: number, domain: View): View {
  const tSpan = (start.t1 - start.t0) * factorX;
  const ySpan = (start.y1 - start.y0) * factorY;
  const tx = (anchorT - start.t0) / (start.t1 - start.t0 || 1);
  const ty = (anchorY - start.y0) / (start.y1 - start.y0 || 1);
  return clampView(
    {
      t0: anchorT - tx * tSpan,
      t1: anchorT + (1 - tx) * tSpan,
      y0: anchorY - ty * ySpan,
      y1: anchorY + (1 - ty) * ySpan,
    },
    domain,
  );
}

function layout(
  width: number,
  height: number,
  future: LegView,
  calls: LegView[],
  puts: LegView[],
  spot: number,
  hidden: Set<string>,
  view: View | null,
  fitted: boolean,
  markers: boolean,
) {
  const plotL = 48;
  const plotR = Math.max(plotL + 64, width - 122);
  const plotT = 12;
  const plotB = height - 44;
  const plotW = Math.max(1, plotR - plotL);
  const plotH = Math.max(1, plotB - plotT);
  const atm = nearestStrike(calls, spot);
  const callStrikes = calls.map((leg) => leg.contract.strike);
  const putStrikes = puts.map((leg) => leg.contract.strike);
  const series = [
    toSeries(future, "FUT", "var(--color-fg)", 1.7, 1),
    ...calls.map((leg) => toSeries(leg, "CE", "var(--color-up)", leg.contract.strike === atm ? 1.7 : 1.15, wingOpacity(leg.contract.strike, atm, callStrikes))),
    ...puts.map((leg) => toSeries(leg, "PE", "var(--color-down)", leg.contract.strike === atm ? 1.7 : 1.15, wingOpacity(leg.contract.strike, atm, putStrikes))),
  ].filter((row) => row.points.length > 0 && !hidden.has(row.key));

  const premiums = series.filter((row) => row.kind !== "FUT").flatMap((row) => row.points.map((point) => point.price));
  const rawMin = premiums.length ? Math.min(...premiums) : 0;
  const rawMax = premiums.length ? Math.max(...premiums) : 1;
  const pad = Math.max(0.5, (rawMax - rawMin) * 0.08);
  const fullY0 = rawMin - pad;
  const fullY1 = rawMax + pad || fullY0 + 1;
  const fut = series.find((row) => row.kind === "FUT");
  const futPrices = fut?.points.map((point) => point.price) ?? [];
  const fMin = futPrices.length ? Math.min(...futPrices) : 0;
  const fMax = futPrices.length ? Math.max(...futPrices) : 0;
  const times = series.flatMap((row) => row.points.map((point) => point.t));
  const fullT0 = times.length ? Math.min(...times) : 0;
  const fullT1 = times.length ? Math.max(...times) : 1;
  const domain = { t0: fullT0, t1: Math.max(fullT1, fullT0 + 1000), y0: fullY0, y1: fullY1 };
  const window = view ? clampView(view, domain) : fitted ? domain : trailing(domain);
  const xOf = (t: number) => plotL + ((window.t1 === window.t0 ? 0.5 : (t - window.t0) / (window.t1 - window.t0)) * plotW);
  const yOf = (value: number) => plotT + (1 - (value - window.y0) / (window.y1 - window.y0 || 1)) * plotH;
  const project = (row: Series, price: number) => (row.kind === "FUT" ? scaleFuture(price, fMin, fMax, fullY0, fullY1) : price);

  const plotted: { series: Series; points: PlotPoint[] }[] = series.map((row) => ({
    series: row,
    points: row.points.map((point) => {
      const plot = project(row, point.price);
      return { t: point.t, plot, real: point.price, x: xOf(point.t), y: yOf(plot) };
    }),
  }));

  const paths = plotted.map((row) => {
    const last = row.points[row.points.length - 1];
    return {
      key: row.series.key,
      kind: row.series.kind,
      name: row.series.name,
      color: row.series.color,
      width: row.series.width,
      opacity: row.series.opacity,
      paths: strokePaths(row.points),
      tipX: last?.x ?? 0,
      tipReal: last?.real ?? 0,
    };
  });

  const crosses: Cross[] = [];
  if (markers) {
    for (let i = 0; i < plotted.length; i++) {
      for (let j = i + 1; j < plotted.length; j++) {
        const left = plotted[i]!;
        const right = plotted[j]!;
        if (left.series.kind === "FUT" || right.series.kind === "FUT") continue;
        if (left.series.kind === right.series.kind || left.series.strike !== right.series.strike) continue;
        for (const hit of pairCrosses(left.points, right.points)) {
          if (hit.t < window.t0 || hit.t > window.t1 || hit.y < window.y0 || hit.y > window.y1) continue;
          crosses.push({
            t: hit.t,
            x: xOf(hit.t),
            y: yOf(hit.y),
            a: left.series.name,
            b: right.series.name,
            priceA: money(hit.realA, left.series.kind),
            priceB: money(hit.realB, right.series.kind),
          });
        }
      }
    }
  }
  const close = plotted.length <= 3 || window.t1 - window.t0 <= LABEL_SPAN_MS;
  const marks = close ? crosses : thinMarks(crosses);
  const labels = placeCrossLabels(marks, width, plotT, plotB);
  const ends = placeEndLabels(
    plotted.flatMap((row) => {
      const last = [...row.points].reverse().find((point) => point.t >= window.t0 && point.t <= window.t1);
      if (!last || last.plot < window.y0 || last.plot > window.y1) return [];
      return [{ name: `${row.series.name} ${money(last.real, row.series.kind)}`, color: row.series.color, y: last.y }];
    }),
    plotT + 10,
    plotB - 4,
  );
  const grid = [0, 0.5, 1].map((step) => {
    const price = window.y1 - step * (window.y1 - window.y0);
    return { y: yOf(price), label: `₹${axisPrice(price, window.y1 - window.y0)}` };
  });
  const timesAxis = [
    { x: plotL, label: clock(window.t0), anchor: "start" as const },
    { x: (plotL + plotR) / 2, label: clock((window.t0 + window.t1) / 2), anchor: "middle" as const },
    { x: plotR, label: clock(window.t1), anchor: "end" as const },
  ];

  return {
    plotL,
    plotR,
    plotT,
    plotB,
    domain,
    frame: window,
    grid,
    series: paths,
    crosses: marks,
    labels,
    ends,
    times: times.length ? timesAxis : [],
    futMin: fMin,
    futMax: fMax,
    fullY0,
    fullY1,
    premMin: rawMin,
    premMax: rawMax,
  };
}

function barStamp(leg: LegView): string {
  const last = leg.bars[leg.bars.length - 1];
  return `${leg.contract.securityId}:${leg.bars.length}:${last?.t ?? 0}`;
}

function nudgeLive(
  drawn: ReturnType<typeof layout>,
  future: LegView,
  calls: LegView[],
  puts: LegView[],
): ReturnType<typeof layout> | null {
  const price = new Map<string, number>();
  for (const leg of [future, ...calls, ...puts]) {
    if (leg.ltp > 0) price.set(leg.contract.securityId, leg.ltp);
  }
  const plotH = Math.max(1, drawn.plotB - drawn.plotT);
  const yOf = (plot: number) => drawn.plotT + (1 - (plot - drawn.frame.y0) / (drawn.frame.y1 - drawn.frame.y0 || 1)) * plotH;
  const series = drawn.series.map((row) => {
    const ltp = price.get(row.key);
    if (!(ltp && ltp > 0) || ltp === row.tipReal || !row.paths.length) return row;
    const plot = row.kind === "FUT" ? scaleFuture(ltp, drawn.futMin, drawn.futMax, drawn.fullY0, drawn.fullY1) : ltp;
    const y = Math.min(drawn.plotB, Math.max(drawn.plotT, yOf(plot)));
    const paths = row.paths.slice();
    paths[paths.length - 1] = replaceLast(paths[paths.length - 1]!, row.tipX, y);
    return { ...row, paths, tipReal: ltp };
  });
  const ends = placeEndLabels(
    series.flatMap((row) => {
      const ltp = price.get(row.key) ?? row.tipReal;
      if (!(ltp > 0)) return [];
      const plot = row.kind === "FUT" ? scaleFuture(ltp, drawn.futMin, drawn.futMax, drawn.fullY0, drawn.fullY1) : ltp;
      const y = Math.min(drawn.plotB - 4, Math.max(drawn.plotT + 10, yOf(plot)));
      return [{ name: `${row.name} ${money(ltp, row.kind)}`, color: row.color, y }];
    }),
    drawn.plotT + 10,
    drawn.plotB - 4,
  );
  return { ...drawn, series, ends };
}

function replaceLast(path: string, x: number, y: number): string {
  const cut = path.lastIndexOf(" ");
  const point = `${x.toFixed(1)},${y.toFixed(1)}`;
  return cut < 0 ? point : `${path.slice(0, cut)} ${point}`;
}

function toSeries(leg: LegView, kind: Kind, color: string, width: number, opacity: number): Series {
  const strike = leg.contract.strike;
  const name = kind === "FUT" ? "FUT" : `${formatStrike(strike)} ${kind}`;
  return { key: leg.contract.securityId, kind, strike, name, color, width, opacity, points: samplesOf(leg) };
}

function samplesOf(leg: LegView): Sample[] {
  const map = new Map<number, number>();
  const put = (t: number, price: number) => {
    if (price > 0) map.set(Math.floor(t / 60_000) * 60_000, price);
  };
  for (const bar of leg.bars) put(bar.t, bar.c);
  for (const print of leg.prints) put(print.t, print.c);
  if (leg.ltp > 0) put(Date.now(), leg.ltp);
  const points = despike(
    [...map.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([t, price]) => ({ t, price })),
  );
  if (points.length < 2) return points;
  const end = points[points.length - 1]!.t;
  return points.filter((point) => point.t >= end - WINDOW_MS);
}

function despike(points: Sample[]): Sample[] {
  if (points.length < 3) return points;
  const kept: Sample[] = [points[0]!];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = kept[kept.length - 1]!;
    const cur = points[i]!;
    const next = points[i + 1]!;
    const jump = Math.abs(cur.price - prev.price) / prev.price;
    const back = Math.abs(next.price - prev.price) / prev.price;
    if (jump > 0.4 && back < 0.15) continue;
    kept.push(cur);
  }
  kept.push(points[points.length - 1]!);
  return kept;
}

function wingOpacity(strike: number, atm: number, strikes: number[]): number {
  const at = strikes.indexOf(atm);
  const idx = strikes.indexOf(strike);
  if (at < 0 || idx < 0) return 1;
  return Math.max(0.45, 1 - Math.abs(idx - at) * 0.1);
}

function nearestStrike(calls: LegView[], spot: number): number {
  let best = calls[0]?.contract.strike ?? 0;
  for (const leg of calls) {
    if (Math.abs(leg.contract.strike - spot) < Math.abs(best - spot)) best = leg.contract.strike;
  }
  return best;
}

function scaleFuture(price: number, fMin: number, fMax: number, yMin: number, yMax: number): number {
  if (!(fMax > fMin)) return (yMin + yMax) / 2;
  return yMin + ((price - fMin) / (fMax - fMin)) * (yMax - yMin);
}

function strokePaths(points: PlotPoint[]): string[] {
  const paths: string[] = [];
  let current: string[] = [];
  for (let i = 0; i < points.length; i++) {
    const point = points[i]!;
    const prev = points[i - 1];
    if (prev && point.t - prev.t > GAP_MS) {
      if (current.length > 1) paths.push(current.join(" "));
      current = [];
    }
    current.push(`${point.x.toFixed(1)},${point.y.toFixed(1)}`);
  }
  if (current.length > 1) paths.push(current.join(" "));
  return paths;
}

function pairCrosses(a: PlotPoint[], b: PlotPoint[]): { t: number; y: number; realA: number; realB: number }[] {
  const hits: { t: number; y: number; realA: number; realB: number }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length - 1 && j < b.length - 1) {
    const hit = segmentCross(a[i]!, a[i + 1]!, b[j]!, b[j + 1]!);
    if (hit) hits.push(hit);
    if (a[i + 1]!.t <= b[j + 1]!.t) i += 1;
    else j += 1;
  }
  return hits;
}

function segmentCross(a0: PlotPoint, a1: PlotPoint, b0: PlotPoint, b1: PlotPoint) {
  if (a1.t - a0.t > GAP_MS || b1.t - b0.t > GAP_MS) return null;
  const t0 = Math.max(a0.t, b0.t);
  const t1 = Math.min(a1.t, b1.t);
  if (!(t1 > t0) || t1 - t0 > GAP_MS) return null;
  const ya0 = lerp(a0.t, a0.plot, a1.t, a1.plot, t0);
  const ya1 = lerp(a0.t, a0.plot, a1.t, a1.plot, t1);
  const yb0 = lerp(b0.t, b0.plot, b1.t, b1.plot, t0);
  const yb1 = lerp(b0.t, b0.plot, b1.t, b1.plot, t1);
  const d0 = ya0 - yb0;
  const d1 = ya1 - yb1;
  if (!(d0 * d1 < 0)) return null;
  const u = d0 / (d0 - d1);
  const t = t0 + u * (t1 - t0);
  return {
    t,
    y: ya0 + u * (ya1 - ya0),
    realA: lerp(a0.t, a0.real, a1.t, a1.real, t),
    realB: lerp(b0.t, b0.real, b1.t, b1.real, t),
  };
}

function lerp(t0: number, v0: number, t1: number, v1: number, t: number): number {
  if (t1 === t0) return v0;
  return v0 + ((t - t0) / (t1 - t0)) * (v1 - v0);
}

function thinMarks(crosses: Cross[]): Cross[] {
  const kept: Cross[] = [];
  for (const cross of [...crosses].reverse()) {
    if (kept.some((item) => Math.hypot(item.x - cross.x, item.y - cross.y) < 18)) continue;
    kept.push(cross);
    if (kept.length >= 18) break;
  }
  return kept;
}

function placeCrossLabels(crosses: Cross[], width: number, top: number, bottom: number) {
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  const labels: { x: number; y: number; lines: string[] }[] = [];
  const ordered = [...crosses].sort((a, b) => b.t - a.t);
  for (const cross of ordered) {
    const lines = [clock(cross.t, true), `${cross.a} ${cross.priceA}`, `${cross.b} ${cross.priceB}`];
    const w = Math.max(...lines.map((line) => line.length)) * 5.6 + 4;
    const h = 36;
    let x = cross.x + 8;
    if (x + w > width - 4) x = Math.max(4, cross.x - 8 - w);
    let y = cross.y - 8;
    if (y + h > bottom) y = cross.y - h;
    if (y < top) y = top;
    const box = { x, y: y - 10, w, h };
    if (placed.some((item) => overlaps(item, box))) continue;
    placed.push(box);
    labels.push({ x, y, lines });
  }
  return labels;
}

function placeEndLabels(rows: { name: string; color: string; y: number }[], top: number, bottom: number) {
  const sorted = rows
    .filter((row) => Number.isFinite(row.y))
    .map((row) => ({ ...row, anchor: row.y }))
    .sort((a, b) => a.y - b.y);
  let cursor = top;
  for (const row of sorted) {
    row.y = Math.max(row.y, cursor);
    cursor = row.y + 13;
  }
  const overflow = sorted.length ? sorted[sorted.length - 1]!.y - bottom : 0;
  if (overflow > 0) {
    for (const row of sorted) row.y -= overflow;
  }
  return sorted.map((row) => ({ ...row, y: Math.min(bottom, Math.max(top, row.y)) }));
}

function overlaps(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function formatStrike(strike: number): string {
  return Number.isInteger(strike) ? String(strike) : strike.toFixed(2);
}

function money(value: number, kind: Kind): string {
  if (kind === "FUT") {
    return value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return value.toFixed(2);
}

function axisPrice(value: number, span: number): string {
  return span >= 40 ? value.toFixed(0) : value.toFixed(1);
}

function clock(ts: number, withSeconds = false): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: withSeconds ? "2-digit" : undefined,
    hourCycle: "h23",
  }).format(ts);
}
