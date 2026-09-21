import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";

import { tokenize, KeywordIndex, search, EmbeddingClient, EmbeddingStore, embeddingText, cosine } from "../src/search.js";
import { KnowledgeStore } from "../src/kb.js";
import { tmpDataDir } from "./helpers.js";

const D = (id, topic, statement, extra = {}) => ({ id, meeting: "M1", topic, status: "active", statement, rationale: "", date: "2026-09-01", ...extra });

function store(decisions) {
  const kb = new KnowledgeStore(path.join(tmpDataDir(), "kb"));
  kb.saveDecisions(decisions);
  return kb;
}

test("tokenize drops stop words, short tokens, and simple suffixes", () => {
  assert.deepEqual(tokenize("The export command retries failed requests"), ["export", "command", "retri", "fail", "request"]);
  assert.deepEqual(tokenize("Exit codes are frozen"), ["exit", "code", "frozen"]);
  assert.deepEqual(tokenize("retry retried retries"), ["retri", "retri", "retri"], "one stem for every form");
});

test("BM25 ranks the decision that shares rare query terms first", () => {
  const idx = new KeywordIndex([
    D("a", "retry-policy", "Retries are capped at three with exponential backoff."),
    D("b", "api-contract", "The export command defaults to JSON on stdout."),
    D("c", "api-contract", "Exit codes 0 through 3 are frozen."),
  ]);
  const ranked = idx.score("how many retries with backoff").sort((x, y) => y.score - x.score);
  assert.equal(ranked[0].d.id, "a");
  assert.ok(ranked[0].score > ranked[1].score);
});

test("search caps, filters by topic, excludes inactive, and ignores blank queries", async () => {
  const kb = store([
    D("a", "retry-policy", "Retries are capped at three with exponential backoff."),
    D("b", "retry-policy", "Only idempotent operations are retried."),
    D("c", "retry-policy", "Two retries.", { status: "superseded" }),
    D("d", "api-contract", "The export command defaults to JSON on stdout."),
  ]);
  const r = await search(kb, "retries exponential backoff idempotent", { k: 1 });
  assert.equal(r.length, 1);
  assert.equal(r[0].id, "a");
  const all = await search(kb, "retries", { k: 10 });
  assert.deepEqual(all.map((x) => x.id).sort(), ["a", "b"], "superseded excluded");
  const withOld = await search(kb, "retries", { k: 10, includeInactive: true });
  assert.ok(withOld.some((x) => x.id === "c"));
  assert.deepEqual((await search(kb, "export", { topic: "retry-policy" })), []);
  assert.deepEqual(await search(kb, "   "), []);
  assert.equal(r[0].vector, null);
});

test("embeddings find a paraphrase that shares no keywords, and degrade to keywords when the endpoint fails", async () => {
  // A fake embeddings endpoint: two fixed directions, chosen by which words appear.
  let fail = false;
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    if (fail) {
      res.writeHead(500);
      return res.end("{}");
    }
    const { input } = JSON.parse(body);
    const data = input.map((text, index) => ({ index, embedding: /retr|again|attempt/i.test(text) ? [1, 0.1] : [0.1, 1] }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const kb = store([
      D("a", "retry-policy", "Retries are capped at three with exponential backoff."),
      D("b", "api-contract", "The export command defaults to JSON on stdout."),
    ]);
    const embedder = new EmbeddingClient({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: "fake-embed" });
    const es = new EmbeddingStore(kb.dir);
    const vectors = await embedder.embed(kb.decisions().map(embeddingText));
    es.append(kb.decisions().map((d, i) => ({ id: d.id, model: "fake-embed", vector: vectors[i] })));
    assert.equal(es.read().size, 2);
    assert.ok(cosine([1, 0], [1, 0]) > 0.99);
    assert.equal(cosine([1, 0, 0], [1, 0]), 0, "vectors of different dimension never compare");
    const stale = new Map(es.read());
    stale.set("a", { ...stale.get("a"), model: "old-embed" });
    const r0 = await search(kb, "how many attempts when a request fails", { embedder, embeddings: stale });
    assert.equal(r0.find((x) => x.id === "a")?.vector ?? null, null, "a vector from another model is ignored");

    const r = await search(kb, "how many attempts when a request fails", { embedder, embeddings: es.read() });
    assert.equal(r[0].id, "a", "paraphrase found through the vector");
    assert.ok(r[0].vector > 0.9);
    fail = true;
    const r2 = await search(kb, "exponential backoff", { embedder, embeddings: es.read() });
    assert.equal(r2[0].id, "a", "keyword-only when embeddings fail");
    assert.equal(r2[0].vector, null);
  } finally {
    server.close();
  }
});
