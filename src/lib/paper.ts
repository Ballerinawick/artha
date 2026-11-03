import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { BoardSignal } from "./dhan/types";

export type PaperTrade = {
  id: string;
  symbol: string;
  name: string;
  kind: "stock" | "option";
  side: "BUY" | "SELL";
  securityId: string;
  segment: "NSE_EQ" | "IDX_I" | "NSE_FNO";
  qty: number;
  entry: number;
  target: number;
  mark: number;
  status: "open" | "target" | "squared" | "sent";
  mode: "live" | "review";
  openedAt: number;
  orderId?: string;
  note: string;
};

type PaperState = {
  trades: PaperTrade[];
  ensure: (signal: BoardSignal) => void;
  mark: (id: string, price: number) => void;
  setQty: (id: string, qty: number) => void;
  square: (id: string) => void;
  sent: (id: string, orderId: string) => void;
};

function hitTarget(side: "BUY" | "SELL", mark: number, target: number) {
  return side === "BUY" ? mark >= target : mark <= target;
}

export function paperPnl(t: PaperTrade): number {
  const diff = t.side === "BUY" ? t.mark - t.entry : t.entry - t.mark;
  return diff * t.qty;
}

export const usePaper = create<PaperState>()(
  persist(
    (set, get) => ({
      trades: [],
      ensure: (signal) => {
        if (signal.mode !== "live") return;
        if (get().trades.some((t) => t.id === signal.id)) return;
        const trade: PaperTrade = {
          id: signal.id,
          symbol: signal.symbol,
          name: signal.name,
          kind: signal.kind,
          side: signal.side,
          securityId: signal.securityId,
          segment: signal.segment,
          qty: signal.qty,
          entry: signal.entry,
          target: signal.target,
          mark: signal.entry,
          status: "open",
          mode: signal.mode,
          openedAt: Date.now(),
          note: signal.note,
        };
        set({ trades: [trade, ...get().trades].slice(0, 40) });
      },
      mark: (id, price) => {
        const trades = get().trades;
        let changed = false;
        const next = trades.map((t) => {
          if (t.id !== id || t.status === "sent" || t.status === "squared") return t;
          const status: PaperTrade["status"] = hitTarget(t.side, price, t.target) || t.status === "target" ? "target" : "open";
          if (t.mark === price && t.status === status) return t;
          changed = true;
          return { ...t, mark: price, status };
        });
        if (changed) set({ trades: next });
      },
      setQty: (id, qty) =>
        set({
          trades: get().trades.map((t) => (t.id === id && t.status === "open" ? { ...t, qty } : t)),
        }),
      square: (id) =>
        set({
          trades: get().trades.map((t) => (t.id === id && t.status !== "sent" ? { ...t, status: "squared" } : t)),
        }),
      sent: (id, orderId) =>
        set({
          trades: get().trades.map((t) => (t.id === id ? { ...t, status: "sent", orderId } : t)),
        }),
    }),
    { name: "artha-paper" },
  ),
);
