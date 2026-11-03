import { createServerFn } from "@tanstack/react-start";
import { buildMarketBoard, buildStockDetail } from "./yahoo";
import { UNIVERSE_BY_SYMBOL } from "./universe";

export const getMarketBoard = createServerFn({ method: "GET" }).handler(async () => {
  return buildMarketBoard();
});

export const getStockDetail = createServerFn({ method: "GET" })
  .validator((input: { symbol: string }) => {
    const symbol = String(input?.symbol ?? "").toUpperCase();
    if (!UNIVERSE_BY_SYMBOL.has(symbol)) throw new Error("Unknown symbol");
    return { symbol };
  })
  .handler(async ({ data }) => {
    return buildStockDetail(data.symbol);
  });
