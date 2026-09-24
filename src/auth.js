// Tokens and browser sessions. Tokens are hashed at rest; the plaintext is
// shown once at creation. Sessions are cookie-backed and persisted so a
// restart does not sign everyone out. DESIGN.md 5.1.
//
// A token may carry an expiry and a scope. A scoped token belongs to one
// room (and names the harness and launch it was minted for) and can do
// nothing outside it; the server enforces that on every room-addressed
// request. Records without these fields behave as they always have.

import crypto from "node:crypto";

const TOKEN_PREFIX = "mm_";
const SESSION_COOKIE = "mm_session";

export class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

const hash = (value) => crypto.createHash("sha256").update(value, "utf8").digest("hex");

export function parseCookies(header) {
  const out = new Map();
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out.set(part.slice(0, idx).trim(), decodeURIComponent(part.slice(idx + 1).trim()));
  }
  return out;
}

export class Auth {
  constructor(store, { sessionDays = 30 } = {}) {
    this.store = store;
    this.sessionDays = sessionDays;
    this.tokensFile = store.filePath("tokens.json");
    this.sessionsFile = store.filePath("sessions.json");
  }

  // ---- tokens ----

  readTokens() {
    return this.store.readJSON(this.tokensFile, { format: 1, tokens: [] });
  }

  writeTokens(data) {
    this.store.writeJSON(this.tokensFile, data);
  }

  hasAnyToken() {
    return this.readTokens().tokens.some((t) => !t.revoked_at);
  }

