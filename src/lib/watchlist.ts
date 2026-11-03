import { create } from "zustand";
import { persist } from "zustand/middleware";

type WatchlistState = {
  symbols: string[];
  toggle: (symbol: string) => void;
  has: (symbol: string) => boolean;
};

export const useWatchlist = create<WatchlistState>()(
  persist(
    (set, get) => ({
      symbols: [],
      has: (symbol) => get().symbols.includes(symbol),
      toggle: (symbol) =>
        set((state) => ({
          symbols: state.symbols.includes(symbol)
            ? state.symbols.filter((s) => s !== symbol)
            : [symbol, ...state.symbols].slice(0, 24),
        })),
    }),
    { name: "artha-watchlist" },
  ),
);
