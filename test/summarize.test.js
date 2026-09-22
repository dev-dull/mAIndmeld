import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { buildEnvelope, validateNote, extractJson, redact, createAdapter, summarize, Breaker } from "../src/summarize.js";
import { KnowledgeStore } from "../src/kb.js";
import * as rooms from "../src/rooms.js";
import { tmpDataDir } from "./helpers.js";

const T0 = Date.parse("2026-09-20T12:00:00Z");

function room() {
  const r = rooms.createRoom({ title: "Retry policy", objective: "Decide retries", creator: { name: "a", kind: "agent" }, code: "MM-RTRY" }, T0);
  rooms.joinRoom(r, { name: "b", kind: "agent" }, T0);
  rooms.sendMessage(r, { sender: "a", content: "Three retries with backoff. My key is sk-abcdefghijklmnopqrstuvwxyz1234 do not share." }, 10000, T0);
  r.human_required = true;
  rooms.sendMessage(r, { sender: "b", content: "Agreed on retry policy." }, 10000, T0);
  rooms.closeRoom(r, { by: "Ana", kind: "human", summary: "Retries agreed." }, T0);
  r.status = "closed";
  return r;
}

test("the envelope carries context for matching topics, provisional ids, and redactions", () => {
  const kb = new KnowledgeStore(path.join(tmpDataDir(), "kb"));
  kb.saveTopics([
    { name: "retry-policy", description: "", aliases: ["retries"], created: "2026-09-01" },
    { name: "billing", description: "", aliases: [], created: "2026-09-01" },
  ]);
  kb.saveDecisions([
    { id: "D-M20260901-X-01", meeting: "M20260901-X", topic: "retry-policy", status: "active", statement: "Two retries.", date: "2026-09-01", supersedes: [] },
    { id: "D-M20260901-X-02", meeting: "M20260901-X", topic: "billing", status: "active", statement: "Monthly.", date: "2026-09-01", supersedes: [] },
    { id: "D-M20260901-X-03", meeting: "M20260901-X", topic: "retry-policy", status: "superseded", statement: "One retry.", date: "2026-08-01", supersedes: [] },
  ]);
  const { envelope, redactions } = buildEnvelope(room(), kb);
  assert.equal(envelope.room.code, "MM-RTRY");
  assert.deepEqual(envelope.context.active_decisions.map((d) => d.id), ["D-M20260901-X-01"], "only active decisions on topics the transcript mentions");
  assert.deepEqual(envelope.provisional_message_ids, [4]);
  assert.equal(redactions, 1);
  assert.ok(!envelope.messages.some((m) => m.content.includes("sk-abcdefghijklmnopqrstuvwxyz1234")));
  assert.ok(envelope.messages.some((m) => m.content.includes("[redacted]")));
  assert.equal(envelope.closing.summary, "Retries agreed.");
});

test("redact catches common credential shapes and leaves prose alone", () => {
  assert.equal(redact("plain words 12345").count, 0);
  assert.equal(redact("commit 3f2a9c0d1e4b5a6f7c8d9e0f1a2b3c4d5e6f7a8b landed").count, 0, "git hashes are not secrets");
  assert.equal(redact("token mm_abcdefghijklmnopqrstuvwxyz012345 and Bearer abcdefghijklmnopqrstuvwxyz").count, 2);
  assert.equal(redact("AKIAABCDEFGHIJKLMNOP").count, 1);
});

test("validateNote reports every schema problem", () => {
  const envelope = { context: { topics: [{ name: "retry-policy", aliases: ["Retries"] }], active_decisions: [{ id: "D-1" }] } };
  const good = { title: "t", summary: "s", topics: ["Retry Policy"], decisions: [{ topic: "retries", statement: "x", confidence: "chair", supersedes: ["D-1"] }], participants_summary: { a: "spoke" }, human_involved: false };
  assert.deepEqual(validateNote(good, envelope), [], "names and aliases match after slugifying");
  assert.deepEqual(validateNote({ ...good, participants_summary: { a: 1 } }, envelope), ["participants_summary.a must be a string"]);

  // Decision 13: an undeclared decision topic is promoted with a warning, not rejected.
  const promoted = [];
  const undeclared = { ...good, topics: ["billing"], decisions: [{ topic: "Billing", statement: "Monthly invoices.", confidence: "chair" }] };
  assert.deepEqual(validateNote(undeclared, envelope, promoted), []);
  assert.equal(promoted.length, 1);
  assert.match(promoted[0], /"billing" was used by a decision without being declared/);
  assert.deepEqual(undeclared.new_topics, [{ name: "billing", reason: "used by decision 1 without being declared", promoted: true }]);
  const bad = { title: "", summary: "s", topics: ["unknown"], new_topics: [{ name: "fresh" }], decisions: [{ topic: "", statement: "x".repeat(201), confidence: "sure", supersedes: ["D-9"] }], human_involved: "yes" };
  const errors = validateNote(bad, envelope);
  assert.ok(errors.some((e) => /title must be/.test(e)));
  assert.ok(errors.some((e) => /"unknown" is not in the vocabulary/.test(e)));
  assert.ok(errors.some((e) => /new topic fresh needs a reason/.test(e)));
  assert.ok(errors.some((e) => /decision 0: topic is required/.test(e)));
  assert.ok(errors.some((e) => /at most 200 characters/.test(e)));
  assert.ok(errors.some((e) => /confidence must be/.test(e)));
  assert.ok(errors.some((e) => /supersedes unknown id D-9/.test(e)));
  assert.ok(errors.some((e) => /human_involved/.test(e)));
  assert.deepEqual(validateNote(null, envelope), ["note must be a JSON object"]);
});

