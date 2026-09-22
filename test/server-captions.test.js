import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { boot } from "./helpers.js";
import { PNG_1x1 } from "./fixtures-images.js";

/** A fake vision endpoint that records what it was sent. */
function fakeVision() {
  const calls = [];
  let mode = "ok";
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    calls.push(JSON.parse(body));
    if (mode === "fail") {
      res.writeHead(500, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "no eyes today" }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Caption: A single teal pixel on a white background.\n" } }] }));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${server.address().port}/v1`,
    calls,
    setMode: (m) => { mode = m; },
    close: () => new Promise((r) => server.close(r)),
  })));
}

async function upload(s, code, name = "builder") {
  const res = await fetch(`${s.base}/api/rooms/${code}/attachments?name=${name}`, { method: "POST", headers: { "content-type": "image/png", authorization: `Bearer ${s.token}` }, body: PNG_1x1 });
  const data = await res.json();
  assert.equal(res.status, 201, JSON.stringify(data));
  return data.attachment;
}

async function until(fn, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 40));
  }
  return null;
}

test("captions.profile must name a configured profile", async () => {
  await assert.rejects(boot({ extra: { captions: { profile: "ghost" } } }), /captions.profile names ghost, which is not a configured profile/);
});

test("with a vision profile configured, an upload gets an automatic caption in the background and the person's caption stays", async () => {
  const vision = await fakeVision();
  let s;
  try {
    s = await boot({ extra: { profiles: { eyes: { base_url: vision.url, model: "seeing-1" } }, captions: { profile: "eyes" } }, limits: { rooms_per_hour: 100 } });
    const health = await s.req("GET", "/api/health", { token: null });
    assert.equal(health.data.captions.profile, "eyes");

    const code = (await s.req("POST", "/api/rooms", { body: { title: "Captions", name: "builder" } })).data.room.code;
    const a = await upload(s, code);
    assert.equal(a.auto_caption, true);
    // The upload returned before the endpoint answered: the ledger has no auto caption yet, or it has one; either way the upload never waited.
    const auto = await until(async () => (await s.req("GET", `/api/rooms/${code}`)).data.room.attachments[a.id].caption_auto);
    assert.equal(auto, "A single teal pixel on a white background.");
    assert.equal(vision.calls.length, 1);
    const sent = vision.calls[0];
    assert.equal(sent.model, "seeing-1");
    const parts = sent.messages[0].content;
    assert.equal(parts[0].type, "text");
    assert.equal(parts[1].type, "image_url");
    assert.match(parts[1].image_url.url, /^data:image\/png;base64,iVBOR/);

    // Sending copies the automatic caption onto the message; the person's caption is untouched.
    const m = (await s.req("POST", `/api/rooms/${code}/messages`, { body: { sender: "builder", content: "", attachment_id: a.id, caption: "one pixel" } })).data.message;
    assert.equal(m.attachment.caption, "one pixel");
    assert.equal(m.attachment.caption_auto, "A single teal pixel on a white background.");

    // The other order: message sent before the caption arrives; the message is updated and an SSE update is published.
    const b = await upload(s, code);
    const early = (await s.req("POST", `/api/rooms/${code}/messages`, { body: { sender: "builder", content: "quick", attachment_id: b.id, caption: "sent at once" } })).data.message;
    const updated = await until(async () => (await s.req("GET", `/api/rooms/${code}`)).data.room.messages.find((x) => x.id === early.id).attachment.caption_auto);
    assert.equal(updated, "A single teal pixel on a white background.");
    assert.equal((await s.req("GET", `/api/rooms/${code}`)).data.room.messages.find((x) => x.id === early.id).attachment.caption, "sent at once");

    // A failing endpoint: the upload still succeeds, the person's caption is all there is, and the failure is counted.
    vision.setMode("fail");
    const c = await upload(s, code);
    const m3 = (await s.req("POST", `/api/rooms/${code}/messages`, { body: { sender: "builder", content: "", attachment_id: c.id, caption: "no help" } })).data.message;
    assert.equal(m3.attachment.caption, "no help");
    await until(async () => (await s.req("GET", "/api/health", { token: null })).data.captions.failures >= 1);
    const after = await s.req("GET", "/api/health", { token: null });
    assert.equal(after.data.captions.failures, 1);
    assert.equal((await s.req("GET", `/api/rooms/${code}`)).data.room.attachments[c.id].caption_auto, undefined);
  } finally {
    if (s) await s.close();
    await vision.close();
  }
});

test("without captions.profile there is no automatic caption and health says so", async () => {
  const s = await boot({ limits: { rooms_per_hour: 100 } });
  try {
    assert.equal((await s.req("GET", "/api/health", { token: null })).data.captions, null);
    const code = (await s.req("POST", "/api/rooms", { body: { title: "Plain", name: "builder" } })).data.room.code;
    const a = await upload(s, code);
    assert.equal(a.auto_caption, false);
  } finally {
    await s.close();
  }
});
