import { test } from "node:test";
import assert from "node:assert/strict";

import * as rooms from "../src/rooms.js";

const creator = { name: "tool-builder", kind: "agent", client: "claude-code" };

test("createRoom builds a valid room with a system message and the creator joined", () => {
  const room = rooms.createRoom({ title: "Export contract", objective: "Agree flags", creator });
  assert.match(room.code, /^MM-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(room.status, "open");
  assert.equal(room.participants.length, 1);
  assert.equal(room.participants[0].name, "tool-builder");
  assert.equal(room.messages.length, 1);
  assert.equal(room.messages[0].kind, "system");
  assert.equal(room.participants[0].cursor, 1);
  assert.equal(room.human_present, false);
});

test("createRoom validates title, name, kind, and mode", () => {
  assert.throws(() => rooms.createRoom({ title: "", creator }), /title is required/);
  assert.throws(() => rooms.createRoom({ title: "x".repeat(161), creator }), /160 characters/);
  assert.throws(() => rooms.createRoom({ title: "ok", creator: { name: "@bad", kind: "agent" } }), /must not start with @/);
  assert.throws(() => rooms.createRoom({ title: "ok", creator: { name: "ab", kind: "agent" } }), /control characters/);
  assert.throws(() => rooms.createRoom({ title: "ok", creator: { name: "a", kind: "robot" } }), /kind must be one of/);
  assert.throws(() => rooms.createRoom({ title: "ok", creator: { name: "Room", kind: "agent" } }), /is reserved/);
  assert.throws(() => rooms.createRoom({ title: "ok", creator, responseMode: "loud" }), /response_mode/);
});

test("joinRoom adds participants, rejoins idempotently, and rejects a kind clash", () => {
  const room = rooms.createRoom({ title: "t", creator });
  const first = rooms.joinRoom(room, { name: "consumer-app", kind: "agent" });
  assert.equal(first.rejoined, false);
  assert.equal(room.participants.length, 2);
  const again = rooms.joinRoom(room, { name: "Consumer-App", kind: "agent" });
  assert.equal(again.rejoined, true);
  assert.equal(room.participants.length, 2);
  assert.throws(() => rooms.joinRoom(room, { name: "consumer-app", kind: "human" }), /already in the room as agent/);
  rooms.joinRoom(room, { name: "Alastair", kind: "human" });
  assert.equal(room.human_present, true);
});

test("sendMessage requires a participant, parses mentions, and flags provisional", () => {
  const room = rooms.createRoom({ title: "t", creator });
  rooms.joinRoom(room, { name: "consumer-app", kind: "agent" });
  assert.throws(() => rooms.sendMessage(room, { sender: "stranger", content: "hi" }, 1000), /not a participant/);
  assert.throws(() => rooms.sendMessage(room, { sender: "tool-builder", content: "   " }, 1000), /content is required/);
  assert.throws(() => rooms.sendMessage(room, { sender: "tool-builder", content: "x".repeat(20) }, 10), /exceeds 10 bytes/);
  const m = rooms.sendMessage(room, { sender: "tool-builder", content: "@consumer-app need --format json; email me@consumer-app.example" }, 1000);
  assert.deepEqual(m.mentions, ["consumer-app"]);
  assert.equal(m.kind, "agent");
  assert.equal(m.provisional, undefined);
  room.human_required = true;
  const p = rooms.sendMessage(room, { sender: "consumer-app", content: "deciding anyway" }, 1000);
  assert.equal(p.provisional, true);
  assert.throws(() => rooms.sendMessage(room, { sender: "consumer-app", content: "x", reply_to: 99 }, 1000), /reply_to/);
});

test("unreadFor excludes own messages and honours the cursor", () => {
  const room = rooms.createRoom({ title: "t", creator });
  const { participant: b } = rooms.joinRoom(room, { name: "b", kind: "agent" });
  rooms.sendMessage(room, { sender: "b", content: "mine" }, 1000);
  rooms.sendMessage(room, { sender: "tool-builder", content: "theirs" }, 1000);
  const unread = rooms.unreadFor(room, b);
  assert.equal(unread.length, 1);
  assert.equal(unread[0].content, "theirs");
});

test("leaveRoom removes the participant and recomputes human presence", () => {
  const room = rooms.createRoom({ title: "t", creator });
  rooms.joinRoom(room, { name: "Ana", kind: "human" });
  assert.equal(room.human_present, true);
  rooms.leaveRoom(room, "ana", "bye all");
  assert.equal(room.human_present, false);
  assert.equal(room.participants.length, 1);
  assert.equal(room.messages.at(-2).content, "bye all");
  assert.match(room.messages.at(-1).content, /Ana left/);
  assert.throws(() => rooms.leaveRoom(room, "nobody"), /not in room/);
});

test("closeRoom is idempotent and blocks further sends", () => {
  const room = rooms.createRoom({ title: "t", creator });
  assert.equal(rooms.closeRoom(room, { by: "Ana", kind: "human", summary: "Done." }), true);
  assert.equal(room.status, "closed");
  assert.equal(room.messages.at(-1).kind, "summary");
  assert.equal(rooms.closeRoom(room, { by: "Ana", kind: "human" }), false);
  assert.throws(() => rooms.sendMessage(room, { sender: "tool-builder", content: "late" }, 1000), /is closed/);
  assert.throws(() => rooms.joinRoom(room, { name: "late", kind: "agent" }), /is closed/);
});

test("setResponseMode records a system message only on change", () => {
  const room = rooms.createRoom({ title: "t", creator });
  const before = room.messages.length;
  assert.equal(rooms.setResponseMode(room, "open", "Ana"), false);
  assert.equal(rooms.setResponseMode(room, "addressed_only", "Ana"), true);
  assert.equal(room.messages.length, before + 1);
  assert.throws(() => rooms.setResponseMode(room, "shout", "Ana"), /response_mode/);
});
