import { create } from "zustand";
import { istDateKey } from "@/lib/market/hours";
import { adoptDay, currentDay, mergeCloses, nextDayFile, rememberLegs, type CloseBar } from "./day-tape";
import { markTrades, reduceAtm, type BookSnap, type WaveLeg } from "./cross-math";
import { loadNiftyMinutes, loadNiftySession, saveNiftySession } from "./session-api";

type Store = BookSnap & {
  session: string;
  reset: () => void;
};

let sessionReady = false;
let saveTimer = 0;

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
    const [remote, tape] = await Promise.all([
      loadNiftySession({ data: { day: today } }),
      loadNiftyMinutes({ data: { day: today } }),
    ]);
    const legs: Record<string, CloseBar[]> = {};
    if (remote && remote.expiry === expiry) {
      for (const [id, rows] of Object.entries(remote.legs as Record<string, CloseBar[]>)) legs[id] = rows;
    }
    for (const [id, rows] of Object.entries(tape.legs)) {
      legs[id] = mergeCloses(rows, legs[id] ?? []);
    }
    if (remote && remote.expiry === expiry) {
      adoptDay({ date: today, expiry, legs });
      const book = remote.book;
      useCrossBook.setState({
        trades: book.trades,
        seen: book.seen,
        total: book.total,
        closedPnl: book.closedPnl,
        session: today,
      });
    } else {
      adoptDay({ date: today, expiry, legs });
      useCrossBook.setState({ trades: [], seen: [], total: 0, closedPnl: 0, session: today });
    }
  } catch {
    adoptDay(nextDayFile(null, today, expiry));
    useCrossBook.setState({ trades: [], seen: [], total: 0, closedPnl: 0, session: today });
  }
  sessionReady = true;
}

let lastScan = 0;

/** The open premium follows the socket, even while today's tape is still loading. */
export function touchOpenMarks(priceOf: (id: string) => number | undefined) {
  const state = useCrossBook.getState();
  const marked = markTrades(state.trades, priceOf);
  if (marked === state.trades) return;
  useCrossBook.setState({ trades: marked });
}

/** One-minute ATM book. A new session day starts empty. Yesterday is not replayed. */
export function syncCrossBook(legs: WaveLeg[], lot: number, expiry: string, anchor: number) {
  if (!(lot > 0) || !expiry || !sessionReady) return;
  const now = Date.now();
  if (now - lastScan < 1000) return;
  lastScan = now;
  const today = istDateKey();
  let state = useCrossBook.getState();
  if (state.session !== today) {
    useCrossBook.setState({ trades: [], seen: [], total: 0, closedPnl: 0, session: today });
    adoptDay(nextDayFile(null, today, expiry));
    state = useCrossBook.getState();
  }
  const legsChanged = rememberLegs(
    expiry,
    legs.map((leg) => ({ id: leg.contract.securityId, bars: leg.bars.map((bar) => ({ t: bar.t, c: bar.c })) })),
  );
  const priceOf = (id: string) => legs.find((leg) => leg.contract.securityId === id)?.ltp;
  const marked = markTrades(state.trades, priceOf);
  const base = marked === state.trades ? state : { ...state, trades: marked };
  const next = reduceAtm(base, legs, lot, expiry, anchor, now);
  if (next !== state) {
    useCrossBook.setState({
      trades: next.trades,
      seen: next.seen,
      total: next.total,
      closedPnl: next.closedPnl,
      session: today,
    });
  }
  if (legsChanged || next !== state) scheduleSave(expiry);
}

function scheduleSave(expiry: string) {
  if (typeof window === "undefined" || saveTimer) return;
  saveTimer = window.setTimeout(() => {
    saveTimer = 0;
    const day = currentDay();
    const state = useCrossBook.getState();
    if (day.date !== istDateKey() || day.expiry !== expiry) return;
    void saveNiftySession({
      data: {
        day: day.date,
        expiry,
        legs: day.legs,
        book: { trades: state.trades, seen: state.seen, total: state.total, closedPnl: state.closedPnl },
      },
    }).catch(() => {});
  }, 5000);
}
