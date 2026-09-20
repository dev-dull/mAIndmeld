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

const here = path.dirname(fileURLToPath(import.meta.url));
export const VERSION = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8")).version;
const WEB_DIR = path.join(here, "web");

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const STATIC_TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

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
  const models = new Map(); // `${code}:${name}` -> ModelParticipant
  const quiet = process.env.MAINDMELD_QUIET === "1";
  const log = (line) => {
    if (!quiet) process.stdout.write(`${new Date().toISOString()} ${line}\n`);
  };

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

  const isHumanCreator = (room) => room.created_by.kind === "human";

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
      return { room: fresh, invitation: invitationText(fresh, config.publicOrigin), invites };
    },

    async get(code) {
      const room = loadOr404(code);
      return { room, invitation: invitationText(room, config.publicOrigin) };
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
      const result = await withRoom(code, (room) => {
        const { participant, rejoined } = rooms.joinRoom(room, {
          name: body.name || principal.name,
          kind: body.kind || principalKind(principal),
          client: body.client,
        });
        return { participant, rejoined, room };
      });
      if (!result.rejoined) {
        events.notify(code, { type: "participant", action: "joined", participant: result.participant });
        if (result.room.others_joined > 0) abandonCandidates.delete(code);
      }
      return { ...result, invitation: invitationText(result.room, config.publicOrigin) };
    },

    async leave(principal, code, body) {
      const participant = await withRoom(code, (room) => rooms.leaveRoom(room, body.name || principal.name, body.message));
      events.notify(code, { type: "participant", action: "left", participant });
      return participant;
    },

    async send(principal, code, body) {
      limit(principal, "messages");
      const message = await withRoom(code, (room) =>
        rooms.sendMessage(room, { sender: body.sender || principal.name, content: body.content, reply_to: body.reply_to }, config.limits.maxBodyBytes),
      );
      events.notify(code, { type: "message", message });
      return message;
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
        messages,
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
        log(`room ${code} closed by ${principal.name}`);
      }
      return changed;
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
      resolved.abandoned = abandoned;
      return resolved;
    },

    async invite(principal, code, body) {
      const kind = String(body.kind ?? "session");
      if (kind === "model") {
        const profileKey = String(body.profile ?? "");
        const profile = config.profiles[profileKey];
        if (!profile) throw new HttpError(404, `no model profile named ${profileKey}; configured: ${Object.keys(config.profiles).join(", ") || "none"}`);
        const name = rooms.cleanName(body.name || profile.displayName);
        const key = `${code}:${name.toLowerCase()}`;
        if (models.has(key) && !models.get(key).stopped) return { participant: models.get(key).status(), rejoined: true };
        const { participant } = await withRoom(code, (room) => rooms.joinRoom(room, { name, kind: "model", client: profileKey }));
        events.notify(code, { type: "participant", action: "joined", participant });
        const mp = new ModelParticipant({ code, name, profileKey, profile, hooks: modelHooks }).start();
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
      },
      events: events.counts(),
      models: modelStatuses(),
      profiles: profileReport(),
      scheduler: { rooms_with_motions: motionRooms.size, abandon_candidates: abandonCandidates.size, abandon_after_seconds: config.abandonAfterSeconds },
      notifiers: notifier.targets,
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
      requireAuth(req);
      return events.subscribe(null, res);
    }

    if (head !== "rooms") throw new HttpError(404, "not found");
    const principal = requireAuth(req);
    checkOrigin(req, principal);

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

    if (req.method !== "POST") throw new HttpError(405, "method not allowed");
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
      case "wait":
        return send(res, 200, await service.wait(principal, code, body));
      case "hold":
        return send(res, 200, await service.hold(principal, code, body));
      case "human":
        return send(res, 200, await service.human(principal, code, body));
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
      if (parts[0] === "login" && parts.length === 1) return serveStatic(res, "login.html");
      if (parts[0] === "rooms" && parts.length === 2 && isRoomCode(parts[1])) return serveStatic(res, "room.html");
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
      for (const room of store.listRooms()) {
        if (room.status !== "open") continue;
        if (rooms.openMotions(room).length) motionRooms.add(room.code);
        if (!isHumanCreator(room) && !room.others_joined && !room.human_present) abandonCandidates.add(room.code);
      }
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
    stop() {
      clearInterval(this.timer);
      for (const mp of models.values()) mp.stop();
      models.clear();
      for (const set of events.subscribers.values()) for (const res of set) res.end();
      for (const res of events.lobby) res.end();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
