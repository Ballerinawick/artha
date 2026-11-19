import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { create } from "zustand";
import { useJournal, type PremiumTrade } from "./journal";
import { useR2 } from "./r2-session";
import { saveTape } from "./tape-db";
import { archiveTicks, getDeskState, getNiftyBook, getOptionMinutes } from "./server";
import { useDhanCreds, useDhanSession } from "./session";
import { parseFeed, type FeedTick } from "./ticks";
import type { NiftyBook, OptContract } from "./nifty";
import { applyServerAlt } from "./alt-tape";
import { applyServerBook, openSession, setServerOwns, syncCrossBook, touchOpenMarks, useCrossBook, useDeskMirror } from "./cross-book";
import { barsFor, inCashSession, olderBars, prepareDay } from "./day-tape";
import { saveNiftyTicks } from "./session-api";
import { istDateKey } from "@/lib/market/hours";
import {
  applyTick,
  completedBars,
  EMPTY_SWING,
  entryPrice,
  exitPrice,
  minPremiumMove,
  sideAllowed,
  stepSwing,
  targetHit,
  type Bar5,
  type SwingSnap,
} from "./reversal";

export type PrintCandle = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  bid: number;
  ask: number;
  atp: number;
};

export type LegView = {
  contract: OptContract;
  ltp: number;
  bid: number;
  ask: number;
  bars: Bar5[];
  prints: PrintCandle[];
  wave: number[];
  swing: SwingSnap;
  ticks: number;
};

export type EngineView = {
  status: "idle" | "chain" | "connecting" | "live" | "quiet" | "error";
  note: string;
  spot: number;
  book: NiftyBook | null;
  ce: LegView | null;
  pe: LegView | null;
  future: LegView | null;
  ladder: LegView[];
  archive: string;
  retry: () => void;
};

const CHAIN_KEY = "artha:nifty-book:v8";
const NIFTY_ID = "13";

function readCachedBook(): NiftyBook | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = localStorage.getItem(CHAIN_KEY);
    if (!raw) return undefined;
    const book = JSON.parse(raw) as NiftyBook;
    if (!book?.future?.securityId || !book.chain?.length || (book.ladder?.length ?? 0) < 4) return undefined;
    return book;
  } catch {
    return undefined;
  }
}

function rememberBook(book: NiftyBook) {
  try {
    localStorage.setItem(CHAIN_KEY, JSON.stringify(book));
  } catch {
    /* the phone can refuse a full tape; the socket still runs */
  }
}

type Tape = {
  status: EngineView["status"];
  note: string;
  spot: number;
  ce: LegView | null;
  pe: LegView | null;
  future: LegView | null;
  ladder: LegView[];
  archive: string;
};

const useTape = create<Tape>(() => ({
  status: "idle",
  note: "Waiting for the Dhan login.",
  spot: 0,
  ce: null,
  pe: null,
  future: null,
  ladder: [],
  archive: "Tape saves on this browser every minute.",
}));

let tapeKey = "";
let stopTape: (() => void) | null = null;

type LegRuntime = {
  contract: OptContract;
  ltp: number;
  bid: number;
  ask: number;
  bars: Bar5[];
  prints: PrintCandle[];
  wave: number[];
  closed: number;
  swing: SwingSnap;
  ticks: number;
};

function blankLeg(contract: OptContract): LegRuntime {
  return { contract, ltp: contract.ltp, bid: 0, ask: 0, bars: [], prints: [], wave: [], closed: 0, swing: EMPTY_SWING, ticks: 0 };
}

