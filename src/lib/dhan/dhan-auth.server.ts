import { createHmac } from "node:crypto";

export type DhanEnv = {
  clientId: string;
  apiKey: string;
  apiSecret: string;
  pin: string;
  totpSecret: string;
};

/** Present only when the machine has its own Dhan login. Nothing here is read from the page. */
export function readDhanEnv(): DhanEnv | null {
  const clientId = process.env.DHAN_CLIENT_ID?.trim() ?? "";
  const apiKey = process.env.DHAN_API_KEY?.trim() ?? "";
  const apiSecret = process.env.DHAN_API_SECRET?.trim() ?? "";
  const pin = process.env.DHAN_PIN?.trim() ?? "";
  const totpSecret = process.env.DHAN_TOTP_SECRET?.trim().replace(/\s/g, "") ?? "";
  if (!/^\d{4,16}$/.test(clientId) || apiKey.length < 4 || apiSecret.length < 8 || pin.length < 4 || totpSecret.length < 8) {
    return null;
  }
  return { clientId, apiKey, apiSecret, pin, totpSecret };
}

export function totpCode(secret: string, now = Date.now()): string {
  const key = base32(secret);
  const counter = Math.floor(now / 30_000);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const bin = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(bin % 1_000_000).padStart(6, "0");
}

export async function mintAccessToken(env: DhanEnv): Promise<string> {
  const url = `https://auth.dhan.co/app/generateAccessToken?dhanClientId=${encodeURIComponent(env.clientId)}&pin=${encodeURIComponent(env.pin)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      app_id: env.apiKey,
      app_secret: env.apiSecret,
      totp: totpCode(env.totpSecret),
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Dhan login failed (${response.status}).`);
  let token = "";
  try {
    const body = JSON.parse(text) as { accessToken?: string; access_token?: string };
    token = String(body.accessToken ?? body.access_token ?? "");
  } catch {
    token = "";
  }
  if (token.length < 20) throw new Error("Dhan login did not return a token.");
  return token;
}

function base32(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.toUpperCase().replace(/=+$/g, "");
  let bits = "";
  for (const char of clean) {
    const value = alphabet.indexOf(char);
    if (value < 0) continue;
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
