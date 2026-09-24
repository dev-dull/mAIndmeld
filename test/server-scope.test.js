import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { boot } from "./helpers.js";

let s;
let code;
let other;
let scoped;
let nextId = 1;
before(async () => {
  s = await boot({ limits: { rooms_per_hour: 100 } });
  code = (await s.req("POST", "/api/rooms", { body: { title: "Scoped", objective: "Test scope", name: "host" } })).data.room.code;
  other = (await s.req("POST", "/api/rooms", { body: { title: "Elsewhere", name: "host" } })).data.room.code;
  scoped = s.app.auth.createLaunchToken({ room: code, harness: "hermes", launch: "L1", ttlMs: 60_000 }).token;
});
after(() => s.close());

async function rpc(name, args, token) {
  const res = await fetch(`${s.base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }),
  });
  return (await res.json()).result;
}

test("a launch token works inside its room over HTTP: join, send, listen, read, upload", async () => {
  const join = await s.req("POST", `/api/rooms/${code}/join`, { token: scoped, body: { name: "Hermes" } });
  assert.equal(join.status, 200, JSON.stringify(join.data));
  assert.equal((await s.req("POST", `/api/rooms/${code}/messages`, { token: scoped, body: { sender: "Hermes", content: "hello from a harness" } })).status, 201);
  assert.equal((await s.req("GET", `/api/rooms/${code}/messages?after=0`, { token: scoped })).status, 200);
  assert.equal((await s.req("GET", `/api/rooms/${code}`, { token: scoped })).status, 200);
  assert.equal((await s.req("GET", "/api/session", { token: scoped })).status, 200);
});

test("a launch token is refused outside its room: other rooms, creation, the lobby, sweeps; reading the record is allowed", async () => {
  const r = await s.req("GET", `/api/rooms/${other}`, { token: scoped });
  assert.equal(r.status, 403);
  assert.match(r.data.error, new RegExp(`scoped to room ${code}, not ${other}`));
  assert.equal((await s.req("POST", `/api/rooms/${other}/join`, { token: scoped, body: { name: "Hermes" } })).status, 403);
  assert.equal((await s.req("POST", "/api/rooms", { token: scoped, body: { title: "nope" } })).status, 403);
  assert.equal((await s.req("GET", "/api/rooms", { token: scoped })).status, 403);
  assert.equal((await s.req("GET", "/api/events", { token: scoped })).status, 403);
  assert.equal((await s.req("GET", "/api/kb/sweeps", { token: scoped })).status, 403);
  assert.equal((await s.req("GET", "/api/kb/search?q=anything", { token: scoped })).status, 200, "kb_search is read-only and expected of every participant");
  assert.equal((await s.req("GET", "/api/kb/decisions", { token: scoped })).status, 200);
});

test("over MCP a launch token may act in its room and search, and nothing else", async () => {
  const listen = await rpc("room_listen", { code, name: "Hermes", wait: 0 }, scoped);
  assert.ok(!listen.isError, JSON.stringify(listen));
  const search = await rpc("kb_search", { query: "scope" }, scoped);
  assert.ok(!search.isError);
  const create = await rpc("room_create", { title: "nope", name: "Hermes" }, scoped);
  assert.equal(create.isError, true);
  assert.match(create.content[0].text, /cannot create rooms/);
  const list = await rpc("room_list", {}, scoped);
  assert.equal(list.isError, true);
  const elsewhere = await rpc("room_join", { code: other, name: "Hermes" }, scoped);
  assert.equal(elsewhere.isError, true);
  assert.match(elsewhere.content[0].text, new RegExp(`scoped to room ${code}, not ${other}`));
});

test("expiry and revocation end a launch token; the tick sweeps the record", async () => {
  const short = s.app.auth.createLaunchToken({ room: code, harness: "pi", launch: "L2", ttlMs: 50 });
  assert.equal((await s.req("GET", `/api/rooms/${code}`, { token: short.token })).status, 200);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal((await s.req("GET", `/api/rooms/${code}`, { token: short.token })).status, 401, "expired");
  assert.ok(s.app.auth.listTokens().some((t) => t.name === "launch-L2"));
  await s.app.service.tick();
  assert.ok(!s.app.auth.listTokens().some((t) => t.name === "launch-L2"), "swept");

  assert.deepEqual(s.app.auth.revokeScoped(code, { launch: "L1" }), ["launch-L1"]);
  assert.equal((await s.req("GET", `/api/rooms/${code}`, { token: scoped })).status, 401, "revoked");
  assert.equal((await s.req("GET", `/api/rooms/${code}`)).status, 200, "the ordinary token is untouched");
});