export function usePremiumEngine(): EngineView {
  const creds = useDhanCreds();
  const tape = useTape();
  const openTrade = useJournal((s) => s.open);
  const markTrade = useJournal((s) => s.mark);
  const closeTrade = useJournal((s) => s.close);
  const legs = useRef<Map<string, LegRuntime>>(new Map());
  const spotRef = useRef(0);

  useEffect(() => {
    let stop = false;
    const pull = async () => {
      try {
        const desk = await getDeskState({ data: {} });
        if (stop) return;
        setServerOwns(desk.owns);
        useDeskMirror.setState({ phase: desk.phase, note: desk.note, live: desk.live, orders: desk.orders });
        if (desk.owns) {
          applyServerBook(desk.book);
          applyServerAlt("BANKNIFTY", desk.bank, desk.bankExpiry);
        }
      } catch {
        if (!stop) setServerOwns(false);
      }
    };
    void pull();
    const id = window.setInterval(pull, 1000);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, []);

  const bookQuery = useQuery({
    queryKey: ["nifty-book", creds?.clientId],
    enabled: !!creds,
    queryFn: async () => {
      const book = await getNiftyBook({ data: creds! });
      rememberBook(book);
      return book;
    },
    initialData: readCachedBook,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
    retryDelay: 6000,
  });

  useEffect(() => {
    const patch = useTape.setState;
    if (!creds) {
      stopTape?.();
      stopTape = null;
      tapeKey = "";
      patch({ status: "idle", note: "Connect to Dhan to open the Nifty feed." });
      return;
    }
    if (bookQuery.isLoading) {
      patch({ status: "chain", note: "Reading the Nifty option chain once, so the socket knows which contracts to follow." });
      return;
    }
    if (bookQuery.isError) {
      const message = bookQuery.error instanceof Error ? bookQuery.error.message : "Option chain failed.";
      if (/refused this client id/i.test(message)) useDhanSession.getState().clearToken();
      patch({ status: "error", note: message });
      return;
    }
    const book = bookQuery.data;
    if (!book) return;
    if (!book.ladder) {
      void bookQuery.refetch();
      return;
    }
    const key = `${creds.clientId}:${book.future.securityId}:${book.ce.securityId}:${book.pe.securityId}:${book.ladder.map((leg) => leg.securityId).join(".")}`;
    if (tapeKey === key) return;
    stopTape?.();
    tapeKey = key;
    patch({ spot: book.spot });
    spotRef.current = book.spot;
    prepareDay(book.expiry);
    const ceLeg = blankLeg(book.ce);
    const peLeg = blankLeg(book.pe);
    const futLeg = blankLeg(book.future);
    prime(ceLeg, withSaved(book.ce.securityId, book.history.ce));
    prime(peLeg, withSaved(book.pe.securityId, book.history.pe));
    prime(futLeg, withSaved(book.future.securityId, book.history.future));
    legs.current = new Map([[book.future.securityId, futLeg]]);
    for (const contract of book.ladder) {
      const leg = contract.securityId === book.ce.securityId ? ceLeg : contract.securityId === book.pe.securityId ? peLeg : blankLeg(contract);
      prime(leg, withSaved(contract.securityId, book.history.ladder?.[contract.securityId] ?? []));
      legs.current.set(contract.securityId, leg);
    }
    const watch = { ce: book.ce, pe: book.pe };
    const chain = book.chain ?? [];
    type BandRow = { strike: number; ce: string; pe: string };
    const band: { key: string; rows: BandRow[] } = { key: "", rows: [] };
    const rowsAround = (futurePx: number): BandRow[] => {
      if (!chain.length) return [];
      const idx = chain.reduce((best, row, i) => (Math.abs(row.strike - futurePx) < Math.abs(chain[best]!.strike - futurePx) ? i : best), 0);
      return [chain[idx - 1], chain[idx], chain[idx + 1]].filter((row): row is BandRow => !!row);
    };
    band.rows = rowsAround(book.future.ltp || book.spot || book.ce.strike);
    band.key = band.rows.map((row) => row.strike).join(",");
    const ensure = (contract: OptContract) => {
      const existing = legs.current.get(contract.securityId);
      if (existing) return existing;
      const leg = blankLeg(contract);
      prime(leg, withSaved(contract.securityId, []));
      legs.current.set(contract.securityId, leg);
      return leg;
    };
    const filling = new Set<string>();
    const backfill = (id: string) => {
      const leg = legs.current.get(id);
      if (!leg || leg.bars.length > 1 || filling.has(id)) return;
      filling.add(id);
      void getOptionMinutes({ data: { clientId: creds.clientId, accessToken: creds.accessToken, securityId: id } })
        .then((bars) => {
          const current = legs.current.get(id);
          if (!current || !bars?.length) return;
          const kept = new Map(current.bars.map((bar) => [bar.t, bar]));
          for (const bar of bars) if (!kept.has(bar.t)) kept.set(bar.t, bar);
          prime(current, [...kept.values()].sort((a, b) => a.t - b.t));
          publish();
        })
        .catch(() => undefined)
        .finally(() => filling.delete(id));
    };
    const follow = (futurePx: number) => {
      if (!(futurePx > 0) || !chain.length) return;
      const rows = rowsAround(futurePx);
      const key = rows.map((row) => row.strike).join(",");
      if (key === band.key) return;
      band.key = key;
      band.rows = rows;
      const mid = rows.reduce((best, row) => (Math.abs(row.strike - futurePx) < Math.abs(best.strike - futurePx) ? row : best));
      watch.ce = { securityId: mid.ce, strike: mid.strike, ltp: 0, type: "CE", why: "at the money" };
      watch.pe = { securityId: mid.pe, strike: mid.strike, ltp: 0, type: "PE", why: "at the money" };
      for (const row of rows) {
        const callWhy = row.strike < mid.strike ? "in the money" : row.strike > mid.strike ? "out of the money" : "at the money";
        const putWhy = row.strike > mid.strike ? "in the money" : row.strike < mid.strike ? "out of the money" : "at the money";
        ensure({ securityId: row.ce, strike: row.strike, ltp: 0, type: "CE", why: callWhy });
        ensure({ securityId: row.pe, strike: row.strike, ltp: 0, type: "PE", why: putWhy });
        backfill(row.ce);
        backfill(row.pe);
      }
      sendFeed();
    };
    patch({
      ce: viewOf(ceLeg),
      pe: viewOf(peLeg),
      future: viewOf(futLeg),
      ladder: book.ladder.flatMap((contract) => {
        const leg = legs.current.get(contract.securityId);
        return leg ? [viewOf(leg)] : [];
      }),
    });
    for (const trade of useJournal.getState().trades) {
      if (trade.status !== "open") continue;
      if (trade.securityId === book.ce.securityId || trade.securityId === book.pe.securityId) continue;
      closeTrade(trade.id, trade.entry, "Old contract. The desk is watching a different strike.");
    }

    const url = `wss://api-feed.dhan.co?version=2&token=${encodeURIComponent(creds.accessToken)}&clientId=${encodeURIComponent(creds.clientId)}&authType=2`;
    let socket: WebSocket | null = null;
    const sendFeed = () => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      const open = useCrossBook.getState().trades.find((trade) => trade.status === "open");
      const ids = [book.future.securityId, ...band.rows.flatMap((row) => [row.ce, row.pe])];
      if (open) {
        if (!ids.includes(open.ceId)) ids.push(open.ceId);
        if (!ids.includes(open.peId)) ids.push(open.peId);
      }
      const list = [
        { ExchangeSegment: "IDX_I", SecurityId: NIFTY_ID },
        ...ids.map((id) => ({ ExchangeSegment: "NSE_FNO", SecurityId: id })),
      ];
      socket.send(JSON.stringify({ RequestCode: 21, InstrumentCount: list.length, InstrumentList: list }));
    };
    let stopped = false;
    let retry = 0;
    let timer = 0;
    const rows: string[] = ["kind,ts,securityId,ltp,bid,ask,atp,volume,oi"];
    const flush = window.setInterval(() => {
      const keys = useR2.getState();
      if (rows.length < 2) return;
      const now = new Date();
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
      const hm = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now).replace(":", "-");
      const body = rows.join("\n");
      rows.length = 1;
      const name = `${day}/${hm}`;
      void saveTape(name, body)
        .then(() => patch({ archive: `Tape saved on this browser · ${name}` }))
        .catch(() => patch({ archive: "This browser blocked the saved tape." }));
      if (!keys.accessKeyId || !keys.secretAccessKey) return;
      void archiveTicks({ data: { accessKeyId: keys.accessKeyId, secretAccessKey: keys.secretAccessKey, key: `ticks/${day}/${hm}.csv`, body } })
        .then(() => patch({ archive: `Tape saved on this browser and in R2 · ${name}` }))
        .catch((error: unknown) => {
          rows.push(...body.split("\n").slice(1));
          patch({ archive: error instanceof Error ? error.message : "R2 save failed. The browser copy is kept." });
        });
    }, 60_000);
    const pending: { t: number; securityId: string; kind: "FUT" | "CE" | "PE"; strike: number; ltp: number }[] = [];
    const sendTicks = () => {
      if (!pending.length) return;
      const rows = pending.splice(0, 800);
      void saveNiftyTicks({ data: { day: istDateKey(), rows } }).catch(() => {
        pending.unshift(...rows);
        if (pending.length > 4000) pending.splice(0, pending.length - 4000);
      });
    };
    const tickSave = window.setInterval(sendTicks, 2000);
    stopTape = () => {
      stopped = true;
      window.clearTimeout(timer);
      window.clearInterval(flush);
      window.clearInterval(tickSave);
      sendTicks();
      socket?.close();
    };

    let paintQueued = false;
    let lastPaint = 0;
    const publish = () => {
      if (paintQueued) return;
      paintQueued = true;
      const wait = Math.max(0, 200 - (Date.now() - lastPaint));
      window.setTimeout(() => {
        window.requestAnimationFrame(() => {
          paintQueued = false;
          if (stopped) return;
          lastPaint = Date.now();
        const nextFut = legs.current.get(book.future.securityId);
        follow(nextFut?.ltp || spotRef.current);
        const ceLegNow = legs.current.get(watch.ce.securityId);
        const peLegNow = legs.current.get(watch.pe.securityId);
        if (ceLegNow) patch({ ce: viewOf(ceLegNow) });
        if (peLegNow) patch({ pe: viewOf(peLegNow) });
        if (nextFut) patch({ future: viewOf(nextFut) });
        const chart = band.rows.flatMap((row) => {
          const call = legs.current.get(row.ce);
          const put = legs.current.get(row.pe);
          return [call, put].flatMap((leg) => (leg ? [viewOf(leg)] : []));
        });
        patch({ spot: spotRef.current, ladder: chart.length ? chart : [ceLegNow, peLegNow].flatMap((leg) => (leg ? [viewOf(leg)] : [])) });
        const priceOf = (id: string) => legs.current.get(id)?.ltp;
        touchOpenMarks(priceOf);
        const open = useCrossBook.getState().trades.find((trade) => trade.status === "open");
        const scanIds = [watch.ce.securityId, watch.pe.securityId, open?.ceId, open?.peId].filter((id): id is string => !!id);
        const scan = [...new Set(scanIds)].flatMap((id) => {
          const leg = legs.current.get(id);
          return leg ? [viewOf(leg)] : [];
        });
        syncCrossBook(scan, book.lot, book.expiry, nextFut?.ltp || spotRef.current);
        });
      }, wait);
    };
    void openSession(book.expiry).then(() => {
      if (stopped || tapeKey !== key) return;
      for (const [id, leg] of legs.current) {
        const merged = withSaved(id, leg.bars);
        if (!merged.length) continue;
        leg.bars = merged;
      }
      const held = useCrossBook.getState().trades.find((trade) => trade.status === "open");
      if (held) {
        ensure({ securityId: held.ceId, strike: held.buy.strike, ltp: 0, type: "CE", why: "open" });
        ensure({ securityId: held.peId, strike: held.buy.strike, ltp: 0, type: "PE", why: "open" });
        sendFeed();
      }
      publish();
    });

    const connect = () => {
      if (stopped) return;
      patch({ status: "connecting", note: "Opening the Dhan tick socket." });
      socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      socket.onopen = () => {
        retry = 0;
        patch({
          status: "live",
          note: `Front-month future ${book.future.why}. ATM, one in the money, one out. Paper buys the ATM pair only.`,
        });
        sendFeed();
      };
      socket.onmessage = (event) => {
        if (!(event.data instanceof ArrayBuffer)) return;
        const ticks = parseFeed(event.data);
        if (!ticks.length) return;
        for (const tick of ticks) absorb(tick, book);
        publish();
      };
      socket.onerror = () => {
        patch({ status: "error", note: "The tick socket failed. The chain is still loaded, but there is no live premium." });
      };
      socket.onclose = () => {
        if (stopped) return;
        patch({ status: "quiet" });
        retry += 1;
        if (retry > 5) {
          patch({ note: "Dhan closed the tick socket. Refresh this screen to try again." });
          return;
        }
        patch({ note: "Tick socket dropped. Reconnecting." });
        timer = window.setTimeout(connect, 1500 * retry);
      };
    };

    function absorb(tick: FeedTick, liveBook: NiftyBook) {
      if (!(tick.ltp > 0)) return;
      if (tick.securityId === NIFTY_ID) {
        spotRef.current = tick.ltp;
        return;
      }
      const leg = legs.current.get(tick.securityId);
      if (!leg) return;
      const futureLeg = legs.current.get(liveBook.future.securityId);
      const option = leg.contract.type === "CE" || leg.contract.type === "PE";
      leg.ticks += 1;
      leg.ltp = tick.ltp;
      leg.wave.push(tick.ltp);
      if (leg.wave.length > 480) leg.wave.shift();
      const kind = tick.securityId === liveBook.future.securityId ? "fut" : leg.contract.type === "CE" ? "ce" : "pe";
      rows.push([kind, Date.now(), tick.securityId, tick.ltp, tick.bid || 0, tick.ask || 0, tick.atp || 0, tick.volume || 0, tick.oi || 0].join(","));
      if (rows.length > 8000) rows.splice(1, rows.length - 4000);
      if (tick.bid > 0) leg.bid = tick.bid;
      if (tick.ask > 0) leg.ask = tick.ask;
      const now = Date.now();
      if (inCashSession(now)) {
        pending.push({
          t: now,
          securityId: tick.securityId,
          kind: kind === "fut" ? "FUT" : kind === "ce" ? "CE" : "PE",
          strike: leg.contract.strike,
          ltp: tick.ltp,
        });
        if (pending.length > 4000) pending.splice(0, pending.length - 4000);
      }
      pushPrint(leg.prints, now, tick.ltp, leg.bid, leg.ask, tick.atp);
      const nextBars = applyTick(leg.bars, { ts: now, ltp: tick.ltp, bid: leg.bid, ask: leg.ask });
      leg.bars = nextBars;
      const tradable =
        tick.securityId === liveBook.future.securityId ||
        tick.securityId === liveBook.ce.securityId ||
        tick.securityId === liveBook.pe.securityId;
      if (!tradable) return;
      const closed = completedBars(nextBars, now);
      const open = option
        ? useJournal.getState().trades.find((row) => row.securityId === leg.contract.securityId && row.status === "open")
        : undefined;
      if (open && open.target == null) {
        closeTrade(open.id, leg.bid > 0 ? leg.bid : leg.ltp, "Closed a leftover one-second paper so the next one can be held.");
      } else if (open?.target && targetHit(leg.bid || leg.ltp, open.target) && now - open.entryTs >= 60_000) {
        closeTrade(open.id, leg.bid > 0 ? leg.bid : leg.ltp, "Bid reached the target. That covers the ₹40 and the spread.");
      }
      if (closed.length > leg.closed) {
        leg.closed = closed.length;
        const last = closed[closed.length - 1];
        const live = option
          ? useJournal.getState().trades.find((row) => row.securityId === leg.contract.securityId && row.status === "open")
          : undefined;
        const minMove = last ? minPremiumMove(entryPrice(last), exitPrice(last), liveBook.lot) : 1;
        const swing = stepSwing(leg.swing, closed, now, minMove, !!live, live ? now - live.entryTs : 0);
        leg.swing = swing;
        const bias = futureLeg?.swing.bias ?? "flat";
        if (live && last && now - live.entryTs >= 5 * 60_000 && ((live.type === "CE" && bias === "down") || (live.type === "PE" && bias === "up"))) {
          closeTrade(
            live.id,
            exitPrice(last),
            live.type === "CE" ? "Future turned down, so the call is closed." : "Future turned up, so the put is closed.",
          );
        } else if (last && swing.action === "enter" && swing.target && swing.breakLevel && (leg.contract.type === "CE" || leg.contract.type === "PE")) {
          if (!sideAllowed(leg.contract.type, bias)) {
            leg.swing = {
              ...swing,
              action: null,
              reason:
                leg.contract.type === "CE"
                  ? "Call swing is there, but the future is not rising."
                  : "Put swing is there, but the future is not falling.",
            };
          } else {
            openTrade({
              id: `${leg.contract.type}-${last.t}`,
              type: leg.contract.type,
              strike: leg.contract.strike,
              expiry: liveBook.expiry,
              securityId: leg.contract.securityId,
              entryTs: now,
              entry: entryPrice(last),
              mfe: 0,
              mae: 0,
              lot: liveBook.lot,
              target: swing.target,
              status: "open",
              reason: swing.reason,
            });
          }
        } else if (last && swing.action === "exit" && live) {
          closeTrade(live.id, exitPrice(last), swing.reason);
        }
      }
      if (open) markTrade(open.id, tick.ltp);
    }

    connect();
    return () => undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creds?.clientId, creds?.accessToken, bookQuery.data, bookQuery.isLoading, bookQuery.isError, closeTrade, markTrade, openTrade]);

  return {
    status: tape.status,
    note: tape.note,
    spot: tape.spot || bookQuery.data?.spot || 0,
    book: bookQuery.data ?? null,
    ce: tape.ce,
    pe: tape.pe,
    future: tape.future,
    ladder: tape.ladder,
    archive: tape.archive,
    retry: () => {
      void bookQuery.refetch();
    },
  };
}

