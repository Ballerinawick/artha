import { create } from "zustand";
import { istDateKey } from "@/lib/market/hours";
import { adoptDay, mergeCloses, nextDayFile, setOlder, type CloseBar } from "./day-tape";
import { markTrades, type BookSnap, type WaveLeg } from "./cross-math";
import { loadKeptMinutes, loadNiftyMinutes, loadNiftySession } from "./session-api";

type Store = BookSnap & {
  session: string;
  reset: () => void;
};

export const useDeskMirror = create<{
  phase: string;
  note: string;
  live: boolean;
  orders: Record<string, { buyOrderId?: string; sellOrderId?: string; error?: string }>;
}>()(() => ({
  phase: "sleep",
  note: "",
  live: false,
  orders: {},
}));

let serverOwns = false;

export function setServerOwns(on: boolean) {
  serverOwns = on;
}

export function applyServerBook(book: BookSnap) {
  useCrossBook.setState({
    trades: book.trades,
    seen: book.seen,
    total: book.total,
    closedPnl: book.closedPnl,
    session: istDateKey(),
  });
}

export const useCrossBook = create<Store>()((set) => ({
  trades: [],
  seen: [],
  total: 0,
  closedPnl: 0,
  session: "",
  reset: () => set({ trades: [], seen: [], total: 0, closedPnl: 0, session: istDateKey() }),
}));

/** Read today's tape from the deployed database. A failure still lets the app open. */
export async function openSession(expiry: string) {
  const today = istDateKey();
  try {
    const [remote, tape, kept] = await Promise.all([
      loadNiftySession({ data: { day: today } }),
      loadNiftyMinutes({ data: { day: today } }),
      loadKeptMinutes({ data: {} }),
    ]);
    const legs: Record<string, CloseBar[]> = {};
    if (remote && remote.expiry === expiry) {
      for (const [id, rows] of Object.entries(remote.legs as Record<string, CloseBar[]>)) legs[id] = rows;
    }
    for (const [id, rows] of Object.entries(tape.legs)) {
      legs[id] = mergeCloses(rows, legs[id] ?? []);
    }
    const prior: Record<string, CloseBar[]> = {};
    for (const [id, rows] of Object.entries(kept.legs)) {
      const old = rows.filter((row) => !legs[id]?.some((live) => live.t === row.t));
      if (old.length) prior[id] = old;
    }
    setOlder(prior);
    adoptDay({ date: today, expiry, legs });
    if (!serverOwns) {
      if (remote && remote.expiry === expiry) {
        const book = remote.book;
        useCrossBook.setState({
          trades: book.trades,
          seen: book.seen,
          total: book.total,
          closedPnl: book.closedPnl,
          session: today,
        });
      } else {
        useCrossBook.setState({ trades: [], seen: [], total: 0, closedPnl: 0, session: today });
      }
    }
  } catch {
    adoptDay(nextDayFile(null, today, expiry));
    useCrossBook.setState({ trades: [], seen: [], total: 0, closedPnl: 0, session: today });
  }
}

/** The open premium follows the socket, even while today's tape is still loading. */
export function touchOpenMarks(priceOf: (id: string) => number | undefined) {
  if (serverOwns) return;
  const state = useCrossBook.getState();
  const marked = markTrades(state.trades, priceOf);
  if (marked === state.trades) return;
  useCrossBook.setState({ trades: marked });
}

/** The phone is a mirror. It never opens or closes a paper. */
export function syncCrossBook(_legs: WaveLeg[], _lot: number, _expiry: string, _anchor: number) {
  return;
}
