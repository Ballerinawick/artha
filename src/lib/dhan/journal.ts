import { create } from "zustand";
import { persist } from "zustand/middleware";
import { BROKERAGE, STT_RATE } from "./reversal";

export type PremiumTrade = {
  id: string;
  type: "CE" | "PE";
  strike: number;
  expiry: string;
  securityId: string;
  entryTs: number;
  exitTs?: number;
  entry: number;
  exit?: number;
  mfe: number;
  mae: number;
  lot: number;
  target?: number;
  status: "open" | "closed";
  reason: string;
};

type JournalState = {
  trades: PremiumTrade[];
  open: (trade: PremiumTrade) => void;
  mark: (id: string, ltp: number) => void;
  close: (id: string, exit: number, reason: string) => void;
};

export function tradePnl(trade: PremiumTrade): number {
  if (trade.exit == null) return 0;
  return markedPnl(trade.entry, trade.exit, trade.lot);
}

/** What the open paper would keep if it were sold at this price. */
export function livePnl(trade: PremiumTrade, mark: number): number {
  if (!(mark > 0)) return 0;
  return markedPnl(trade.entry, mark, trade.lot);
}

function markedPnl(entry: number, exit: number, lot: number): number {
  const gross = (exit - entry) * lot;
  const stt = exit * lot * STT_RATE;
  return gross - BROKERAGE - stt;
}

export function holdLabel(trade: PremiumTrade, now = Date.now()): string {
  const ms = (trade.exitTs ?? now) - trade.entryTs;
  const min = Math.round(ms / 60_000);
  if (min < 1) return "<1m";
  if (min < 60) return `${min}m`;
  const hours = Math.floor(min / 60);
  return `${hours}h ${min % 60}m`;
}

export const useJournal = create<JournalState>()(
  persist(
    (set, get) => ({
      trades: [],
      open: (trade) => {
        if (get().trades.some((row) => row.securityId === trade.securityId && row.status === "open")) return;
        set({ trades: [trade, ...get().trades].slice(0, 80) });
      },
      mark: (id, ltp) => {
        let changed = false;
        const trades = get().trades.map((trade) => {
          if (trade.id !== id || trade.status !== "open") return trade;
          const move = ltp - trade.entry;
          const mfe = Math.max(trade.mfe, move);
          const mae = Math.min(trade.mae, move);
          if (mfe === trade.mfe && mae === trade.mae) return trade;
          changed = true;
          return { ...trade, mfe, mae };
        });
        if (changed) set({ trades });
      },
      close: (id, exit, reason) =>
        set({
          trades: get().trades.map((trade) =>
            trade.id === id && trade.status === "open"
              ? { ...trade, status: "closed", exit, exitTs: Date.now(), reason }
              : trade,
          ),
        }),
    }),
    { name: "artha-premium-journal" },
  ),
);
