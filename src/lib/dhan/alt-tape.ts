import { create } from "zustand";
import { istDateKey } from "@/lib/market/hours";
import { markTrades, reduceAtm, type BookSnap, type WaveLeg } from "./cross-math";
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

const KEY = "artha:alt-papers:v1";

function readPapers(): Record<string, BookRow> {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, BookRow>;
    const today = istDateKey();
    const kept: Record<string, BookRow> = {};
    for (const [symbol, row] of Object.entries(parsed)) {
      if (row?.session === today) kept[symbol] = row;
    }
    return kept;
  } catch {
    return {};
  }
}

function writePapers(papers: Record<string, BookRow>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(papers));
  } catch {
    /* this browser blocked the copy */
  }
}

export const useAltTape = create<Store>()((set) => ({
  note: "Bank Nifty and the five stocks wait until the Nifty feed has started.",
  views: {},
  marks: {},
  papers: {},
  setNote: (note) => set({ note }),
  setView: (symbol, view) => set((state) => ({ views: { ...state.views, [symbol]: view } })),
  setMarks: (marks) => set({ marks }),
}));

let papersReady = false;

export function hydrateAltPapers() {
  if (papersReady || typeof window === "undefined") return;
  papersReady = true;
  useAltTape.setState({ papers: readPapers() });
}

export function syncAltPaper(symbol: string, legs: WaveLeg[], lot: number, expiry: string, anchor: number) {
  if (!(lot > 0) || !expiry) return;
  hydrateAltPapers();
  const today = istDateKey();
  const state = useAltTape.getState();
  const prev = state.papers[symbol];
  const base: BookRow =
    prev && prev.session === today && prev.expiry === expiry
      ? prev
      : { trades: [], seen: [], total: 0, closedPnl: 0, session: today, expiry };
  const priceOf = (id: string) => legs.find((leg) => leg.contract.securityId === id)?.ltp;
  const marked = markTrades(base.trades, priceOf);
  const input = marked === base.trades ? base : { ...base, trades: marked };
  const next = reduceAtm(input, legs, lot, expiry, anchor);
  if (next === input && input === base) return;
  const row: BookRow = { ...next, session: today, expiry };
  const papers = { ...useAltTape.getState().papers, [symbol]: row };
  useAltTape.setState({ papers });
  writePapers(papers);
}
