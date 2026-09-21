// The sweep: find pairs of active decisions on one topic that may conflict,
// deterministic rules first and a model second, and write a report of
// proposals. The sweep never retires anything; a human applies a proposal.
// DESIGN.md 12 and decision 8.

import fs from "node:fs";
import path from "node:path";

import { tokenize } from "./search.js";

const iso = (ms) => new Date(ms).toISOString();
const dateOf = (ms) => iso(ms).slice(0, 10);

function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

const NUMBER_OR_ENUM = /\b(\d+(?:\.\d+)?|json|csv|ndjson|yaml|xml|true|false|on|off|enabled|disabled|always|never)\b/gi;

function valueTokens(statement) {
  return [...new Set((statement.match(NUMBER_OR_ENUM) || []).map((v) => v.toLowerCase()))];
}

function subjectKey(statement) {
  return tokenize(statement).slice(0, 3).join(" ");
}

const pairKey = (a, b) => [a, b].sort().join("|");

/** Rule-based candidates among active decisions grouped by topic. */
export function findCandidates(decisions, { minJaccard = 0.5 } = {}) {
  const active = decisions.filter((d) => d.status === "active" && !d.provisional);
  const byTopic = new Map();
  for (const d of active) byTopic.set(d.topic, [...(byTopic.get(d.topic) || []), d]);
  const proposals = [];
  const remaining = [];
  for (const [topic, list] of byTopic) {
    const sorted = [...list].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const older = sorted[i];
        const newer = sorted[j];
        const reviewed = new Set([...(older.reviewed_pairs || []), ...(newer.reviewed_pairs || [])]);
        if (reviewed.has(pairKey(older.id, newer.id))) continue;
        const ta = tokenize(older.statement);
        const tb = tokenize(newer.statement);
        const sim = jaccard(ta, tb);
        if (sim >= minJaccard) {
          proposals.push({ type: "supersede", topic, older: older.id, newer: newer.id, rule: "A", confidence: "high", reason: `statements share ${Math.round(sim * 100)}% of their content words`, similarity: Number(sim.toFixed(2)) });
          continue;
        }
        const va = valueTokens(older.statement);
        const vb = valueTokens(newer.statement);
        if (va.length && vb.length && subjectKey(older.statement) === subjectKey(newer.statement) && va.join(",") !== vb.join(",")) {
          proposals.push({ type: "supersede", topic, older: older.id, newer: newer.id, rule: "B", confidence: "high", reason: `same subject, different values (${va.join("/")} vs ${vb.join("/")})` });
          continue;
        }
        remaining.push({ topic, older, newer });
      }
    }
  }
  return { proposals, remaining };
}

/** Topic pairs that look like duplicates. */
export function findTopicMerges(topics) {
  const out = [];
  const names = topics.map((t) => t.name);
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      const a = names[i];
      const b = names[j];
      const aliasHit = (topics[i].aliases || []).includes(b) || (topics[j].aliases || []).includes(a);
      const prefix = a.startsWith(`${b}-`) || b.startsWith(`${a}-`);
      const close = editDistance(a, b) <= 2 && Math.min(a.length, b.length) >= 5;
      if (aliasHit || prefix || close) out.push({ type: "topic_merge", topics: [a, b], reason: aliasHit ? "one is an alias of the other" : prefix ? "one name extends the other" : "names differ by two characters or fewer" });
    }
  }
  return out;
}

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) for (let j = 1; j <= b.length; j += 1) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

/** Ask the adapter's model whether two decisions conflict. Returns "needs review" proposals. */
export async function modelCandidates(adapter, pairs, { max = 40, log = () => {} } = {}) {
  if (!adapter?.ask) return [];
  const out = [];
  for (const { topic, older, newer } of pairs.slice(0, max)) {
    try {
      const answer = await adapter.ask(
        `Two decisions were recorded on the topic "${topic}".\nOlder (${older.date}): ${older.statement}\nNewer (${newer.date}): ${newer.statement}\n\nDoes the newer decision conflict with or replace the older one, such that only one can be followed? Answer "yes" or "no" on the first line and one sentence of reasoning on the second.`,
      );
      const [first, ...rest] = String(answer).trim().split("\n");
      if (/^\s*yes\b/i.test(first)) out.push({ type: "supersede", topic, older: older.id, newer: newer.id, rule: "model", confidence: "needs review", reason: (rest.join(" ").trim() || first).slice(0, 300) });
    } catch (error) {
      log(`sweep model pass: ${error.message}`);
      break;
    }
  }
  return out;
}

export class SweepStore {
  constructor(kb) {
    this.kb = kb;
    this.dir = path.join(kb.dir, "sweeps");
    this.stateFile = path.join(kb.dir, "state.json");
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  state() {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
    } catch {
      return { last_sweep_at: null, last_sweep_id: null };
    }
  }

  saveState(s) {
    this.kb.writeAtomic(this.stateFile, JSON.stringify(s, null, 2));
  }

