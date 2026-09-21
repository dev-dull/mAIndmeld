import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { boot } from "./helpers.js";
import { KnowledgeStore } from "../src/kb.js";

const D = (id, topic, statement, date, extra = {}) => ({ id, meeting: `M-${id}`, topic, status: "active", statement, rationale: "", date, created_at: `${date}T12:00:00Z`, supersedes: [], ...extra });

function seed(s) {
  const kb = new KnowledgeStore(s.config.kbDir);
  kb.saveTopics([{ name: "retry-policy", description: "", aliases: [], created: "2026-09-01" }, { name: "api-contract", description: "", aliases: [], created: "2026-09-01" }]);
  kb.saveDecisions([
    D("D-1", "retry-policy", "Retries are capped at three attempts with exponential backoff.", "2026-09-01"),
    D("D-2", "retry-policy", "Only idempotent operations are retried.", "2026-09-02"),
    D("D-3", "api-contract", "The export command defaults to JSON on stdout.", "2026-09-03"),
    D("D-4", "api-contract", "Exit codes 0 through 3 are frozen.", "2026-09-04"),
    D("D-5", "api-contract", "The export command paginates with an opaque cursor.", "2026-09-05"),
    D("D-6", "api-contract", "The export command supports --since and --until.", "2026-09-06"),
    D("D-7", "api-contract", "Old rule.", "2026-08-01", { status: "superseded" }),
  ]);
  kb.writeIndex();
  return kb;
}

test("search endpoint and join-time injection, capped", async () => {
  const s = await boot({ extra: { search: { inject_limit: 3 } } });
  try {
    seed(s);
    const r = await s.req("GET", "/api/kb/search?q=export%20command%20stdout&k=2");
    assert.equal(r.status, 200);
    assert.equal(r.data.results.length, 2);
    assert.equal(r.data.results[0].id, "D-3");
    assert.equal(r.data.embeddings.enabled, false);
    assert.equal((await s.req("GET", "/api/kb/search?q=%20")).status, 400);

    const created = await s.req("POST", "/api/rooms", { body: { title: "Export command flags", objective: "Decide the export command's output and exit codes", name: "a" } });
    assert.equal(created.status, 201);
    assert.ok(created.data.prior_decisions.length <= 3, "capped by inject_limit");
    assert.ok(created.data.prior_decisions.length >= 2);
    assert.ok(created.data.prior_decisions.every((d) => d.statement && d.id && !("rationale" in d)), "statements only");
    const joined = await s.req("POST", `/api/rooms/${created.data.room.code}/join`, { body: { name: "b" } });
    assert.ok(joined.data.prior_decisions.some((d) => d.id === "D-3"));
    const quiet = await s.req("POST", "/api/rooms", { body: { title: "Lunch", objective: "Where to eat", name: "a" } });
    assert.deepEqual(quiet.data.prior_decisions, [], "no injection when nothing matches");
    assert.equal((await s.req("GET", "/api/health")).data.search.inject_limit, 3);
  } finally {
    await s.close();
  }
});

test("the human brief says why they were called and what is needed", async () => {
  const s = await boot();
  try {
    const code = (await s.req("POST", "/api/rooms", { body: { title: "Budget", objective: "Approve retries", name: "a" } })).data.room.code;
    await s.req("POST", `/api/rooms/${code}/join`, { body: { name: "b" } });
    const before = await s.req("GET", `/api/rooms/${code}/brief`);
    assert.equal(before.data.called, null);
    assert.match(before.data.needed, /No human has been called/);
    await s.req("POST", `/api/rooms/${code}/messages`, { body: { sender: "a", content: "Proposal: three retries." } });
    await s.req("POST", `/api/rooms/${code}/motions`, { body: { type: "call_human", reason: "billing owner needed", name: "a" } });
    await s.req("POST", `/api/rooms/${code}/motions/1/vote`, { body: { vote: "yes", name: "b" } });
    await s.req("POST", `/api/rooms/${code}/messages`, { body: { sender: "b", content: "deciding provisionally" } });
    const brief = await s.req("GET", `/api/rooms/${code}/brief`);
    assert.equal(brief.data.called.how, "motion");
    assert.equal(brief.data.called.by, "a");
    assert.equal(brief.data.called.reason, "billing owner needed");
    assert.deepEqual(brief.data.called.tally.yes, ["a", "b"]);
    assert.match(brief.data.needed, /acknowledge the call.*or dismiss/);
    assert.equal(brief.data.provisional_messages, 1);
    assert.equal(brief.data.recent.at(-1).provisional, true);
    assert.ok(!brief.data.recent.some((m) => m.kind === "system"));
    await s.req("POST", `/api/rooms/${code}/join`, { body: { name: "Ana", kind: "human" } });
    const present = await s.req("GET", `/api/rooms/${code}/brief`);
    assert.match(present.data.needed, /You are present/);
    assert.match(present.data.url, new RegExp(`/rooms/${code}$`));
  } finally {
    await s.close();
  }
});

