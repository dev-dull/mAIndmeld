import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

import { buildPrompt, OpenAIChatClient } from "../src/models.js";
import * as rooms from "../src/rooms.js";
import { boot, tmpDataDir } from "./helpers.js";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/server.js";

// A fake OpenAI-compatible endpoint. Each request's last user turn is echoed
// back with a prefix, unless the script says otherwise.
function fakeEndpoint() {
  const calls = [];
  let mode = "echo"; // echo | pass | fail | slow
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const parsed = JSON.parse(body);
    calls.push({ auth: req.headers.authorization, body: parsed });
    if (mode === "fail") {
      res.writeHead(500, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "boom" }));
    }
    if (mode === "slow") await new Promise((r) => setTimeout(r, 400));
    const last = [...parsed.messages].reverse().find((m) => m.role === "user");
    const content = mode === "pass" ? "[pass]" : `echo: ${last.content.split("\n").at(-1)}`;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: parsed.model, choices: [{ message: { role: "assistant", content } }], usage: { total_tokens: 1 } }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${server.address().port}/v1`,
      calls,
      setMode: (m) => { mode = m; },
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

let fake;
before(async () => {
  fake = await fakeEndpoint();
});
after(() => fake.close());

test("buildPrompt folds the transcript into alternating turns with the room context", () => {
  const room = rooms.createRoom({ title: "Retry policy", objective: "Cap retries", creator: { name: "tool-builder", kind: "agent" } });
  rooms.joinRoom(room, { name: "Qwen", kind: "model" });
  rooms.sendMessage(room, { sender: "tool-builder", content: "Three retries?" }, 1000);
  rooms.sendMessage(room, { sender: "Qwen", content: "Yes, with backoff." }, 1000);
  rooms.sendMessage(room, { sender: "tool-builder", content: "Agreed." }, 1000);
  const turns = buildPrompt(room, "Qwen", { window: 40 });
  assert.equal(turns[0].role, "system");
  assert.match(turns[0].content, /You are Qwen/);
  assert.match(turns[0].content, /Objective: Cap retries/);
  assert.match(turns[0].content, /tool-builder \(agent\), Qwen \(model\)/);
  const roles = turns.slice(1).map((t) => t.role);
  assert.deepEqual(roles, ["user", "assistant", "user"]);
  assert.match(turns[1].content, /\[room\] tool-builder created/);
  assert.match(turns[1].content, /tool-builder \(agent\): Three retries\?/);
  assert.equal(turns[2].content, "Yes, with backoff.");
});

test("OpenAIChatClient sends the bearer key from the environment and surfaces errors", async () => {
  process.env.FAKE_KEY = "secret-123";
  const client = new OpenAIChatClient({ baseUrl: fake.url, apiKeyEnv: "FAKE_KEY", model: "fake-1", timeoutMs: 5000, extra: { chat_template_kwargs: { enable_thinking: false } } });
  const out = await client.complete([{ role: "user", content: "hi" }], { maxTokens: 10 });
  assert.equal(out.text, "echo: hi");
  const call = fake.calls.at(-1);
  assert.equal(call.auth, "Bearer secret-123");
  assert.equal(call.body.model, "fake-1");
  assert.equal(call.body.max_tokens, 10);
  assert.deepEqual(call.body.chat_template_kwargs, { enable_thinking: false });

  fake.setMode("fail");
  await assert.rejects(client.complete([{ role: "user", content: "x" }]), /HTTP 500/);
  fake.setMode("echo");

  const noKey = new OpenAIChatClient({ baseUrl: fake.url, apiKeyEnv: "MISSING_KEY_VAR", model: "m" });
  await assert.rejects(noKey.complete([]), /MISSING_KEY_VAR is not set/);

  const slow = new OpenAIChatClient({ baseUrl: fake.url, model: "m", timeoutMs: 50 });
  fake.setMode("slow");
  await assert.rejects(slow.complete([{ role: "user", content: "x" }]), /no answer within 50 ms/);
  fake.setMode("echo");
});

test("a model participant joins a room, answers others, passes when told, and stays quiet otherwise", async () => {
  const dataDir = tmpDataDir();
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({
    profiles: {
      echo: { base_url: fake.url, model: "fake-1", display_name: "Echo", min_gap_ms: 0, timeout_ms: 5000 },
    },
  }));
  const config = loadConfig({ dataDir, port: 0 }, { USER: "tester" });
  const app = createApp(config);
  const { token } = app.auth.createToken("test"); // the room creator's name; sends below use it
  await app.start();
  const base = config.publicOrigin;
  const api = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() };
  };
  const waitFor = async (pred, ms = 6000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const { data } = await api("GET", `/api/rooms/${code}`);
      if (pred(data.room)) return data.room;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("condition not met in time");
  };

  try {
    const created = await api("POST", "/api/rooms", { title: "Echo test", objective: "See the echo" });
    var code = created.data.room.code;
    const missing = await api("POST", `/api/rooms/${code}/invite`, { kind: "model", profile: "nope" });
    assert.equal(missing.status, 404);
    assert.match(missing.data.error, /configured: echo/);

    const invited = await api("POST", `/api/rooms/${code}/invite`, { kind: "model", profile: "echo" });
    assert.equal(invited.status, 200);
    assert.equal(invited.data.participant.name, "Echo");
    let room = await waitFor((r) => r.participants.some((p) => p.name === "Echo" && p.kind === "model"));

    // Only system messages so far: the model should not speak on join.
    await new Promise((r) => setTimeout(r, 2000));
    room = (await api("GET", `/api/rooms/${code}`)).data.room;
    assert.equal(room.messages.filter((m) => m.kind === "model").length, 0, "no reply to an empty room");

    await api("POST", `/api/rooms/${code}/messages`, { sender: "test", content: "Echo, what do you think?" });
    room = await waitFor((r) => r.messages.some((m) => m.kind === "model"));
    const reply = room.messages.find((m) => m.kind === "model");
    assert.equal(reply.sender, "Echo");
    assert.equal(reply.content, "echo: test (agent): Echo, what do you think?");

    // Its own reply must not trigger another reply.
    await new Promise((r) => setTimeout(r, 2000));
    room = (await api("GET", `/api/rooms/${code}`)).data.room;
    assert.equal(room.messages.filter((m) => m.kind === "model").length, 1, "no self-reply loop");

    fake.setMode("pass");
    await api("POST", `/api/rooms/${code}/messages`, { sender: "test", content: "Anything to add?" });
    await new Promise((r) => setTimeout(r, 2500));
    room = (await api("GET", `/api/rooms/${code}`)).data.room;
    assert.equal(room.messages.filter((m) => m.kind === "model").length, 1, "[pass] posts nothing");
    fake.setMode("echo");

    const health = await api("GET", "/api/health");
    assert.equal(health.data.models.length, 1);
    assert.equal(health.data.models[0].replies, 1);
    assert.ok(health.data.models[0].latency_ms.p50 >= 0);

    await api("POST", `/api/rooms/${code}/close`, { summary: "done" });
    await new Promise((r) => setTimeout(r, 300));
    const after = await api("GET", "/api/health");
    assert.equal(after.data.models.length, 0, "model participants stop when the room closes");
  } finally {
    await app.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("invite kinds: human flags the room, session returns the invitation", async () => {
  const s = await boot();
  try {
    const { data } = await s.req("POST", "/api/rooms", { body: { title: "invites" } });
    const code = data.room.code;
    const human = await s.req("POST", `/api/rooms/${code}/invite`, { body: { kind: "human", reason: "billing decision" } });
    assert.equal(human.status, 200);
    const room = (await s.req("GET", `/api/rooms/${code}`)).data.room;
    assert.equal(room.human_required, true);
    assert.match(room.messages.at(-1).content, /asked for a human.*billing decision/);
    const session = await s.req("POST", `/api/rooms/${code}/invite`, { body: { kind: "session", name: "consumer-app" } });
    assert.equal(session.status, 200);
    assert.match(session.data.invitation, new RegExp(code));
    assert.equal((await s.req("POST", `/api/rooms/${code}/invite`, { body: { kind: "ghost" } })).status, 400);
  } finally {
    await s.close();
  }
});
