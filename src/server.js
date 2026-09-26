// The mAIndmeld server: one process serving the JSON API, the MCP endpoint,
// long-poll and SSE fan-out, and the web UI from one origin. The room
// operations live in a service object shared by the HTTP API and MCP.
// DESIGN.md sections 3, 5, 8, 9.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.js";
import { Store, isRoomCode, FormatTooNewError } from "./store.js";
import * as rooms from "./rooms.js";
import { Auth } from "./auth.js";
import { RoomEvents } from "./events.js";
import { ModelParticipant } from "./models.js";
import { createMcp } from "./mcp.js";
import { createNotifier } from "./notify.js";
import { KnowledgeStore, meetingIdFor } from "./kb.js";
import { buildEnvelope, createAdapter, summarize, Breaker } from "./summarize.js";
import { search as kbSearch, EmbeddingClient, EmbeddingStore, embeddingText } from "./search.js";
import { runSweep, decideProposal, SweepStore } from "./sweep.js";
import { sniffImage, imageDimensions, stripMetadata, AttachmentFiles, Signer, newAttachmentId, ATTACHMENT_ID, SIGNED_URL_TTL_MS } from "./attachments.js";
import { createCaptioner } from "./captions.js";
import crypto from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
export const VERSION = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8")).version;
const WEB_DIR = path.join(here, "web");
/** Decisions embedded per request during a backfill; keeps requests short on slow endpoints. */
const EMBED_CHUNK = 32;

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const STATIC_TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** Sliding-window counter per key. */
class RateLimiter {
  constructor() {
    this.hits = new Map();
  }

  allow(key, limit, windowMs) {
    const now = Date.now();
    const list = (this.hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= limit) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }
}

export function invitationText(room, origin) {
  const lines = [
    `You are invited to mAIndmeld room ${room.code}: "${room.title}".`,
    `Join with the maindmeld MCP tool room_join, code ${room.code}, and listen.`,
    `Web: ${origin}/rooms/${room.code}`,
  ];
  if (room.objective) lines.push(`Objective: ${room.objective}`);
  return lines.join("\n");
}

