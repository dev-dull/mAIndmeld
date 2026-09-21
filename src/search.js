// Retrieval over the decisions: a small BM25 over statement, rationale, and
// topic, blended with cosine similarity when an embeddings profile is
// configured. Decisions are the unit of retrieval. DESIGN.md 13.

import fs from "node:fs";
import path from "node:path";

const STOP = new Set("a an and are as at be by for from has have if in into is it its of on or that the this to was we were will with our your not no yes do does did so than then there their they them can should must may".split(" "));

export function tokenize(text) {
  const out = [];
  for (const raw of String(text ?? "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOP.has(raw)) continue;
    let t = raw;
    // Plural and past-tense rules in the spirit of Porter step 1: retries,
    // retried, and retry all reduce to "retri"; codes to "code".
    if (t.length > 4 && t.endsWith("sses")) t = t.slice(0, -2);
    else if (t.length > 4 && t.endsWith("ies")) t = t.slice(0, -2);
    else if (t.length > 4 && /(x|z|ch|sh)es$/.test(t)) t = t.slice(0, -2);
    else if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) t = t.slice(0, -1);
    if (t.length > 5 && t.endsWith("ing")) t = t.slice(0, -3);
    else if (t.length > 4 && t.endsWith("ied")) t = t.slice(0, -2);
    else if (t.length > 4 && t.endsWith("ed")) t = t.slice(0, -2);
    else if (t.length > 3 && t.endsWith("y")) t = `${t.slice(0, -1)}i`;
    out.push(t);
  }
  return out;
}

/** BM25 index over an array of decisions. Cheap to rebuild; callers cache by file mtime. */
export class KeywordIndex {
  constructor(decisions, { k1 = 1.2, b = 0.75 } = {}) {
    this.k1 = k1;
    this.b = b;
    this.docs = decisions.map((d) => {
      // The topic is counted twice on purpose: a query naming the topic
      // should outrank one that merely shares a word with the statement.
      const topicTokens = tokenize(d.topic.replace(/-/g, " "));
      const tokens = [...tokenize(d.statement), ...tokenize(d.rationale), ...topicTokens, ...topicTokens];
      const tf = new Map();
      for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
      return { d, tf, len: tokens.length };
    });
    this.avgLen = this.docs.reduce((s, x) => s + x.len, 0) / (this.docs.length || 1);
    this.df = new Map();
    for (const doc of this.docs) for (const t of doc.tf.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
  }

  score(query) {
    const q = [...new Set(tokenize(query))];
    const N = this.docs.length;
    return this.docs.map((doc) => {
      let s = 0;
      for (const t of q) {
        const f = doc.tf.get(t);
        if (!f) continue;
        const n = this.df.get(t) || 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        s += idf * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * doc.len) / this.avgLen)));
      }
      return { d: doc.d, score: s };
    });
  }
}

// ---- embeddings (optional) ----

export class EmbeddingClient {
  constructor(profile, { timeoutMs = 30_000 } = {}) {
    this.baseUrl = profile.baseUrl.replace(/\/$/, "");
    this.model = profile.model;
    this.apiKeyEnv = profile.apiKeyEnv;
    this.timeoutMs = timeoutMs;
  }

  async embed(texts) {
    const key = this.apiKeyEnv ? process.env[this.apiKeyEnv] : null;
    if (this.apiKeyEnv && !key) throw new Error(`environment variable ${this.apiKeyEnv} is not set`);
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model: this.model, input: texts }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`embeddings: HTTP ${res.status}`);
    const data = await res.json();
    const out = (data.data || []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((x) => x.embedding);
    if (out.length !== texts.length) throw new Error("embeddings: response count mismatch");
    return out;
  }
}

export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0; // different models, different spaces
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export class EmbeddingStore {
  constructor(kbDir) {
    this.file = path.join(kbDir, "embeddings.jsonl");
  }

  read() {
    if (!fs.existsSync(this.file)) return new Map();
    const map = new Map();
    for (const line of fs.readFileSync(this.file, "utf8").split("\n")) {
      if (!line) continue;
      const rec = JSON.parse(line);
      map.set(rec.id, rec);
    }
    return map;
  }

  append(records) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(this.file, records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""), { mode: 0o600 });
  }
}

/** Text embedded for a decision: what retrieval should match. */
export const embeddingText = (d) => `${d.topic.replace(/-/g, " ")}: ${d.statement}${d.rationale ? ` ${d.rationale}` : ""}`;

/**
 * Search over the knowledge store. `embedder` and `embeddings` are optional.
 * Returns up to k results, active by default, best first.
 */
export async function search(kb, query, { k = 5, topic, includeInactive = false, embedder = null, embeddings = null, cache = null } = {}) {
  const q = String(query ?? "").trim();
  if (!q) return [];
  let decisions = kb.decisions();
  if (!includeInactive) decisions = decisions.filter((d) => d.status === "active");
  if (topic) decisions = decisions.filter((d) => d.topic === topic);
  if (!decisions.length) return [];

  let index = cache?.get?.(includeInactive, topic);
  if (!index) {
    index = new KeywordIndex(decisions);
    cache?.set?.(includeInactive, topic, index);
  }
  const kw = index.score(q);
  const maxKw = Math.max(...kw.map((x) => x.score), 0);

  let vecScores = null;
  if (embedder && embeddings && embeddings.size) {
    try {
      const [qv] = await embedder.embed([q]);
      vecScores = new Map();
      for (const d of decisions) {
        const rec = embeddings.get(d.id);
        // Only vectors from the current model are comparable; others are ignored
        // until `maindmeld index` re-embeds them.
        if (rec?.vector && (!rec.model || rec.model === embedder.model)) vecScores.set(d.id, Math.max(0, cosine(qv, rec.vector)));
      }
    } catch {
      vecScores = null; // keyword-only when the endpoint is unavailable
    }
  }

  const scored = kw.map(({ d, score }) => {
    const kwNorm = maxKw ? score / maxKw : 0;
    const vec = vecScores?.get(d.id);
    const combined = vec === undefined ? kwNorm : kwNorm && vec ? 0.5 * kwNorm + 0.5 * vec : Math.max(kwNorm, vec * 0.9);
    return { d, score: combined, keyword: kwNorm, vector: vec ?? null };
  }).filter((x) => x.score > 0.05);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, Math.min(50, k))).map(({ d, score, keyword, vector }) => ({
    id: d.id,
    topic: d.topic,
    statement: d.statement,
    meeting: d.meeting,
    date: d.date,
    status: d.status,
    provisional: Boolean(d.provisional),
    score: Number(score.toFixed(3)),
    keyword: Number(keyword.toFixed(3)),
    vector: vector === null ? null : Number(vector.toFixed(3)),
  }));
}
