// A rate-limited endpoint (issues #58, #44): wait as long as it asks, keep the
// failure count honest, and hold every room on the profile back, not just this one.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { retryAfterMs, isRateLimited } from "../src/models.js";
import { createApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { tmpDataDir } from "./helpers.js";

test("retryAfterMs reads Retry-After, the reset buckets, and the body; isRateLimited is 429 only", () => {
  const h = (o) => new Headers(o);
  assert.equal(retryAfterMs(h({ "retry-after": "2" })), 2000, "bare seconds");
  assert.equal(retryAfterMs(h({ "retry-after": "0" })), 0);
  const soon = retryAfterMs(h({ "retry-after": new Date(Date.now() + 5000).toUTCString() }));
  assert.ok(soon > 3000 && soon <= 5000, `an HTTP date, not a duration: ${soon}`);
  assert.equal(retryAfterMs(h({ "x-ratelimit-reset-tokens": "217ms" })), 217);
  assert.equal(retryAfterMs(h({ "x-ratelimit-reset-tokens": "2.5s" })), 2500);
  assert.equal(retryAfterMs(h({ "x-ratelimit-reset-requests": "1m30s" })), 90_000);
  assert.equal(retryAfterMs(h({ "x-ratelimit-reset-tokens": "217ms", "x-ratelimit-reset-requests": "8s" })), 8000, "the exhausted bucket is the longest one");
  assert.equal(retryAfterMs(h({ "retry-after": "1", "x-ratelimit-reset-requests": "8s" })), 1000, "Retry-After wins");
  assert.equal(retryAfterMs(h({}), "Quota exceeded ... Please retry in 4.066337932s."), 4066, "Gemini says it in the body");
  assert.equal(retryAfterMs(h({}), ""), null);
  assert.equal(retryAfterMs(h({ "retry-after": "soon" })), null);
  assert.equal(retryAfterMs(undefined), null);

  assert.ok(isRateLimited({ status: 429 }));
  assert.ok(!isRateLimited({ status: 503 }), "a 503 is availability, not rate");
  assert.ok(!isRateLimited({ status: 500 }));
  assert.ok(!isRateLimited(new Error("no answer within 5000 ms")));
});

/** A room server with one model profile pointed at a controllable endpoint. */
async function withServer(profileExtra, body) {
  const calls = [];
  let answer = { status: 200 };
  const endpoint = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    calls.push({ at: Date.now(), body: JSON.parse(raw) });
    if (answer.status === 429) {
      res.writeHead(429, { "content-type": "application/json", ...(answer.headers || {}) });
      return res.end(JSON.stringify({ error: { message: "rate limit reached for tokens per minute" } }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Noted." } }] }));
  });
  await new Promise((r) => endpoint.listen(0, "127.0.0.1", r));
  const dataDir = tmpDataDir();
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({
    limits: { rooms_open_per_creator: 100, messages_per_minute: 1000 },
    profiles: { throttled: { base_url: `http://127.0.0.1:${endpoint.address().port}/v1`, model: "fake-r", display_name: "Throttled", min_gap_ms: 0, timeout_ms: 5000, ...profileExtra } },
  }));
  const config = loadConfig({ dataDir, port: 0 }, { USER: "tester" });
  const app = createApp(config);
  const { token } = app.auth.createToken("test");
  await app.start();
  const api = async (method, p, payload) => {
    const res = await fetch(config.publicOrigin + p, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: payload ? JSON.stringify(payload) : undefined });
    return { status: res.status, data: await res.json() };
  };
  const health = async () => (await api("GET", "/api/health")).data;
  const waitFor = async (pred, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await pred()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  };
  const openRoom = async (title) => {
    const code = (await api("POST", "/api/rooms", { title, objective: "Decide something" })).data.room.code;
    await api("POST", `/api/rooms/${code}/invite`, { kind: "model", profile: "throttled" });
    return code;
  };
  try {
    await body({ api, health, waitFor, openRoom, calls, setAnswer: (a) => { answer = a; }, modelStatus: async (room) => (await health()).models.find((m) => m.room === room) });
  } finally {
    await app.stop();
    await new Promise((r) => endpoint.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test("a 429 that clears is waited out, not counted as a failure", async () => {
  await withServer({}, async ({ api, health, waitFor, openRoom, calls, setAnswer, modelStatus }) => {
    const code = await openRoom("Throttle me");
    setAnswer({ status: 429, headers: { "retry-after": "1" } });
    await api("POST", `/api/rooms/${code}/messages`, { content: "your turn, Throttled" });

    assert.ok(await waitFor(() => calls.length >= 1), "it called once");
    await waitFor(() => calls.length >= 2, 500); // the retry is a second away, not now
    assert.equal(calls.length, 1, "no immediate retry against a per-minute limit");
    setAnswer({ status: 200 });

    assert.ok(await waitFor(async () => (await api("GET", `/api/rooms/${code}`)).data.room.messages.some((m) => m.sender === "Throttled")), "it replied after the wait");
    assert.ok(calls[1].at - calls[0].at >= 900, `waited the second it was asked for: ${calls[1].at - calls[0].at} ms`);

    const st = await modelStatus(code);
    assert.equal(st.failures, 0, "a 429 that clears is not a failure");
    assert.equal(st.paused_until, null, "and never a ten-minute pause");
    const p = (await health()).profiles.throttled;
    assert.equal(p.rate_limited, 1);
    assert.equal(p.failures, 0);
    assert.equal(p.calls, 2, "the refused call still counts as a call");
  });
});

test("a 429 that persists costs one failure for the burst, and holds every room on the profile", async () => {
  // Waits of 700 ms then 1400 ms, leaving a 2800 ms cooldown: long enough that the
  // other room's debounce fires while it is still in force.
  await withServer({ rate_limit_backoff_ms: 700 }, async ({ api, health, waitFor, openRoom, calls, setAnswer, modelStatus }) => {
    const first = await openRoom("Room one");
    const second = await openRoom("Room two");
    setAnswer({ status: 429 }); // no hint: the ladder applies

    await api("POST", `/api/rooms/${first}/messages`, { content: "your turn, Throttled" });
    assert.ok(await waitFor(async () => (await modelStatus(first)).failures >= 1, 12_000), "the burst ended in one failure");
    const afterBurst = calls.length;
    assert.equal(afterBurst, 3, `three attempts in one reply, not ${afterBurst}`);
    assert.ok(calls[1].at - calls[0].at >= 650, `first wait ~700 ms: ${calls[1].at - calls[0].at}`);
    assert.ok(calls[2].at - calls[1].at >= 1300, `then double: ${calls[2].at - calls[1].at}`);

    const one = await modelStatus(first);
    assert.equal(one.failures, 1, "three 429s in a row are one failure");
    assert.equal(one.paused_until, null, "not the unavailable pause");
    assert.ok(one.rate_limited_until, "it knows when to come back");

    // The quota belongs to the provider: the other room must not spend it either.
    const skippedBefore = (await health()).profiles.throttled.skipped;
    await api("POST", `/api/rooms/${second}/messages`, { content: "your turn, Throttled" });
    assert.ok(await waitFor(async () => (await health()).profiles.throttled.skipped > skippedBefore, 6000), "the second room reached the gate and was held back");
    assert.equal(calls.length, afterBurst, "and made no call while the profile cools down");

    // The profile's view is about calls the endpoint refused, so they are counted
    // as rate limits, never as failures; the participant's own counter (one per
    // burst, asserted above) is what eventually retires a genuinely dead endpoint.
    const p = (await health()).profiles.throttled;
    assert.equal(p.failures, 0, "a throttled call is not a failed call");
    assert.equal(p.rate_limited, 3);
    assert.ok(p.rate_limited_until, "health shows the cooldown");
    assert.match(p.hint, /rate limited/);

    // Once it clears, the held room carries on by itself: no new message needed.
    setAnswer({ status: 200 });
    assert.ok(await waitFor(async () => (await api("GET", `/api/rooms/${second}`)).data.room.messages.some((m) => m.sender === "Throttled"), 12_000), "the second room replied after the cooldown");
  });
});

test("a hint longer than the in-reply ceiling becomes a cooldown instead of a long sleep", async () => {
  await withServer({}, async ({ api, health, waitFor, openRoom, calls, setAnswer, modelStatus }) => {
    const code = await openRoom("Daily quota");
    setAnswer({ status: 429, headers: { "retry-after": "600" } }); // ten minutes: do not sleep on it
    await api("POST", `/api/rooms/${code}/messages`, { content: "your turn, Throttled" });

    assert.ok(await waitFor(async () => (await modelStatus(code)).failures >= 1));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(calls.length, 1, "one attempt, no in-reply retry");
    const p = (await health()).profiles.throttled;
    assert.equal(p.rate_limited, 1);
    assert.ok(Date.parse(p.rate_limited_until) - Date.now() > 500_000, "the cooldown carries the ten minutes");
  });
});