test("sweep endpoints: run, list, read, human-only decide; the scheduler runs a due sweep", async () => {
  const s = await boot({ extra: { sweep: { interval_days: 1 } } });
  try {
    seed(s);
    const kb = new KnowledgeStore(s.config.kbDir);
    const all = kb.decisions();
    all.push(D("D-8", "retry-policy", "Retries are capped at five attempts with exponential backoff.", "2026-09-10"));
    kb.saveDecisions(all);

    const run = await s.req("POST", "/api/kb/sweeps/run", { body: { all: true } });
    assert.equal(run.status, 201, JSON.stringify(run.data));
    const id = run.data.sweep.id;
    assert.ok(run.data.sweep.proposals.some((p) => p.older === "D-1" && p.newer === "D-8"));
    const list = await s.req("GET", "/api/kb/sweeps");
    assert.equal(list.data.sweeps[0].id, id);
    assert.equal(list.data.state.last_sweep_id, id);
    assert.equal((await s.req("GET", `/api/kb/sweeps/${id}`)).data.sweep.id, id);
    assert.equal((await s.req("GET", "/api/kb/sweeps/S-nope")).status, 404);

    const n = run.data.sweep.proposals.findIndex((p) => p.older === "D-1") + 1;
    const noName = await s.req("POST", `/api/kb/sweeps/${id}/proposals/${n}`, { body: { action: "apply" } });
    assert.equal(noName.status, 403, "a bare token is not a human");
    const applied = await s.req("POST", `/api/kb/sweeps/${id}/proposals/${n}`, { body: { action: "apply", name: "Ana" } });
    assert.equal(applied.status, 200);
    assert.equal(applied.data.proposal.decision.by, "Ana");
    assert.equal(kb.decisions().find((d) => d.id === "D-1").status, "superseded");
    const again = await s.req("POST", `/api/kb/sweeps/${id}/proposals/${n}`, { body: { action: "reject", name: "Ana" } });
    assert.equal(again.status, 409);

    // Sessions decide under their display name.
    const login = await s.req("POST", "/api/session", { token: null, origin: s.config.publicOrigin, body: { token: s.token, name: "Bo" } });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const runTwo = await s.req("POST", "/api/kb/sweeps/run", { token: null, cookie, origin: s.config.publicOrigin, body: { all: true } });
    assert.equal(runTwo.status, 201);
    assert.equal(runTwo.data.sweep.proposals.filter((p) => p.type === "supersede").length, 0, "the applied pair is not proposed again");

    // The scheduler: force the last sweep into the past and tick.
    const health = await s.req("GET", "/api/health");
    assert.equal(health.data.sweep.interval_days, 1);
    kb.writeAtomic(path.join(kb.dir, "state.json"), JSON.stringify({ last_sweep_at: "2026-01-01T00:00:00Z", last_sweep_id: id }));
    const tick = await s.app.service.tick();
    assert.match(tick.sweep, /^S\d{8}-/);
    const sweeps = (await s.req("GET", "/api/kb/sweeps")).data.sweeps;
    assert.equal(sweeps.length, 3);
    assert.equal((await s.app.service.tick()).sweep, null, "not due again");
  } finally {
    await s.close();
  }
});
