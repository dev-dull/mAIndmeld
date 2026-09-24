import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { Store } from "../src/store.js";
import { Auth, parseCookies } from "../src/auth.js";
import { tmpDataDir } from "./helpers.js";

function fresh() {
  const dir = tmpDataDir();
  return { dir, auth: new Auth(new Store(dir), { sessionDays: 1 }) };
}

test("tokens are created once, stored hashed, verified, and revoked", () => {
  const { dir, auth } = fresh();
  assert.equal(auth.hasAnyToken(), false);
  const { token } = auth.createToken("cli");
  assert.match(token, /^mm_[A-Za-z0-9_-]{40,}$/);
  const onDisk = fs.readFileSync(`${dir}/tokens.json`, "utf8");
  assert.ok(!onDisk.includes(token), "plaintext must not be on disk");
  assert.deepEqual(auth.verifyToken(token), { name: "cli", scope: null, expires_at: null });
  assert.equal(auth.verifyToken("mm_nope"), null);
  assert.equal(auth.verifyToken(undefined), null);
  assert.throws(() => auth.createToken("cli"), /already exists/);
  assert.throws(() => auth.createToken("bad name!"), /token name/);
  auth.revokeToken("cli");
  assert.equal(auth.verifyToken(token), null);
  assert.equal(auth.hasAnyToken(), false);
  assert.throws(() => auth.revokeToken("cli"), /no active token/);
});

test("sessions are created, read back, renamed, and die with their token", () => {
  const { auth } = fresh();
  auth.createToken("web");
  const id = auth.createSession("web", "Ana");
  const s = auth.getSession(id);
  assert.equal(s.display_name, "Ana");
  assert.equal(s.token_name, "web");
  auth.renameSession(id, "Ana B");
  assert.equal(auth.getSession(id).display_name, "Ana B");
  auth.revokeToken("web");
  assert.equal(auth.getSession(id), null);
});

test("authenticate reads bearer headers and session cookies", () => {
  const { auth } = fresh();
  const { token } = auth.createToken("agent");
  assert.deepEqual(auth.authenticate({ headers: { authorization: `Bearer ${token}` } }), { kind: "token", name: "agent", scope: null });
  assert.equal(auth.authenticate({ headers: { authorization: "Bearer mm_wrong" } }), null);
  assert.equal(auth.authenticate({ headers: {} }), null);
  const id = auth.createSession("agent", "Ana");
  const p = auth.authenticate({ headers: { cookie: `other=1; mm_session=${id}` } });
  assert.equal(p.kind, "session");
  assert.equal(p.name, "Ana");
  assert.equal(p.token_name, "agent");
});

test("parseCookies handles empty and messy headers", () => {
  assert.equal(parseCookies(undefined).size, 0);
  const c = parseCookies(" a=1;b=%20x ; junk ");
  assert.equal(c.get("a"), "1");
  assert.equal(c.get("b"), " x");
});

test("expiring and scoped tokens: verified within scope and time, listed with both, revoked by room, swept when expired", () => {
  const dir = tmpDataDir();
  try {
    const auth = new Auth(new Store(dir));
    const t0 = Date.parse("2026-09-25T10:00:00Z");
    const plain = auth.createToken("plain");
    const launch = auth.createLaunchToken({ room: "MM-ABCD", harness: "hermes", launch: "l1", ttlMs: 60_000 }, t0);
    assert.equal(launch.name, "launch-l1");
    assert.equal(launch.expires_at, "2026-09-25T10:01:00.000Z");
    assert.deepEqual(launch.scope, { room: "MM-ABCD", harness: "hermes", launch: "l1" });

    assert.deepEqual(auth.verifyToken(plain.token, t0), { name: "plain", scope: null, expires_at: null });
    assert.deepEqual(auth.verifyToken(launch.token, t0 + 30_000), { name: "launch-l1", scope: { room: "MM-ABCD", harness: "hermes", launch: "l1" }, expires_at: "2026-09-25T10:01:00.000Z" });
    assert.equal(auth.verifyToken(launch.token, t0 + 61_000), null, "expired");

    const listed = auth.listTokens().find((t) => t.name === "launch-l1");
    assert.equal(listed.scope.room, "MM-ABCD");
    assert.ok(listed.expires_at);
    assert.equal(auth.listTokens().find((t) => t.name === "plain").scope, null);

    const other = auth.createLaunchToken({ room: "MM-ABCD", harness: "pi", launch: "l2", ttlMs: 60_000 }, t0);
    const elsewhere = auth.createLaunchToken({ room: "MM-WXYZ", harness: "pi", launch: "l3", ttlMs: 60_000 }, t0);
    assert.deepEqual(auth.revokeScoped("MM-ABCD", { launch: "l1" }), ["launch-l1"]);
    assert.equal(auth.verifyToken(launch.token, t0), null, "revoked");
    assert.ok(auth.verifyToken(other.token, t0), "the other launch in the room still works");
    assert.deepEqual(auth.revokeScoped("MM-ABCD"), ["launch-l2"]);
    assert.ok(auth.verifyToken(elsewhere.token, t0), "another room untouched");
    assert.ok(auth.verifyToken(plain.token, t0), "unscoped tokens are never touched by a room revoke");

    assert.equal(auth.sweepExpiredTokens(t0 + 30_000), 0);
    assert.equal(auth.sweepExpiredTokens(t0 + 61_000), 3, "all three launch tokens expired");
    assert.deepEqual(auth.listTokens().map((t) => t.name), ["plain"]);
    assert.throws(() => auth.createLaunchToken({ harness: "x" }), /needs a room and a launch id/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
