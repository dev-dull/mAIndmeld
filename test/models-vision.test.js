import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { buildPrompt, INLINE_IMAGES } from "../src/models.js";
import { createApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { tmpDataDir } from "./helpers.js";
import { PNG_1x1, JPEG_WITH_EXIF } from "./fixtures-images.js";

const hasImagePart = (messages) => messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"));

/** A fake endpoint that answers, and in "novision" mode rejects any request with an image part. */
function fakeEndpoint() {
  const calls = [];
  let mode = "ok";
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const parsed = JSON.parse(body);
    calls.push(parsed);
    if (mode === "novision" && hasImagePart(parsed.messages)) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "This model does not support image input" } }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "I see it." } }] }));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${server.address().port}/v1`,
    calls,
    setMode: (m) => { mode = m; },
    close: () => new Promise((r) => server.close(r)),
  })));
}

test("buildPrompt gives image parts only to vision profiles with a loader, only for the newest images, and merges turns with parts", () => {
  const msg = (id, sender, kind, content, attachment) => ({ id, kind, sender, content, attachment, created_at: "2026-09-22T12:00:00Z" });
  const room = {
    title: "T", objective: "", response_mode: "open", participants: [{ name: "a", kind: "agent" }, { name: "Eyes", kind: "model" }],
    messages: [
      msg(1, "a", "agent", "one", { id: "1111111111111111", caption: "first" }),
      msg(2, "a", "agent", "two", { id: "2222222222222222", caption: "second" }),
      msg(3, "a", "agent", "three", { id: "3333333333333333", caption: "third" }),
      msg(4, "a", "agent", "four", { id: "4444444444444444", caption: "fourth" }),
      msg(5, "a", "agent", "five", { id: "5555555555555555", caption: "fifth", caption_auto: "a teal square" }),
      msg(6, "Eyes", "model", "mine", { id: "6666666666666666", caption: "own image" }),
    ],
  };
  const loader = (r, a) => `data:image/png;base64,${a.id}`;
  assert.equal(INLINE_IMAGES, 4);

  const plain = buildPrompt(room, "Eyes", { vision: false, window: 40 }, { loadImage: loader });
  assert.ok(!hasImagePart(plain), "a non-vision profile never gets bytes");
  assert.match(plain[1].content, /\[image: fifth \(described as: a teal square\)\]/);

  const noLoader = buildPrompt(room, "Eyes", { vision: true, window: 40 }, {});
  assert.ok(!hasImagePart(noLoader));

  const vision = buildPrompt(room, "Eyes", { vision: true, window: 40 }, { loadImage: loader });
  const user = vision[1];
  assert.equal(user.role, "user");
  assert.ok(Array.isArray(user.content));
  const uris = user.content.filter((p) => p.type === "image_url").map((p) => p.image_url.url);
  assert.deepEqual(uris, ["data:image/png;base64,2222222222222222", "data:image/png;base64,3333333333333333", "data:image/png;base64,4444444444444444", "data:image/png;base64,5555555555555555"], "the newest four from others; the oldest stays caption only");
  const texts = user.content.filter((p) => p.type === "text").map((p) => p.text).join("");
  assert.match(texts, /a \(agent\): one\n\[image: first\]/);
  assert.equal(vision[2].role, "assistant");
  assert.equal(typeof vision[2].content, "string", "the model's own image is never sent back to it as bytes");
});

test("a vision model receives the image with metadata stripped, a non-vision model gets the caption, an over-limit image goes as caption only, and a rejecting endpoint pauses the participant without breaking the room", async () => {
  const fake = await fakeEndpoint();
  const dataDir = tmpDataDir();
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({
    limits: { rooms_open_per_creator: 100, max_attachment_bytes: 200000 },
    profiles: {
      eyes: { base_url: fake.url, model: "fake-v", display_name: "Eyes", min_gap_ms: 0, timeout_ms: 5000, vision: true, image_max_px: 20 },
      blind: { base_url: fake.url, model: "fake-t", display_name: "Blind", min_gap_ms: 0, timeout_ms: 5000 },
    },
  }));
  const config = loadConfig({ dataDir, port: 0 }, { USER: "tester" });
  assert.equal(config.profiles.eyes.vision, true);
  assert.equal(config.profiles.eyes.imageMaxPx, 20);
  assert.equal(config.profiles.blind.vision, false);
  const app = createApp(config);
  const { token } = app.auth.createToken("test");
  await app.start();
  const base = config.publicOrigin;
  const api = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() };
  };
  const upload = async (code, bytes, type) => {
    const res = await fetch(`${base}/api/rooms/${code}/attachments`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": type }, body: bytes });
    const data = await res.json();
    assert.equal(res.status, 201, JSON.stringify(data));
    return data.attachment;
  };
  const callsFor = (model) => fake.calls.filter((c) => c.model === model);
  const waitFor = async (pred, ms = 6000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (pred()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };

  try {
    const code = (await api("POST", "/api/rooms", { title: "Vision", objective: "Look at pictures" })).data.room.code;
    await api("POST", `/api/rooms/${code}/invite`, { kind: "model", profile: "eyes" });
    await api("POST", `/api/rooms/${code}/invite`, { kind: "model", profile: "blind" });

    // A 1x1 PNG is within limits: the vision model gets the bytes, the other one the caption.
    const a = await upload(code, PNG_1x1, "image/png");
    await api("POST", `/api/rooms/${code}/messages`, { content: "look", attachment_id: a.id, caption: "a teal pixel" });
    assert.ok(await waitFor(() => callsFor("fake-v").length >= 1 && callsFor("fake-t").length >= 1), "both models were called");
    const v = callsFor("fake-v").at(-1);
    const parts = v.messages.find((m) => Array.isArray(m.content)).content;
    const img = parts.find((p) => p.type === "image_url");
    assert.match(img.image_url.url, /^data:image\/png;base64,/);
    assert.ok(parts.filter((p) => p.type === "text").map((p) => p.text).join("").includes("[image: a teal pixel]"));
    const t = callsFor("fake-t").at(-1);
    assert.ok(!hasImagePart(t.messages), "the non-vision model never receives bytes");
    assert.ok(t.messages.some((m) => typeof m.content === "string" && m.content.includes("[image: a teal pixel]")));

    // Message timestamps have one-second precision and a model ignores anything not newer than its last reply, so space the rounds out.
    const nextSecond = () => new Promise((r) => setTimeout(r, 1100));

    // A JPEG with EXIF arrives stripped.
    await nextSecond();
    const before = callsFor("fake-v").length;
    const b = await upload(code, JPEG_WITH_EXIF, "image/jpeg");
    await api("POST", `/api/rooms/${code}/messages`, { content: "and this", attachment_id: b.id, caption: "a photo" });
    assert.ok(await waitFor(() => callsFor("fake-v").length > before));
    const jpegUri = callsFor("fake-v").at(-1).messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p) => p.type === "image_url").at(-1).image_url.url;
    const sentBytes = Buffer.from(jpegUri.split(",")[1], "base64");
    assert.ok(!sentBytes.includes("GPSLatitude"), "GPS stripped before the model saw it");
    assert.ok(JPEG_WITH_EXIF.includes("GPSLatitude"), "while the stored file still has it");

    // Over the pixel limit (32 wide, limit 20): caption only, for the vision model too.
    await nextSecond();
    fake.calls.length = 0;
    const wide = await upload(code, JPEG_WITH_EXIF, "image/jpeg");
    // the ledger knows the dimensions from the header
    const ledger = (await api("GET", `/api/rooms/${code}`)).data.room.attachments[wide.id];
    assert.deepEqual([ledger.width, ledger.height], [32, 16]);
    app.config.profiles.eyes.imageMaxPx = 0; // tighten so even the 1x1 image is over: no bytes at all this round
    await api("POST", `/api/rooms/${code}/messages`, { content: "big one", attachment_id: wide.id, caption: "a wide diagram" });
    assert.ok(await waitFor(() => callsFor("fake-v").length >= 1));
    assert.ok(!hasImagePart(callsFor("fake-v").at(-1).messages), "over-limit images go as caption only");
    app.config.profiles.eyes.imageMaxPx = 20;

    // An endpoint that rejects image parts: the failure is counted, and the room carries on for the other model.
    await nextSecond();
    fake.setMode("novision");
    fake.calls.length = 0;
    const c = await upload(code, PNG_1x1, "image/png");
    await api("POST", `/api/rooms/${code}/messages`, { content: "again", attachment_id: c.id, caption: "the pixel again" });
    assert.ok(await waitFor(() => callsFor("fake-v").length >= 1 && callsFor("fake-t").length >= 1));
    await new Promise((r) => setTimeout(r, 300));
    const health = await api("GET", "/api/health");
    const eyes = health.data.models.find((m) => m.name === "Eyes");
    assert.ok(eyes.failures >= 1, JSON.stringify(eyes));
    const room = (await api("GET", `/api/rooms/${code}`)).data.room;
    assert.equal(room.status, "open");
    assert.ok(room.messages.some((m) => m.sender === "Blind"), "the non-vision model still answered");
  } finally {
    await app.stop();
    await fake.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
