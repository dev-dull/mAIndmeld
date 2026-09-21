import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { boot } from "./helpers.js";

let s;
before(async () => {
  s = await boot();
});
after(() => s.close());

async function createRoom(overrides = {}) {
  const { status, data } = await s.req("POST", "/api/rooms", { body: { title: "Export contract", objective: "Agree the flags", ...overrides } });
  assert.equal(status, 201, JSON.stringify(data));
  return data;
}

test("health needs no auth and reports version", async () => {
  const { status, data } = await s.req("GET", "/api/health", { token: null });
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.match(data.version, /^\d+\.\d+\.\d+/);
  assert.equal(data.limits.messages_per_minute, 120);
});

test("the API refuses unauthenticated and badly authenticated requests", async () => {
  assert.equal((await s.req("GET", "/api/rooms", { token: null })).status, 401);
  assert.equal((await s.req("GET", "/api/rooms", { token: "mm_wrong" })).status, 401);
  assert.equal((await s.req("POST", "/api/rooms", { token: null, body: { title: "x" } })).status, 401);
});

test("a bearer principal creates a room as an agent and gets an invitation", async () => {
  const { room, invitation } = await createRoom();
  assert.match(room.code, /^MM-/);
  assert.equal(room.created_by.kind, "agent");
  assert.equal(room.created_by.name, "test");
  assert.ok(invitation.includes(room.code));
  assert.ok(invitation.includes(`/rooms/${room.code}`));
  const got = await s.req("GET", `/api/rooms/${room.code}`);
  assert.equal(got.status, 200);
  assert.equal(got.data.room.title, "Export contract");
});

test("join, send, mentions, list, and leave", async () => {
  const { room } = await createRoom();
  const join = await s.req("POST", `/api/rooms/${room.code}/join`, { body: { name: "consumer-app", kind: "agent", client: "claude-code" } });
  assert.equal(join.status, 200);
  assert.equal(join.data.rejoined, false);
  const again = await s.req("POST", `/api/rooms/${room.code}/join`, { body: { name: "consumer-app" } });
  assert.equal(again.data.rejoined, true);

  const sent = await s.req("POST", `/api/rooms/${room.code}/messages`, { body: { sender: "consumer-app", content: "@test need --format json" } });
  assert.equal(sent.status, 201);
  assert.deepEqual(sent.data.message.mentions, ["test"]);

  const stranger = await s.req("POST", `/api/rooms/${room.code}/messages`, { body: { sender: "nobody", content: "hi" } });
  assert.equal(stranger.status, 403);

  const list = await s.req("GET", "/api/rooms?status=open");
  assert.ok(list.data.rooms.some((r) => r.code === room.code && r.message_count === 3));

  const left = await s.req("POST", `/api/rooms/${room.code}/leave`, { body: { name: "consumer-app", message: "done here" } });
  assert.equal(left.status, 200);
  const after = await s.req("GET", `/api/rooms/${room.code}`);
  assert.equal(after.data.room.participants.length, 1);
  assert.match(after.data.room.messages.at(-1).content, /consumer-app left/);
});

test("long-poll wakes on a new message and advances the cursor", async () => {
  const { room } = await createRoom();
  await s.req("POST", `/api/rooms/${room.code}/join`, { body: { name: "listener" } });

  const started = Date.now();
  const poll = s.req("GET", `/api/rooms/${room.code}/messages?name=listener&wait=10`);
  await new Promise((r) => setTimeout(r, 150));
  await s.req("POST", `/api/rooms/${room.code}/messages`, { body: { sender: "test", content: "wake up" } });
  const { status, data } = await poll;
  assert.equal(status, 200);
  assert.ok(Date.now() - started < 3000, "poll should resolve promptly, not at the timeout");
  assert.equal(data.messages.length, 1);
  assert.equal(data.messages[0].content, "wake up");
  assert.equal(data.next, "reply");
  assert.equal(data.status, "open");

  const quiet = await s.req("GET", `/api/rooms/${room.code}/messages?name=listener&wait=1`);
  assert.equal(quiet.data.messages.length, 0);
  assert.equal(quiet.data.next, "listen");
  assert.equal(quiet.data.cursor, data.cursor);

  const own = await s.req("POST", `/api/rooms/${room.code}/messages`, { body: { sender: "listener", content: "my own" } });
  assert.equal(own.status, 201);
  const skipOwn = await s.req("GET", `/api/rooms/${room.code}/messages?name=listener&wait=0`);
  assert.equal(skipOwn.data.messages.length, 0, "own messages are never unread");

  const observer = await s.req("GET", `/api/rooms/${room.code}/messages?after=0`);
  assert.equal(observer.data.messages.length, room.messages.length + 3);

  const unknown = await s.req("GET", `/api/rooms/${room.code}/messages?name=ghost`);
  assert.equal(unknown.status, 403);
});

