import { useEffect } from "react";
import { ALT_SPECS } from "./alt-spec";
import type { AltBook } from "./alt-load";
import { hydrateAltPapers, syncAltPaper, useAltTape, type AltView } from "./alt-tape";
import { useDhanCreds } from "./session";
import { getAltBook, getAltMinutes } from "./server";
import { parseFeed } from "./ticks";
import type { OptContract } from "./nifty";
import { applyTick, EMPTY_SWING, type Bar5 } from "./reversal";
import type { LegView } from "./use-premium-engine";

type Leg = { contract: OptContract; ltp: number; bid: number; ask: number; bars: Bar5[] };
type Band = { strike: number; ce: string; pe: string };
type Live = { book: AltBook; legs: Map<string, Leg>; bandKey: string; rows: Band[] };

let startedFor = "";
let watching = "";

/** The chart on screen. Other books still paper, but they do not redraw this page. */
export function watchAlt(symbol: string) {
  watching = symbol;
}

function viewOf(leg: Leg): LegView {
  return {
    contract: leg.contract,
    ltp: leg.ltp,
    bid: leg.bid,
    ask: leg.ask,
    bars: leg.bars,
    prints: [],
    wave: [],
    swing: EMPTY_SWING,
    ticks: 0,
  };
}

function blank(contract: OptContract, bars: Bar5[]): Leg {
  const last = bars[bars.length - 1];
  return { contract, ltp: last?.c ?? contract.ltp, bid: 0, ask: 0, bars: bars.slice() };
}

