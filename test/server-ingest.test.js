import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

import { boot } from "./helpers.js";

// A fake OpenAI-compatible summarizer. `mode` decides what it returns.
let mode = "good";
const calls = [];
const fake = http.createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const parsed = JSON.parse(body);
  calls.push(parsed);
  const envelope = JSON.parse(parsed.messages.at(-1).content.replace(/^TRANSCRIPT ENVELOPE:\n/, ""));
  let content;
  if (mode === "fail") {
    res.writeHead(500);
    return res.end("{}");
  }
  if (mode === "bad" || (mode === "bad-then-good" && !envelope.retry)) {
    content = JSON.stringify({ title: "", summary: "s", topics: ["ghost"], decisions: [], human_involved: "no" });
  } else {
    content = `Here you go:\n${JSON.stringify({
      title: `Note for ${envelope.room.title}`,
      summary: "They agreed on the export contract. Exit codes are frozen. Nothing else changed.",
      topics: ["api-contract"],
      new_topics: envelope.context.topics.some((t) => t.name === "api-contract") ? [] : [{ name: "api-contract", reason: "CLI contracts had no topic" }],
      decisions: [{ topic: "api-contract", statement: "The export command defaults to JSON.", rationale: "Machine readable.", supersedes: [], confidence: "unanimous", provisional: false }],
      open_questions: [],
      action_items: [{ owner: "consumer-app", text: "Write contract tests." }],
      participants_summary: {},
      human_involved: envelope.participants.some((p) => p.kind === "human"),
    })}`;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
});
before(() => new Promise((r) => fake.listen(0, "127.0.0.1", r)));
after(() => fake.close());

const cfg = (extra = {}) => ({
  extra: {
    profiles: { summ: { base_url: `http://127.0.0.1:${fake.address().port}/v1`, model: "fake-summ", timeout_ms: 5000 } },
    summarizer: { adapter: "openai-compatible", profile: "summ", timeout_ms: 5000 },
    ...extra,
  },
});

async function meeting(s, title = "Export contract") {
  const { data } = await s.req("POST", "/api/rooms", { body: { title, objective: "Agree flags", name: "tool-builder" } });
  const code = data.room.code;
  await s.req("POST", `/api/rooms/${code}/join`, { body: { name: "consumer-app" } });
  await s.req("POST", `/api/rooms/${code}/join`, { body: { name: "Ana", kind: "human" } });
  await s.req("POST", `/api/rooms/${code}/messages`, { body: { sender: "tool-builder", content: "Proposal: --format json" } });
  await s.req("POST", `/api/rooms/${code}/messages`, { body: { sender: "consumer-app", content: "Agreed." } });
  return code;
}
const get = async (s, code) => (await s.req("GET", `/api/rooms/${code}`)).data.room;
async function until(s, code, pred, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await get(s, code);
    if (pred(r)) return r;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error(`condition not met for ${code}: ${(await get(s, code)).status} ${JSON.stringify((await get(s, code)).ingest)}`);
}

test("a closed meeting passes through closing and lands in the knowledge store", async () => {
  mode = "good";
  const s = await boot(cfg());
  try {
    const code = await meeting(s);
    const closed = await s.req("POST", `/api/rooms/${code}/close`, { body: { name: "Ana", summary: "Done." } });
    assert.equal(closed.status, 200);
    const room = await until(s, code, (r) => r.status === "closed" && r.ingest?.status === "done");
    assert.match(room.ingest.note_id, /^M\d{8}-/);
    assert.match(room.messages.at(-1).content, /Summary written: M\d{8}-\w{4} with 1 decision\./);
    assert.equal(room.ingest.attempts, 1);

    const meetings = (await s.req("GET", "/api/kb/meetings")).data.meetings;
    assert.equal(meetings.length, 1);
    assert.equal(meetings[0].title, "Note for Export contract");
    assert.equal(meetings[0].human_involved, true);
    const note = (await s.req("GET", `/api/kb/meetings/${room.ingest.note_id}`)).data.meeting;
    assert.match(note.markdown, /## Decisions\n\n- \*\*D-M\d{8}-\w{4}-01\*\* \(api-contract, unanimous\): The export command defaults to JSON\./);
    const decisions = (await s.req("GET", "/api/kb/decisions?status=active")).data.decisions;
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].topic, "api-contract");
    assert.deepEqual((await s.req("GET", "/api/kb/topics")).data.topics.map((t) => t.name), ["api-contract"]);
    const index = await fetch(`${s.base}/api/kb/index`, { headers: { authorization: `Bearer ${s.token}` } });
    assert.match(index.headers.get("content-type"), /text\/markdown/);
    assert.match(await index.text(), /### api-contract/);
    assert.ok(fs.existsSync(path.join(s.config.kbDir, "transcripts", `${code}.json`)));
    const ledger = JSON.parse(fs.readFileSync(path.join(s.dataDir, "ingested.json"), "utf8"));
    assert.equal(ledger.rooms[code].status, "done");
    assert.equal(ledger.rooms[code].adapter, "openai-compatible");

    // The request the summarizer saw carried the vocabulary and no secrets.
    const last = calls.at(-1);
    assert.equal(last.model, "fake-summ");
    assert.deepEqual(last.response_format, { type: "json_object" });
    assert.match(last.messages[0].content, /Return one JSON object/);

    // A second meeting on the same topic sees the first decision in context.
    const code2 = await meeting(s, "Second");
    await s.req("POST", `/api/rooms/${code2}/messages`, { body: { sender: "tool-builder", content: "Revisiting the api-contract from last time." } });
    await s.req("POST", `/api/rooms/${code2}/close`, { body: { name: "Ana" } });
    await until(s, code2, (r) => r.ingest?.status === "done");
    const env2 = JSON.parse(calls.at(-1).messages.at(-1).content.replace(/^TRANSCRIPT ENVELOPE:\n/, ""));
    assert.equal(env2.context.active_decisions.length, 1, "prior active decision on a mentioned topic is in context");
    assert.equal((await s.req("GET", "/api/health")).data.ingest.adapter.name, "openai-compatible");
  } finally {
    await s.close();
  }
});

