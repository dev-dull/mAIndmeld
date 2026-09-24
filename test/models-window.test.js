import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { buildPrompt, promptChars, isTooLarge, MIN_WINDOW, MAX_MESSAGE_CHARS } from "../src/models.js";
import { createApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { tmpDataDir } from "./helpers.js";

const msg = (id, sender, kind, content) => ({ id, kind, sender, content, created_at: "2026-09-24T17:00:00Z" });
const room = (n, chars = 200) => ({
  title: "Big room", objective: "", response_mode: "open", participants: [{ name: "a", kind: "agent" }, { name: "M", kind: "model" }],
  messages: Array.from({ length: n }, (_, i) => msg(i + 1, "a", "agent", `message ${i + 1} ${"x".repeat(chars)}`)),
});

test("buildPrompt honours a window override and max_prompt_chars, and clips single long messages", () => {
  const r = room(40);
  const full = buildPrompt(r, "M", { window: 40 });
  const ten = buildPrompt(r, "M", { window: 40 }, { window: 10 });
  assert.ok(promptChars(ten) < promptChars(full) / 3);
  assert.ok(ten[1].content.includes("message 31 ") && !ten[1].content.includes("message 30 "));

  const capped = buildPrompt(r, "M", { window: 40, maxPromptChars: 2500 });
  assert.ok(promptChars(capped) <= 2500, `fits the cap: ${promptChars(capped)}`);
  assert.ok(promptChars(capped) > 1000, "but keeps as much as fits");
  const floor = buildPrompt(r, "M", { window: 40, maxPromptChars: 10 });
  assert.ok(floor[1].content.includes(`message ${40 - MIN_WINDOW + 1} `), "never below the floor");

  const long = buildPrompt({ ...room(1), messages: [msg(1, "a", "agent", "y".repeat(MAX_MESSAGE_CHARS + 500))] }, "M", { window: 40 });
  assert.ok(long[1].content.includes("more characters not shown to models"));
  assert.ok(long[1].content.length < MAX_MESSAGE_CHARS + 200);
});

test("isTooLarge recognises 413 and the 400s that name a limit, nothing else", () => {
  assert.ok(isTooLarge({ status: 413 }));
  assert.ok(isTooLarge({ status: 400, body: '{"error":{"message":"This model\'s maximum context length is 8192 tokens"}}' }));
  assert.ok(isTooLarge({ status: 400, body: "Request too large for model" }));
  assert.ok(!isTooLarge({ status: 400, body: "invalid api key" }));
  assert.ok(!isTooLarge({ status: 500 }));
  assert.ok(!isTooLarge(new Error("no answer within 5000 ms")));
});

test("a 413 shrinks the participant's window and retries at once; it is not a failure and the window creeps back", async () => {
  const bodies = [];
  let limit = 6000;
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    bodies.push(body.length);
    if (body.length > limit) {
      res.writeHead(413, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Request too large" } }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Noted." } }] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  const dataDir = tmpDataDir();
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({
    limits: { rooms_open_per_creator: 100, messages_per_minute: 1000 },
    profiles: { small: { base_url: url, model: "fake-s", display_name: "Small", min_gap_ms: 0, timeout_ms: 5000, window: 40 } },
  }));
  const config = loadConfig({ dataDir, port: 0 }, { USER: "tester" });
  const app = createApp(config);
  const { token } = app.auth.createToken("test");
  await app.start();
  const base = config.publicOrigin;
  const api = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() };
  };
  const waitFor = async (pred, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await pred()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };
  const modelStatus = async () => (await api("GET", "/api/health")).data.models.find((m) => m.name === "Small");

  try {
    const code = (await api("POST", "/api/rooms", { title: "Long one", objective: "Talk a lot" })).data.room.code;
    for (let i = 0; i < 30; i += 1) await api("POST", `/api/rooms/${code}/messages`, { content: `point ${i} ${"z".repeat(300)}` });
    await api("POST", `/api/rooms/${code}/invite`, { kind: "model", profile: "small" });
    await api("POST", `/api/rooms/${code}/messages`, { content: "your turn, Small" });

    assert.ok(await waitFor(async () => (await api("GET", `/api/rooms/${code}`)).data.room.messages.some((m) => m.sender === "Small")), "the model replied");
    const first413 = bodies.findIndex((b) => b > limit);
    assert.ok(first413 >= 0, "the first request was too large");
    assert.ok(bodies.at(-1) <= limit, "the retry fit");
    assert.ok(bodies.length >= 2 && bodies.length <= 5, `retried a few times, not ${bodies.length}`);
    let st = await modelStatus();
    assert.equal(st.failures, 0, "a 413 is not a failure");
    assert.equal(st.paused_until, null);
    assert.ok(st.window < 40 && st.window >= MIN_WINDOW, `window shrank to ${st.window}`);
    assert.equal(st.window_max, 40);

    // Another turn a second later: the window creeps back by one on success.
    const shrunk = st.window;
    await new Promise((r) => setTimeout(r, 1100));
    await api("POST", `/api/rooms/${code}/messages`, { content: "and again, Small" });
    assert.ok(await waitFor(async () => (await modelStatus()).window > shrunk));
    st = await modelStatus();
    assert.equal(st.window, shrunk + 1);
    assert.equal(st.failures, 0);
  } finally {
    await app.stop();
    await new Promise((r) => server.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
