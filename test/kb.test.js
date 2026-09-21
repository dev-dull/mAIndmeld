import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { KnowledgeStore, meetingIdFor, slugify, topicsToYaml, topicsFromYaml, parseFrontMatter } from "../src/kb.js";
import * as rooms from "../src/rooms.js";
import { tmpDataDir } from "./helpers.js";

const T0 = Date.parse("2026-09-20T12:00:00Z");

function closedRoom(code = "MM-K7QD", title = "Export contract") {
  const room = rooms.createRoom({ title, objective: "Agree flags", creator: { name: "tool-builder", kind: "agent" }, code }, T0);
  rooms.joinRoom(room, { name: "consumer-app", kind: "agent" }, T0);
  rooms.joinRoom(room, { name: "Ana", kind: "human" }, T0);
  rooms.sendMessage(room, { sender: "tool-builder", content: "Proposal: --format json" }, 10000, T0);
  rooms.sendMessage(room, { sender: "consumer-app", content: "Agreed." }, 10000, T0);
  rooms.closeRoom(room, { by: "Ana", kind: "human", summary: "Done." }, T0);
  room.status = "closed";
  return room;
}

const note = (over = {}) => ({
  title: "Export contract agreed",
  summary: "The builder proposed json output. The consumer agreed. Exit codes are frozen.",
  topics: ["api-contract"],
  new_topics: [{ name: "api-contract", reason: "No topic covered CLI contracts." }],
  decisions: [
    { topic: "api-contract", statement: "The export command defaults to JSON on stdout.", rationale: "Machine readable.", supersedes: [], confidence: "unanimous", provisional: false },
    { topic: "api-contract", statement: "Exit codes 0/1/2/3 are frozen.", rationale: "", supersedes: [], confidence: "majority", provisional: true },
  ],
  open_questions: ["Does --strict apply to GETs?"],
  action_items: [{ owner: "consumer-app", text: "Write contract tests." }],
  participants_summary: { "tool-builder": "proposed the contract", Ana: "approved" },
  human_involved: true,
  ...over,
});

test("ids and slugs", () => {
  const room = closedRoom();
  assert.equal(meetingIdFor(room), "M20260920-K7QD");
  assert.equal(slugify("Export: the CLI contract! (v2)"), "export-the-cli-contract-v2");
  assert.equal(slugify("   "), "meeting");
});

test("topics.yaml round-trips through the subset writer and reader", () => {
  const topics = [
    { name: "api-contract", description: "CLI and API contracts, incl. exit codes", aliases: ["contract", "exit codes"], created: "2026-09-20" },
    { name: "retry-policy", description: 'Retries: "when and how many"', aliases: [], created: "2026-09-20" },
  ];
  const text = topicsToYaml(topics);
  assert.match(text, /^  - name: api-contract$/m);
  assert.deepEqual(topicsFromYaml(text), topics);
  assert.throws(() => topicsFromYaml("topics:\n  - name: x\n  bogus: y\n"), /unexpected line/);
});

