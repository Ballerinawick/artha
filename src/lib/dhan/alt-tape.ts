import { create } from "zustand";
import { istDateKey } from "@/lib/market/hours";
import type { BookSnap, WaveLeg } from "./cross-math";
import type { LegView } from "./use-premium-engine";

export type AltView = {
  symbol: string;
  name: string;
  status: "wait" | "live" | "error";
  note: string;
  spot: number;
  lot: number;
  expiry: string;
  future: LegView | null;
  ce: LegView | null;
  pe: LegView | null;
  ladder: LegView[];
};

type BookRow = BookSnap & { session: string; expiry: string };

type Store = {
  note: string;
  views: Record<string, AltView>;
  marks: Record<string, number>;
  papers: Record<string, BookRow>;
  setNote: (note: string) => void;
  setView: (symbol: string, view: AltView) => void;
  setMarks: (marks: Record<string, number>) => void;
};

export const useAltTape = create<Store>()((set) => ({
  note: "Bank Nifty and the five stocks wait until the Nifty feed has started.",
  views: {},
  marks: {},
  papers: {},
  setNote: (note) => set({ note }),
  setView: (symbol, view) => set((state) => ({ views: { ...state.views, [symbol]: view } })),
  setMarks: (marks) => set({ marks }),
}));

export function hydrateAltPapers() {
  return;
}

export function applyServerAlt(symbol: string, book: BookSnap, expiry: string) {
  const row: BookRow = {
    trades: book.trades,
    seen: book.seen,
    total: book.total,
    closedPnl: book.closedPnl,
    session: istDateKey(),
    expiry,
  };
  useAltTape.setState((state) => ({ papers: { ...state.papers, [symbol]: row } }));
}

/** The phone does not paper Bank Nifty. The server book is applied with applyServerAlt. */
export function syncAltPaper(_symbol: string, _legs: WaveLeg[], _lot: number, _expiry: string, _anchor: number) {
  return;
}
