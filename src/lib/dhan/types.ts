import type { Check } from "./algo";

export type DhanCreds = { clientId: string; accessToken: string };

export type Funds = {
  available: number;
  used: number;
  withdrawable: number;
  collateral: number;
  sod: number;
};

export type Holding = {
  symbol: string;
  securityId: string;
  qty: number;
  avg: number;
};

export type LivePosition = {
  symbol: string;
  securityId: string;
  segment: string;
  product: string;
  side: string;
  netQty: number;
  buyAvg: number;
  sellAvg: number;
  realized: number;
  unrealized: number;
};

export type BoardSignal = {
  id: string;
  symbol: string;
  name: string;
  securityId: string;
  segment: "NSE_EQ" | "IDX_I" | "NSE_FNO";
  kind: "stock" | "option";
  side: "BUY" | "SELL";
  entry: number;
  target: number;
  score: number;
  ltp: number;
  checks: Check[];
  mode: "live" | "review";
  sessionDate: string;
  squareOff: string;
  qty: number;
  note: string;
  option?: {
    underlying: string;
    strike: number;
    type: "CE" | "PE";
    expiry: string;
    iv: number | null;
    delta: number | null;
    oiChange: number | null;
  };
};

export type TapePoint = {
  symbol: string;
  name: string;
  securityId: string;
  ltp: number;
  prev: number;
  changePct: number;
};

export type LiveTape = { asOfLabel: string; tape: TapePoint[] };

export type QuietName = { symbol: string; name: string; reason: string };

export type EngineRead = {
  scanned: number;
  livePrints: number;
  reviews: number;
  quiet: number;
  phase: string;
};

export type SignalBoard = {
  asOfLabel: string;
  sessionNote: string;
  tape: TapePoint[];
  signals: BoardSignal[];
  quiet: QuietName[];
  engine: EngineRead;
  warnings: string[];
};

export type DeskBook = {
  asOfLabel: string;
  funds: Funds | null;
  holdings: Holding[];
  positions: LivePosition[];
  warnings: string[];
};
