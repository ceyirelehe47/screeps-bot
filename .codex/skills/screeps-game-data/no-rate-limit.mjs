#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

const action = process.argv[2];
if (action !== "--status" && action !== "--redirect") {
  console.error("Usage: node no-rate-limit.mjs --status|--redirect");
  process.exit(2);
}

const secret = JSON.parse(await readFile(".secret.json", "utf8"));
const token = process.env.SCREEPS_TOKEN || secret.main?.token;
if (!token) throw new Error("Missing SCREEPS_TOKEN and .secret.json main.token");

if (action === "--status") {
  const queryUrl = new URL("https://screeps.com/api/auth/query-token");
  queryUrl.searchParams.set("token", token);
  const [query, probe] = await Promise.all([
    fetch(queryUrl, { signal: AbortSignal.timeout(15_000) }),
    fetch("https://screeps.com/api/user/name", {
      headers: { "X-Token": token },
      signal: AbortSignal.timeout(15_000),
    }),
  ]);
  const response = await query.json();
  const until = response?.token?.noRatelimitUntil;
  console.log(JSON.stringify({
    queryStatus: query.status,
    probeStatus: probe.status,
    noRatelimitUntil: Number.isSafeInteger(until) ? until : null,
    noRatelimitActive: Number.isSafeInteger(until) && until > Date.now(),
    rateLimitHeadersPresent: ["x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"]
      .some((name) => probe.headers.has(name)),
  }, null, 2));
} else {
  const nonce = randomBytes(16).toString("hex");
  const destination = new URL("https://screeps.com/a/#!/account/auth-tokens/noratelimit");
  destination.hash += `?token=${encodeURIComponent(token)}`;
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== `/${nonce}`) {
      response.writeHead(404, { "Cache-Control": "no-store" });
      response.end();
      return;
    }
    response.writeHead(302, {
      Location: destination.toString(),
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    });
    response.end();
    server.close();
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No redirect listener address");
    console.log(`http://127.0.0.1:${address.port}/${nonce}`);
  });
  setTimeout(() => server.close(), 60_000).unref();
}
