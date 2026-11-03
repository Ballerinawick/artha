import { createServerFn } from "@tanstack/react-start";
import { cachePeek, cacheSet } from "@/lib/market/cache";
import { istDateKey } from "@/lib/market/hours";
import type { Horizon, MarketBoard, StockDetail } from "@/lib/market/types";
import { UNIVERSE_BY_SYMBOL } from "@/lib/market/universe";
import { buildMarketBoard, buildStockDetail } from "@/lib/market/yahoo";

const hits: number[] = [];

function allowAi(): boolean {
  const now = Date.now();
  while (hits.length && now - hits[0]! > 10 * 60 * 1000) hits.shift();
  if (hits.length >= 12) return false;
  hits.push(now);
  return true;
}

async function grok(messages: { role: "system" | "user"; content: string }[], maxTokens: number) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return { ok: false as const, error: "AI is not available in this environment" };
  if (!allowAi()) return { ok: false as const, error: "Too many AI requests. Try again in a few minutes." };

  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "grok-4.5",
      temperature: 0.3,
      max_tokens: maxTokens,
      messages,
    }),
  });
  if (!res.ok) return { ok: false as const, error: `Advisor error ${res.status}` };
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return { ok: true as const, text: body.choices?.[0]?.message?.content?.trim() ?? "" };
}

function pickLines(board: MarketBoard, horizon: Horizon) {
  return board.picks[horizon]
    .slice(0, 5)
    .map((p) => {
      const q = board.quotes.find((x) => x.symbol === p.symbol);
      if (!q) return `${p.symbol} score ${p.score}`;
      return `${q.symbol} ${q.name} ₹${q.price.toFixed(2)} ${q.changePct.toFixed(2)}% score ${p.score} ${p.action} :: ${p.reasons.join("; ")}`;
    })
    .join("\n");
}

export const askAdvisor = createServerFn({ method: "POST" })
  .validator((input: { kind: "briefing" | "stock"; symbol?: string; horizon?: Horizon }) => {
    if (input.kind !== "briefing" && input.kind !== "stock") throw new Error("Invalid request");
    if (input.kind === "stock") {
      const symbol = String(input.symbol ?? "").toUpperCase();
      if (!UNIVERSE_BY_SYMBOL.has(symbol)) throw new Error("Unknown symbol");
      const horizon = (input.horizon ?? "short") as Horizon;
      return { kind: "stock" as const, symbol, horizon };
    }
    return { kind: "briefing" as const };
  })
  .handler(async ({ data }) => {
    const day = istDateKey();
    if (data.kind === "briefing") {
      const key = `ai:brief:${day}`;
      const cached = cachePeek<{ ok: true; text: string }>(key);
      if (cached) return cached;
      const board = await buildMarketBoard();
      const result = await grok(
        [
          {
            role: "system",
            content:
              "You are Artha, a cautious Indian equity desk for NSE/BSE. You are not SEBI-registered. Use only the snapshot. Be specific with prices in INR. Short sections. No markdown tables. No emoji. End with one risk line.",
          },
          {
            role: "user",
            content: `IST stamp: ${board.asOfLabel}
Session: ${board.sessionLabel}
Indices: ${board.indices.map((i) => `${i.name} ${i.price.toFixed(2)} (${i.changePct.toFixed(2)}%)`).join(" | ")}
Breadth: ${board.breadth.up} up / ${board.breadth.down} down / ${board.breadth.flat} unchanged

INTRADAY
${pickLines(board, "intraday")}

SHORT TERM
${pickLines(board, "short")}

LONG TERM
${pickLines(board, "long")}

BONUS & DIVIDEND
${pickLines(board, "dividend")}

Write today's briefing: Market tape, Intraday, Short term, Long term, Income/bonus, then one thing to avoid. 420 words max.`,
          },
        ],
        700,
      );
      if (result.ok) cacheSet(key, 18 * 60 * 60 * 1000, result);
      return result;
    }

    const key = `ai:stock:${day}:${data.symbol}:${data.horizon}`;
    const cached = cachePeek<{ ok: true; text: string }>(key);
    if (cached) return cached;
    const detail: StockDetail = await buildStockDetail(data.symbol);
    const q = detail.quote;
    const pick = detail.scores[data.horizon];
    const result = await grok(
      [
        {
          role: "system",
          content:
            "You are Artha, a cautious NSE advisor. Not SEBI-registered. Use only the data. Three tight bullets plus one risk. INR. No emoji. No generic pep talk.",
        },
        {
          role: "user",
          content: `Horizon: ${data.horizon}
${q.symbol} ${q.name} (${q.sector})
Price ₹${q.price.toFixed(2)}  change ${q.changePct.toFixed(2)}%
Range today ₹${q.dayLow.toFixed(2)}–₹${q.dayHigh.toFixed(2)}
52w ₹${q.week52Low.toFixed(2)}–₹${q.week52High.toFixed(2)}
RSI ${q.rsi?.toFixed(1) ?? "n/a"}  SMA20 ${q.sma20?.toFixed(2) ?? "n/a"}  SMA50 ${q.sma50?.toFixed(2) ?? "n/a"}  SMA200 ${q.sma200?.toFixed(2) ?? "n/a"}
5d ${q.mom5?.toFixed(1) ?? "n/a"}%  1m ${q.mom21?.toFixed(1) ?? "n/a"}%  rel volume ${q.relVolume?.toFixed(2) ?? "n/a"}
Yield ${q.dividendYield != null ? (q.dividendYield * 100).toFixed(2) + "%" : "n/a"}
Model score ${pick.score} ${pick.action}
Reasons: ${pick.reasons.join("; ")}
Risk note: ${pick.risk}

Write a ${data.horizon} view for this name.`,
        },
      ],
      380,
    );
    if (result.ok) cacheSet(key, 18 * 60 * 60 * 1000, result);
    return result;
  });
