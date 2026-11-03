export type AltSpec = {
  symbol: string;
  name: string;
  underlyingId: string;
  segment: "IDX_I" | "NSE_EQ";
  fut: RegExp;
  optionInstrument: "OPTIDX" | "OPTSTK";
  futureInstrument: "FUTIDX" | "FUTSTK";
};

/** Same three-strike window as Nifty. Bank first, then the five liquid names. */
export const ALT_SPECS: AltSpec[] = [
  { symbol: "BANKNIFTY", name: "Bank Nifty", underlyingId: "25", segment: "IDX_I", fut: /^BANKNIFTY-[A-Za-z]{3}\d{4}-FUT$/, optionInstrument: "OPTIDX", futureInstrument: "FUTIDX" },
  { symbol: "RELIANCE", name: "Reliance", underlyingId: "2885", segment: "NSE_EQ", fut: /^RELIANCE-[A-Za-z]{3}\d{4}-FUT$/, optionInstrument: "OPTSTK", futureInstrument: "FUTSTK" },
  { symbol: "HDFCBANK", name: "HDFC Bank", underlyingId: "1333", segment: "NSE_EQ", fut: /^HDFCBANK-[A-Za-z]{3}\d{4}-FUT$/, optionInstrument: "OPTSTK", futureInstrument: "FUTSTK" },
  { symbol: "ICICIBANK", name: "ICICI Bank", underlyingId: "4963", segment: "NSE_EQ", fut: /^ICICIBANK-[A-Za-z]{3}\d{4}-FUT$/, optionInstrument: "OPTSTK", futureInstrument: "FUTSTK" },
  { symbol: "SBIN", name: "SBI", underlyingId: "3045", segment: "NSE_EQ", fut: /^SBIN-[A-Za-z]{3}\d{4}-FUT$/, optionInstrument: "OPTSTK", futureInstrument: "FUTSTK" },
  { symbol: "TCS", name: "TCS", underlyingId: "11536", segment: "NSE_EQ", fut: /^TCS-[A-Za-z]{3}\d{4}-FUT$/, optionInstrument: "OPTSTK", futureInstrument: "FUTSTK" },
];

export function altSpec(symbol: string): AltSpec | null {
  return ALT_SPECS.find((spec) => spec.symbol === symbol) ?? null;
}