function pushPrint(prints: PrintCandle[], now: number, ltp: number, bid: number, ask: number, atp: number) {
  const bucket = Math.floor(now / 5_000) * 5_000;
  const last = prints[prints.length - 1];
  if (!last || last.t !== bucket) {
    prints.push({ t: bucket, o: ltp, h: ltp, l: ltp, c: ltp, bid, ask, atp });
    if (prints.length > 360) prints.shift();
    return;
  }
  last.h = Math.max(last.h, ltp);
  last.l = Math.min(last.l, ltp);
  last.c = ltp;
  if (bid > 0) last.bid = bid;
  if (ask > 0) last.ask = ask;
  if (atp > 0) last.atp = atp;
}

function withSaved(id: string, bars: Bar5[]): Bar5[] {
  const map = new Map<number, Bar5>();
  for (const bar of bars) {
    if (bar.c > 0 && inCashSession(bar.t)) map.set(bar.t, bar);
  }
  for (const row of barsFor(id)) {
    if (map.has(row.t) || !(row.c > 0) || !inCashSession(row.t)) continue;
    map.set(row.t, { t: row.t, o: row.c, h: row.c, l: row.c, c: row.c, bid: 0, ask: 0 });
  }
  for (const row of olderBars(id)) {
    if (map.has(row.t) || !(row.c > 0) || !inCashSession(row.t)) continue;
    map.set(row.t, { t: row.t, o: row.c, h: row.c, l: row.c, c: row.c, bid: 0, ask: 0 });
  }
  return [...map.values()].sort((a, b) => a.t - b.t);
}

