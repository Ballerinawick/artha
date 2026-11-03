const BASE = "https://api.dhan.co/v2";

export class DhanError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function cleanMessage(status: number, body: string): string {
  try {
    const json = JSON.parse(body) as { errorMessage?: string; message?: string; remarks?: string };
    const msg = json.errorMessage || json.message || json.remarks;
    if (msg && !/token|jwt|bearer/i.test(msg)) return msg;
  } catch {
    /* plain text */
  }
  if (status === 401 || status === 403) return "Dhan refused this client id or access token.";
  if (status === 429) return "Dhan is limiting requests. The chain will be tried again in a few seconds.";
  return `Dhan returned ${status}.`;
}

export async function dhan<T>(
  creds: { clientId: string; accessToken: string },
  path: string,
  init?: { method?: "GET" | "POST"; body?: unknown; retry429?: boolean },
): Promise<T> {
  const attempts = init?.retry429 ? 2 : 1;
  let last: DhanError | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 3500));
    const res = await fetch(`${BASE}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "access-token": creds.accessToken,
        "client-id": creds.clientId,
      },
      body: init?.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(14000),
    });
    const text = await res.text();
    if (res.status === 429 && attempt < attempts - 1) {
      last = new DhanError(429, cleanMessage(429, text));
      continue;
    }
    if (!res.ok) throw new DhanError(res.status, cleanMessage(res.status, text));
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  }
  throw last ?? new DhanError(429, "Dhan is limiting requests. The chain will be tried again in a few seconds.");
}