export function useAltEngine() {
  const creds = useDhanCreds();

  useEffect(() => {
    if (!creds) return;
    hydrateAltPapers();
    const key = creds.clientId;
    if (startedFor === key) return;
    startedFor = key;
    const lives = new Map<string, Live>();
    const byId = new Map<string, Leg>();
    const filling = new Set<string>();
    let socket: WebSocket | null = null;
    let stopped = false;
    let timer = 0;
    let retry = 0;
    const setNote = useAltTape.getState().setNote;

    const rowsAround = (book: AltBook, px: number): Band[] => {
      const chain = book.chain;
      if (!chain.length || !(px > 0)) return [];
      const idx = chain.reduce((best, row, i) => (Math.abs(row.strike - px) < Math.abs(chain[best]!.strike - px) ? i : best), 0);
      return [chain[idx - 1], chain[idx], chain[idx + 1]].filter((row): row is Band => !!row);
    };

    const ensure = (live: Live, contract: OptContract) => {
      const existing = live.legs.get(contract.securityId);
      if (existing) return existing;
      const leg = blank(contract, []);
      live.legs.set(contract.securityId, leg);
      byId.set(contract.securityId, leg);
      return leg;
    };

    const backfill = (symbol: string, id: string) => {
      const live = lives.get(symbol);
      const leg = live?.legs.get(id);
      if (!live || !leg || leg.bars.length > 1 || filling.has(id)) return;
      filling.add(id);
      void getAltMinutes({ data: { clientId: creds.clientId, accessToken: creds.accessToken, symbol, securityId: id } })
        .then((bars) => {
          const current = lives.get(symbol)?.legs.get(id);
          if (!current || !bars?.length) return;
          const kept = new Map(current.bars.map((bar) => [bar.t, bar]));
          for (const bar of bars) if (!kept.has(bar.t)) kept.set(bar.t, bar);
          current.bars = [...kept.values()].sort((a, b) => a.t - b.t);
          if (!(current.ltp > 0)) current.ltp = current.bars[current.bars.length - 1]?.c ?? 0;
        })
        .catch(() => undefined)
        .finally(() => filling.delete(id));
    };

    const follow = (live: Live, px: number) => {
      const rows = rowsAround(live.book, px);
      const nextKey = rows.map((row) => row.strike).join(",");
      if (!nextKey || nextKey === live.bandKey) return;
      live.bandKey = nextKey;
      live.rows = rows;
      const mid = rows.reduce((best, row) => (Math.abs(row.strike - px) < Math.abs(best.strike - px) ? row : best));
      for (const row of rows) {
        const callWhy = row.strike < mid.strike ? "in the money" : row.strike > mid.strike ? "out of the money" : "at the money";
        const putWhy = row.strike > mid.strike ? "in the money" : row.strike < mid.strike ? "out of the money" : "at the money";
        ensure(live, { securityId: row.ce, strike: row.strike, ltp: 0, type: "CE", why: callWhy });
        ensure(live, { securityId: row.pe, strike: row.strike, ltp: 0, type: "PE", why: putWhy });
        backfill(live.book.symbol, row.ce);
        backfill(live.book.symbol, row.pe);
      }
      sendFeed();
    };

    const sendFeed = () => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      const ids = new Set<string>();
      for (const live of lives.values()) {
        ids.add(live.book.future.securityId);
        for (const row of live.rows) {
          ids.add(row.ce);
          ids.add(row.pe);
        }
        const open = useAltTape.getState().papers[live.book.symbol]?.trades.find((trade) => trade.status === "open");
        if (open) {
          ids.add(open.ceId);
          ids.add(open.peId);
        }
      }
      const list = [...ids].map((id) => ({ ExchangeSegment: "NSE_FNO", SecurityId: id }));
      if (!list.length) return;
      socket.send(JSON.stringify({ RequestCode: 21, InstrumentCount: list.length, InstrumentList: list }));
    };

    let lastPaper = 0;
    const publish = () => {
      const now = Date.now();
      const paperDue = now - lastPaper >= 2000;
      if (paperDue) lastPaper = now;
      const marks: Record<string, number> = {};
      let marksChanged = false;
      for (const live of lives.values()) {
        const fut = live.legs.get(live.book.future.securityId);
        const px = fut?.ltp || live.book.spot;
        follow(live, px);
        const mid = live.rows.reduce((best, row) => (Math.abs(row.strike - px) < Math.abs(best.strike - px) ? row : best), live.rows[0]);
        const ce = mid ? live.legs.get(mid.ce) : undefined;
        const pe = mid ? live.legs.get(mid.pe) : undefined;
        if (paperDue) {
          const open = useAltTape.getState().papers[live.book.symbol]?.trades.find((trade) => trade.status === "open");
          const scanIds = [ce?.contract.securityId, pe?.contract.securityId, open?.ceId, open?.peId].filter((id): id is string => !!id);
          const scan = [...new Set(scanIds)].flatMap((id) => {
            const leg = live.legs.get(id);
            return leg ? [{ contract: leg.contract, ltp: leg.ltp, bars: leg.bars, prints: [] }] : [];
          });
          syncAltPaper(live.book.symbol, scan, live.book.lot, live.book.expiry, px);
          if (open) {
            const mark = live.legs.get(open.buy.securityId)?.ltp;
            if (mark && mark > 0) marks[open.buy.securityId] = mark;
          }
        }
        if (watching !== live.book.symbol) continue;
        const ladder = live.rows.flatMap((row) => {
          const call = live.legs.get(row.ce);
          const put = live.legs.get(row.pe);
          return [call, put].flatMap((leg) => (leg ? [viewOf(leg)] : []));
        });
        const view: AltView = {
          symbol: live.book.symbol,
          name: live.book.name,
          status: "live",
          note: `${live.book.name} · lot ${live.book.lot || "—"} · ${live.book.expiry}`,
          spot: live.book.spot,
          lot: live.book.lot,
          expiry: live.book.expiry,
          future: fut ? viewOf(fut) : null,
          ce: ce ? viewOf(ce) : null,
          pe: pe ? viewOf(pe) : null,
          ladder,
        };
        useAltTape.getState().setView(live.book.symbol, view);
      }
      if (paperDue) {
        const prev = useAltTape.getState().marks;
        for (const [id, px] of Object.entries(marks)) if (prev[id] !== px) marksChanged = true;
        if (marksChanged || Object.keys(prev).length !== Object.keys(marks).length) useAltTape.getState().setMarks(marks);
      }
    };

    const connect = () => {
      if (stopped || !lives.size) return;
      const url = `wss://api-feed.dhan.co?version=2&token=${encodeURIComponent(creds.accessToken)}&clientId=${encodeURIComponent(creds.clientId)}&authType=2`;
      socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      socket.onopen = () => {
        retry = 0;
        sendFeed();
        setNote("Bank Nifty and the five stocks are on their own socket. Nifty is unchanged.");
      };
      socket.onmessage = (event) => {
        if (!(event.data instanceof ArrayBuffer)) return;
        const ticks = parseFeed(event.data);
        const now = Date.now();
        for (const tick of ticks) {
          if (!(tick.ltp > 0)) continue;
          const leg = byId.get(tick.securityId);
          if (!leg) continue;
          leg.ltp = tick.ltp;
          if (tick.bid > 0) leg.bid = tick.bid;
          if (tick.ask > 0) leg.ask = tick.ask;
          leg.bars = applyTick(leg.bars, { ts: now, ltp: tick.ltp, bid: leg.bid, ask: leg.ask });
        }
      };
      socket.onclose = () => {
        if (stopped) return;
        retry += 1;
        if (retry > 6) {
          setNote("The second socket closed. Nifty is still on its own feed.");
          return;
        }
        timer = window.setTimeout(connect, 1500 * retry);
      };
    };

    const arm = (book: AltBook) => {
      const legs = new Map<string, Leg>();
      legs.set(book.future.securityId, blank(book.future, book.history.future));
      for (const contract of book.ladder) {
        const leg = blank(contract, book.history.ladder?.[contract.securityId] ?? []);
        legs.set(contract.securityId, leg);
        byId.set(contract.securityId, leg);
      }
      const futureLeg = legs.get(book.future.securityId);
      if (futureLeg) byId.set(book.future.securityId, futureLeg);
      const px = book.future.ltp || book.spot || book.ce.strike;
      const live: Live = { book, legs, bandKey: "", rows: [] };
      lives.set(book.symbol, live);
      follow(live, px);
      if (!socket) connect();
      else sendFeed();
      publish();
    };

    const run = async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 15000));
      if (stopped || startedFor !== key) return;
      for (const spec of ALT_SPECS) {
        if (stopped) return;
        setNote(`Loading ${spec.name}. Nifty keeps its own feed.`);
        try {
          const book = await getAltBook({ data: { clientId: creds.clientId, accessToken: creds.accessToken, symbol: spec.symbol } });
          if (stopped) return;
          arm(book);
        } catch (error) {
          useAltTape.getState().setView(spec.symbol, {
            symbol: spec.symbol,
            name: spec.name,
            status: "error",
            note: error instanceof Error ? error.message : `${spec.name} did not load.`,
            spot: 0,
            lot: 0,
            expiry: "",
            future: null,
            ce: null,
            pe: null,
            ladder: [],
          });
        }
      }
      if (lives.size) setNote("Bank Nifty and the five stocks are live. Same circle rule. Nifty was not changed.");
    };

    const paint = window.setInterval(publish, 1000);
    void run();
    return () => undefined;
  }, [creds]);
}
