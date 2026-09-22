import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { boot } from "./helpers.js";
import { PNG_1x1, JPEG_32x16, PNG_SPOOF, TEXT } from "./fixtures-images.js";
import { messageText } from "../src/rooms.js";

let s;
before(async () => {
  s = await boot({ limits: { max_attachment_bytes: 200, max_room_attachment_bytes: 200, rooms_per_hour: 100 } });
});
after(() => s.close());

async function upload(code, bytes, { type = "image/png", token, name = "builder" } = {}) {
  const headers = { "content-type": type, authorization: `Bearer ${token || s.token}` };
  const res = await fetch(`${s.base}/api/rooms/${code}/attachments${name ? `?name=${name}` : ""}`, { method: "POST", headers, body: bytes });
  const data = await res.json();
  return { status: res.status, data };
}

async function room(title = "Pictures") {
  const r = await s.req("POST", "/api/rooms", { body: { title, name: "builder" } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.room.code;
}

test("upload, send, and read an image over HTTP with a token and with a signed link", async () => {
  const code = await room();
  const up = await upload(code, PNG_1x1);
  assert.equal(up.status, 201, JSON.stringify(up.data));
  const a = up.data.attachment;
  assert.match(a.id, /^[a-f0-9]{16}$/);
  assert.equal(a.type, "image/png");
  assert.equal(a.bytes, PNG_1x1.length);
  assert.deepEqual([a.width, a.height], [1, 1]);
  assert.match(a.url, new RegExp(`^${s.base}/api/rooms/${code}/attachments/${a.id}\\?sig=`));

  const sent = await s.req("POST", `/api/rooms/${code}/messages`, { body: { sender: "builder", content: "the spike", attachment_id: a.id, caption: "latency spike at 14:02" } });
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  const m = sent.data.message;
  assert.deepEqual({ ...m.attachment, url: undefined }, { id: a.id, type: "image/png", bytes: PNG_1x1.length, caption: "latency spike at 14:02", url: undefined });
  assert.ok(m.attachment.url.includes("?sig="));
  assert.equal(messageText(m), "the spike\n[image: latency spike at 14:02]");

  // With the bearer token.
  const withToken = await fetch(`${s.base}/api/rooms/${code}/attachments/${a.id}`, { headers: { authorization: `Bearer ${s.token}` } });
  assert.equal(withToken.status, 200);
  assert.equal(withToken.headers.get("content-type"), "image/png");
  assert.equal(withToken.headers.get("cache-control"), "private, max-age=300");
  assert.ok(Buffer.from(await withToken.arrayBuffer()).equals(PNG_1x1));

  // With the signed link and no token at all.
  const signed = await fetch(m.attachment.url);
  assert.equal(signed.status, 200);
  assert.ok(Buffer.from(await signed.arrayBuffer()).equals(PNG_1x1));

  // The room file carries the ledger and the message; the listen response carries a fresh link.
  const got = await s.req("GET", `/api/rooms/${code}`);
  assert.equal(got.data.room.attachments[a.id].message_id, m.id);
  assert.ok(got.data.room.messages.at(-1).attachment.url);
  const listen = await s.req("GET", `/api/rooms/${code}/messages?after=0`);
  assert.equal(listen.data.messages.at(-1).attachment.caption, "latency spike at 14:02");
  assert.ok(listen.data.messages.at(-1).attachment.url.includes("?sig="));

  // A message that is only an image is allowed; text is then the caption line.
  const up2 = await upload(code, JPEG_32x16, { type: "image/jpeg" });
  assert.equal(up2.status, 201);
  const only = await s.req("POST", `/api/rooms/${code}/messages`, { body: { sender: "builder", attachment_id: up2.data.attachment.id, caption: "the diagram" } });
  assert.equal(only.status, 201, JSON.stringify(only.data));
  assert.equal(only.data.message.content, "");
  assert.equal(messageText(only.data.message), "[image: the diagram]");
});

test("uploads are rejected when oversized, not an image, spoofed, mislabelled, unauthenticated, or from a non-participant", async () => {
  const code = await room("Rejections");
  const big = Buffer.concat([PNG_1x1, Buffer.alloc(300)]);
  assert.equal((await upload(code, big)).status, 413, "over max_attachment_bytes");
  const text = await upload(code, TEXT, { type: "text/plain" });
  assert.equal(text.status, 415);
  assert.match(text.data.error, /not a PNG, JPEG, WebP, or GIF/);
  assert.equal((await upload(code, PNG_SPOOF)).status, 415, "PNG header on a non-PNG body");
  const renamed = await upload(code, JPEG_32x16, { type: "image/png" });
  assert.equal(renamed.status, 415, "a JPEG declared as PNG");
  assert.match(renamed.data.error, /says image\/png but the bytes are image\/jpeg/);
  assert.equal((await upload(code, PNG_1x1, { type: "application/octet-stream" })).status, 201, "an unspecific type is fine; the bytes decide");
  const noType = await fetch(`${s.base}/api/rooms/${code}/attachments?name=builder`, { method: "POST", headers: { authorization: `Bearer ${s.token}` }, body: new Uint8Array(JPEG_32x16) });
  assert.equal(noType.status, 201, "no Content-Type at all: the bytes decide");
  assert.equal((await noType.json()).attachment.type, "image/jpeg");
  const noAuth = await fetch(`${s.base}/api/rooms/${code}/attachments`, { method: "POST", headers: { "content-type": "image/png" }, body: PNG_1x1 });
  assert.equal(noAuth.status, 401);
  const stranger = await upload(code, PNG_1x1, { name: "nobody" });
  assert.equal(stranger.status, 403);
  assert.equal((await fetch(`${s.base}/api/rooms/${code}/attachments`, { method: "POST", headers: { "content-type": "image/png", authorization: `Bearer ${s.token}` } })).status, 400, "empty body");
});

test("the room cap, wrong-room and non-sender references, reuse, and bad links are refused", async () => {
  const code = await room("Caps");
  const other = await room("Other");
  await s.req("POST", `/api/rooms/${code}/join`, { body: { name: "consumer" } });
  const a = (await upload(code, PNG_1x1)).data.attachment;
  const b = (await upload(code, PNG_1x1)).data.attachment;
  assert.ok(a && b);
  const third = await upload(code, PNG_1x1);
  assert.equal(third.status, 413, "over max_room_attachment_bytes");
  assert.match(third.data.error, /exceed 200 bytes/);

  const wrongRoom = await s.req("POST", `/api/rooms/${other}/messages`, { body: { sender: "builder", content: "x", attachment_id: a.id, caption: "elsewhere" } });
  assert.equal(wrongRoom.status, 404);
  const notMine = await s.req("POST", `/api/rooms/${code}/messages`, { body: { sender: "consumer", content: "x", attachment_id: a.id, caption: "not mine" } });
  assert.equal(notMine.status, 403);
  assert.match(notMine.data.error, /uploaded by builder, not consumer/);
  const captionOnly = await s.req("POST", `/api/rooms/${code}/messages`, { body: { sender: "builder", content: "x", caption: "no image" } });
  assert.equal(captionOnly.status, 400);
  const uncaptioned = await s.req("POST", `/api/rooms/${code}/messages`, { body: { sender: "builder", content: "x", attachment_id: a.id } });
  assert.equal(uncaptioned.status, 400, "a caption is required with an image");
  assert.match(uncaptioned.data.error, /caption is required/);
  const tooShort = await s.req("POST", `/api/rooms/${code}/messages`, { body: { sender: "builder", content: "x", attachment_id: a.id, caption: "ok" } });
  assert.equal(tooShort.status, 400);
  const first = await s.req("POST", `/api/rooms/${code}/messages`, { body: { sender: "builder", content: "x", attachment_id: a.id, caption: "the first" } });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const again = await s.req("POST", `/api/rooms/${code}/messages`, { body: { sender: "builder", content: "y", attachment_id: a.id, caption: "again" } });
  assert.equal(again.status, 409, "one message per attachment");
  const unknown = await s.req("POST", `/api/rooms/${code}/messages`, { body: { sender: "builder", content: "y", attachment_id: "0123456789abcdef", caption: "nothing" } });
  assert.equal(unknown.status, 404);

  const url = first.data.message.attachment.url;
  assert.equal((await fetch(`${url}x`)).status, 403, "tampered signature");
  assert.equal((await fetch(url.replace(code, other))).status, 403, "signature for another room");
  assert.equal((await fetch(url.split("?")[0])).status, 401, "no signature and no token");
  assert.equal((await fetch(`${s.base}/api/rooms/${code}/attachments/0123456789abcdef`, { headers: { authorization: `Bearer ${s.token}` } })).status, 404);
  assert.equal((await fetch(`${s.base}/api/rooms/${code}/attachments/..%2F..%2Fetc`, { headers: { authorization: `Bearer ${s.token}` } })).status, 404);
});

test("closing a room leaves its attachments in place; an older room file without the ledger still loads", async () => {
  const code = await room("Closing");
  const a = (await upload(code, PNG_1x1)).data.attachment;
  await s.req("POST", `/api/rooms/${code}/messages`, { body: { sender: "builder", content: "keep", attachment_id: a.id, caption: "kept image" } });
  const closed = await s.req("POST", `/api/rooms/${code}/close`, { body: { name: "Ana", kind: "human" } });
  // Direct close is a human power; join a human first if needed.
  if (closed.status !== 200) {
    await s.req("POST", `/api/rooms/${code}/join`, { body: { name: "Ana", kind: "human" } });
    assert.equal((await s.req("POST", `/api/rooms/${code}/close`, { body: { name: "Ana" } })).status, 200);
  }
  const file = path.join(s.dataDir, "rooms", code, "attachments", `${a.id}.png`);
  assert.ok(fs.existsSync(file));
  assert.equal((await fetch(`${s.base}/api/rooms/${code}/attachments/${a.id}`, { headers: { authorization: `Bearer ${s.token}` } })).status, 200);
  assert.equal((await upload(code, PNG_1x1)).status, 409, "no uploads to a closed room");

  const roomFile = path.join(s.dataDir, "rooms", `${code}.json`);
  const json = JSON.parse(fs.readFileSync(roomFile, "utf8"));
  delete json.attachments;
  fs.writeFileSync(roomFile, JSON.stringify(json));
  const got = await s.req("GET", `/api/rooms/${code}`);
  assert.equal(got.status, 200);
  assert.deepEqual(got.data.room.attachments, {});
  assert.equal(got.data.room.messages.find((m) => m.attachment)?.attachment.id, a.id, "the message keeps its attachment field");
});

test("the SSE stream carries the attachment on the message, so another browser can render it", async () => {
  const code = await room("SSE");
  const controller = new AbortController();
  const res = await fetch(`${s.base}/api/rooms/${code}/events`, { headers: { authorization: `Bearer ${s.token}` }, signal: controller.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const a = (await upload(code, PNG_1x1)).data.attachment;
  await s.req("POST", `/api/rooms/${code}/messages`, { body: { sender: "builder", content: "look", attachment_id: a.id, caption: "a gradient" } });
  let text = "";
  const decoder = new TextDecoder();
  while (!text.includes("a gradient")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  controller.abort();
  const event = text.split("\n\n").map((block) => block.split("\n").find((l) => l.startsWith("data:"))).filter(Boolean).map((l) => JSON.parse(l.slice(5))).find((e) => e.message?.attachment);
  assert.ok(event, text);
  assert.equal(event.message.attachment.id, a.id);
  assert.equal(event.message.attachment.caption, "a gradient");
});

test("an upload never attached to a message is removed by the tick after the orphan window", async () => {
  // Three seconds, not one: upload times are floored to the second and a slow
  // CI runner can spend most of a second on the setup below.
  const t = await boot({ limits: { attachment_orphan_seconds: 3, rooms_per_hour: 100 } });
  try {
    const started = Date.now();
    const code = (await t.req("POST", "/api/rooms", { body: { title: "Orphans", name: "builder" } })).data.room.code;
    const res = await fetch(`${t.base}/api/rooms/${code}/attachments?name=builder`, { method: "POST", headers: { "content-type": "image/png", authorization: `Bearer ${t.token}` }, body: PNG_1x1 });
    const orphan = (await res.json()).attachment;
    const res2 = await fetch(`${t.base}/api/rooms/${code}/attachments?name=builder`, { method: "POST", headers: { "content-type": "image/png", authorization: `Bearer ${t.token}` }, body: PNG_1x1 });
    const kept = (await res2.json()).attachment;
    assert.ok(orphan && kept, "both uploads succeeded");
    assert.equal((await t.req("POST", `/api/rooms/${code}/messages`, { body: { sender: "builder", content: "kept", attachment_id: kept.id, caption: "the one we keep" } })).status, 201);
    assert.ok(Date.now() - started < 1800, "setup took too long for this test's window; raise attachment_orphan_seconds");
    await t.app.service.tick();
    assert.ok(fs.existsSync(path.join(t.dataDir, "rooms", code, "attachments", `${orphan.id}.png`)), "not before the window");
    await new Promise((r) => setTimeout(r, Math.max(0, 3400 - (Date.now() - started))));
    await t.app.service.tick();
    assert.ok(!fs.existsSync(path.join(t.dataDir, "rooms", code, "attachments", `${orphan.id}.png`)), "orphan removed");
    assert.ok(fs.existsSync(path.join(t.dataDir, "rooms", code, "attachments", `${kept.id}.png`)), "attached file kept");
    const got = await t.req("GET", `/api/rooms/${code}`);
    assert.deepEqual(Object.keys(got.data.room.attachments), [kept.id]);
  } finally {
    await t.close();
  }
});

test("over MCP, room_send takes attachment_id and listen renders the caption and a link", async () => {
  let nextId = 1;
  const rpc = async (name, args) => {
    const res = await fetch(`${s.base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${s.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }),
    });
    const data = await res.json();
    assert.ok(!data.error, JSON.stringify(data.error));
    return data.result;
  };
  const created = await rpc("room_create", { title: "MCP pictures", name: "agent-a" });
  const code = created.structuredContent.code;
  await rpc("room_join", { code, name: "agent-b" });
  const a = (await upload(code, PNG_1x1, { name: "agent-a" })).data.attachment;
  const sent = await rpc("room_send", { code, name: "agent-a", content: "see this", attachment_id: a.id, caption: "the dashboard", then_listen: false });
  assert.match(sent.content[0].text, /^Sent #\d+/);
  const heard = await rpc("room_listen", { code, name: "agent-b", wait: 0 });
  assert.match(heard.content[0].text, /agent-a \(agent\): see this\n {2}\[image: the dashboard\] http/);
  assert.ok(heard.structuredContent.messages.at(-1).attachment.url.includes("?sig="));
  const missing = await rpc("room_send", { code, name: "agent-a", content: "", then_listen: false });
  assert.equal(missing.isError, true, "no text and no attachment");
  assert.match(missing.content[0].text, /content is required/);
});