export function createApp(config = loadConfig()) {
  const store = new Store(config.dataDir);
  const auth = new Auth(store, { sessionDays: config.sessionDays });
  const events = new RoomEvents();
  const limiter = new RateLimiter();
  const startedAt = Date.now();
  const queues = new Map(); // per-room promise chain, belt and braces (DESIGN.md 3.1)
  const files = new AttachmentFiles(store.roomsDir);
  const signer = new Signer();
  const attachmentRooms = new Set(); // rooms with an upload not yet on a message, for the orphan sweep
  const models = new Map(); // `${code}:${name}` -> ModelParticipant
  const quiet = process.env.MAINDMELD_QUIET === "1";
  const log = (line) => {
    if (!quiet) process.stdout.write(`${new Date().toISOString()} ${line}\n`);
  };
  const captioner = createCaptioner(config, log);
  let captionsInFlight = Promise.resolve(); // so stop() can wait for the last one

  // ---- helpers ----

  const send = (res, status, body, headers = {}) => {
    const json = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
    res.end(json);
  };

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > config.limits.maxBodyBytes + 1024) throw new HttpError(413, `request body exceeds ${config.limits.maxBodyBytes} bytes`);
      chunks.push(chunk);
    }
    if (size === 0) return {};
    let parsed;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new HttpError(400, "request body must be valid JSON");
    }
    if (!parsed || typeof parsed !== "object") throw new HttpError(400, "request body must be a JSON object");
    return parsed;
  }

  /** Raw bytes with a hard cap; used for uploads, which are not JSON. */
  async function readRaw(req, maxBytes) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) throw new HttpError(413, `attachment exceeds ${maxBytes} bytes`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  function attachmentUrl(code, id) {
    return `${config.publicOrigin}/api/rooms/${code}/attachments/${id}?sig=${signer.sign(code, id)}`;
  }

  /** Copies of messages with a fetchable URL on each attachment. The URL is never stored. */
  function withUrls(code, messages) {
    return messages.map((m) => (m.attachment ? { ...m, attachment: { ...m.attachment, url: attachmentUrl(code, m.attachment.id) } } : m));
  }

  /** Load, mutate synchronously, save. Serialized per room. */
  function withRoom(code, fn) {
    if (!isRoomCode(code)) throw new HttpError(404, `no room ${code}`);
    const prev = queues.get(code) || Promise.resolve();
    const run = prev.then(() => {
      const room = store.loadRoom(code);
      if (!room) throw new HttpError(404, `no room ${code}`);
      const result = fn(room);
      store.saveRoom(room);
      return result;
    });
    const settled = run.catch(() => {});
    queues.set(code, settled);
    settled.then(() => {
      if (queues.get(code) === settled) queues.delete(code);
    });
    return run;
  }

  const principalKind = (principal) => (principal.kind === "session" ? "human" : "agent");
  const principalKey = (principal) => (principal.kind === "session" ? principal.token_name : principal.name);

  function limit(principal, kind) {
    const key = `${kind}:${principalKey(principal)}`;
    const ok = kind === "messages"
      ? limiter.allow(key, config.limits.messagesPerMinute, 60_000)
      : limiter.allow(key, config.limits.roomsPerHour, 3_600_000);
    if (!ok) throw new HttpError(429, `rate limit hit: ${kind === "messages" ? `${config.limits.messagesPerMinute} messages per minute` : `${config.limits.roomsPerHour} rooms per hour`}`, { limit: kind });
  }

  const loadOr404 = (code) => {
    const room = store.loadRoom(code);
    if (!room) throw new HttpError(404, `no room ${code}`);
    return room;
  };

  /** withRoom, plus publish every message the mutation appended. */
  async function mutateAndPublish(code, fn) {
    const { result, added, room } = await withRoom(code, (room) => {
      const start = room.messages.length;
      const result = fn(room);
      return { result, added: room.messages.slice(start), room };
    });
    for (const m of added) events.notify(code, { type: "message", message: m });
    return { result, room };
  }

  /**
   * The human acting on a room. A browser session qualifies under its display
   * name; a token qualifies only if the named participant is a human, which
   * keeps the CLI's join-as-human flows working. DESIGN.md 6.4.
   */
  function actingHuman(room, principal, name) {
    if (principal.kind === "session") return principal.name;
    const n = name || principal.name;
    const p = rooms.findParticipant(room, n);
    if (p && p.kind === "human") return p.name;
    throw new HttpError(403, `only a human may do this; ${n} is not a human participant of ${room.code}`);
  }

  const notifier = createNotifier(config, log);
  const motionRooms = new Set(); // rooms with an open motion, for the scheduler
  const abandonCandidates = new Set(); // open rooms an agent or model created that nobody else has joined
  const closingRooms = new Set(); // rooms in `closing`, watched for the maximum age
  const pendingIngests = new Set(); // rooms whose ingest gave up and awaits a retry

  const isHumanCreator = (room) => room.created_by.kind === "human";

  // ---- ingest: close handoff into the knowledge store (DESIGN.md 10, 11) ----

  const kb = new KnowledgeStore(config.kbDir);
  const adapter = createAdapter(config); // null when no summarizer is configured
  const breaker = new Breaker();

  // ---- retrieval (DESIGN.md 13) ----

  const embedProfile = config.search.embeddingsProfile ? config.profiles[config.search.embeddingsProfile] : null;
  const embedder = embedProfile ? new EmbeddingClient(embedProfile, { timeoutMs: embedProfile.timeoutMs }) : null;
  const embeddingStore = new EmbeddingStore(config.kbDir);
  const searchCache = { key: null, indexes: new Map() };
  const indexCache = {
    stamp: () => {
      try {
        return fs.statSync(kb.decisionsFile).mtimeMs;
      } catch {
        return 0;
      }
    },
    get(inactive, topic) {
      const stamp = this.stamp();
      if (searchCache.key !== stamp) {
        searchCache.key = stamp;
        searchCache.indexes.clear();
      }
      return searchCache.indexes.get(`${inactive}|${topic || ""}`) || null;
    },
    set(inactive, topic, index) {
      searchCache.indexes.set(`${inactive}|${topic || ""}`, index);
    },
  };

  async function searchDecisions(query, opts = {}) {
    return kbSearch(kb, query, { ...opts, embedder, embeddings: embedder ? embeddingStore.read() : null, cache: indexCache });
  }

  /**
   * Best effort: embed decisions that lack a vector from the current model, in
   * chunks so a backfill of a large store keeps what it has finished when the
   * endpoint fails or times out. Returns how many vectors were written. Never throws.
   */
  async function embedMissing(ids = null) {
    if (!embedder) return 0;
    let written = 0;
    try {
      const have = embeddingStore.read();
      const current = (d) => have.get(d.id)?.model === embedder.model;
      const todo = kb.decisions().filter((d) => !current(d) && (!ids || ids.includes(d.id)));
      for (let i = 0; i < todo.length; i += EMBED_CHUNK) {
        const chunk = todo.slice(i, i + EMBED_CHUNK);
        const vectors = await embedder.embed(chunk.map(embeddingText));
        embeddingStore.append(chunk.map((d, j) => ({ id: d.id, model: embedder.model, vector: vectors[j], created_at: new Date().toISOString() })));
        written += chunk.length;
      }
    } catch (error) {
      log(`embeddings: ${error.message}${written ? ` after ${written} vector${written === 1 ? "" : "s"}` : ""}`);
    }
    return written;
  }

  const embeddingsStatus = () => ({ enabled: Boolean(embedder), model: embedder?.model || null, vectors: embedder ? embeddingStore.read().size : 0 });

  /** The few decisions an arriving participant should know about. Hard-capped. */
  async function priorDecisions(room) {
    try {
      const results = await searchDecisions(`${room.title} ${room.objective}`, { k: config.search.injectLimit });
      // Keyword scores tail off into noise; keep only results near the best one.
      const top = results[0]?.score || 0;
      return results.filter((r) => r.score >= top * 0.3).map(({ id, topic, statement, date }) => ({ id, topic, statement, date }));
    } catch (error) {
      log(`prior decisions for ${room.code}: ${error.message}`);
      return [];
    }
  }
  const ledgerFile = store.filePath("ingested.json");
  let ingestChain = Promise.resolve();
  let ingestRunning = null;
  let sweepRunning = false;

  function ledgerWrite(code, entry) {
    const ledger = store.readJSON(ledgerFile, { format: 1, rooms: {} });
    ledger.rooms[code] = { ...(ledger.rooms[code] || {}), ...entry, updated_at: new Date().toISOString() };
    store.writeJSON(ledgerFile, ledger);
  }

  /** Queue an ingest; runs one at a time, never throws to the caller. */
  function enqueueIngest(code, { force = false } = {}) {
    const job = ingestChain.then(() => runIngest(code, { force })).catch((e) => log(`ingest ${code}: ${e.stack || e}`));
    ingestChain = job;
    return job;
  }

  async function runIngest(code, { force }) {
    let room = store.loadRoom(code);
    if (!room || room.status === "abandoned" || room.status === "open") return { skipped: "not closed" };
    if (!force && room.ingest?.status === "done") return { skipped: "already done" };
    if (!adapter) {
      await mutateAndPublish(code, (r) => rooms.finishClosing(r, { status: "skipped", reason: "no summarizer configured" }));
      closingRooms.delete(code);
      return { skipped: "no summarizer" };
    }
    if (breaker.isOpen()) {
      const until = breaker.state().until;
      await mutateAndPublish(code, (r) => {
        r.ingest = { ...(r.ingest || {}), status: "pending", last_error: `summarizer breaker open until ${until}`, updated_at: rooms.now() };
      });
      pendingIngests.add(code);
      return { pending: "breaker open" };
    }
    ingestRunning = code;
    await mutateAndPublish(code, (r) => {
      r.ingest = { ...(r.ingest || { note_id: null }), status: "running", attempts: (r.ingest?.attempts || 0) + 1, last_error: null, updated_at: rooms.now() };
    });
    room = store.loadRoom(code);
    try {
      const { envelope, redactions } = buildEnvelope(room, kb);
      const warnings = redactions ? [`${redactions} credential-looking string${redactions === 1 ? "" : "s"} redacted before summarizing; the raw transcript keeps them`] : [];
      const { note, warnings: more } = await summarize(adapter, envelope, { log });
      warnings.push(...more);
      const meetingId = meetingIdFor(room);
      const resummarize = kb.decisions().some((d) => d.meeting === meetingId); // a forced first ingest is still a first ingest
      const result = kb.writeNote(room, note, { adapter: adapter.name, model: adapter.model, resummarize, warnings });
      breaker.success();
      const { room: after } = await mutateAndPublish(code, (r) => {
        rooms.finishClosing(r, { status: "done", note_id: result.meetingId, last_error: null });
        r.ingest = { ...r.ingest, status: "done", note_id: result.meetingId, last_error: null, updated_at: rooms.now() };
        rooms.addSystemMessage(r, `Summary written: ${result.meetingId} with ${result.decisionIds.length} decision${result.decisionIds.length === 1 ? "" : "s"}${result.superseded.length ? `, superseding ${result.superseded.join(", ")}` : ""}.`, { action: "ingested", note_id: result.meetingId, decisions: result.decisionIds });
      });
      ledgerWrite(code, { status: "done", note_id: result.meetingId, adapter: adapter.name, model: adapter.model, decisions: result.decisionIds, attempts: room.ingest.attempts });
      closingRooms.delete(code);
      pendingIngests.delete(code);
      embedMissing(result.decisionIds).then((n) => n && log(`embeddings: ${n} vector${n === 1 ? "" : "s"} written for ${result.meetingId}`));
      events.notify(code, { type: "room", room: rooms.summarizeRoom(after) });
      log(`ingest ${code}: note ${result.meetingId} written (${result.decisionIds.length} decisions)`);
      return { done: result.meetingId };
    } catch (error) {
      const pause = breaker.failure({ rateLimited: error.status === 429 });
      const message = String(error.message).slice(0, 500);
      await mutateAndPublish(code, (r) => {
        r.ingest = { ...(r.ingest || {}), status: "pending", last_error: message, updated_at: rooms.now() };
        if (r.status === "closing") rooms.addSystemMessage(r, `The summary could not be written yet: ${message}. It will be retried.`, { action: "ingest_failed" });
      });
      ledgerWrite(code, { status: "pending", last_error: message, attempts: room.ingest.attempts });
      pendingIngests.add(code);
      log(`ingest ${code}: failed: ${message}${pause ? `; breaker open for ${Math.round(pause / 60000)} min` : ""}`);
      return { pending: message };
    } finally {
      ingestRunning = null;
    }
  }

  /** Called whenever a room leaves `open`; starts ingest for rooms that entered `closing`. */
  function afterClose(code, room) {
    if (room.status === "closing") {
      closingRooms.add(code);
      enqueueIngest(code);
    }
    if (room.status !== "open") endLaunchesFor(code, "room closed").catch((e) => log(`launches ${code}: ${e.message}`));
  }

  // ---- runners and launches (DESIGN.md 7.4): the server holds intent and observed facts, nothing else ----

  const runners = new Map(); // name -> { name, harnesses: Set, res: SSE response or null, last_seen_at, active: Set of launch ids }
  const launchIndex = new Map(); // launch id -> room code
  const launchRooms = new Set(); // rooms with an active launch, for the scheduler
  const runnersFile = store.filePath("runners.json");
  const launchTimeouts = () => ({ join_ms: config.launch.joinTimeoutSeconds * 1000, grace_ms: config.launch.joinGraceSeconds * 1000, claim_ms: config.launch.claimTimeoutSeconds * 1000 });

  function saveRunners() {
    try {
      store.writeJSON(runnersFile, { format: 1, runners: [...runners.values()].map((r) => ({ name: r.name, harnesses: [...r.harnesses], last_seen_at: r.last_seen_at, token: r.token })) });
    } catch (error) {
      log(`runners.json: ${error.message}`);
    }
  }

  const streamAlive = (res) => Boolean(res && !res.destroyed && !res.writableEnded && res.socket && !res.socket.destroyed);

  function runnerOnline(name) {
    const r = runners.get(name);
    if (!r) return false;
    if (r.res && !streamAlive(r.res)) {
      r.res = null; // the socket died without a close event; treat it as gone
      r.last_seen_at = rooms.now();
    }
    return Boolean(r.res || Date.now() - Date.parse(r.last_seen_at) < config.launch.runnerOfflineSeconds * 1000);
  }

  /** The runner's own token must be the one acting on its launches; another token, even a runner's, is refused. */
  function requireRunnerToken(principal, runnerName) {
    const r = runners.get(runnerName);
    if (!r || r.token !== principal.name) throw new HttpError(403, `only runner ${runnerName}'s own token may act on its launches`);
  }

  function runnerView(r) {
    return { name: r.name, harnesses: [...r.harnesses].sort(), online: runnerOnline(r.name), last_seen_at: r.last_seen_at, active: r.active.size };
  }

  /** The runner for a harness: the one asked for, else the online one offering it with the fewest active launches. */
  function runnerFor(harness, preferred) {
    const offering = [...runners.values()].filter((r) => r.harnesses.has(harness) && runnerOnline(r.name));
    if (preferred) {
      const r = offering.find((x) => x.name === preferred);
      if (!r) throw new HttpError(409, runners.has(preferred) ? `runner ${preferred} is offline or does not offer ${harness}` : `no runner named ${preferred}`);
      return r;
    }
    if (!offering.length) throw new HttpError(409, `no runner online offers ${harness}`);
    return offering.sort((a, b) => a.active.size - b.active.size || a.name.localeCompare(b.name))[0];
  }

  function runnerSend(name, event, data) {
    const r = runners.get(name);
    if (!r?.res) return false;
    events.write(r.res, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  }

  /** A runner's SSE stream: registers it, replays its pending launches, then delivers launch and cancel events. */
  function runnerSubscribe(req, res, { name, harnesses, principal }) {
    const clean = rooms.cleanName(name, "runner name");
    const set = new Set(String(harnesses || "").split(",").map((h) => h.trim()).filter(Boolean));
    if (!set.size) throw new HttpError(400, "harnesses is required: the names this runner can launch, comma separated");
    let r = runners.get(clean);
    if (r?.res && r.res !== res) {
      try { r.res.end(); } catch { /* replaced */ }
    }
    if (!r) {
      r = { name: clean, harnesses: set, res: null, last_seen_at: rooms.now(), active: new Set(), token: principal.name };
      runners.set(clean, r);
    }
    r.harnesses = set;
    r.res = res;
    r.token = principal.name; // the token that owns this runner's launches from now on
    r.last_seen_at = rooms.now();
    saveRunners();
    // A half-open socket must not look online forever: keepalive probes make the OS notice a dead peer.
    res.socket?.setKeepAlive?.(true, 15_000);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write(`event: hello\ndata: ${JSON.stringify({ runner: clean, harnesses: [...set], heartbeat_seconds: 30 })}\n\n`);
    // Replay what this runner has not claimed yet. Synchronous room loads, one per room
    // with an active launch; that set is small by construction (launches end within minutes).
    for (const code of launchRooms) {
      let room = null;
      try {
        room = store.loadRoom(code);
      } catch (error) {
        log(`runner ${clean}: could not replay launches of ${code}: ${error.message}`);
      }
      if (!room) continue;
      for (const l of rooms.activeLaunches(room)) {
        if (l.state === "requested" && l.runner === clean) res.write(`event: launch\ndata: ${JSON.stringify(launchEventData(room, l))}\n\n`);
      }
    }
    const beat = setInterval(() => {
      r.last_seen_at = rooms.now();
      events.write(res, ": heartbeat\n\n");
    }, 30_000);
    beat.unref();
    req.on("close", () => {
      clearInterval(beat);
      if (r.res === res) {
        r.res = null;
        r.last_seen_at = rooms.now();
        saveRunners();
      }
    });
  }

  const launchEventData = (room, l) => ({ launch: l.id, room: room.code, harness: l.harness, title: room.title, objective: room.objective, requested_by: l.requested_by });

  /** Cancel every active launch of a room (it closed or was abandoned), revoke its tokens, and tell the runners. */
  async function endLaunchesFor(code, reason) {
    if (!launchRooms.has(code)) return;
    const { result: ended } = await mutateAndPublish(code, (room) => {
      const out = [];
      for (const l of rooms.activeLaunches(room)) {
        rooms.endLaunch(room, l.id, { state: "cancelled", reason });
        out.push({ id: l.id, runner: l.runner });
      }
      return out;
    });
    auth.revokeScoped(code);
    for (const l of ended) {
      launchIndex.delete(l.id);
      runners.get(l.runner)?.active.delete(l.id);
      runnerSend(l.runner, "cancel", { launch: l.id, room: code, reason });
    }
    launchRooms.delete(code);
    for (const l of ended) events.notify(code, { type: "launch", launch: { id: l.id, state: "cancelled" } });
  }

  /** Overdue launches: started without a join, or requested with the runner gone. Run by the scheduler. */
  async function tickLaunches() {
    for (const code of [...launchRooms]) {
      try {
        const { result } = await mutateAndPublish(code, (room) => {
          const ended = [];
          for (const { launch, state, reason } of rooms.overdueLaunches(room, Date.now(), runnerOnline, launchTimeouts())) {
            rooms.endLaunch(room, launch.id, { state, reason });
            ended.push({ id: launch.id, runner: launch.runner, state });
          }
          return { ended, remaining: rooms.activeLaunches(room).length };
        });
        for (const l of result.ended) {
          auth.revokeScoped(code, { launch: l.id });
          launchIndex.delete(l.id);
          runners.get(l.runner)?.active.delete(l.id);
          if (l.state === "timed_out") runnerSend(l.runner, "cancel", { launch: l.id, room: code, reason: "did not join in time" });
          if (l.state === "failed") runnerSend(l.runner, "cancel", { launch: l.id, room: code, reason: "not claimed in time" });
          events.notify(code, { type: "launch", launch: { id: l.id, state: l.state } });
          log(`launch ${l.id} in ${code}: ${l.state}`);
        }
        if (!result.remaining) launchRooms.delete(code);
      } catch (error) {
        log(`tick launches ${code}: ${error.message}`);
        launchRooms.delete(code);
      }
    }
  }

  function afterMotion(code, motion, action, room) {
    events.notify(code, { type: "motion", action, motion: rooms.motionView(motion, null) });
    if (motion.status === "open") {
      motionRooms.add(code);
      return;
    }
    if (action !== "resolved") events.notify(code, { type: "motion", action: "resolved", motion: rooms.motionView(motion, null) });
    if (!rooms.openMotions(room).length) motionRooms.delete(code);
    events.notify(code, { type: "room", room: rooms.summarizeRoom(room) });
    log(`motion #${motion.id} (${motion.type}) in ${code} ${motion.status} ${motion.outcome?.how}`);
    if (room.status !== "open") afterClose(code, room);
    if (motion.status === "carried" && motion.type === "call_human") {
      notifier.humanNeeded(room, motion.reason, "human_called").catch(() => {});
    }
  }

  // ---- profile statistics: turn latency and waits into tuning data (DESIGN.md 10.3) ----

  const profileStats = new Map(); // profileKey -> stats
  function statsFor(key) {
    let s = profileStats.get(key);
    if (!s) {
      s = { durations: [], calls: 0, failures: 0, timeouts: 0, skipped: 0, waits: 0, callTimes: [] };
      profileStats.set(key, s);
    }
    return s;
  }
  function recordProfile(key, event) {
    const s = statsFor(key);
    if (event.ms !== undefined) {
      s.calls += 1;
      s.durations.push(event.ms);
      if (s.durations.length > 500) s.durations.shift();
    }
    if (event.failure) {
      s.calls += 1;
      s.failures += 1;
      if (event.timeout) s.timeouts += 1;
    }
    if (event.wait) s.waits += 1;
    if (event.skipped) s.skipped += 1;
  }
  function allowCall(key) {
    const limit = config.profiles[key]?.maxCallsPerHour ?? 120;
    const s = statsFor(key);
    const now = Date.now();
    s.callTimes = s.callTimes.filter((t) => now - t < 3_600_000);
    if (s.callTimes.length >= limit) {
      recordProfile(key, { skipped: true });
      return false;
    }
    s.callTimes.push(now);
    return true;
  }
  function profileReport() {
    const out = {};
    for (const [key, p] of Object.entries(config.profiles)) {
      const s = statsFor(key);
      const sorted = [...s.durations].sort((a, b) => a - b);
      const pick = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);
      const p95 = pick(0.95);
      let hint = null;
      if (p95 !== null && p95 > p.timeoutMs * 0.8) hint = `p95 ${p95} ms is near timeout_ms ${p.timeoutMs}; consider timeout_ms ${Math.ceil((p95 * 1.5) / 1000) * 1000}`;
      else if (s.waits > 0) hint = `${s.waits} wait${s.waits === 1 ? "" : "s"} granted; consider a longer timeout_ms or vote window`;
      out[key] = {
        model: p.model,
        display_name: p.displayName,
        vision: p.vision,
        timeout_ms: p.timeoutMs,
        max_calls_per_hour: p.maxCallsPerHour,
        calls: s.calls,
        failures: s.failures,
        timeouts: s.timeouts,
        skipped: s.skipped,
        waits: s.waits,
        latency_ms: { p50: pick(0.5), p95, n: sorted.length },
        calls_last_hour: s.callTimes.filter((t) => Date.now() - t < 3_600_000).length,
        hint,
      };
    }
    return out;
  }

  // ---- model participants ----

  const MODEL_IMAGE_MAX_BYTES = 1024 * 1024;
  const imageSkipsLogged = new Set();
  /**
   * The bytes of an attachment for a vision profile, as a data URI with
   * metadata stripped, or null when the image is over the profile's limits
   * (no resizing without a dependency, so it goes as caption only) or missing.
   */
  function loadImageFor(profile) {
    return (room, attachment) => {
      const record = room.attachments?.[attachment.id];
      if (!record) return null;
      const px = Math.max(record.width || 0, record.height || 0);
      const key = `${room.code}/${attachment.id}`;
      if (record.bytes > MODEL_IMAGE_MAX_BYTES || px > profile.imageMaxPx) {
        if (!imageSkipsLogged.has(key)) {
          imageSkipsLogged.add(key);
          log(`image ${key} (${record.bytes} bytes, ${record.width ?? "?"}x${record.height ?? "?"}) is over the limit for vision profiles (${MODEL_IMAGE_MAX_BYTES} bytes, ${profile.imageMaxPx} px); models get its caption only`);
        }
        return null;
      }
      try {
        const bytes = stripMetadata(fs.readFileSync(files.pathFor(room.code, attachment.id, record.ext)), record.type);
        return `data:${record.type};base64,${bytes.toString("base64")}`;
      } catch (error) {
        log(`image ${key}: ${error.message}`);
        return null;
      }
    };
  }

  const modelHooks = {
    loadRoom: (code) => store.loadRoom(code),
    on: (code, fn) => events.on(code, fn),
    log,
    record: recordProfile,
    allowCall,
    async post(code, name, text) {
      const message = await withRoom(code, (room) => rooms.sendMessage(room, { sender: name, content: text }, config.limits.maxBodyBytes));
      events.notify(code, { type: "message", message });
    },
    async system(code, text) {
      const message = await withRoom(code, (room) => rooms.addSystemMessage(room, text));
      events.notify(code, { type: "message", message });
    },
    async vote(code, name, id, vote, reason) {
      const { result: motion, room } = await mutateAndPublish(code, (room) => rooms.castVote(room, id, { name, vote, reason }));
      afterMotion(code, motion, "voted", room);
    },
  };

  function modelStatuses() {
    const out = [];
    for (const [key, mp] of models) {
      if (mp.stopped) models.delete(key);
      else out.push(mp.status());
    }
    return out;
  }

  // ---- the room service, shared by the HTTP API and MCP ----

  const service = {
    async createRoom(principal, body) {
      limit(principal, "rooms");
      const creatorName = body.name || principal.name;
      const creatorKind = body.kind || principalKind(principal);
      if (creatorKind !== "human") {
        // DESIGN.md 7.1: a runaway agent cannot open rooms without end.
        const open = store.listRooms().filter((r) => r.status === "open" && r.created_by.name.toLowerCase() === String(creatorName).toLowerCase()).length;
        if (open >= config.limits.roomsOpenPerCreator) {
          throw new HttpError(429, `${creatorName} already has ${open} open rooms; close one before creating another`, { limit: "rooms_open" });
        }
      }
      let room;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        room = rooms.createRoom({
          title: body.title,
          objective: body.objective,
          creator: { name: creatorName, kind: creatorKind, client: body.client },
          responseMode: body.response_mode,
        });
        if (!store.roomExists(room.code)) break;
        room = null;
      }
      if (!room) throw new HttpError(500, "could not allocate a room code");
      room.clock_config = { ...config.clocks };
      room.ingest_enabled = Boolean(adapter);
      store.saveRoom(room);
      if (!isHumanCreator(room)) abandonCandidates.add(room.code);
      events.notify(room.code, { type: "room", room: rooms.summarizeRoom(room) });
      log(`room ${room.code} created by ${room.created_by.name} (${room.created_by.kind})`);

      const invites = [];
      for (const profile of Array.isArray(body.invite_models) ? body.invite_models : []) {
        try {
          const r = await service.invite(principal, room.code, { kind: "model", profile: String(profile) });
          invites.push({ kind: "model", profile: String(profile), ok: true, name: r.participant.name });
        } catch (error) {
          invites.push({ kind: "model", profile: String(profile), ok: false, error: error.message });
        }
      }
      if (body.invite_human) {
        await service.invite(principal, room.code, { kind: "human", reason: body.objective });
        invites.push({ kind: "human", ok: true });
      }
      const fresh = invites.length ? store.loadRoom(room.code) : room;
      return { room: fresh, invitation: invitationText(fresh, config.publicOrigin), invites, prior_decisions: await priorDecisions(fresh) };
    },

    async get(code) {
      const room = loadOr404(code);
      return { room: { ...room, messages: withUrls(code, room.messages) }, invitation: invitationText(room, config.publicOrigin) };
    },

    async list(name) {
      const all = store.listRooms().sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1)).map(rooms.summarizeRoom);
      const lower = name ? name.toLowerCase() : null;
      const mine = lower ? all.filter((r) => r.status === "open" && r.participants.some((p) => p.name.toLowerCase() === lower)) : [];
      const needs = all.filter((r) => r.status === "open" && r.human_required && !r.human_present);
      const other = all.filter((r) => r.status === "open" && !mine.includes(r) && !needs.includes(r));
      return { all, mine, needs_human: needs, other_open: other };
    },

    async join(principal, code, body) {
      const launchId = principal.scope?.launch || null;
      const result = await withRoom(code, (room) => {
        if (launchId) {
          // A launch token joining is the fact that turns "started" into "joined"; a late join past the grace is refused.
          const l = room.launches?.[launchId];
          if (l && !["started", "joined"].includes(l.state)) throw new HttpError(409, `launch ${launchId} is ${l.state}; the room no longer expects this harness`);
        }
        const { participant, rejoined } = rooms.joinRoom(room, {
          name: body.name || principal.name,
          kind: body.kind || principalKind(principal),
          client: body.client || (launchId ? "runner" : undefined),
        });
        const launch = launchId ? rooms.launchJoined(room, launchId, participant.name) : null;
        return { participant, rejoined, room, launch };
      });
      if (result.launch) events.notify(code, { type: "launch", launch: rooms.launchView(result.launch) });
      if (!result.rejoined) {
        events.notify(code, { type: "participant", action: "joined", participant: result.participant });
        if (result.room.others_joined > 0) abandonCandidates.delete(code);
      }
      const room = { ...result.room, messages: withUrls(code, result.room.messages) };
      return { ...result, room, invitation: invitationText(room, config.publicOrigin), prior_decisions: await priorDecisions(result.room) };
    },

    /** What a called person needs to know, without the transcript. DESIGN.md 13. */
    async brief(code) {
      const room = loadOr404(code);
      const calls = room.messages.filter((m) => m.data?.action === "human_called");
      const lastCall = calls.at(-1) || null;
      const carried = room.motions.filter((m) => m.type === "call_human" && m.status === "carried").at(-1) || null;
      const open = rooms.openMotions(room).map((m) => rooms.motionView(m, null));
      const provisional = room.messages.filter((m) => m.provisional).length;
      const blockedClose = room.human_required && !room.human_present;
      let needed;
      if (room.status !== "open") needed = `The room is ${room.status}; nothing is needed.`;
      else if (!room.human_required) needed = "No human has been called. Join if you want to take part.";
      else if (blockedClose) needed = "Join the room, then acknowledge the call (carry on with you present) or dismiss it (the agents may finish alone). Close is blocked until you do.";
      else if (open.length) needed = `You are present. ${open.length} motion${open.length === 1 ? " is" : "s are"} open; you may let the vote run, carry or cancel it, or give a slow voter more time.`;
      else needed = "You are present and acknowledged; the agents can continue. Dismiss the call if they no longer need you.";
      return {
        code: room.code,
        title: room.title,
        objective: room.objective,
        status: room.status,
        called: lastCall
          ? { at: lastCall.created_at, reason: lastCall.data?.reason || carried?.reason || null, by: carried?.proposer || null, how: carried ? "motion" : "invite", tally: carried?.outcome?.tally || null }
          : null,
        needed,
        human_required: room.human_required,
        human_present: room.human_present,
        acknowledged_at: room.human_acknowledged_at,
        provisional_messages: provisional,
        open_motions: open,
        participants: room.participants.map(({ name, kind }) => ({ name, kind })),
        recent: room.messages.filter((m) => m.kind !== "system" && m.kind !== "summary").slice(-6).map(({ id, kind, sender, content, created_at, provisional: p }) => ({ id, kind, sender, content: content.slice(0, 600), created_at, provisional: p || undefined })),
        url: `${config.publicOrigin}/rooms/${room.code}`,
      };
    },

    async leave(principal, code, body) {
      const participant = await withRoom(code, (room) => rooms.leaveRoom(room, body.name || principal.name, body.message));
      events.notify(code, { type: "participant", action: "left", participant });
      return participant;
    },

    async send(principal, code, body) {
      limit(principal, "messages");
      const message = await withRoom(code, (room) =>
        rooms.sendMessage(room, { sender: body.sender || principal.name, content: body.content, reply_to: body.reply_to, attachment_id: body.attachment_id, caption: body.caption }, config.limits.maxBodyBytes),
      );
      events.notify(code, { type: "message", message });
      return withUrls(code, [message])[0];
    },

    /**
     * Store an image for a later message. The bytes are checked structurally,
     * capped per file and per room, and written inside the room's queue so
     * the ledger in the room file and the file on disk never disagree.
     */
    async upload(principal, code, { buffer, contentType, name }) {
      limit(principal, "messages");
      if (!buffer.length) throw new HttpError(400, "upload the image bytes as the request body");
      const sniffed = sniffImage(buffer);
      if (!sniffed) throw new HttpError(415, "not a PNG, JPEG, WebP, or GIF image (checked by content, not by name)");
      const declared = String(contentType || "").split(";")[0].trim().toLowerCase();
      if (declared && declared !== "application/octet-stream" && declared !== sniffed.type) {
        throw new HttpError(415, `Content-Type says ${declared} but the bytes are ${sniffed.type}`);
      }
      const dims = imageDimensions(buffer, sniffed.type);
      const id = newAttachmentId();
      const by = name || principal.name;
      const record = await withRoom(code, (room) => {
        if (rooms.attachmentBytes(room) + buffer.length > config.limits.maxRoomAttachmentBytes) {
          throw new HttpError(413, `room ${code} would exceed ${config.limits.maxRoomAttachmentBytes} bytes of attachments`);
        }
        const r = rooms.registerAttachment(room, { id, type: sniffed.type, ext: sniffed.ext, bytes: buffer.length, width: dims?.width, height: dims?.height, by });
        files.write(code, id, sniffed.ext, buffer);
        return r;
      });
      attachmentRooms.add(code);
      if (captioner) {
        // Background: the upload has returned by the time this resolves.
        const job = captioner.caption(buffer, sniffed.type).then(async (text) => {
          if (!text) return;
          const { room, added } = await withRoom(code, (room) => ({ room, added: rooms.setAutoCaption(room, id, text) }));
          if (!added) return;
          const m = room.messages.find((x) => x.attachment?.id === id);
          if (m) events.notify(code, { type: "message", action: "updated", message: withUrls(code, [m])[0] });
        }).catch((error) => log(`caption ${code}/${id}: ${error.message}`));
        captionsInFlight = captionsInFlight.then(() => job);
      }
      return { id, type: record.type, bytes: record.bytes, width: record.width, height: record.height, url: attachmentUrl(code, id), expires_in_seconds: SIGNED_URL_TTL_MS / 1000, auto_caption: Boolean(captioner) };
    },

    /** The ledger record and file path for serving. */
    attachment(code, id) {
      if (!ATTACHMENT_ID.test(String(id))) throw new HttpError(404, `no attachment ${id}`);
      const room = loadOr404(code);
      const record = room.attachments?.[id];
      if (!record) throw new HttpError(404, `no attachment ${id} in ${code}`);
      const file = files.pathFor(code, id, record.ext);
      if (!fs.existsSync(file)) throw new HttpError(404, `attachment ${id} is missing from disk`);
      return { record, file };
    },

    /** Long-poll. With `name`, advances that participant's cursor. */
    async listen(code, { name, wait = 0, after = null }) {
      const maxWait = Math.min(config.limits.maxWaitSeconds, Math.max(0, Number(wait) || 0));
      const explicitAfter = after === null || after === undefined ? null : Math.max(0, Number(after) || 0);

      const snapshot = (room) => {
        const participant = name ? rooms.findParticipant(room, name) : null;
        if (name && !participant && room.status === "open") throw new HttpError(403, `${name} is not a participant in ${code}; join first`);
        const from = explicitAfter ?? (participant ? participant.cursor : 0);
        const messages = participant && explicitAfter === null
          ? rooms.unreadFor(room, participant)
          : rooms.messagesAfter(room, from).filter((m) => !participant || m.sender.toLowerCase() !== participant.name.toLowerCase());
        return { participant, messages };
      };

      // Wake for something worth waking for: a non-system message, an open
      // motion, or the room closing. System lines alone (joins, leaves) are
      // returned with the next real event or at the deadline, so an agent
      // in a listen loop is not spun up for every arrival.
      const awaitingVote = (room, participant) =>
        Boolean(participant) && rooms.openMotions(room).some((m) => m.eligible.some((n) => n.toLowerCase() === participant.name.toLowerCase()) && m.votes[participant.name] === undefined && !m.votes[m.eligible.find((n) => n.toLowerCase() === participant.name.toLowerCase())]);
      const worthWaking = (room, messages, participant) =>
        room.status !== "open" || messages.some((m) => m.kind !== "system") || awaitingVote(room, participant);

      let room = loadOr404(code);
      let { participant, messages } = snapshot(room);
      const deadline = Date.now() + maxWait * 1000;
      while (!worthWaking(room, messages, participant) && Date.now() < deadline) {
        await events.waitForChange(code, Math.ceil((deadline - Date.now()) / 1000));
        room = loadOr404(code);
        ({ participant, messages } = snapshot(room));
      }

      let cursor = explicitAfter ?? 0;
      if (participant) {
        cursor = room.next_message_id - 1;
        // Returning this response is what delivers any open motion to the
        // participant, so their vote window starts now.
        const delivered = await withRoom(code, (r) => {
          const p = rooms.findParticipant(r, participant.name);
          if (!p) return [];
          p.cursor = Math.max(p.cursor, cursor);
          p.last_seen_at = rooms.now();
          return rooms.deliverMotions(r, p.name);
        });
        for (const m of delivered) events.notify(code, { type: "motion", action: "delivered", motion: rooms.motionView(m, null), to: participant.name });
        if (delivered.length) room = loadOr404(code);
      } else if (messages.length) {
        cursor = messages.at(-1).id;
      }

      const pending = participant ? rooms.pendingVoteFor(room, participant.name) : null;
      const next = room.status !== "open" ? "leave" : pending ? "vote" : messages.some((m) => m.kind !== "system") ? "reply" : "listen";
      return {
        code,
        status: room.status,
        response_mode: room.response_mode,
        human_required: room.human_required,
        human_present: room.human_present,
        held: room.held,
        participants: room.participants.map(({ name: n, kind, last_seen_at }) => ({ name: n, kind, last_seen_at })),
        motions_open: rooms.openMotions(room).map((m) => rooms.motionView(m, participant?.name ?? null)),
        messages: withUrls(code, messages),
        cursor,
        next,
      };
    },

    async status(code) {
      return rooms.summarizeRoom(loadOr404(code));
    },

    async setMode(principal, code, mode) {
      const changed = await withRoom(code, (room) => rooms.setResponseMode(room, mode, principal.name));
      if (changed) events.notify(code, { type: "room", room: rooms.summarizeRoom(store.loadRoom(code)) });
      return changed;
    },

    /** Direct close is a human power; agents file the close motion. */
    async close(principal, code, body) {
      const { result: changed, room } = await mutateAndPublish(code, (room) => {
        const by = actingHuman(room, principal, body.name);
        return rooms.closeRoom(room, { by, kind: "human", summary: body.summary, how: "direct" });
      });
      if (changed) {
        motionRooms.delete(code);
        events.notify(code, { type: "room", room: rooms.summarizeRoom(room) });
        log(`room ${code} ${room.status} by ${principal.name}`);
        afterClose(code, room);
      }
      return changed;
    },

    // ---- ingest and the knowledge store (DESIGN.md 10, 11) ----

    /** Run or rerun ingest now. `action: "skip"` (human) closes without a note. */
    async ingest(principal, code, body = {}) {
      const room = loadOr404(code);
      if (body.action === "skip") {
        const { room: after } = await mutateAndPublish(code, (r) => {
          const by = actingHuman(r, principal, body.name);
          if (r.status !== "closing") throw new HttpError(409, `room ${code} is ${r.status}, not closing`);
          rooms.finishClosing(r, { status: "skipped", reason: `closed without a note by ${by}` });
          rooms.addSystemMessage(r, `${by} closed the room without waiting for a summary.`, { action: "ingest_skipped" });
        });
        closingRooms.delete(code);
        pendingIngests.delete(code);
        events.notify(code, { type: "room", room: rooms.summarizeRoom(after) });
        return { ingest: after.ingest };
      }
      if (room.status === "open") throw new HttpError(409, `room ${code} is still open`);
      if (room.status === "abandoned") throw new HttpError(409, `room ${code} was abandoned and is not summarized`);
      if (!adapter) throw new HttpError(409, "no summarizer is configured");
      const result = await enqueueIngest(code, { force: Boolean(body.force) });
      return { result, ingest: store.loadRoom(code).ingest };
    },

    kb: {
      index: () => kb.index(),
      meetings: () => kb.listMeetings(),
      meeting: (id) => kb.readMeeting(id),
      decisions: ({ status, topic } = {}) => kb.decisions().filter((d) => (!status || d.status === status) && (!topic || d.topic === topic)),
      topics: () => kb.topics(),
      reindex: async () => {
        kb.writeIndex();
        const embedded = await embedMissing();
        return { embedded, ...embeddingsStatus() };
      },
      search: (query, opts) => searchDecisions(query, opts),
      embeddings: embeddingsStatus,
    },

    // ---- the sweep (DESIGN.md 12): proposes, never retires ----

    sweep: {
      state: () => new SweepStore(kb).state(),
      list: () => new SweepStore(kb).list().map(({ id, ran_at, all, topics_checked, proposals }) => ({ id, ran_at, all, topics: topics_checked.length, proposals: proposals.length, undecided: proposals.filter((p) => !p.decision).length })),
      read: (id) => new SweepStore(kb).read(id),
      async run({ all = false } = {}) {
        if (sweepRunning) throw new HttpError(409, "a sweep is already running");
        sweepRunning = true;
        try {
          const report = await runSweep(kb, adapter, { all, maxModelPairs: config.sweep.modelPairs, log });
          log(`sweep ${report.id}: ${report.proposals.length} proposal${report.proposals.length === 1 ? "" : "s"} over ${report.topics_checked.length} topics`);
          return report;
        } finally {
          sweepRunning = false;
        }
      },
      decide(principal, id, n, body) {
        // Human only: a session, or a token whose name is not a room participant
        // is not enough to tell, so tokens must say who they act for.
        const by = principal.kind === "session" ? principal.name : body.name;
        if (!by) throw new HttpError(403, "applying or rejecting a proposal is a human power; pass your name");
        try {
          return decideProposal(kb, id, Number(n), { action: body.action, by });
        } catch (error) {
          throw new HttpError(error.status || 400, error.message);
        }
      },
    },

    // ---- motions and human powers (DESIGN.md 6) ----

    async motions(code) {
      const room = loadOr404(code);
      return {
        open: rooms.openMotions(room).map((m) => rooms.motionView(m, null)),
        recent: room.motions.filter((m) => m.status !== "open").slice(-5).map((m) => rooms.motionView(m, null)),
      };
    },

    async motion(principal, code, body) {
      const me = body.name || principal.name;
      const { result, room } = await mutateAndPublish(code, (room) =>
        rooms.fileMotion(room, { type: body.type, proposer: me, reason: body.reason, summary: body.summary }),
      );
      if (!result.existing) afterMotion(code, result.motion, "filed", room);
      return { motion: rooms.motionView(result.motion, me), existing: result.existing };
    },

    async vote(principal, code, id, body) {
      const me = body.name || principal.name;
      const { result: motion, room } = await mutateAndPublish(code, (room) => rooms.castVote(room, id, { name: me, vote: body.vote, reason: body.reason }));
      afterMotion(code, motion, "voted", room);
      return { motion: rooms.motionView(motion, me) };
    },

    async override(principal, code, id, body) {
      const { result: motion, room } = await mutateAndPublish(code, (room) =>
        rooms.overrideMotion(room, id, { by: actingHuman(room, principal, body.name), outcome: body.outcome, reason: body.reason }),
      );
      afterMotion(code, motion, "resolved", room);
      return { motion: rooms.motionView(motion, null) };
    },

    async wait(principal, code, body) {
      const { result, room } = await mutateAndPublish(code, (room) =>
        rooms.waitRoom(room, { by: actingHuman(room, principal, body.name), target: body.for, seconds: body.seconds }),
      );
      if (result.target && result.target !== "ingest") {
        const mp = models.get(`${code}:${result.target.toLowerCase()}`);
        if (mp) {
          mp.suspendUnavailable(result.seconds * 1000);
          recordProfile(mp.profileKey, { wait: result.seconds });
        }
      }
      events.notify(code, { type: "room", room: rooms.summarizeRoom(room) });
      return result;
    },

    async hold(principal, code, body) {
      const action = String(body.action ?? "");
      if (action !== "pause" && action !== "resume") throw new HttpError(400, "action must be pause or resume");
      const { result, room } = await mutateAndPublish(code, (room) => {
        const by = actingHuman(room, principal, body.name);
        return action === "pause" ? rooms.holdRoom(room, by) : rooms.resumeRoom(room, by);
      });
      events.notify(code, { type: "room", room: rooms.summarizeRoom(room) });
      return { held: room.held, result };
    },

    async human(principal, code, body) {
      const { result, room } = await mutateAndPublish(code, (room) =>
        rooms.humanAction(room, { name: actingHuman(room, principal, body.name), action: body.action }),
      );
      events.notify(code, { type: "room", room: rooms.summarizeRoom(room) });
      return result;
    },

    /** Resolve expired motions and abandon unjoined rooms. Run by the scheduler and on demand. */
    async tick() {
      const resolved = [];
      const abandoned = [];
      const cutoff = Date.now() - config.abandonAfterSeconds * 1000;
      for (const code of [...abandonCandidates]) {
        try {
          const { result, room } = await mutateAndPublish(code, (room) => {
            if (room.status !== "open" || room.others_joined > 0 || room.human_present || isHumanCreator(room)) return "drop";
            if (Date.parse(room.created_at) > cutoff) return "keep";
            return rooms.abandonRoom(room) ? "abandoned" : "drop";
          });
          if (result !== "keep") abandonCandidates.delete(code);
          if (result === "abandoned") {
            motionRooms.delete(code);
            endLaunchesFor(code, "room abandoned").catch((e) => log(`launches ${code}: ${e.message}`));
            events.notify(code, { type: "room", room: rooms.summarizeRoom(room) });
            abandoned.push(code);
            log(`room ${code} abandoned: nobody joined ${room.created_by.name}`);
          }
        } catch (error) {
          log(`tick abandon ${code}: ${error.message}`);
          abandonCandidates.delete(code);
        }
      }
      for (const code of [...motionRooms]) {
        try {
          const { result, room } = await mutateAndPublish(code, (room) => {
            const done = [];
            for (const m of rooms.openMotions(room)) if (rooms.evaluate(room, m.id)) done.push(m);
            return done;
          });
          for (const m of result) {
            afterMotion(code, m, "resolved", room);
            resolved.push({ code, id: m.id, status: m.status, how: m.outcome.how });
          }
          if (!rooms.openMotions(room).length) motionRooms.delete(code);
        } catch (error) {
          log(`tick ${code}: ${error.message}`);
          motionRooms.delete(code);
        }
      }
      // Closing rooms past their maximum age close with the summary still pending.
      const timedOut = [];
      for (const code of [...closingRooms]) {
        try {
          const { result, room } = await mutateAndPublish(code, (room) => {
            if (room.status !== "closing") return "drop";
            if (ingestRunning === code) return "keep";
            const grace = room.ingest_grace_until ? Date.parse(room.ingest_grace_until) : 0;
            const deadline = Math.max(Date.parse(room.closed_at) + config.closingMaxSeconds * 1000, grace);
            if (Date.now() < deadline) return "keep";
            rooms.finishClosing(room, { status: room.ingest?.note_id ? "done" : "pending", last_error: room.ingest?.last_error || "closing timed out before a summary was written" });
            rooms.addSystemMessage(room, "The room closed before its summary was written; the summary will be retried in the background.", { action: "closing_timed_out" });
            return "timed_out";
          });
          if (result !== "keep") closingRooms.delete(code);
          if (result === "timed_out") {
            pendingIngests.add(code);
            timedOut.push(code);
            events.notify(code, { type: "room", room: rooms.summarizeRoom(room) });
          }
        } catch (error) {
          log(`tick closing ${code}: ${error.message}`);
          closingRooms.delete(code);
        }
      }
      await tickLaunches();
      // Expired tokens are dead already; drop the records.
      try {
        const gone = auth.sweepExpiredTokens();
        if (gone) log(`removed ${gone} expired token record(s)`);
      } catch (error) {
        log(`tick tokens: ${error.message}`);
      }
      // Uploads nobody ever attached to a message are removed after the orphan window.
      const orphanCutoff = Date.now() - config.limits.attachmentOrphanSeconds * 1000;
      for (const code of [...attachmentRooms]) {
        try {
          const { result } = await withRoom(code, (room) => {
            const gone = rooms.orphanedAttachments(room, orphanCutoff);
            for (const a of gone) {
              rooms.dropAttachment(room, a.id);
              files.remove(code, a.id, a.ext);
            }
            const stillWaiting = Object.values(room.attachments || {}).some((a) => a.message_id === null);
            return { result: { gone: gone.length, stillWaiting } };
          });
          if (result.gone) log(`room ${code}: removed ${result.gone} orphaned attachment(s)`);
          if (!result.stillWaiting) attachmentRooms.delete(code);
        } catch (error) {
          log(`tick attachments ${code}: ${error.message}`);
          attachmentRooms.delete(code);
        }
      }
      // Retry pending ingests once the retry interval has passed and the breaker allows.
      if (adapter && !breaker.isOpen()) {
        for (const code of [...pendingIngests]) {
          const room = store.loadRoom(code);
          if (!room || room.ingest?.status !== "pending") {
            pendingIngests.delete(code);
            continue;
          }
          if (Date.now() - Date.parse(room.ingest.updated_at) >= config.ingestRetrySeconds * 1000) enqueueIngest(code, { force: true });
        }
      }
      // The weekly sweep, when due and when there is anything to sweep.
      resolved.sweep = null;
      if (config.sweep.intervalDays > 0 && !sweepRunning && !ingestRunning) {
        const last = service.sweep.state().last_sweep_at;
        const due = !last || Date.now() - Date.parse(last) >= config.sweep.intervalDays * 86_400_000;
        if (due && kb.decisions().length) {
          try {
            resolved.sweep = (await service.sweep.run()).id;
          } catch (error) {
            log(`scheduled sweep: ${error.message}`);
          }
        }
      }
      resolved.abandoned = abandoned;
      resolved.timed_out = timedOut;
      return resolved;
    },

    /** Ask a runner to start a harness into a room. Fails at once if no runner offers it. */
    async launch(principal, code, body) {
      const harness = String(body.harness ?? "").trim();
      if (!harness) throw new HttpError(400, "harness is required");
      const runner = runnerFor(harness, body.runner ? String(body.runner) : null);
      const id = crypto.randomBytes(6).toString("hex");
      const { result } = await mutateAndPublish(code, (room) => rooms.requestLaunch(room, { id, harness, runner: runner.name, requested_by: body.name || principal.name }));
      const launch = result.launch;
      if (!result.existing) {
        launchIndex.set(launch.id, code);
        launchRooms.add(code);
        runner.active.add(launch.id);
        const room = store.loadRoom(code);
        runnerSend(runner.name, "launch", launchEventData(room, launch));
        events.notify(code, { type: "launch", launch: rooms.launchView(launch) });
        log(`launch ${launch.id} in ${code}: ${harness} requested on runner ${runner.name}`);
      }
      return { launch: rooms.launchView(launch), existing: result.existing };
    },

    /** The runner takes a launch: first claim wins and receives the room-scoped token, once. */
    async claimLaunch(principal, id, body) {
      const code = launchIndex.get(id);
      if (!code) throw new HttpError(404, `no active launch ${id}`);
      const runner = rooms.cleanName(body.runner || principal.name, "runner");
      requireRunnerToken(principal, runner);
      const tokenName = `launch-${id}`;
      const { result: launch, room } = await mutateAndPublish(code, (room) => rooms.claimLaunch(room, id, { runner, token_name: tokenName }));
      const minted = auth.createLaunchToken({ room: code, harness: launch.harness, launch: id, ttlMs: config.launch.tokenMinutes * 60_000 });
      events.notify(code, { type: "launch", launch: rooms.launchView(launch) });
      log(`launch ${id} in ${code}: claimed by runner ${runner}`);
      return {
        launch: rooms.launchView(launch),
        room: { code, title: room.title, objective: room.objective },
        invitation: invitationText(room, config.publicOrigin),
        mcp_url: `${config.publicOrigin}/mcp`,
        token: minted.token,
        token_expires_at: minted.expires_at,
        join_timeout_seconds: config.launch.joinTimeoutSeconds,
      };
    },

    /** The runner reports how a launch ended. */
    async launchStatus(principal, id, body) {
      const code = launchIndex.get(id);
      if (!code) throw new HttpError(404, `no active launch ${id}`);
      const state = String(body.state ?? "");
      if (state !== "exited" && state !== "failed") throw new HttpError(400, "state must be exited or failed");
      const { result, room } = await mutateAndPublish(code, (room) => {
        const current = room.launches?.[id];
        if (!current) throw new HttpError(404, `no active launch ${id}`);
        requireRunnerToken(principal, current.runner); // inside the queue, so the binding it checks is the one being ended
        return rooms.endLaunch(room, id, { state, reason: body.reason, exit_code: body.exit_code });
      });
      auth.revokeScoped(code, { launch: id });
      launchIndex.delete(id);
      runners.get(result.launch.runner)?.active.delete(id);
      if (!rooms.activeLaunches(room).length) launchRooms.delete(code);
      events.notify(code, { type: "launch", launch: rooms.launchView(result.launch) });
      log(`launch ${id} in ${code}: ${state}${body.reason ? ` (${body.reason})` : ""}`);
      return { launch: rooms.launchView(result.launch) };
    },

    runners() {
      return [...runners.values()].map(runnerView).sort((a, b) => a.name.localeCompare(b.name));
    },

    async invite(principal, code, body) {
      const kind = String(body.kind ?? "session");
      if (kind === "harness") return service.launch(principal, code, { harness: body.harness, runner: body.runner, name: body.name });
      if (kind === "model") {
        const profileKey = String(body.profile ?? "");
        const profile = config.profiles[profileKey];
        if (!profile) throw new HttpError(404, `no model profile named ${profileKey}; configured: ${Object.keys(config.profiles).join(", ") || "none"}`);
        const name = rooms.cleanName(body.name || profile.displayName);
        const key = `${code}:${name.toLowerCase()}`;
        if (models.has(key) && !models.get(key).stopped) return { participant: models.get(key).status(), rejoined: true };
        const { participant } = await withRoom(code, (room) => rooms.joinRoom(room, { name, kind: "model", client: profileKey }));
        events.notify(code, { type: "participant", action: "joined", participant });
        const mp = new ModelParticipant({ code, name, profileKey, profile, hooks: { ...modelHooks, loadImage: profile.vision ? loadImageFor(profile) : null } }).start();
        models.set(key, mp);
        log(`model ${name} (${profileKey}) joined ${code}`);
        mp.schedule();
        return { participant: mp.status(), rejoined: false };
      }
      if (kind === "human") {
        const { result: changed, room } = await mutateAndPublish(code, (room) => {
          if (room.status !== "open") throw new HttpError(409, `room ${code} is ${room.status}`);
          if (room.human_required) return false;
          room.human_required = true;
          rooms.addSystemMessage(room, `${principal.name} asked for a human to join.${body.reason ? ` Reason: ${body.reason}` : ""}`, { action: "human_called", reason: body.reason || null });
          return true;
        });
        if (changed) {
          events.notify(code, { type: "room", room: rooms.summarizeRoom(room) });
          notifier.humanNeeded(room, body.reason, "invited").catch(() => {});
        }
        return { ok: true, human_required: true };
      }
      if (kind === "session") {
        const room = loadOr404(code);
        const target = body.name ? rooms.cleanName(body.name, "invitee") : null;
        await withRoom(code, (r) => rooms.addSystemMessage(r, `${principal.name} invited ${target || "another session"}.`));
        events.notify(code, { type: "message", message: store.loadRoom(code).messages.at(-1) });
        return { invitation: invitationText(room, config.publicOrigin), deliver: "Send this text to the session yourself; the server cannot reach it." };
      }
      throw new HttpError(400, "kind must be session, model, or human");
    },
  };

  const mcp = createMcp({ service, version: VERSION, log });

  // ---- auth ----

  function requireAuth(req) {
    const principal = auth.authenticate(req);
    if (!principal) throw new HttpError(401, "sign in with a token");
    return principal;
  }

  /**
   * A scoped token belongs to one room. Anything addressed to another room,
   * to room creation, or to the lobby is refused; reading the record
   * (kb_search) is allowed because the pre-flight rule expects it.
   */
  function requireScope(principal, code) {
    const scope = principal.scope;
    if (!scope) return;
    if (!code) throw new HttpError(403, `token ${principal.name} is scoped to room ${scope.room} and cannot do this`);
    if (code !== scope.room) throw new HttpError(403, `token ${principal.name} is scoped to room ${scope.room}, not ${code}`);
  }

  function originAllowed(req) {
    const origin = req.headers.origin;
    return Boolean(origin) && config.allowedOrigins.has(origin);
  }

  function checkOrigin(req, principal) {
    if (!MUTATING.has(req.method) || principal.kind !== "session") return;
    if (!originAllowed(req)) throw new HttpError(403, `origin ${req.headers.origin || "(none)"} is not this server's public origin`);
  }

  // ---- API handlers ----

  function health() {
    const all = store.listRooms();
    const counts = {};
    for (const r of all) counts[r.status] = (counts[r.status] || 0) + 1;
    return {
      ok: true,
      version: VERSION,
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
      rooms: counts,
      limits: {
        messages_per_minute: config.limits.messagesPerMinute,
        rooms_per_hour: config.limits.roomsPerHour,
        max_body_bytes: config.limits.maxBodyBytes,
        max_wait_seconds: config.limits.maxWaitSeconds,
        max_attachment_bytes: config.limits.maxAttachmentBytes,
        max_room_attachment_bytes: config.limits.maxRoomAttachmentBytes,
      },
      events: events.counts(),
      models: modelStatuses(),
      profiles: profileReport(),
      scheduler: { rooms_with_motions: motionRooms.size, abandon_candidates: abandonCandidates.size, abandon_after_seconds: config.abandonAfterSeconds, closing: closingRooms.size },
      ingest: {
        adapter: adapter ? { name: adapter.name, model: adapter.model } : null,
        running: ingestRunning,
        pending: pendingIngests.size,
        breaker: breaker.state(),
        kb_dir: config.kbDir,
        closing_max_seconds: config.closingMaxSeconds,
        ingest_retry_seconds: config.ingestRetrySeconds,
      },
      search: { ...service.kb.embeddings(), inject_limit: config.search.injectLimit },
      sweep: { ...service.sweep.state(), interval_days: config.sweep.intervalDays, running: sweepRunning, undecided: service.sweep.list().reduce((s, x) => s + x.undecided, 0) },
      notifiers: notifier.targets,
      captions: captioner ? captioner.state() : null,
      runners: service.runners(),
      launches: { active_rooms: launchRooms.size, active: launchIndex.size },
      clocks: { window_seconds: config.clocks.window_ms / 1000, hard_seconds: config.clocks.hard_ms / 1000 },
      mcp: { endpoint: `${config.publicOrigin}/mcp`, protocol_versions: mcp.tools ? ["2025-11-25", "2025-06-18", "2025-03-26"] : [] },
      public_origin: config.publicOrigin,
    };
  }

  async function login(req, res) {
    // Login is browser-only and sets a cookie, so it gets the origin check
    // too; otherwise a hostile page could sign a victim in under its token.
    if (!originAllowed(req)) throw new HttpError(403, `origin ${req.headers.origin || "(none)"} is not this server's public origin`);
    const body = await readBody(req);
    const record = auth.verifyToken(String(body.token ?? "").trim());
    if (!record) throw new HttpError(401, "that token is not valid");
    // A browser session carries no scope, so a scoped token must not become one.
    if (record.scope) throw new HttpError(403, `token ${record.name} is scoped to room ${record.scope.room} and cannot sign in to the browser`);
    const name = rooms.cleanName(body.name || record.name, "display name");
    const id = auth.createSession(record.name, name);
    const secure = config.publicOrigin.startsWith("https:");
    send(res, 200, { name, token_name: record.name }, { "set-cookie": auth.sessionCookie(id, { secure }) });
  }

  async function handleApi(req, res, url, parts) {
    const [, head, code, sub, id, verb] = parts;

    if (head === "health" && req.method === "GET") return send(res, 200, health());

    if (head === "session") {
      if (req.method === "POST" && !code) return login(req, res);
      const principal = requireAuth(req);
      checkOrigin(req, principal);
      if (req.method === "GET") return send(res, 200, { kind: principal.kind, name: principal.name, token_name: principal.token_name ?? principal.name });
      if (req.method === "DELETE") {
        if (principal.kind === "session") auth.deleteSession(principal.id);
        return send(res, 200, { ok: true }, { "set-cookie": auth.clearedCookie() });
      }
      if (req.method === "POST" && code === "name" && principal.kind === "session") {
        const body = await readBody(req);
        const name = rooms.cleanName(body.name, "display name");
        auth.renameSession(principal.id, name);
        return send(res, 200, { name });
      }
      throw new HttpError(404, "not found");
    }

    if (head === "events" && req.method === "GET") {
      requireScope(requireAuth(req), null);
      return events.subscribe(null, res);
    }

    if (head === "runners" && req.method === "GET" && !code) {
      requireScope(requireAuth(req), null);
      return send(res, 200, { runners: service.runners() });
    }

    if (head === "runner" && code === "events" && req.method === "GET") {
      requireScope(requireAuth(req), null);
      return runnerSubscribe(req, res, { name: url.searchParams.get("name"), harnesses: url.searchParams.get("harnesses"), principal: auth.authenticate(req) });
    }

    if (head === "launches" && code && req.method === "POST") {
      const principal = requireAuth(req);
      checkOrigin(req, principal);
      requireScope(principal, null);
      const body = await readBody(req);
      if (sub === "claim") return send(res, 200, await service.claimLaunch(principal, code, body));
      if (sub === "status") return send(res, 200, await service.launchStatus(principal, code, body));
      throw new HttpError(404, "not found");
    }

    if (head === "kb") {
      const principal = requireAuth(req);
      checkOrigin(req, principal);
      if (code === "sweeps") {
        requireScope(principal, null);
        if (req.method === "GET" && !sub) return send(res, 200, { sweeps: service.sweep.list(), state: service.sweep.state() });
        if (req.method === "GET" && sub) {
          const r = service.sweep.read(sub);
          if (!r) throw new HttpError(404, `no sweep ${sub}`);
          return send(res, 200, { sweep: r });
        }
        if (req.method === "POST" && sub === "run") {
          const body = await readBody(req);
          return send(res, 201, { sweep: await service.sweep.run({ all: Boolean(body.all) }) });
        }
        if (req.method === "POST" && sub && id === "proposals" && verb) {
          const body = await readBody(req);
          return send(res, 200, { proposal: service.sweep.decide(principal, sub, verb, body) });
        }
        throw new HttpError(404, "not found");
      }
      if (req.method === "POST" && code === "index" && !sub) {
        // Rewrite INDEX.md and embed every decision that lacks a vector from the
        // current model: the backfill after enabling or changing embeddings.
        requireScope(principal, null);
        return send(res, 200, { reindex: await service.kb.reindex() });
      }
      if (req.method !== "GET") throw new HttpError(405, "method not allowed");
      if (code === "index") {
        res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" });
        return res.end(service.kb.index());
      }
      if (code === "meetings" && !sub) return send(res, 200, { meetings: service.kb.meetings() });
      if (code === "meetings" && sub) {
        const m = service.kb.meeting(sub);
        if (!m) throw new HttpError(404, `no meeting ${sub}`);
        return send(res, 200, { meeting: m });
      }
      if (code === "decisions") return send(res, 200, { decisions: service.kb.decisions({ status: url.searchParams.get("status") || undefined, topic: url.searchParams.get("topic") || undefined }) });
      if (code === "topics") return send(res, 200, { topics: service.kb.topics() });
      if (code === "search") {
        const q = url.searchParams.get("q") || "";
        if (!q.trim()) throw new HttpError(400, "q is required");
        const results = await service.kb.search(q, { k: Number(url.searchParams.get("k")) || 5, topic: url.searchParams.get("topic") || undefined, includeInactive: url.searchParams.get("all") === "1" });
        return send(res, 200, { query: q, results, embeddings: service.kb.embeddings() });
      }
      throw new HttpError(404, "not found");
    }

    if (head !== "rooms") throw new HttpError(404, "not found");

    // Attachment bytes: a valid signature stands in for a token, so an agent
    // can hand the URL to a tool that cannot set headers. Nothing else does.
    if (sub === "attachments" && id && req.method === "GET" && isRoomCode(code)) {
      const sig = url.searchParams.get("sig");
      if (!(sig && signer.verify(code, id, sig))) {
        if (sig) throw new HttpError(403, "the attachment link has expired or is not valid; ask for a fresh one by listening again");
        requireScope(requireAuth(req), code);
      }
      const { record, file } = service.attachment(code, id);
      res.writeHead(200, {
        "content-type": record.type,
        "content-length": record.bytes,
        "content-disposition": `inline; filename="${id}.${record.ext}"`,
        "cache-control": "private, max-age=300",
      });
      return fs.createReadStream(file).pipe(res);
    }

    const principal = requireAuth(req);
    checkOrigin(req, principal);
    requireScope(principal, code);

    if (!code) {
      if (req.method === "GET") {
        const status = url.searchParams.get("status");
        const { all } = await service.list(null);
        return send(res, 200, { rooms: status ? all.filter((r) => r.status === status) : all });
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        return send(res, 201, await service.createRoom(principal, body));
      }
      throw new HttpError(405, "method not allowed");
    }

    if (!isRoomCode(code)) throw new HttpError(404, `no room ${code}`);

    if (!sub && req.method === "GET") return send(res, 200, await service.get(code));

    if (sub === "events" && req.method === "GET") {
      if (!store.roomExists(code)) throw new HttpError(404, `no room ${code}`);
      return events.subscribe(code, res);
    }

    if (sub === "messages" && req.method === "GET") {
      const state = await service.listen(code, {
        name: url.searchParams.get("name"),
        wait: url.searchParams.get("wait") || 0,
        after: url.searchParams.has("after") ? url.searchParams.get("after") : null,
      });
      return send(res, 200, state);
    }

    if (sub === "motions" && req.method === "GET") return send(res, 200, await service.motions(code));
    if (sub === "launches" && req.method === "GET") return send(res, 200, { launches: (await service.status(code)).launches });
    if (sub === "brief" && req.method === "GET") return send(res, 200, await service.brief(code));

    if (req.method !== "POST") throw new HttpError(405, "method not allowed");

    if (sub === "attachments" && !id) {
      const buffer = await readRaw(req, config.limits.maxAttachmentBytes);
      const result = await service.upload(principal, code, { buffer, contentType: req.headers["content-type"], name: url.searchParams.get("name") });
      return send(res, 201, { attachment: result });
    }

    const body = await readBody(req);

    if (sub === "motions" && id !== undefined) {
      if (verb === "vote") return send(res, 200, await service.vote(principal, code, id, body));
      if (verb === "override") return send(res, 200, await service.override(principal, code, id, body));
      if (verb === "veto") return send(res, 200, await service.override(principal, code, id, { ...body, outcome: "cancel" }));
      throw new HttpError(404, "not found");
    }

    switch (sub) {
      case "motions":
        return send(res, 201, await service.motion(principal, code, body));
      case "launches":
        return send(res, 201, await service.launch(principal, code, body));
      case "wait":
        return send(res, 200, await service.wait(principal, code, body));
      case "hold":
        return send(res, 200, await service.hold(principal, code, body));
      case "human":
        return send(res, 200, await service.human(principal, code, body));
      case "ingest":
        return send(res, 200, await service.ingest(principal, code, body));
      case "join": {
        const r = await service.join(principal, code, body);
        return send(res, 200, r);
      }
      case "leave":
        await service.leave(principal, code, body);
        return send(res, 200, { ok: true });
      case "messages":
        return send(res, 201, { message: await service.send(principal, code, body) });
      case "invite":
        return send(res, 200, await service.invite(principal, code, body));
      case "mode":
        await service.setMode(principal, code, body.response_mode);
        return send(res, 200, { response_mode: body.response_mode });
      case "close":
        return send(res, 200, { ok: true, changed: await service.close(principal, code, body) });
      default:
        throw new HttpError(404, "not found");
    }
  }

  async function handleMcp(req, res) {
    // MCP clients are not browsers, but the spec says validate Origin when
    // present, so a rebinding page cannot drive the endpoint.
    if (req.headers.origin && !originAllowed(req)) throw new HttpError(403, `origin ${req.headers.origin} is not this server's public origin`);
    const principal = requireAuth(req);
    const body = req.method === "POST" ? await readBody(req) : null;
    return mcp.handle(req, res, { body, principal, send });
  }

  // ---- static ----

  function serveStatic(res, file) {
    const full = path.join(WEB_DIR, file);
    if (!full.startsWith(WEB_DIR) || !fs.existsSync(full)) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("not found");
    }
    const type = STATIC_TYPES[path.extname(full)] || "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": type.startsWith("text/html") ? "no-store" : "max-age=300" });
    fs.createReadStream(full).pipe(res);
  }

  // ---- dispatch ----

  async function handle(req, res) {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "same-origin");
    res.setHeader("content-security-policy", "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
    const url = new URL(req.url, config.publicOrigin);
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      if (parts[0] === "api") return await handleApi(req, res, url, parts);
      if (parts[0] === "mcp" && parts.length === 1) return await handleMcp(req, res);
      if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method not allowed");
      if (parts.length === 0) return serveStatic(res, "index.html");
      // Browsers and bookmark tools ask for these by path without reading any <link>.
      if (parts.length === 1 && (parts[0] === "favicon.ico" || parts[0] === "apple-touch-icon.png")) return serveStatic(res, parts[0]);
      if (parts[0] === "login" && parts.length === 1) return serveStatic(res, "login.html");
      if (parts[0] === "rooms" && parts.length === 2 && isRoomCode(parts[1])) return serveStatic(res, "room.html");
      if (parts[0] === "notes" && parts.length === 2 && /^M\d{8}-[A-Z0-9]{4}$/.test(parts[1])) return serveStatic(res, "note.html");
      if (parts[0] === "sweeps" && parts.length === 1) return serveStatic(res, "sweeps.html");
      if (parts[0] === "static" && parts.length === 2) return serveStatic(res, parts[1]);
      throw new HttpError(404, "not found");
    } catch (error) {
      const status = error.status || 500;
      if (status >= 500) log(`error ${req.method} ${url.pathname}: ${error.stack || error}`);
      if (res.headersSent) return res.end();
      const message = status >= 500 && !(error instanceof FormatTooNewError) ? "internal error" : error.message;
      return send(res, status, { error: message, ...(error.extra || {}) });
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      log(`unhandled ${error.stack || error}`);
      if (!res.headersSent) send(res, 500, { error: "internal error" });
    });
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  function bootstrapToken() {
    if (auth.hasAnyToken()) return null;
    try {
      const { token } = auth.createToken("bootstrap");
      log(`no tokens existed, so one was created. Token "bootstrap": ${token}`);
      log(`save it now; it is not shown again. Sign in at ${config.publicOrigin}/login`);
      return token;
    } catch (error) {
      if (!config.loopback) throw new Error(`refusing to bind ${config.bind} with no token and no way to create one: ${error.message}`);
      log(`could not create a bootstrap token: ${error.message}`);
      return null;
    }
  }

  return {
    config,
    store,
    auth,
    events,
    service,
    server,
    start() {
      for (const w of config.warnings || []) log(`warning: ${w}`);
      bootstrapToken();
      for (const r of store.readJSON(runnersFile, { runners: [] }).runners || []) {
        runners.set(r.name, { name: r.name, harnesses: new Set(r.harnesses || []), res: null, last_seen_at: r.last_seen_at || rooms.now(), active: new Set(), token: r.token || null });
      }
      for (const room of store.listRooms()) {
        if (room.status === "closing") {
          closingRooms.add(room.code);
          if (room.ingest?.status !== "done") enqueueIngest(room.code); // resume after a restart
          continue;
        }
        if (room.status === "closed" && room.ingest?.status === "pending") pendingIngests.add(room.code);
        if (room.status !== "open") continue;
        if (rooms.openMotions(room).length) motionRooms.add(room.code);
        for (const l of rooms.activeLaunches(room)) {
          launchIndex.set(l.id, room.code);
          launchRooms.add(room.code);
          const r = runners.get(l.runner);
          if (r) r.active.add(l.id);
        }
        if (!isHumanCreator(room) && !room.others_joined && !room.human_present) abandonCandidates.add(room.code);
        if (Object.values(room.attachments || {}).some((a) => a.message_id === null)) attachmentRooms.add(room.code);
      }
      if (adapter) log(`summarizer: ${adapter.name} (${adapter.model}); knowledge store at ${config.kbDir}`);
      else log("no summarizer configured; rooms close without a summary (set config.summarizer to enable)");
      this.timer = setInterval(() => service.tick().catch((e) => log(`tick: ${e.message}`)), 5000);
      this.timer.unref();
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.bind, () => {
          server.off("error", reject);
          const addr = server.address();
          if (config.port === 0) {
            // Ephemeral port (tests): make the origin checks match reality.
            config.port = addr.port;
            config.publicOrigin = `http://${config.loopback ? "127.0.0.1" : config.bind}:${addr.port}`;
            if (config.loopback) for (const host of ["127.0.0.1", "localhost", "[::1]"]) config.allowedOrigins.add(`http://${host}:${addr.port}`);
            else config.allowedOrigins.add(config.publicOrigin);
          }
          log(`mAIndmeld ${VERSION} listening on http://${config.bind}:${addr.port} (data ${config.dataDir}); MCP at ${config.publicOrigin}/mcp`);
          resolve(addr);
        });
      });
    },
    async stop() {
      clearInterval(this.timer);
      await ingestChain.catch(() => {});
      await captionsInFlight.catch(() => {});
      for (const mp of models.values()) mp.stop();
      models.clear();
      for (const set of events.subscribers.values()) for (const res of set) res.end();
      for (const res of events.lobby) res.end();
      for (const r of runners.values()) if (r.res) r.res.end();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