test("SSE streams messages to a subscriber", async () => {
  const { room } = await createRoom();
  const controller = new AbortController();
  const res = await fetch(`${s.base}/api/rooms/${room.code}/events`, { headers: { authorization: `Bearer ${s.token}` }, signal: controller.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const readUntil = async (needle) => {
    while (!buffer.includes(needle)) {
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended");
      buffer += decoder.decode(value);
    }
  };
  await readUntil(": connected");
  await s.req("POST", `/api/rooms/${room.code}/messages`, { body: { sender: "test", content: "streamed" } });
  await readUntil("event: message");
  await readUntil("streamed");
  controller.abort();
});

test("browser sessions: login, cookie auth, origin check, sign out", async () => {
  const crossSite = await s.req("POST", "/api/session", { token: null, origin: "https://evil.example", body: { token: s.token, name: "Ana" } });
  assert.equal(crossSite.status, 403, "login must carry a trusted origin");
  const login = await s.req("POST", "/api/session", { token: null, origin: s.config.publicOrigin, body: { token: s.token, name: "Ana" } });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.match(cookie, /^mm_session=/);
  assert.match(login.headers.get("set-cookie"), /HttpOnly/);

  const me = await s.req("GET", "/api/session", { token: null, cookie });
  assert.equal(me.data.name, "Ana");
  assert.equal(me.data.kind, "session");

  const noOrigin = await s.req("POST", "/api/rooms", { token: null, cookie, body: { title: "x" } });
  assert.equal(noOrigin.status, 403);
  const badOrigin = await s.req("POST", "/api/rooms", { token: null, cookie, origin: "https://evil.example", body: { title: "x" } });
  assert.equal(badOrigin.status, 403);
  const good = await s.req("POST", "/api/rooms", { token: null, cookie, origin: s.config.publicOrigin, body: { title: "Human room" } });
  assert.equal(good.status, 201);
  assert.equal(good.data.room.created_by.kind, "human");
  assert.equal(good.data.room.created_by.name, "Ana");
  assert.equal(good.data.room.human_present, true);

  const bad = await s.req("POST", "/api/session", { token: null, origin: s.config.publicOrigin, body: { token: "mm_nope" } });
  assert.equal(bad.status, 401);

  const out = await s.req("DELETE", "/api/session", { token: null, cookie, origin: s.config.publicOrigin });
  assert.equal(out.status, 200);
  assert.equal((await s.req("GET", "/api/session", { token: null, cookie })).status, 401);
});

test("response mode and direct close", async () => {
  const { room } = await createRoom();
  const mode = await s.req("POST", `/api/rooms/${room.code}/mode`, { body: { response_mode: "addressed_only" } });
  assert.equal(mode.status, 200);
  const agentClose = await s.req("POST", `/api/rooms/${room.code}/close`, { body: { summary: "nope" } });
  assert.equal(agentClose.status, 403, "direct close is a human power");
  await s.req("POST", `/api/rooms/${room.code}/join`, { body: { name: "Ana", kind: "human" } });
  const closed = await s.req("POST", `/api/rooms/${room.code}/close`, { body: { name: "Ana", summary: "Agreed on --format json." } });
  assert.equal(closed.status, 200);
  const got = await s.req("GET", `/api/rooms/${room.code}`);
  assert.equal(got.data.room.status, "closed");
  assert.equal(got.data.room.summary, "Agreed on --format json.");
  assert.equal(got.data.room.messages.at(-1).kind, "summary");
  const late = await s.req("POST", `/api/rooms/${room.code}/messages`, { body: { sender: "test", content: "late" } });
  assert.equal(late.status, 409);
  const poll = await s.req("GET", `/api/rooms/${room.code}/messages?name=test&wait=5`);
  assert.equal(poll.data.next, "leave");
});

test("validation and limits: bad JSON, oversized body, unknown room, bad code", async () => {
  assert.equal((await s.req("POST", "/api/rooms", { body: "{not json", raw: true })).status, 400);
  assert.equal((await s.req("POST", "/api/rooms", { body: "[1]", raw: true })).status, 400);
  const { room } = await createRoom();
  const big = await s.req("POST", `/api/rooms/${room.code}/messages`, { body: { sender: "test", content: "x".repeat(70_000) } });
  assert.equal(big.status, 413);
  assert.equal((await s.req("GET", "/api/rooms/MM-ZZZZ")).status, 404);
  assert.equal((await s.req("GET", "/api/rooms/../../etc")).status, 404);
  assert.equal((await s.req("GET", "/api/nope")).status, 404);
});

test("static pages are served with security headers", async () => {
  for (const [p, type] of [["/", "text/html"], ["/login", "text/html"], ["/rooms/MM-ABCD", "text/html"], ["/static/app.js", "text/javascript"], ["/static/style.css", "text/css"], ["/static/logo.svg", "image/svg\\+xml"], ["/favicon.ico", "image/x-icon"], ["/apple-touch-icon.png", "image/png"]]) {
    const res = await fetch(s.base + p);
    assert.equal(res.status, 200, p);
    assert.match(res.headers.get("content-type"), new RegExp(type), p);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.match(res.headers.get("content-security-policy"), /default-src 'self'/);
  }
  assert.equal((await fetch(`${s.base}/static/../package.json`)).status, 404);
  assert.equal((await fetch(`${s.base}/nope`)).status, 404);
});

test("rate limits name the limit that was hit", async () => {
  const t = await boot({ limits: { messages_per_minute: 3, rooms_per_hour: 100 } });
  try {
    const { data } = await t.req("POST", "/api/rooms", { body: { title: "r" } });
    const code = data.room.code;
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await t.req("POST", `/api/rooms/${code}/messages`, { body: { sender: "test", content: `m${i}` } })).status, 201);
    }
    const blocked = await t.req("POST", `/api/rooms/${code}/messages`, { body: { sender: "test", content: "one more" } });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.data.limit, "messages");
    assert.match(blocked.data.error, /3 messages per minute/);
  } finally {
    await t.close();
  }
});

test("hundreds of concurrent sends lose nothing and never duplicate an id", async () => {
  const t = await boot({ limits: { messages_per_minute: 100000 } });
  try {
    const { data } = await t.req("POST", "/api/rooms", { body: { title: "race" } });
    const code = data.room.code;
    const writers = ["a", "b", "c"];
    for (const w of writers) await t.req("POST", `/api/rooms/${code}/join`, { body: { name: w } });
    const N = 150;
    const jobs = [];
    for (const w of writers) for (let i = 0; i < N; i += 1) jobs.push(t.req("POST", `/api/rooms/${code}/messages`, { body: { sender: w, content: `${w}-${i}` } }));
    const results = await Promise.all(jobs);
    assert.ok(results.every((r) => r.status === 201), "every send accepted");
    const { data: after } = await t.req("GET", `/api/rooms/${code}`);
    const agentMessages = after.room.messages.filter((m) => m.kind === "agent");
    assert.equal(agentMessages.length, writers.length * N);
    const ids = after.room.messages.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length, "ids are unique");
    assert.deepEqual(ids, ids.map((_, i) => i + 1), "ids are dense and ordered");
  } finally {
    await t.close();
  }
});
