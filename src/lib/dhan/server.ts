import { createServerFn } from "@tanstack/react-start";
import { buildDesk, buildSignalBoard, fetchTape } from "./board";
import { dhan } from "./client";
import { mintAccessToken, readDhanEnv } from "./dhan-auth.server";
import { loadAltBook, loadAltMinutes } from "./alt-load";
import { loadNiftyBook, loadOptionMinutes } from "./nifty";
import { putR2 } from "./r2";
import type { DhanCreds } from "./types";

function creds(input: { clientId?: string; accessToken?: string }): DhanCreds {
  const clientId = String(input.clientId ?? "").trim();
  const accessToken = String(input.accessToken ?? "").trim();
  if (!/^\d{4,16}$/.test(clientId)) throw new Error("Client id should be the numeric Dhan id.");
  if (accessToken.length < 20) throw new Error("Access token looks too short.");
  return { clientId, accessToken };
}

export const getDeskState = createServerFn({ method: "POST" })
  .validator(() => ({}))
  .handler(async () => {
    const { startDesk, deskSnapshot } = await import("./watcher.server");
    startDesk();
    return deskSnapshot();
  });

export const connectDhan = createServerFn({ method: "POST" })
  .validator(() => ({}))
  .handler(async () => {
    const env = readDhanEnv();
    if (!env) {
      throw new Error(
        "Dhan API-key login is not configured. Set DHAN_CLIENT_ID, DHAN_API_KEY, DHAN_API_SECRET, DHAN_PIN, and DHAN_TOTP_SECRET on the server.",
      );
    }
    const accessToken = await mintAccessToken(env);
    await dhan({ clientId: env.clientId, accessToken }, "/fundlimit");
    return { ok: true as const, clientId: env.clientId, accessToken };
  });

export const archiveTicks = createServerFn({ method: "POST" })
  .validator((input: { accessKeyId?: string; secretAccessKey?: string; key?: string; body?: string }) => {
    const accessKeyId = String(input.accessKeyId ?? "").trim();
    const secretAccessKey = String(input.secretAccessKey ?? "").trim();
    const key = String(input.key ?? "");
    const body = String(input.body ?? "");
    if (accessKeyId.length < 8 || secretAccessKey.length < 8) throw new Error("R2 token is missing.");
    if (!/^ticks\/\d{4}-\d{2}-\d{2}\/\d{2}-\d{2}\.csv$/.test(key)) throw new Error("Tape name is not valid.");
    if (body.length < 5 || body.length > 1_500_000) throw new Error("Tape batch is empty or too large.");
    return { accessKeyId, secretAccessKey, key, body };
  })
  .handler(async ({ data }) => {
    await putR2(data.accessKeyId, data.secretAccessKey, data.key, data.body);
    return { ok: true as const };
  });

export const getNiftyBook = createServerFn({ method: "POST" })
  .validator((input: { clientId: string; accessToken: string }) => creds(input))
  .handler(async ({ data }) => loadNiftyBook(data));

export const getOptionMinutes = createServerFn({ method: "POST" })
  .validator((input: { clientId: string; accessToken: string; securityId?: string }) => {
    const c = creds(input);
    const securityId = String(input.securityId ?? "");
    if (!/^\d+$/.test(securityId)) throw new Error("Contract id is not valid.");
    return { ...c, securityId };
  })
  .handler(async ({ data }) => loadOptionMinutes(data, data.securityId));

export const getAltBook = createServerFn({ method: "POST" })
  .validator((input: { clientId: string; accessToken: string; symbol?: string }) => {
    const c = creds(input);
    const symbol = String(input.symbol ?? "").toUpperCase();
    if (!/^[A-Z]{3,12}$/.test(symbol)) throw new Error("Symbol is not valid.");
    return { ...c, symbol };
  })
  .handler(async ({ data }) => loadAltBook(data, data.symbol));

export const getAltMinutes = createServerFn({ method: "POST" })
  .validator((input: { clientId: string; accessToken: string; symbol?: string; securityId?: string }) => {
    const c = creds(input);
    const symbol = String(input.symbol ?? "").toUpperCase();
    const securityId = String(input.securityId ?? "");
    if (!/^[A-Z]{3,12}$/.test(symbol) || !/^\d+$/.test(securityId)) throw new Error("Contract is not valid.");
    return { ...c, symbol, securityId };
  })
  .handler(async ({ data }) => loadAltMinutes(data, data.symbol, data.securityId));

export const getLiveTape = createServerFn({ method: "POST" })
  .validator((input: { clientId: string; accessToken: string; fnoIds?: string[] }) => {
    const c = creds(input);
    const fnoIds = Array.isArray(input.fnoIds)
      ? input.fnoIds.map(String).filter((id) => /^\d+$/.test(id)).slice(0, 40)
      : [];
    return { ...c, fnoIds };
  })
  .handler(async ({ data }) => fetchTape(data, data.fnoIds));

export const getSignalBoard = createServerFn({ method: "POST" })
  .validator((input: { clientId: string; accessToken: string; symbols?: string[] }) => {
    const c = creds(input);
    const symbols = Array.isArray(input.symbols)
      ? [...new Set(input.symbols.map((s) => String(s).toUpperCase()))].slice(0, 6)
      : [];
    if (!symbols.length) throw new Error("Nothing to scan.");
    return { ...c, symbols };
  })
  .handler(async ({ data }) => buildSignalBoard(data, data.symbols));

export const getDeskBook = createServerFn({ method: "POST" })
  .validator((input: { clientId: string; accessToken: string }) => creds(input))
  .handler(async ({ data }) => buildDesk(data));

export const placeDhanOrder = createServerFn({ method: "POST" })
  .validator(
    (input: {
      clientId: string;
      accessToken: string;
      securityId: string;
      segment: "NSE_EQ" | "NSE_FNO";
      side: "BUY" | "SELL";
      qty: number;
      symbol: string;
    }) => {
      const c = creds(input);
      const qty = Math.floor(Number(input.qty));
      if (!input.securityId || qty < 1 || qty > 100000) throw new Error("Quantity is not valid.");
      if (input.segment !== "NSE_EQ" && input.segment !== "NSE_FNO") throw new Error("Segment is not valid.");
      if (input.side !== "BUY" && input.side !== "SELL") throw new Error("Side is not valid.");
      if (input.segment === "NSE_FNO" && !/^\d+$/.test(String(input.securityId))) {
        throw new Error("This option contract has no Dhan security id yet, so it stays on paper.");
      }
      return { ...c, securityId: String(input.securityId), segment: input.segment, side: input.side, qty, symbol: String(input.symbol) };
    },
  )
  .handler(async () => {
    throw new Error("This phone cannot send an order. Lightsail sends the market order when the paper opens or closes.");
  });