test("writeNote lays out the store, numbers decisions per meeting, and builds the index", () => {
  const dir = tmpDataDir();
  const kb = new KnowledgeStore(path.join(dir, "kb"));
  const room = closedRoom();
  const r = kb.writeNote(room, note(), { adapter: "command", model: "fake" });
  assert.equal(r.meetingId, "M20260920-K7QD");
  assert.deepEqual(r.decisionIds, ["D-M20260920-K7QD-01", "D-M20260920-K7QD-02"]);
  assert.deepEqual(r.topicsAdded, ["api-contract"]);
  assert.equal(r.notePath, "meetings/2026/2026-09-20-MM-K7QD-export-contract.md");

  assert.ok(fs.existsSync(path.join(kb.dir, "transcripts", "MM-K7QD.json")));
  const md = fs.readFileSync(path.join(kb.dir, r.notePath), "utf8");
  const fm = parseFrontMatter(md);
  assert.equal(fm.id, "M20260920-K7QD");
  assert.deepEqual(fm.participants, ["tool-builder", "consumer-app", "Ana"]);
  assert.deepEqual(fm.decisions, r.decisionIds);
  assert.equal(fm.human_involved, true);
  assert.deepEqual(fm.summarizer, { adapter: "command", model: "fake" });
  for (const h of ["## Summary", "## Decisions", "## Open questions", "## Action items", "## Participants"]) assert.ok(md.includes(h), h);
  assert.match(md, /\*\*D-M20260920-K7QD-02\*\* \(api-contract, provisional, majority\)/);

  const d1 = fs.readFileSync(path.join(kb.dir, "decisions", "D-M20260920-K7QD-01.md"), "utf8");
  assert.match(d1, /^---\nid: D-M20260920-K7QD-01\ntopic: api-contract\nstatus: active/);
  assert.match(d1, /---\nThe export command defaults to JSON on stdout\.\n\nRationale: Machine readable\./);
  const jsonl = kb.decisions();
  assert.equal(jsonl.length, 2);
  assert.equal(jsonl[1].provisional, true);

  const index = kb.index();
  assert.match(index, /### api-contract\n\n- D-M20260920-K7QD-01 \(2026-09-20\): The export command defaults to JSON on stdout\./);
  assert.match(index, /## Provisional decisions[\s\S]*D-M20260920-K7QD-02/);
  assert.match(index, /## Topics\n\n- api-contract: No topic covered CLI contracts\./);
  assert.match(index, /## Recent meetings\n\n- 2026-09-20 M20260920-K7QD: Export contract agreed \(2 decisions\)/);

  assert.throws(() => kb.writeNote(room, note(), { adapter: "command" }), /use resummarize/);
  assert.equal(kb.listMeetings().length, 1);
  assert.equal(kb.readMeeting("M20260920-K7QD").title, "Export contract agreed");
  assert.equal(kb.readMeeting("M-nope"), null);
});

test("close-time supersession marks the older decision, and resummarize retires and renumbers", () => {
  const dir = tmpDataDir();
  const kb = new KnowledgeStore(path.join(dir, "kb"));
  kb.writeNote(closedRoom("MM-AAAA", "First"), note(), { adapter: "command" });
  const later = closedRoom("MM-BBBB", "Second");
  later.closed_at = "2026-09-21T12:00:00Z";
  const n2 = note({
    new_topics: [],
    decisions: [{ topic: "api-contract", statement: "The export command defaults to NDJSON on stdout.", rationale: "Streaming.", supersedes: ["D-M20260920-AAAA-01"], confidence: "unanimous" }],
  });
  const r2 = kb.writeNote(later, n2, { adapter: "command" });
  assert.deepEqual(r2.superseded, ["D-M20260920-AAAA-01"]);
  const all = kb.decisions();
  const old = all.find((d) => d.id === "D-M20260920-AAAA-01");
  assert.equal(old.status, "superseded");
  assert.equal(old.superseded_by, "D-M20260921-BBBB-01");
  assert.match(kb.index(), /D-M20260921-BBBB-01/);
  assert.ok(!/D-M20260920-AAAA-01 \(/.test(kb.index()), "superseded decisions leave the active index");

  // Resummarize the first meeting: old ids retire, new ids continue numbering.
  const r3 = kb.writeNote(closedRoom("MM-AAAA", "First"), note({ decisions: [note().decisions[0]] }), { adapter: "command", resummarize: true });
  assert.deepEqual(r3.decisionIds, ["D-M20260920-AAAA-03"]);
  const retired = kb.decisions().filter((d) => d.meeting === "M20260920-AAAA" && d.status === "retired_by_resummarize");
  assert.equal(retired.length, 2);
  assert.deepEqual(retired[0].replaced_by, ["D-M20260920-AAAA-03"]);
  assert.match(fs.readFileSync(path.join(kb.dir, "meetings", "2026", "2026-09-20-MM-AAAA-first.md"), "utf8"), /_Resummarized/);
});
