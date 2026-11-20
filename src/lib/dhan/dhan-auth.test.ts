import assert from "node:assert/strict";
import test from "node:test";
import { mintAccessToken, type DhanEnv } from "./dhan-auth.server.ts";

function tokenWithExpiry(expiresAt: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(expiresAt / 1000) })).toString("base64url");
  return `header.${payload}.signature`;
}

test("shares one generated token across concurrent and later callers", async () => {
  const env: DhanEnv = {
    clientId: "100000001",
    apiKey: "test-api-key",
    apiSecret: "test-api-secret",
    pin: "1234",
    totpSecret: "JBSWY3DPEHPK3PXP",
  };
  const token = tokenWithExpiry(Date.now() + 60 * 60 * 1000);
  const originalFetch = globalThis.fetch;
  let requests = 0;
  let requested = "";
  globalThis.fetch = async (input) => {
    requests += 1;
    requested = String(input);
    await new Promise((resolve) => setTimeout(resolve, 10));
    return new Response(JSON.stringify({ accessToken: token }), { status: 200 });
  };

  try {
    const [first, second] = await Promise.all([mintAccessToken(env), mintAccessToken(env)]);
    const later = await mintAccessToken(env);

    assert.equal(first, token);
    assert.equal(second, token);
    assert.equal(later, token);
    assert.equal(requests, 1);
    assert.match(requested, /[?&]totp=\d{6}(?:&|$)/);
    assert.doesNotMatch(requested, /app_secret|apiKey/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