  list() {
    return fs.readdirSync(this.dir).filter((f) => f.endsWith(".json")).sort().reverse().map((f) => JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8")));
  }

  read(id) {
    const file = path.join(this.dir, `${id}.json`);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  }

  save(report) {
    this.kb.writeAtomic(path.join(this.dir, `${report.id}.json`), JSON.stringify(report, null, 2));
    this.kb.writeAtomic(path.join(this.dir, `${report.id}.md`), renderReport(report));
  }
}

export function renderReport(r) {
  const lines = [`# Sweep ${r.id}`, "", `Ran ${r.ran_at} over ${r.topics_checked.length} topic${r.topics_checked.length === 1 ? "" : "s"}${r.all ? " (all)" : " touched since the last sweep"}. ${r.proposals.length} proposal${r.proposals.length === 1 ? "" : "s"}. Nothing was changed; apply or reject each with \`maindmeld sweep apply ${r.id} N\` or from the sweep page.`, ""];
  r.proposals.forEach((p, i) => {
    const n = i + 1;
    if (p.type === "supersede") lines.push(`${n}. **Supersede** ${p.older} with ${p.newer} (${p.topic}, rule ${p.rule}, ${p.confidence}): ${p.reason}${p.decision ? ` — ${p.decision.action} by ${p.decision.by} at ${p.decision.at}` : ""}`);
    else lines.push(`${n}. **Merge topics** ${p.topics.join(" and ")}: ${p.reason}${p.decision ? ` — ${p.decision.action} by ${p.decision.by} at ${p.decision.at}` : ""}`);
  });
  if (!r.proposals.length) lines.push("No proposals.");
  lines.push("");
  return lines.join("\n");
}

/** Run a sweep and write its report. Never changes a decision. */
export async function runSweep(kb, adapter, { all = false, now = Date.now(), maxModelPairs = 40, log = () => {} } = {}) {
  const store = new SweepStore(kb);
  const state = store.state();
  const since = all || !state.last_sweep_at ? null : state.last_sweep_at;
  const decisions = kb.decisions();
  // Both sides are ISO 8601 text (created_at is set by ingest), so string order is time order.
  const touched = since ? new Set(decisions.filter((d) => (d.created_at || d.date) > since).map((d) => d.topic)) : new Set(decisions.map((d) => d.topic));
  const scoped = decisions.filter((d) => touched.has(d.topic));
  const { proposals, remaining } = findCandidates(scoped);
  const fromModel = await modelCandidates(adapter, remaining, { max: maxModelPairs, log });
  const merges = findTopicMerges(kb.topics());
  const base = `S${dateOf(now).replace(/-/g, "")}-${iso(now).slice(11, 19).replace(/:/g, "")}`;
  let id = base;
  for (let n = 2; store.read(id); n += 1) id = `${base}-${n}`; // two sweeps in one second must not share a report
  const report = {
    id,
    ran_at: iso(now),
    since,
    all,
    topics_checked: [...touched].sort(),
    pairs_rule_checked: proposals.length + remaining.length,
    pairs_model_checked: adapter?.ask ? Math.min(remaining.length, maxModelPairs) : 0,
    proposals: [...proposals, ...fromModel, ...merges],
  };
  store.save(report);
  store.saveState({ last_sweep_at: iso(now), last_sweep_id: id });
  kb.writeIndex();
  return report;
}

/** A human applies or rejects proposal N of a sweep. */
export function decideProposal(kb, sweepId, n, { action, by, now = Date.now() }) {
  const store = new SweepStore(kb);
  const report = store.read(sweepId);
  if (!report) throw Object.assign(new Error(`no sweep ${sweepId}`), { status: 404 });
  const p = report.proposals[n - 1];
  if (!p) throw Object.assign(new Error(`sweep ${sweepId} has no proposal ${n}`), { status: 404 });
  if (p.decision) throw Object.assign(new Error(`proposal ${n} was already ${p.decision.action} by ${p.decision.by}`), { status: 409 });
  if (action !== "apply" && action !== "reject") throw Object.assign(new Error("action must be apply or reject"), { status: 400 });
  const stamp = iso(now);
  if (p.type === "supersede") {
    const all = kb.decisions();
    const older = all.find((d) => d.id === p.older);
    const newer = all.find((d) => d.id === p.newer);
    if (!older || !newer) throw Object.assign(new Error("a decision in the proposal no longer exists"), { status: 409 });
    const key = pairKey(older.id, newer.id);
    for (const d of [older, newer]) {
      d.reviewed_pairs = [...new Set([...(d.reviewed_pairs || []), key])];
      d.reviewed_by = by;
      d.updated_at = stamp;
    }
    if (action === "apply" && older.status === "active") {
      older.status = "superseded";
      older.superseded_by = newer.id;
    }
    kb.saveDecisions(all);
  }
  // Topic merges are recorded as decided; merging itself stays a manual edit of topics.yaml.
  p.decision = { action: action === "apply" ? "applied" : "rejected", by, at: stamp };
  store.save(report);
  kb.writeIndex();
  return p;
}
