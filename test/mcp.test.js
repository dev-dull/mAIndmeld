import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { boot } from "./helpers.js";
import { LATEST_PROTOCOL } from "../src/mcp.js";

let s;
let nextId = 1;
before(async () => {
  s = await boot();
});
after(() => s.close());

async function rpc(method, params, { token = s.token, headers = {}, id = true } = {}) {
  const body = { jsonrpc: "2.0", method, ...(params ? { params } : {}), ...(id ? { id: nextId++ } : {}) };
  const res = await fetch(`${s.base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null, headers: res.headers };
}

async function call(name, args, opts) {
  const { status, data } = await rpc("tools/call", { name, arguments: args }, opts);
  assert.equal(status, 200, JSON.stringify(data));
  assert.ok(!data.error, JSON.stringify(data.error));
  return data.result;
}

test("initialize negotiates a protocol version and advertises tools", async () => {
  const { status, data, headers } = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  assert.equal(status, 200);
  assert.match(headers.get("content-type"), /application\/json/);
  assert.equal(data.result.protocolVersion, "2025-06-18");
  assert.equal(data.result.serverInfo.name, "maindmeld");
  assert.ok(data.result.capabilities.tools);
  assert.match(data.result.instructions, /After joining, listen/);

  const unknown = await rpc("initialize", { protocolVersion: "1999-01-01" });
  assert.equal(unknown.data.result.protocolVersion, LATEST_PROTOCOL);

  const notified = await rpc("notifications/initialized", undefined, { id: false });
  assert.equal(notified.status, 202);

  const list = await rpc("tools/list");
  const names = list.data.result.tools.map((t) => t.name);
  assert.deepEqual(names, ["room_create", "room_join", "room_send", "room_listen", "room_invite", "room_motion", "room_vote", "room_status", "room_leave", "room_list", "kb_search"]);
  assert.match(data.result.instructions, /pre-flight check/);
  for (const t of list.data.result.tools) assert.equal(t.inputSchema.type, "object");

  const ping = await rpc("ping");
  assert.deepEqual(ping.data.result, {});
});

test("transport rules: auth, GET is 405, bad version header, batches, malformed bodies", async () => {
  assert.equal((await rpc("ping", undefined, { token: null })).status, 401);
  const get = await fetch(`${s.base}/mcp`, { headers: { authorization: `Bearer ${s.token}`, accept: "text/event-stream" } });
  assert.equal(get.status, 405);
  const badVersion = await rpc("ping", undefined, { headers: { "mcp-protocol-version": "1999-01-01" } });
  assert.equal(badVersion.status, 400);
  assert.match(badVersion.data.error.message, /unsupported MCP-Protocol-Version/);
  const okVersion = await rpc("ping", undefined, { headers: { "mcp-protocol-version": "2025-03-26" } });
  assert.equal(okVersion.status, 200);
  const batch = await fetch(`${s.base}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${s.token}` }, body: "[]" });
  assert.equal(batch.status, 400);
  const notRpc = await fetch(`${s.base}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${s.token}` }, body: JSON.stringify({ hello: 1 }) });
  assert.equal(notRpc.status, 400);
  const unknownMethod = await rpc("resources/list");
  assert.equal(unknownMethod.data.error.code, -32601);
  const unknownTool = await rpc("tools/call", { name: "room_explode", arguments: {} });
  assert.equal(unknownTool.data.error.code, -32602);
  const foreign = await rpc("ping", undefined, { headers: { origin: "https://evil.example" } });
  assert.equal(foreign.status, 403);
});

test("two agents and a human meet through the tools", async () => {
  const created = await call("room_create", { title: "Export contract", objective: "Agree the flags", name: "tool-builder" });
  assert.equal(created.isError, false);
  const code = created.structuredContent.code;
  assert.match(code, /^MM-/);
  assert.match(created.content[0].text, new RegExp(`Created room ${code}`));
  assert.match(created.content[0].text, /Invitation for other sessions/);
  assert.match(created.content[0].text, /next: listen/);

  const joined = await call("room_join", { code, name: "consumer-app", client: "claude-code" });
  assert.match(joined.content[0].text, /Joined .* as consumer-app/);
  assert.equal(joined.structuredContent.next, "listen");

  // consumer-app listens; tool-builder speaks while it waits.
  const listening = call("room_listen", { code, name: "consumer-app", wait: 10 });
  await new Promise((r) => setTimeout(r, 150));
  const sent = await call("room_send", { code, name: "tool-builder", content: "@consumer-app proposing --format json", then_listen: false });
  assert.match(sent.content[0].text, /Sent #\d+/);
  const heard = await listening;
  assert.match(heard.content[0].text, /tool-builder \(agent\): @consumer-app proposing --format json/);
  assert.equal(heard.structuredContent.next, "reply");
  assert.equal(heard.structuredContent.messages.length, 1);

  // A human joins through the HTTP API and speaks; the agent's send-then-listen hears it.
  await s.req("POST", `/api/rooms/${code}/join`, { body: { name: "Ana", kind: "human" } });
  const sendAndListen = call("room_send", { code, name: "consumer-app", content: "Agreed, and non-zero exit on partial failure.", wait: 10 });
  await new Promise((r) => setTimeout(r, 150));
  await s.req("POST", `/api/rooms/${code}/messages`, { body: { sender: "Ana", content: "Ship it." } });
  const result = await sendAndListen;
  assert.match(result.content[0].text, /Ana \(human\): Ship it\./);

  const status = await call("room_status", { code });
  assert.match(status.content[0].text, /tool-builder \(agent\), consumer-app \(agent\), Ana \(human\)/);
  assert.equal(status.structuredContent.human_present, true);

  const list = await call("room_list", { name: "consumer-app" });
  assert.equal(list.structuredContent.mine.length, 1);

  const invite = await call("room_invite", { code, kind: "session", name: "reviewer" });
  assert.match(invite.content[0].text, /Deliver this to the other session yourself/);

  const left = await call("room_leave", { code, name: "consumer-app", message: "done here" });
  assert.match(left.content[0].text, /Left/);
  const after = await s.req("GET", `/api/rooms/${code}`);
  assert.ok(!after.data.room.participants.some((p) => p.name === "consumer-app"));

  await s.req("POST", `/api/rooms/${code}/close`, { body: { name: "Ana", summary: "Agreed." } });
  const closedListen = await call("room_listen", { code, name: "tool-builder", wait: 1 });
  assert.equal(closedListen.structuredContent.next, "leave");
});

test("motions through the tools: a listen delivers, send is refused until the vote, close carries", async () => {
  const created = await call("room_create", { title: "Motion room", name: "alpha" });
  const code = created.structuredContent.code;
  await call("room_join", { code, name: "beta" });
  const filed = await call("room_motion", { code, type: "close", summary: "We are done.", name: "alpha" });
  assert.match(filed.content[0].text, /Filed motion #1 \(close\)\. Waiting on: beta\./);

  const heard = await call("room_listen", { code, name: "beta", wait: 1 });
  assert.equal(heard.structuredContent.next, "vote");
  assert.match(heard.content[0].text, /YOU HAVE NOT VOTED/);
  const refused = await call("room_send", { code, name: "beta", content: "one more thing", then_listen: false });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /vote on motion #1/);

  const voted = await call("room_vote", { code, motion_id: 1, vote: "yes", name: "beta" });
  assert.match(voted.content[0].text, /Motion carried \(votes\)/);
  assert.equal(voted.structuredContent.next, "leave");
  const status = await call("room_status", { code });
  assert.equal(status.structuredContent.status, "closed");
});

test("tool errors come back as isError results, not transport failures", async () => {
  const r = await call("room_join", { code: "MM-ZZZZ" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /no room MM-ZZZZ/);
  const empty = await call("room_create", {});
  assert.equal(empty.isError, true);
  assert.match(empty.content[0].text, /title is required/);
  const noCode = await call("room_listen", {});
  assert.match(noCode.content[0].text, /code is required for room_listen/);
  const badKind = await call("room_invite", { code: "MM-ZZZZ", kind: "ghost" });
  assert.match(badKind.content[0].text, /kind must be session, model, human, or harness/);
});
