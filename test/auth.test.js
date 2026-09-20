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
  assert.deepEqual(auth.verifyToken(token), { name: "cli" });
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
  assert.deepEqual(auth.authenticate({ headers: { authorization: `Bearer ${token}` } }), { kind: "token", name: "agent" });
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