function prime(leg: LegRuntime, bars: Bar5[]) {
  if (!bars.length) return;
  const now = Date.now();
  const last = bars[bars.length - 1];
  if (last) leg.ltp = last.c;
  leg.wave = bars.slice(-180).map((bar) => bar.c);
  leg.prints = bars.slice(-160).map((bar) => ({
    t: bar.t,
    o: bar.o,
    h: bar.h,
    l: bar.l,
    c: bar.c,
    bid: bar.bid,
    ask: bar.ask,
    atp: 0,
  }));
  leg.bars = bars;
  const closed = completedBars(bars, now);
  leg.closed = closed.length;
  if (closed.length >= 21) {
    leg.swing = { ...stepSwing(EMPTY_SWING, closed, now, 1, false, 0), action: null };
    return;
  }
  leg.swing = { ...EMPTY_SWING, reason: `Loaded ${closed.length}/21 minutes from today.` };
}

function viewOf(leg: LegRuntime): LegView {
  return {
    contract: leg.contract,
    ltp: leg.ltp,
    bid: leg.bid,
    ask: leg.ask,
    bars: leg.bars,
    prints: leg.prints,
    wave: leg.wave,
    swing: leg.swing,
    ticks: leg.ticks,
  };
}

export function openPremium(trades: PremiumTrade[], securityId: string): PremiumTrade | undefined {
  return trades.find((trade) => trade.securityId === securityId && trade.status === "open");
}
