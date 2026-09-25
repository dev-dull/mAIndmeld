import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { loadConfig, describeConfig, isLoopback } from "../src/config.js";
import { tmpDataDir } from "./helpers.js";

test("defaults are loopback on 7340 with documented limits", () => {
  const dir = tmpDataDir();
  const c = loadConfig({ dataDir: dir }, { USER: "ana" });
  assert.equal(c.bind, "127.0.0.1");
  assert.equal(c.port, 7340);
  assert.equal(c.loopback, true);
  assert.equal(c.publicOrigin, "http://127.0.0.1:7340");
  assert.ok(c.allowedOrigins.has("http://localhost:7340"));
  assert.equal(c.humanName, "ana");
  assert.equal(c.limits.messagesPerMinute, 120);
  assert.equal(c.limits.roomsPerHour, 20);
});

test("environment and config file override defaults, environment wins", () => {
  const dir = tmpDataDir();
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ port: 9000, human_name: "File", limits: { messages_per_minute: 7 } }));
  const c = loadConfig({ dataDir: dir }, { MAINDMELD_BIND: "0.0.0.0", MAINDMELD_PUBLIC_ORIGIN: "https://meld.example/" });
  assert.equal(c.bind, "0.0.0.0");
  assert.equal(c.loopback, false);
  assert.equal(c.port, 9000);
  assert.equal(c.publicOrigin, "https://meld.example");
  assert.deepEqual([...c.allowedOrigins], ["https://meld.example"]);
  assert.equal(c.humanName, "File");
  assert.equal(c.limits.messagesPerMinute, 7);
  assert.equal(c.limits.roomsPerHour, 20);
  const shown = describeConfig(c);
  assert.equal(shown.limits.messages_per_minute, 7);
});

test("a wide bind with no public origin falls back to localhost origins and warns", () => {
  const dir = tmpDataDir();
  const c = loadConfig({ dataDir: dir }, { MAINDMELD_BIND: "0.0.0.0", MAINDMELD_PORT: "7340" });
  assert.equal(c.publicOrigin, "http://localhost:7340");
  assert.ok(c.allowedOrigins.has("http://localhost:7340"));
  assert.ok(c.allowedOrigins.has("http://127.0.0.1:7340"));
  assert.equal(c.warnings.length, 1);
  assert.match(c.warnings[0], /MAINDMELD_PUBLIC_ORIGIN/);
  const configured = loadConfig({ dataDir: dir }, { MAINDMELD_BIND: "0.0.0.0", MAINDMELD_PUBLIC_ORIGIN: "https://meld.example" });
  assert.equal(configured.warnings.length, 0);
  assert.equal(configured.allowedOrigins.size, 1);
});

test("bad values are rejected", () => {
  const dir = tmpDataDir();
  assert.throws(() => loadConfig({ dataDir: dir }, { MAINDMELD_PORT: "abc" }), /port must be/);
  fs.writeFileSync(path.join(dir, "config.json"), "[]");
  assert.throws(() => loadConfig({ dataDir: dir }, {}), /JSON object/);
});

test("isLoopback", () => {
  assert.equal(isLoopback("127.0.0.1"), true);
  assert.equal(isLoopback("::1"), true);
  assert.equal(isLoopback("0.0.0.0"), false);
});

test("a Kubernetes service link in MAINDMELD_PORT or MAINDMELD_BIND is ignored with a warning, not parsed", () => {
  const dir = tmpDataDir();
  try {
    const config = loadConfig({ dataDir: dir }, { MAINDMELD_PORT: "tcp://10.110.91.106:80", MAINDMELD_BIND: "tcp://10.110.91.106:80", USER: "t" });
    assert.equal(config.port, 7340);
    assert.equal(config.bind, "127.0.0.1");
    assert.ok(config.warnings.some((w) => /service link/.test(w)), JSON.stringify(config.warnings));
    const real = loadConfig({ dataDir: dir }, { MAINDMELD_PORT: "7341", USER: "t" });
    assert.equal(real.port, 7341);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
