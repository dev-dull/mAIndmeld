// Tokens and browser sessions. Tokens are hashed at rest; the plaintext is
// shown once at creation. Sessions are cookie-backed and persisted so a
// restart does not sign everyone out. DESIGN.md 5.1.

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

  createToken(name) {
    const clean = String(name ?? "").trim();
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(clean)) {
      throw new AuthError(400, "token name must be 1-40 characters of letters, digits, dot, dash, or underscore");
    }
    const data = this.readTokens();
    if (data.tokens.some((t) => t.name === clean && !t.revoked_at)) {
      throw new AuthError(409, `an active token named ${clean} already exists`);
    }
    const plaintext = TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
    data.tokens.push({ name: clean, hash: hash(plaintext), created_at: new Date().toISOString(), revoked_at: null });
    this.writeTokens(data);
    return { name: clean, token: plaintext };
  }

  listTokens() {
    return this.readTokens().tokens.map(({ name, created_at, revoked_at }) => ({ name, created_at, revoked_at }));
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

  verifyToken(plaintext) {
    if (typeof plaintext !== "string" || !plaintext.startsWith(TOKEN_PREFIX)) return null;
    const candidate = Buffer.from(hash(plaintext), "hex");
    for (const t of this.readTokens().tokens) {
      if (t.revoked_at) continue;
      const stored = Buffer.from(t.hash, "hex");
      if (stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate)) return { name: t.name };
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
   * Returns { kind: "token", name } for a bearer request,
   * { kind: "session", id, name, token_name } for a cookie request, or null.
   */
  authenticate(req) {
    const header = req.headers.authorization;
    if (header) {
      const [scheme, value] = header.split(" ", 2);
      if (scheme?.toLowerCase() === "bearer") {
        const record = this.verifyToken(value?.trim());
        if (record) return { kind: "token", name: record.name };
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
