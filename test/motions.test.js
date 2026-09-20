import { test } from "node:test";
import assert from "node:assert/strict";

import * as rooms from "../src/rooms.js";

const T0 = Date.parse("2026-09-20T12:00:00Z");
const sec = (n) => T0 + n * 1000;

function setup({ models = 0, humans = 0 } = {}) {
  const room = rooms.createRoom({ title: "t", objective: "o", creator: { name: "a", kind: "agent" } }, T0);
  rooms.joinRoom(room, { name: "b", kind: "agent" }, T0);
  rooms.joinRoom(room, { name: "c", kind: "agent" }, T0);
  for (let i = 0; i < models; i += 1) rooms.joinRoom(room, { name: `m${i}`, kind: "model" }, T0);
  for (let i = 0; i < humans; i += 1) rooms.joinRoom(room, { name: `h${i}`, kind: "human" }, T0);
  return room;
}

test("filing a close motion: eligibility, one per type, proposer votes yes", () => {
  const room = setup({ models: 1 });
  const { motion, existing } = rooms.fileMotion(room, { type: "close", proposer: "a", summary: "done" }, T0);
  assert.equal(existing, false);
  assert.deepEqual(motion.eligible, ["a", "b", "c"], "models are not eligible on close");
  assert.deepEqual(motion.votes, { a: "yes" });
  assert.equal(motion.status, "open");
  assert.equal(rooms.fileMotion(room, { type: "close", proposer: "b" }, T0).existing, true);
  assert.throws(() => rooms.fileMotion(room, { type: "close", proposer: "m0" }, T0), /a model may not file a close/);
  assert.throws(() => rooms.fileMotion(room, { type: "explode", proposer: "a" }, T0), /type must be/);
  assert.throws(() => rooms.fileMotion(room, { type: "call_human", proposer: "a" }, T0), /reason is required/);
  assert.match(room.messages.at(-1).content, /moved to close the room: done \(motion #1\)\. Voters: b, c/);
});

test("close carries by unanimity and closes the room; a single no cancels", () => {
  const room = setup();
  const { motion } = rooms.fileMotion(room, { type: "close", proposer: "a", summary: "Agreed." }, T0);
  rooms.castVote(room, motion.id, { name: "b", vote: "yes" }, sec(1));
  assert.equal(motion.status, "open");
  rooms.castVote(room, motion.id, { name: "c", vote: "yes" }, sec(2));
  assert.equal(motion.status, "carried");
  assert.equal(motion.outcome.how, "votes");
  assert.equal(room.status, "closed");
  assert.equal(room.closed_by.how, "motion");
  assert.equal(room.summary, "Agreed.");

  const r2 = setup();
  const m2 = rooms.fileMotion(r2, { type: "close", proposer: "a" }, T0).motion;
  assert.throws(() => rooms.castVote(r2, m2.id, { name: "b", vote: "no" }, T0), /reason is required/);
  rooms.castVote(r2, m2.id, { name: "b", vote: "no", reason: "not yet" }, T0);
  assert.equal(m2.status, "cancelled");
  assert.equal(r2.status, "open");
  assert.throws(() => rooms.castVote(r2, m2.id, { name: "c", vote: "yes" }, T0), /is cancelled/);
});

test("voting rules: eligible only, no double vote, yes or no", () => {
  const room = setup({ models: 1, humans: 1 });
  const { motion } = rooms.fileMotion(room, { type: "close", proposer: "a" }, T0);
  assert.throws(() => rooms.castVote(room, motion.id, { name: "m0", vote: "yes" }, T0), /not an eligible voter/);
  assert.throws(() => rooms.castVote(room, motion.id, { name: "h0", vote: "yes" }, T0), /not an eligible voter/);
  assert.throws(() => rooms.castVote(room, motion.id, { name: "a", vote: "yes" }, T0), /already voted/);
  assert.throws(() => rooms.castVote(room, motion.id, { name: "b", vote: "maybe" }, T0), /yes or no/);
  assert.throws(() => rooms.castVote(room, 99, { name: "b", vote: "yes" }, T0), /no motion #99/);
});

test("silence counts as consent only after delivery, and the hard deadline bounds everything", () => {
  const room = setup();
  const { motion } = rooms.fileMotion(room, { type: "close", proposer: "a" }, T0);
  // b polls and is delivered; c never polls.
  assert.equal(rooms.deliverMotions(room, "b", sec(10)).length, 1);
  assert.equal(motion.windows.b, "2026-09-20T12:02:10Z");
  assert.equal(rooms.evaluate(room, motion.id, sec(200)), null, "c undelivered: not yet");
  // b's window passed at 130s, c still undelivered; hard deadline at 600s.
  assert.equal(rooms.evaluate(room, motion.id, sec(599)), null);
  const resolved = rooms.evaluate(room, motion.id, sec(600));
  assert.equal(resolved.status, "carried");
  assert.equal(resolved.outcome.how, "hard_deadline");
  assert.deepEqual(resolved.outcome.tally.silent, ["b", "c"]);
  assert.match(room.messages.find((m) => m.data?.action === "resolved").content, /2 silent \(b, c\)/);

  const r2 = setup();
  const m2 = rooms.fileMotion(r2, { type: "close", proposer: "a" }, T0).motion;
  rooms.deliverMotions(r2, "b", sec(1));
  rooms.deliverMotions(r2, "c", sec(1));
  assert.equal(rooms.evaluate(r2, m2.id, sec(120)), null);
  assert.equal(rooms.evaluate(r2, m2.id, sec(121)).outcome.how, "silence");
});

test("call_human: models vote, tie carries, majority no cancels, lone proposer carries at once", () => {
  const room = setup({ models: 1 });
  const { motion } = rooms.fileMotion(room, { type: "call_human", proposer: "b", reason: "billing" }, T0);
  assert.deepEqual(motion.eligible, ["a", "b", "c", "m0"]);
  rooms.castVote(room, motion.id, { name: "a", vote: "no", reason: "we can decide" }, sec(1));
  rooms.castVote(room, motion.id, { name: "m0", vote: "no", reason: "agree with a" }, sec(2));
  rooms.castVote(room, motion.id, { name: "c", vote: "yes" }, sec(3));
  assert.equal(motion.status, "carried", "2 yes vs 2 no is a tie and carries");
  assert.equal(room.human_required, true);
  assert.match(room.messages.at(-1).content, /A human has been called/);

  const r2 = setup();
  const m2 = rooms.fileMotion(r2, { type: "call_human", proposer: "a", reason: "r" }, T0).motion;
  rooms.castVote(r2, m2.id, { name: "b", vote: "no", reason: "no need" }, T0);
  rooms.castVote(r2, m2.id, { name: "c", vote: "no", reason: "no need" }, T0);
  assert.equal(m2.status, "cancelled");
  assert.equal(r2.human_required, false);

  const solo = rooms.createRoom({ title: "t", creator: { name: "only", kind: "agent" } }, T0);
  const m3 = rooms.fileMotion(solo, { type: "call_human", proposer: "only", reason: "alone" }, T0).motion;
  assert.equal(m3.status, "carried");
  assert.equal(m3.outcome.how, "lone_proposer");
  assert.equal(solo.human_required, true);
});

test("close is blocked while a called human is absent; dismiss or presence unblocks", () => {
  const room = setup();
  rooms.fileMotion(room, { type: "call_human", proposer: "a", reason: "r" }, T0);
  rooms.castVote(room, 1, { name: "b", vote: "yes" }, T0);
  rooms.castVote(room, 1, { name: "c", vote: "yes" }, T0);
  assert.equal(room.human_required, true);
  assert.throws(() => rooms.fileMotion(room, { type: "close", proposer: "a" }, T0), /close is blocked/);
  const sent = rooms.sendMessage(room, { sender: "a", content: "deciding anyway" }, 1000, T0);
  assert.equal(sent.provisional, true);
  rooms.joinRoom(room, { name: "Ana", kind: "human" }, T0);
  assert.equal(room.human_present, true);
  assert.doesNotThrow(() => rooms.fileMotion(room, { type: "close", proposer: "a" }, T0));
  rooms.leaveRoom(room, "Ana", null, T0);
  assert.equal(room.human_present, false);

  const r2 = setup({ humans: 1 });
  r2.human_required = true;
  rooms.humanAction(r2, { name: "h0", action: "dismiss" }, T0);
  assert.equal(r2.human_required, false);
  assert.throws(() => rooms.humanAction(r2, { name: "a", action: "dismiss" }, T0), /not a human participant/);
  const ack = rooms.humanAction(r2, { name: "h0", action: "acknowledge" }, T0);
  assert.equal(ack.acknowledged, true);
  assert.ok(r2.human_acknowledged_at);
});

test("sending is blocked for a delivered voter who has not voted; humans are exempt", () => {
  const room = setup({ humans: 1 });
  rooms.fileMotion(room, { type: "close", proposer: "a" }, T0);
  assert.doesNotThrow(() => rooms.sendMessage(room, { sender: "b", content: "not delivered yet, may speak" }, 1000, T0));
  rooms.deliverMotions(room, "b", T0);
  assert.throws(() => rooms.sendMessage(room, { sender: "b", content: "x" }, 1000, T0), /vote on motion #1 \(close\) before/);
  assert.equal(rooms.pendingVoteFor(room, "b").id, 1);
  assert.doesNotThrow(() => rooms.sendMessage(room, { sender: "h0", content: "humans may speak" }, 1000, T0));
  rooms.castVote(room, 1, { name: "b", vote: "yes" }, T0);
  assert.doesNotThrow(() => rooms.sendMessage(room, { sender: "b", content: "voted, may speak" }, 1000, T0));
});

test("addressed-only mode is enforced for agents and models, not humans", () => {
  const room = setup({ humans: 1 });
  rooms.setResponseMode(room, "addressed_only", "h0", T0);
  assert.throws(() => rooms.sendMessage(room, { sender: "b", content: "unprompted" }, 1000, T0), /only-when-addressed/);
  rooms.sendMessage(room, { sender: "h0", content: "@b what do you think?" }, 1000, T0);
  assert.doesNotThrow(() => rooms.sendMessage(room, { sender: "b", content: "I think yes" }, 1000, T0));
  assert.throws(() => rooms.sendMessage(room, { sender: "b", content: "and also" }, 1000, T0), /only-when-addressed/, "one mention, one reply");
  assert.throws(() => rooms.sendMessage(room, { sender: "c", content: "me too" }, 1000, T0), /only-when-addressed/);
});

test("override carries or cancels at once; veto is the cancel of a close", () => {
  const room = setup();
  const { motion } = rooms.fileMotion(room, { type: "close", proposer: "a" }, T0);
  const vetoed = rooms.overrideMotion(room, motion.id, { by: "Ana", outcome: "cancel", reason: "not done" }, sec(5));
  assert.equal(vetoed.status, "cancelled");
  assert.equal(vetoed.outcome.how, "veto");
  assert.equal(vetoed.outcome.by, "Ana");
  assert.deepEqual(vetoed.outcome.tally.silent, ["b", "c"]);
  assert.equal(room.status, "open");
  const again = rooms.fileMotion(room, { type: "close", proposer: "a" }, sec(6)).motion;
  const carried = rooms.overrideMotion(room, again.id, { by: "Ana", outcome: "carry" }, sec(7));
  assert.equal(carried.outcome.how, "override");
  assert.equal(room.status, "closed");
  assert.equal(room.closed_by.how, "override");
  assert.throws(() => rooms.overrideMotion(room, again.id, { by: "Ana", outcome: "carry" }, sec(8)), /is carried/);
});

test("wait extends windows and the hard deadline; a participant wait targets one voter", () => {
  const room = setup();
  const { motion } = rooms.fileMotion(room, { type: "close", proposer: "a" }, T0);
  rooms.deliverMotions(room, "b", T0);
  rooms.waitRoom(room, { by: "Ana", seconds: 60 }, sec(10));
  assert.equal(motion.hard_deadline, "2026-09-20T12:11:00Z");
  assert.equal(motion.windows.b, "2026-09-20T12:03:00Z");
  rooms.waitRoom(room, { by: "Ana", target: "b", seconds: 900 }, sec(20));
  assert.equal(motion.windows.b, "2026-09-20T12:18:00Z");
  assert.equal(motion.hard_deadline, "2026-09-20T12:18:00Z", "hard deadline stretches to cover the voter");
  assert.throws(() => rooms.waitRoom(room, { by: "Ana", target: "ghost" }, T0), /not in room/);
  rooms.waitRoom(room, { by: "Ana", target: "ingest", seconds: 120 }, sec(30));
  assert.equal(room.ingest_grace_until, "2026-09-20T12:02:30Z");
  assert.equal(rooms.evaluate(room, motion.id, sec(1000)), null, "still inside the extended deadline");
});

test("hold freezes resolution and resume shifts every clock by the held time", () => {
  const room = setup();
  const { motion } = rooms.fileMotion(room, { type: "close", proposer: "a" }, T0);
  rooms.deliverMotions(room, "b", T0);
  rooms.deliverMotions(room, "c", T0);
  rooms.holdRoom(room, "Ana", sec(30));
  assert.throws(() => rooms.holdRoom(room, "Bo", sec(31)), /already held/);
  assert.equal(rooms.evaluate(room, motion.id, sec(5000)), null, "held rooms never resolve");
  rooms.castVote(room, motion.id, { name: "b", vote: "yes" }, sec(40));
  rooms.castVote(room, motion.id, { name: "c", vote: "yes" }, sec(41));
  assert.equal(motion.status, "open", "even unanimity waits for resume");
  rooms.resumeRoom(room, "Ana", sec(330));
  assert.equal(motion.hard_deadline, "2026-09-20T12:15:00Z", "600s deadline plus 300s held");
  assert.equal(motion.windows.b, "2026-09-20T12:07:00Z");
  assert.equal(rooms.evaluate(room, motion.id, sec(331)).status, "carried");
  assert.throws(() => rooms.resumeRoom(room, "Ana", sec(400)), /not held/);
});

test("closing a room cancels its open motions, and motionView reports the voter's state", () => {
  const room = setup();
  const { motion } = rooms.fileMotion(room, { type: "call_human", proposer: "a", reason: "r" }, T0);
  rooms.deliverMotions(room, "b", T0);
  const view = rooms.motionView(motion, "b");
  assert.equal(view.your_vote, null);
  assert.equal(view.delivered, true);
  assert.equal(view.eligible_for_you, true);
  assert.deepEqual(view.tally, { yes: 1, no: 0, pending: ["b", "c"] });
  assert.equal(rooms.motionView(motion, "c").delivered, false);
  rooms.closeRoom(room, { by: "Ana", kind: "human", summary: "bye" }, T0);
  assert.equal(motion.status, "cancelled");
  assert.equal(motion.outcome.how, "room_closed");
});

test("upgradeRoom fills the milestone 3 fields on an old room", () => {
  const old = { format: 1, code: "MM-AAAA", participants: [], messages: [], next_message_id: 1 };
  rooms.upgradeRoom(old);
  assert.equal(old.format, 2);
  assert.deepEqual(old.motions, []);
  assert.equal(old.held, null);
  assert.equal(old.clock_config.window_ms, 120_000);
  assert.equal(old.next_motion_id, 1);
});