  createToken(name, { expiresAt = null, scope = null } = {}) {
    const clean = String(name ?? "").trim();
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(clean)) {
      throw new AuthError(400, "token name must be 1-40 characters of letters, digits, dot, dash, or underscore");
    }
    const data = this.readTokens();
    if (data.tokens.some((t) => t.name === clean && !t.revoked_at)) {
      throw new AuthError(409, `an active token named ${clean} already exists`);
    }
    const plaintext = TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
    const record = { name: clean, hash: hash(plaintext), created_at: new Date().toISOString(), revoked_at: null };
    if (expiresAt) record.expires_at = new Date(expiresAt).toISOString();
    if (scope) record.scope = { room: scope.room, harness: scope.harness ?? null, launch: scope.launch ?? null };
    data.tokens.push(record);
    this.writeTokens(data);
    return { name: clean, token: plaintext, expires_at: record.expires_at ?? null, scope: record.scope ?? null };
  }

  /** A token for one launch of a harness into one room; expires on its own and is revoked when the launch ends. */
  createLaunchToken({ room, harness, launch, ttlMs = 15 * 60_000 }, nowMs = Date.now()) {
    if (!room || !launch) throw new AuthError(400, "a launch token needs a room and a launch id");
    return this.createToken(`launch-${launch}`, { expiresAt: nowMs + ttlMs, scope: { room, harness, launch } });
  }

  listTokens() {
    return this.readTokens().tokens.map(({ name, created_at, revoked_at, expires_at, scope }) => ({ name, created_at, revoked_at, expires_at: expires_at ?? null, scope: scope ?? null }));
  }

  /** Revoke every active token scoped to a room (the room closed, or a launch ended). Returns the names. */
  revokeScoped(room, { launch = null } = {}) {
    const data = this.readTokens();
    const stamp = new Date().toISOString();
    const names = [];
    for (const t of data.tokens) {
      if (t.revoked_at || !t.scope || t.scope.room !== room) continue;
      if (launch && t.scope.launch !== launch) continue;
      t.revoked_at = stamp;
      names.push(t.name);
    }
    if (names.length) this.writeTokens(data);
    return names;
  }

  /** Drop expired records; nothing can use them and they would only pile up. Returns how many went. */
  sweepExpiredTokens(nowMs = Date.now()) {
    const data = this.readTokens();
    const before = data.tokens.length;
    data.tokens = data.tokens.filter((t) => !(t.expires_at && Date.parse(t.expires_at) < nowMs));
    if (data.tokens.length !== before) this.writeTokens(data);
    return before - data.tokens.length;
  }

  revokeToken(name) {
    const data = this.readTokens();
    const record = data.tokens.find((t) => t.name === name && !t.revoked_at);
    if (!record) throw new AuthError(404, `no active token named ${name}`);
    record.revoked_at = new Date().toISOString();
    this.writeTokens(data);
    // Sessions opened with this token die with it.
    const sessions = this.readSessions();
    for (const [id, s] of Object.entries(sessions.sessions)) {
      if (s.token_name === name) delete sessions.sessions[id];
    }
    this.writeSessions(sessions);
    return record.name;
  }

  verifyToken(plaintext, nowMs = Date.now()) {
    if (typeof plaintext !== "string" || !plaintext.startsWith(TOKEN_PREFIX)) return null;
    const candidate = Buffer.from(hash(plaintext), "hex");
    for (const t of this.readTokens().tokens) {
      if (t.revoked_at) continue;
      if (t.expires_at && Date.parse(t.expires_at) < nowMs) continue;
      const stored = Buffer.from(t.hash, "hex");
      if (stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate)) {
        return { name: t.name, scope: t.scope ?? null, expires_at: t.expires_at ?? null };
      }
    }
    return null;
  }

  // ---- sessions ----

  readSessions() {
    return this.store.readJSON(this.sessionsFile, { format: 1, sessions: {} });
  }

  writeSessions(data) {
    this.store.writeJSON(this.sessionsFile, data);
  }

  createSession(tokenName, displayName) {
    const id = crypto.randomBytes(32).toString("base64url");
    const data = this.readSessions();
    const nowMs = Date.now();
    for (const [sid, s] of Object.entries(data.sessions)) {
      if (Date.parse(s.expires_at) < nowMs) delete data.sessions[sid];
    }
    data.sessions[id] = {
      token_name: tokenName,
      display_name: displayName,
      created_at: new Date(nowMs).toISOString(),
      expires_at: new Date(nowMs + this.sessionDays * 86400_000).toISOString(),
    };
    this.writeSessions(data);
    return id;
  }

  getSession(id) {
    if (!id) return null;
    const data = this.readSessions();
    const s = data.sessions[id];
    if (!s) return null;
    if (Date.parse(s.expires_at) < Date.now()) {
      delete data.sessions[id];
      this.writeSessions(data);
      return null;
    }
    return { id, ...s };
  }

  renameSession(id, displayName) {
    const data = this.readSessions();
    if (!data.sessions[id]) throw new AuthError(401, "session not found");
    data.sessions[id].display_name = displayName;
    this.writeSessions(data);
  }

  deleteSession(id) {
    const data = this.readSessions();
    delete data.sessions[id];
    this.writeSessions(data);
  }

  // ---- request authentication ----

  /**
   * Returns { kind: "token", name, scope } for a bearer request (scope is
   * null for an ordinary token), { kind: "session", id, name, token_name }
   * for a cookie request, or null.
   */
  authenticate(req) {
    const header = req.headers.authorization;
    if (header) {
      const [scheme, value] = header.split(" ", 2);
      if (scheme?.toLowerCase() === "bearer") {
        const record = this.verifyToken(value?.trim());
        if (record) return { kind: "token", name: record.name, scope: record.scope };
      }
      return null;
    }
    const id = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
    const session = this.getSession(id);
    if (session) return { kind: "session", id: session.id, name: session.display_name, token_name: session.token_name };
    return null;
  }

  // Lax, not Strict: a link to a room from a notification in another app
  // must open signed in. Cross-site POSTs are still refused by the browser
  // under Lax, and the server's origin check covers every mutation anyway.
  sessionCookie(id, { secure }) {
    const maxAge = this.sessionDays * 86400;
    return `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
  }

  clearedCookie() {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }
}