test("extractJson finds the object inside prose and fences", () => {
  assert.deepEqual(extractJson('Sure! Here it is:\n```json\n{"a": "b}", "c": {"d": 1}}\n```\nDone.'), { a: "b}", c: { d: 1 } });
  assert.throws(() => extractJson("no json here"), /no JSON object/);
  assert.throws(() => extractJson('{"a": 1'), /unterminated/);
});

test("the command adapter runs an executable on the envelope, and summarize retries once with the errors", async () => {
  const dir = tmpDataDir();
  const script = path.join(dir, "summarizer.mjs");
  // First call: invalid note. Second call: sees retry.errors and returns a valid one.
  fs.writeFileSync(script, `
    let input = ""; process.stdin.on("data", (d) => (input += d)); process.stdin.on("end", () => {
      const env = JSON.parse(input);
      if (!env.retry) { process.stdout.write('prose first {"title": "", "summary": "s", "topics": [], "decisions": [], "human_involved": true}'); return; }
      if (!env.retry.errors.some((e) => /title/.test(e))) { process.stderr.write("errors not passed"); process.exit(2); }
      process.stdout.write(JSON.stringify({ title: "Fixed on retry", summary: "s", topics: [], decisions: [], human_involved: true }));
    });
  `);
  const adapter = createAdapter({ summarizer: { adapter: "command", command: process.execPath, args: [script], timeoutMs: 10000 }, profiles: {}, loopback: true });
  assert.equal(adapter.name, "command");
  const envelope = { context: { topics: [], active_decisions: [] } };
  const logs = [];
  const { note, attempts, warnings } = await summarize(adapter, envelope, { log: (l) => logs.push(l) });
  assert.equal(note.title, "Fixed on retry");
  assert.equal(attempts, 2);
  assert.match(warnings[0], /needed a retry/);
  assert.match(logs[0], /attempt 1 returned an invalid note/);

  const broken = createAdapter({ summarizer: { adapter: "command", command: process.execPath, args: ["-e", "process.exit(3)"], timeoutMs: 10000 }, profiles: {}, loopback: true });
  await assert.rejects(summarize(broken, envelope), /exited 3/);
  const slow = createAdapter({ summarizer: { adapter: "command", command: process.execPath, args: ["-e", "setTimeout(()=>{}, 5000)"], timeoutMs: 200 }, profiles: {}, loopback: true });
  await assert.rejects(summarize(slow, envelope), /no answer within 200 ms/);
  assert.throws(() => createAdapter({ summarizer: { adapter: "nope" }, profiles: {} }), /unknown summarizer adapter/);
  assert.throws(() => createAdapter({ summarizer: { adapter: "openai-compatible", profile: "x" }, profiles: {} }), /profile x is not configured/);
  assert.equal(createAdapter({ profiles: {} }), null);
});

test("the breaker opens after five failures or a rate limit and doubles its pause", () => {
  const b = new Breaker();
  for (let i = 0; i < 4; i += 1) assert.equal(b.failure(), 0);
  assert.equal(b.isOpen(), false);
  assert.equal(b.failure(), 600_000);
  assert.equal(b.isOpen(), true);
  b.openUntil = 0;
  b.success();
  assert.equal(b.failures, 0);
  assert.equal(b.failure({ rateLimited: true }), 1_200_000);
  assert.match(b.state().until, /^\d{4}-/);
});

test("the envelope shows an image as its caption only: no id, no link, and the generated description when present", () => {
  const dir = tmpDataDir();
  try {
    const kb = new KnowledgeStore(path.join(dir, "kb"));
    const r = rooms.createRoom({ title: "Pictures", objective: "Look", creator: { name: "a", kind: "agent" } });
    rooms.registerAttachment(r, { id: "0123456789abcdef", type: "image/png", ext: "png", bytes: 68, width: 1, height: 1, by: "a" });
    rooms.setAutoCaption(r, "0123456789abcdef", "a teal square");
    rooms.sendMessage(r, { sender: "a", content: "the spike", attachment_id: "0123456789abcdef", caption: "latency spike at 14:02" }, 65536);
    rooms.closeRoom(r, { by: "a", kind: "agent", summary: "done" });
    const { envelope } = buildEnvelope(r, kb);
    const line = envelope.messages.find((m) => m.sender === "a" && m.kind === "agent");
    assert.equal(line.content, "the spike\n[image: latency spike at 14:02 (described as: a teal square)]");
    const json = JSON.stringify(envelope);
    assert.ok(!json.includes("0123456789abcdef"), "no attachment id reaches the summarizer");
    assert.ok(!json.includes("/attachments/"), "no link either");
    assert.ok(!("attachment" in line));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
