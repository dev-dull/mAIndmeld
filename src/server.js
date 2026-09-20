// The mAIndmeld server: one process serving the JSON API, long-poll and SSE
// fan-out, and the web UI from one origin. DESIGN.md sections 3, 5, 8.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.js";
import { Store, isRoomCode, FormatTooNewError } from "./store.js";
import * as rooms from "./rooms.js";
import { Auth, AuthError } from "./auth.js";
import { RoomEvents } from "./events.js";
import { ModelParticipant } from "./models.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const VERSION = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8")).version;
const WEB_DIR = path.join(here, "web");

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const STATIC_TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

class HttpError extends Error {
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
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "request body must be a JSON object");
    return parsed;
  }

  /** Load, mutate synchronously, save, and notify. Serialized per room. */
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

  function requireAuth(req) {
    const principal = auth.authenticate(req);
    if (!principal) throw new HttpError(401, "sign in with a token");
    return principal;
  }

  function checkOrigin(req, principal) {
    if (!MUTATING.has(req.method) || principal.kind !== "session") return;
    const origin = req.headers.origin;
    if (!origin || !config.allowedOrigins.has(origin)) {
      throw new HttpError(403, `origin ${origin || "(none)"} is not this server's public origin`);
    }
  }

  function limit(principal, kind) {
    const key = `${kind}:${principalKey(principal)}`;
    const ok = kind === "messages"
      ? limiter.allow(key, config.limits.messagesPerMinute, 60_000)
      : limiter.allow(key, config.limits.roomsPerHour, 3_600_000);
    if (!ok) throw new HttpError(429, `rate limit hit: ${kind === "messages" ? `${config.limits.messagesPerMinute} messages per minute` : `${config.limits.roomsPerHour} rooms per hour`}`, { limit: kind });
  }

  // ---- model participants ----

  const modelHooks = {
    loadRoom: (code) => store.loadRoom(code),
    on: (code, fn) => events.on(code, fn),
    log,
    async post(code, name, text) {
      const message = await withRoom(code, (room) => rooms.sendMessage(room, { sender: name, content: text }, config.limits.maxBodyBytes));
      events.notify(code, { type: "message", message });
    },
    async system(code, text) {
      const message = await withRoom(code, (room) => rooms.addSystemMessage(room, text));
      events.notify(code, { type: "message", message });
    },
  };

  async function inviteModel(code, profileKey, requestedName) {
    const profile = config.profiles[profileKey];
    if (!profile) throw new HttpError(404, `no model profile named ${profileKey}; configured: ${Object.keys(config.profiles).join(", ") || "none"}`);
    const name = rooms.cleanName(requestedName || profile.displayName);
    const key = `${code}:${name.toLowerCase()}`;
    if (models.has(key)) return { participant: models.get(key).status(), rejoined: true };
    const { participant } = await withRoom(code, (room) => rooms.joinRoom(room, { name, kind: "model", client: profileKey }));
    events.notify(code, { type: "participant", action: "joined", participant });
    const mp = new ModelParticipant({ code, name, profileKey, profile, hooks: modelHooks }).start();
    models.set(key, mp);
    log(`model ${name} (${profileKey}) joined ${code}`);
    // Let it read the room as it stands and speak if it has something to say.
    mp.schedule();
    return { participant: mp.status(), rejoined: false };
  }

  function modelStatuses() {
    const out = [];
    for (const [key, mp] of models) {
      if (mp.stopped) models.delete(key);
      else out.push(mp.status());
    }
    return out;
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
      profiles: Object.keys(config.profiles),
      public_origin: config.publicOrigin,
    };
  }

  async function login(req, res) {
    // Login is browser-only and sets a cookie, so it gets the origin check
    // too; otherwise a hostile page could sign a victim in under its token.
    const origin = req.headers.origin;
    if (!origin || !config.allowedOrigins.has(origin)) {
      throw new HttpError(403, `origin ${origin || "(none)"} is not this server's public origin`);
    }
    const body = await readBody(req);
    const record = auth.verifyToken(String(body.token ?? "").trim());
    if (!record) throw new HttpError(401, "that token is not valid");
    const name = rooms.cleanName(body.name || record.name, "display name");
    const id = auth.createSession(record.name, name);
    const secure = config.publicOrigin.startsWith("https:");
    send(res, 200, { name, token_name: record.name }, { "set-cookie": auth.sessionCookie(id, { secure }) });
  }

  async function handleApi(req, res, url, parts) {
    // parts: ["api", ...]
    const [, head, code, sub, ...rest] = parts;

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
        const list = store.listRooms()
          .filter((r) => !status || r.status === status)
          .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
          .map(rooms.summarizeRoom);
        return send(res, 200, { rooms: list });
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        limit(principal, "rooms");
        let room;
        for (let attempt = 0; attempt < 5; attempt += 1) {
          room = rooms.createRoom({
            title: body.title,
            objective: body.objective,
            creator: { name: body.name || principal.name, kind: body.kind || principalKind(principal), client: body.client },
            responseMode: body.response_mode,
          });
          if (!store.roomExists(room.code)) break;
          room = null;
        }
        if (!room) throw new HttpError(500, "could not allocate a room code");
        store.saveRoom(room);
        events.notify(room.code, { type: "room", room: rooms.summarizeRoom(room) });
        log(`room ${room.code} created by ${room.created_by.name} (${room.created_by.kind})`);
        return send(res, 201, { room, invitation: invitationText(room, config.publicOrigin) });
      }
      throw new HttpError(405, "method not allowed");
    }

    if (!isRoomCode(code)) throw new HttpError(404, `no room ${code}`);

    if (!sub && req.method === "GET") {
      const room = store.loadRoom(code);
      if (!room) throw new HttpError(404, `no room ${code}`);
      return send(res, 200, { room, invitation: invitationText(room, config.publicOrigin) });
    }

    if (sub === "events" && req.method === "GET") {
      if (!store.roomExists(code)) throw new HttpError(404, `no room ${code}`);
      return events.subscribe(code, res);
    }

    if (sub === "messages" && req.method === "GET") return longPoll(req, res, url, code);

    if (req.method !== "POST") throw new HttpError(405, "method not allowed");
    const body = await readBody(req);

    switch (sub) {
      case "join": {
        const result = await withRoom(code, (room) => {
          const { participant, rejoined } = rooms.joinRoom(room, {
            name: body.name || principal.name,
            kind: body.kind || principalKind(principal),
            client: body.client,
          });
          return { participant, rejoined, room };
        });
        if (!result.rejoined) events.notify(code, { type: "participant", action: "joined", participant: result.participant });
        return send(res, 200, { room: result.room, participant: result.participant, rejoined: result.rejoined, invitation: invitationText(result.room, config.publicOrigin) });
      }
      case "leave": {
        const participant = await withRoom(code, (room) => rooms.leaveRoom(room, body.name || principal.name, body.message));
        events.notify(code, { type: "participant", action: "left", participant });
        return send(res, 200, { ok: true });
      }
      case "messages": {
        limit(principal, "messages");
        const message = await withRoom(code, (room) =>
          rooms.sendMessage(room, { sender: body.sender || principal.name, content: body.content, reply_to: body.reply_to }, config.limits.maxBodyBytes),
        );
        events.notify(code, { type: "message", message });
        return send(res, 201, { message });
      }
      case "invite": {
        const kind = String(body.kind ?? "session");
        if (kind === "model") {
          const result = await inviteModel(code, String(body.profile ?? ""), body.name);
          return send(res, 200, result);
        }
        if (kind === "human") {
          const changed = await withRoom(code, (room) => {
            if (room.status !== "open") throw new HttpError(409, `room ${code} is ${room.status}`);
            if (room.human_required) return false;
            room.human_required = true;
            rooms.addSystemMessage(room, `${principal.name} asked for a human to join.${body.reason ? ` Reason: ${body.reason}` : ""}`);
            return true;
          });
          if (changed) {
            const room = store.loadRoom(code);
            events.notify(code, { type: "room", room: rooms.summarizeRoom(room) });
            events.notify(code, { type: "message", message: room.messages.at(-1) });
          }
          return send(res, 200, { ok: true, human_required: true });
        }
        if (kind === "session") {
          const room = store.loadRoom(code);
          if (!room) throw new HttpError(404, `no room ${code}`);
          const target = body.name ? rooms.cleanName(body.name, "invitee") : null;
          await withRoom(code, (r) => rooms.addSystemMessage(r, `${principal.name} invited ${target || "another session"}.`));
          events.notify(code, { type: "message", message: store.loadRoom(code).messages.at(-1) });
          return send(res, 200, { invitation: invitationText(room, config.publicOrigin), deliver: "Send this text to the session yourself; the server cannot reach it." });
        }
        throw new HttpError(400, "kind must be session, model, or human");
      }
      case "mode": {
        const changed = await withRoom(code, (room) => rooms.setResponseMode(room, body.response_mode, principal.name));
        if (changed) events.notify(code, { type: "room", room: rooms.summarizeRoom(store.loadRoom(code)) });
        return send(res, 200, { response_mode: body.response_mode });
      }
      case "close": {
        // Milestone 1: any principal may close directly. Milestone 3 restricts
        // direct close to humans and gives agents the close motion.
        const changed = await withRoom(code, (room) =>
          rooms.closeRoom(room, { by: body.name || principal.name, kind: principalKind(principal), summary: body.summary, how: "direct" }),
        );
        if (changed) {
          const room = store.loadRoom(code);
          events.notify(code, { type: "room", room: rooms.summarizeRoom(room) });
          events.notify(code, { type: "message", message: room.messages.at(-1) });
          log(`room ${code} closed by ${principal.name}`);
        }
        return send(res, 200, { ok: true, changed });
      }
      default:
        throw new HttpError(404, "not found");
    }
  }

  async function longPoll(req, res, url, code) {
    const name = url.searchParams.get("name");
    const wait = Math.min(config.limits.maxWaitSeconds, Math.max(0, Number(url.searchParams.get("wait") || 0) || 0));
    const explicitAfter = url.searchParams.has("after") ? Math.max(0, Number(url.searchParams.get("after")) || 0) : null;

    const snapshot = (room) => {
      const participant = name ? rooms.findParticipant(room, name) : null;
      if (name && !participant && room.status === "open") throw new HttpError(403, `${name} is not a participant in ${code}; join first`);
      const after = explicitAfter ?? (participant ? participant.cursor : 0);
      const messages = participant && explicitAfter === null
        ? rooms.unreadFor(room, participant)
        : rooms.messagesAfter(room, after).filter((m) => !participant || m.sender.toLowerCase() !== participant.name.toLowerCase());
      return { participant, messages };
    };

    let room = store.loadRoom(code);
    if (!room) throw new HttpError(404, `no room ${code}`);
    let { participant, messages } = snapshot(room);

    if (messages.length === 0 && room.status === "open" && wait > 0) {
      await events.waitForChange(code, wait);
      room = store.loadRoom(code);
      if (!room) throw new HttpError(404, `no room ${code}`);
      ({ participant, messages } = snapshot(room));
    }

    let cursor = explicitAfter ?? 0;
    if (participant) {
      cursor = room.next_message_id - 1;
      await withRoom(code, (r) => {
        const p = rooms.findParticipant(r, participant.name);
        if (p) {
          p.cursor = Math.max(p.cursor, cursor);
          p.last_seen_at = rooms.now();
        }
      });
    } else if (messages.length) {
      cursor = messages.at(-1).id;
    }

    const next = room.status !== "open" ? "leave" : messages.some((m) => m.kind !== "system") ? "reply" : "listen";
    return send(res, 200, {
      code,
      status: room.status,
      response_mode: room.response_mode,
      human_required: room.human_required,
      human_present: room.human_present,
      participants: room.participants.map(({ name: n, kind, last_seen_at }) => ({ name: n, kind, last_seen_at })),
      motions_open: room.motions.filter((m) => m.status === "open"),
      messages,
      cursor,
      next,
    });
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
    server,
    start() {
      for (const w of config.warnings || []) log(`warning: ${w}`);
      bootstrapToken();
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
          log(`mAIndmeld ${VERSION} listening on http://${config.bind}:${addr.port} (data ${config.dataDir})`);
          resolve(addr);
        });
      });
    },
    stop() {
      for (const mp of models.values()) mp.stop();
      models.clear();
      for (const set of events.subscribers.values()) for (const res of set) res.end();
      for (const res of events.lobby) res.end();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
