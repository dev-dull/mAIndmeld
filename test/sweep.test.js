import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { findCandidates, findTopicMerges, modelCandidates, runSweep, decideProposal, SweepStore } from "../src/sweep.js";
import { KnowledgeStore } from "../src/kb.js";
import { tmpDataDir } from "./helpers.js";

const D = (id, topic, statement, date, extra = {}) => ({ id, meeting: `M-${id}`, topic, status: "active", statement, rationale: "", date, created_at: `${date}T12:00:00Z`, supersedes: [], ...extra });

test("rule A catches near-identical statements and rule B catches changed values on the same subject", () => {
  const { proposals, remaining } = findCandidates([
    D("a1", "retry-policy", "Retries are capped at three attempts with exponential backoff.", "2026-09-01"),
    D("a2", "retry-policy", "Retries are capped at five attempts with exponential backoff.", "2026-09-10"),
    D("b1", "api-contract", "The export command defaults to JSON on stdout.", "2026-09-01"),
    D("b2", "api-contract", "The export command defaults to NDJSON on stdout.", "2026-09-12"),
    D("c1", "api-contract", "Exit codes are frozen.", "2026-09-03"),
    D("p", "retry-policy", "Provisional thing.", "2026-09-11", { provisional: true }),
  ]);
  const a = proposals.find((p) => p.older === "a1");
  assert.equal(a.newer, "a2");
  assert.equal(a.rule, "A");
  assert.equal(a.confidence, "high");
  const b = proposals.find((p) => p.older === "b1" && p.newer === "b2");
  assert.ok(b, "json vs ndjson on the same subject");
  assert.ok(remaining.some((r) => r.older.id === "b1" && r.newer.id === "c1"), "unrelated pair left for the model");
  assert.ok(!proposals.some((p) => p.older === "p" || p.newer === "p"), "provisional decisions are skipped");
});

test("reviewed pairs are never proposed again", () => {
  const { proposals } = findCandidates([
    D("x1", "t", "Retries are capped at three attempts.", "2026-09-01", { reviewed_pairs: ["x1|x2"] }),
    D("x2", "t", "Retries are capped at five attempts.", "2026-09-02"),
  ]);
  assert.deepEqual(proposals, []);
});

test("topic merge proposals: aliases, prefixes, near names", () => {
  const merges = findTopicMerges([
    { name: "retry-policy", aliases: ["retries"] },
    { name: "retries", aliases: [] },
    { name: "retry-policy-export", aliases: [] },
    { name: "billing", aliases: [] },
    { name: "biling", aliases: [] },
    { name: "api-contract", aliases: [] },
  ]);
  const pairs = merges.map((m) => m.topics.join("+"));
  assert.ok(pairs.includes("retry-policy+retries"));
  assert.ok(pairs.includes("retry-policy+retry-policy-export"));
  assert.ok(pairs.includes("billing+biling"));
  assert.ok(!pairs.some((p) => p.includes("api-contract")));
});

test("the model pass proposes only 'needs review' and stops on failure", async () => {
  const asked = [];
  const adapter = { ask: async (q) => { asked.push(q); return asked.length === 1 ? "yes\nThey set different caps." : "no\nDifferent subjects."; } };
  const pairs = [
    { topic: "t", older: D("o", "t", "cap three", "2026-09-01"), newer: D("n", "t", "cap five", "2026-09-02") },
    { topic: "t", older: D("o2", "t", "blue", "2026-09-01"), newer: D("n2", "t", "sky", "2026-09-02") },
  ];
  const out = await modelCandidates(adapter, pairs);
  assert.equal(out.length, 1);
  assert.equal(out[0].confidence, "needs review");
  assert.equal(out[0].rule, "model");
  assert.match(out[0].reason, /different caps/);
  const failing = { ask: async () => { throw new Error("boom"); } };
  assert.deepEqual(await modelCandidates(failing, pairs), []);
  assert.deepEqual(await modelCandidates(null, pairs), []);
  const capped = await modelCandidates({ ask: async () => "yes\nx" }, pairs, { max: 1 });
  assert.equal(capped.length, 1);
});