test("an invalid note is retried with the errors, and a repeat failure leaves the ingest pending while the room keeps closing", async () => {
  mode = "bad-then-good";
  const s = await boot(cfg());
  try {
    const code = await meeting(s);
    await s.req("POST", `/api/rooms/${code}/close`, { body: { name: "Ana" } });
    const room = await until(s, code, (r) => r.ingest?.status === "done");
    assert.match(room.messages.at(-1).content, /Summary written/);
    const note = (await s.req("GET", `/api/kb/meetings/${room.ingest.note_id}`)).data.meeting;
    assert.match(note.markdown, /## Notes from ingest\n\n- the summarizer needed a retry: title must be/);

    mode = "bad";
    const code2 = await meeting(s, "Broken");
    await s.req("POST", `/api/rooms/${code2}/close`, { body: { name: "Ana" } });
    const r2 = await until(s, code2, (r) => r.ingest?.status === "pending");
    assert.equal(r2.status, "closing", "still closing: the deadline has not passed");
    assert.match(r2.ingest.last_error, /failed validation after 2 attempts/);
    assert.match(r2.messages.at(-1).content, /could not be written yet/);
    assert.equal((await s.req("GET", "/api/health")).data.ingest.pending, 1);

    // A human decides not to wait: close without a note.
    const skipped = await s.req("POST", `/api/rooms/${code2}/ingest`, { body: { action: "skip", name: "Ana" } });
    assert.equal(skipped.status, 200);
    assert.equal(skipped.data.ingest.status, "skipped");
    assert.equal((await get(s, code2)).status, "closed");
    const agentSkip = await s.req("POST", `/api/rooms/${code2}/ingest`, { body: { action: "skip" } });
    assert.equal(agentSkip.status, 403);

    // Forcing a rerun once the summarizer behaves writes the note after all.
    mode = "good";
    const forced = await s.req("POST", `/api/rooms/${code2}/ingest`, { body: { force: true } });
    assert.equal(forced.status, 200);
    assert.equal(forced.data.ingest.status, "done");
  } finally {
    await s.close();
  }
});

test("the closing state times out, a human wait extends it, and the breaker opens on repeated failures", async () => {
  mode = "fail";
  const s = await boot(cfg({ closing_max_seconds: 1 }));
  try {
    const code = await meeting(s);
    await s.req("POST", `/api/rooms/${code}/close`, { body: { name: "Ana" } });
    const r = await until(s, code, (x) => x.ingest?.status === "pending");
    assert.equal(r.status, "closing");
    assert.match(r.ingest.last_error, /HTTP 500/);
    // Wait for ingest extends the closing deadline.
    const wait = await s.req("POST", `/api/rooms/${code}/wait`, { body: { name: "Ana", for: "ingest", seconds: 3 } });
    assert.equal(wait.status, 200);
    await new Promise((res) => setTimeout(res, 1200));
    await s.app.service.tick();
    assert.equal((await get(s, code)).status, "closing", "grace keeps it closing past the max age");
    await new Promise((res) => setTimeout(res, 2200));
    const tick = await s.app.service.tick();
    assert.deepEqual(tick.timed_out, [code]);
    const done = await get(s, code);
    assert.equal(done.status, "closed");
    assert.equal(done.ingest.status, "pending");
    assert.match(done.messages.at(-1).content, /closed before its summary was written/);

    // Four more failures open the breaker; the next ingest goes pending without a call.
    const before = calls.length;
    for (let i = 0; i < 4; i += 1) await s.req("POST", `/api/rooms/${code}/ingest`, { body: { force: true } });
    const health = (await s.req("GET", "/api/health")).data.ingest;
    assert.equal(health.breaker.open, true);
    const during = calls.length;
    const blocked = await s.req("POST", `/api/rooms/${code}/ingest`, { body: { force: true } });
    assert.match(blocked.data.ingest.last_error, /breaker open until/);
    assert.equal(calls.length, during, "no call while the breaker is open");
    assert.ok(calls.length > before);
  } finally {
    await s.close();
  }
});

test("without a summarizer rooms close directly with ingest skipped; abandoned rooms are never ingested", async () => {
  const s = await boot();
  try {
    const code = await meeting(s);
    await s.req("POST", `/api/rooms/${code}/close`, { body: { name: "Ana" } });
    const r = await get(s, code);
    assert.equal(r.status, "closed");
    assert.equal(r.ingest.status, "skipped");
    assert.equal(r.ingest.reason, "no summarizer configured");
    const attempt = await s.req("POST", `/api/rooms/${code}/ingest`, { body: {} });
    assert.equal(attempt.status, 409);
    assert.equal((await s.req("GET", "/api/health")).data.ingest.adapter, null);
    assert.deepEqual((await s.req("GET", "/api/kb/meetings")).data.meetings, []);
  } finally {
    await s.close();
  }
});