test("runSweep writes a report and state, scopes to touched topics, and decideProposal applies or rejects", async () => {
  const kb = new KnowledgeStore(path.join(tmpDataDir(), "kb"));
  kb.saveTopics([{ name: "retry-policy", description: "", aliases: [], created: "2026-09-01" }, { name: "api-contract", description: "", aliases: [], created: "2026-09-01" }]);
  kb.saveDecisions([
    D("D-1", "retry-policy", "Retries are capped at three attempts.", "2026-09-01"),
    D("D-2", "retry-policy", "Retries are capped at five attempts.", "2026-09-10"),
    D("D-3", "api-contract", "The export command defaults to JSON on stdout.", "2026-09-05"),
  ]);
  const t1 = Date.parse("2026-09-15T10:00:00Z");
  const r1 = await runSweep(kb, null, { now: t1 });
  assert.match(r1.id, /^S20260915-100000$/);
  assert.deepEqual(r1.topics_checked, ["api-contract", "retry-policy"]);
  assert.equal(r1.proposals.length, 1);
  assert.equal(r1.proposals[0].older, "D-1");
  const store = new SweepStore(kb);
  assert.equal(store.state().last_sweep_id, r1.id);
  assert.ok(fs.existsSync(path.join(kb.dir, "sweeps", `${r1.id}.md`)));
  assert.match(fs.readFileSync(path.join(kb.dir, "sweeps", `${r1.id}.md`), "utf8"), /1\. \*\*Supersede\*\* D-1 with D-2/);
  assert.equal(store.list()[0].id, r1.id);

  // A second sweep only looks at topics touched since the first.
  const all = kb.decisions();
  all.push(D("D-4", "api-contract", "The export command defaults to NDJSON on stdout.", "2026-09-16", { created_at: "2026-09-16T09:00:00Z" }));
  kb.saveDecisions(all);
  const r2 = await runSweep(kb, null, { now: Date.parse("2026-09-22T10:00:00Z") });
  assert.deepEqual(r2.topics_checked, ["api-contract"]);
  assert.equal(r2.proposals.length, 1);
  assert.equal(r2.proposals[0].older, "D-3");

  // Reject the second, apply the first; nothing is deleted; reviewed pairs stick.
  const rejected = decideProposal(kb, r2.id, 1, { action: "reject", by: "Ana" });
  assert.equal(rejected.decision.action, "rejected");
  assert.equal(kb.decisions().find((d) => d.id === "D-3").status, "active");
  const applied = decideProposal(kb, r1.id, 1, { action: "apply", by: "Ana" });
  assert.equal(applied.decision.action, "applied");
  const d1 = kb.decisions().find((d) => d.id === "D-1");
  assert.equal(d1.status, "superseded");
  assert.equal(d1.superseded_by, "D-2");
  assert.equal(d1.reviewed_by, "Ana");
  assert.deepEqual(d1.reviewed_pairs, ["D-1|D-2"]);
  assert.throws(() => decideProposal(kb, r1.id, 1, { action: "apply", by: "Bo" }), /already applied/);
  assert.throws(() => decideProposal(kb, r1.id, 9, { action: "apply", by: "Bo" }), /no proposal 9/);
  assert.throws(() => decideProposal(kb, "S-nope", 1, { action: "apply", by: "Bo" }), /no sweep/);
  const r3 = await runSweep(kb, null, { all: true, now: Date.parse("2026-09-23T10:00:00Z") });
  assert.equal(r3.proposals.length, 0, "applied and rejected pairs are not proposed again");
  assert.match(kb.index(), /D-2/);
  assert.ok(!/- D-1 \(/.test(kb.index()));
});
