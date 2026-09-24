import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { boot, tmpDataDir } from "./helpers.js";
import { loadRunnerConfig, fill, Runner } from "../src/runner.js";

const NODE = process.execPath;

/** A harness that joins the room with the token in its environment, says one thing, and exits 0. */
const JOIN_AND_LEAVE = `
const base = process.env.MAINDMELD_MCP_URL.replace(/\\/mcp$/, "");
const h = { authorization: "Bearer " + process.env.MAINDMELD_TOKEN, "content-type": "application/json" };
const room = process.env.MAINDMELD_ROOM;
const prompt = require("fs").readFileSync(process.env.MAINDMELD_PROMPT_FILE, "utf8");
(async () => {
  let r = await fetch(base + "/api/rooms/" + room + "/join", { method: "POST", headers: h, body: JSON.stringify({ name: "Echo" }) });
  if (r.status !== 200) { console.error("join failed", r.status, await r.text()); process.exit(3); }
  r = await fetch(base + "/api/rooms/" + room + "/messages", { method: "POST", headers: h, body: JSON.stringify({ sender: "Echo", content: "prompt says: " + prompt.split("\\n")[0] }) });
  if (r.status !== 201) { console.error("send failed", r.status); process.exit(4); }
  process.exit(0);
})();
`;
const NEVER_EXITS = `setInterval(() => {}, 1000);`;
const IGNORES_SIGTERM = `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`;

function writeConfig(dir, s, harnesses, extra = {}) {
  const file = path.join(dir, "runner.json");
  fs.writeFileSync(file, JSON.stringify({ name: "laptop", server: s.base, token_env: "TEST_RUNNER_TOKEN", state_dir: path.join(dir, "runs"), ...extra, harnesses }));
  return file;
}

const waitFor = async (fn, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
};

test("runner.json is checked: name, server, token by environment only, commands, no token on the command line, templates", () => {
  const dir = tmpDataDir();
  try {
    const file = path.join(dir, "runner.json");
    const write = (obj) => fs.writeFileSync(file, JSON.stringify(obj));
    const env = { TEST_RUNNER_TOKEN: "mm_x" };
    write({ server: "http://x" });
    assert.throws(() => loadRunnerConfig(file, env), /name is required/);
    write({ name: "a", server: "ftp://x" });
    assert.throws(() => loadRunnerConfig(file, env), /http or https/);
    write({ name: "a", server: "http://x", token: "mm_secret" });
    assert.throws(() => loadRunnerConfig(file, env), /do not put the token in the file/);
    write({ name: "a", server: "http://x", token_env: "NOPE" });
    assert.throws(() => loadRunnerConfig(file, env), /NOPE is not set/);
    write({ name: "a", server: "http://x", token_env: "TEST_RUNNER_TOKEN" });
    assert.throws(() => loadRunnerConfig(file, env), /at least one harness/);
    write({ name: "a", server: "http://x", token_env: "TEST_RUNNER_TOKEN", harnesses: { h: { command: ["h", "--token", "{token}"] } } });
    assert.throws(() => loadRunnerConfig(file, env), /puts \{token\} on the command line/);
    write({ name: "a", server: "http://x", token_env: "TEST_RUNNER_TOKEN", harnesses: { h: { command: ["h"], template: "/nope.md" } } });
    assert.throws(() => loadRunnerConfig(file, env), /template .* does not exist/);
    write({ name: "a", server: "http://x/", token_env: "TEST_RUNNER_TOKEN", harnesses: { h: { command: ["h", "{prompt_file}"], timeout_minutes: 5, cwd: "~/work", env: { A: "{room}" } } } });
    const c = loadRunnerConfig(file, env);
    assert.equal(c.server, "http://x");
    assert.equal(c.token, "mm_x");
    assert.equal(c.maxConcurrent, 2);
    assert.equal(c.harnesses.h.timeoutMs, 300_000);
    assert.ok(c.harnesses.h.template.endsWith(path.join("templates", "harness", "default.md")));
    assert.ok(!c.harnesses.h.cwd.startsWith("~"));
    assert.equal(fill("join {room} as {harness}; {unknown} stays; {token}", { room: "MM-1", harness: "h" }), "join MM-1 as h; {unknown} stays; {token}");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("end to end: a launch reaches a harness process that joins the room with its own token, speaks, and exits; files are cleaned up", async () => {
  const s = await boot({ limits: { rooms_per_hour: 100 } });
  const dir = tmpDataDir();
  let runner;
  try {
    const { token } = s.app.auth.createToken("runner-laptop");
    const file = writeConfig(dir, s, { echo: { command: [NODE, "-e", JOIN_AND_LEAVE], timeout_minutes: 1 } });
    runner = new Runner(loadRunnerConfig(file, { TEST_RUNNER_TOKEN: token }), { log: () => {} });
    await runner.start();
    assert.ok(await waitFor(() => runner.connected), "runner connected");
    const code = (await s.req("POST", "/api/rooms", { body: { title: "Runner test", objective: "See it work", name: "host" } })).data.room.code;
    const req = await s.req("POST", `/api/rooms/${code}/launches`, { body: { harness: "echo" } });
    assert.equal(req.status, 201, JSON.stringify(req.data));
    const done = await waitFor(async () => {
      const l = (await s.req("GET", `/api/rooms/${code}/launches`)).data.launches[0];
      return l.state === "exited" ? l : null;
    }, 10_000);
    assert.ok(done, "launch ended as exited");
    assert.equal(done.exit_code, 0);
    assert.equal(done.participant, "Echo");
    const room = (await s.req("GET", `/api/rooms/${code}`)).data.room;
    const said = room.messages.find((m) => m.sender === "Echo");
    assert.match(said.content, /prompt says: You have been invited into mAIndmeld room MM-/);
    const lines = room.messages.filter((m) => m.kind === "system").map((m) => m.content);
    for (const want of ["echo requested by test on runner laptop.", "echo starting on runner laptop.", "echo joined as Echo.", "echo exited (code 0)."]) assert.ok(lines.includes(want), want);
    assert.ok(!s.app.auth.listTokens().some((t) => t.name === `launch-${done.id}` && !t.revoked_at), "launch token revoked");
    assert.deepEqual(fs.readdirSync(path.join(dir, "runs")).filter((n) => !n.endsWith(".log")), [], "prompt and run records cleaned up");
    assert.equal(runner.status().active.length, 0);
  } finally {
    await runner?.stop();
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cancel on room close, a harness timeout, a bad command, and max_concurrent", async () => {
  const s = await boot({ limits: { rooms_per_hour: 100 }, extra: { launch: { claim_timeout_seconds: 1, join_timeout_seconds: 30 } } });
  const dir = tmpDataDir();
  let runner;
  try {
    const { token } = s.app.auth.createToken("runner-box");
    const file = writeConfig(dir, s, {
      sleeper: { command: [NODE, "-e", NEVER_EXITS], timeout_minutes: 60 },
      brief: { command: [NODE, "-e", NEVER_EXITS], timeout_minutes: 0.02 },
      broken: { command: ["/nonexistent/harness"] },
    }, { max_concurrent: 1 });
    const logs = [];
    runner = new Runner(loadRunnerConfig(file, { TEST_RUNNER_TOKEN: token }), { log: (l) => logs.push(l) });
    await runner.start();
    assert.ok(await waitFor(() => runner.connected));
    const mkRoom = async (title) => (await s.req("POST", "/api/rooms", { body: { title, name: "host" } })).data.room.code;
    const state = async (code) => (await s.req("GET", `/api/rooms/${code}/launches`)).data.launches[0];

    // Room closes while the harness runs: the server cancels, the runner kills, the process is gone.
    const c1 = await mkRoom("closes");
    await s.req("POST", `/api/rooms/${c1}/launches`, { body: { harness: "sleeper" } });
    assert.ok(await waitFor(() => runner.status().active.length === 1), "started");
    const pid = runner.status().active[0].pid;
    await s.req("POST", `/api/rooms/${c1}/join`, { body: { name: "Ana", kind: "human" } });
    assert.equal((await s.req("POST", `/api/rooms/${c1}/close`, { body: { name: "Ana" } })).status, 200);
    assert.ok(await waitFor(() => runner.status().active.length === 0), "runner stopped it");
    assert.equal((await state(c1)).state, "cancelled");
    assert.throws(() => process.kill(pid, 0), "the process is gone");

    // A harness that runs past its timeout is killed and reported failed.
    const c2 = await mkRoom("too long");
    await s.req("POST", `/api/rooms/${c2}/launches`, { body: { harness: "brief" } });
    const l2 = await waitFor(async () => { const l = await state(c2); return l.state === "failed" ? l : null; }, 8000);
    assert.ok(l2, "reported failed");
    assert.match(l2.reason, /timed out after/);

    // A command that does not exist: failed with the reason, nothing left running.
    const c3 = await mkRoom("broken");
    await s.req("POST", `/api/rooms/${c3}/launches`, { body: { harness: "broken" } });
    const l3 = await waitFor(async () => { const l = await state(c3); return l.state === "failed" ? l : null; });
    assert.ok(l3);
    assert.match(l3.reason, /could not start \/nonexistent\/harness/);
    assert.equal(runner.status().active.length, 0);

    // max_concurrent 1: with one running, a second launch is not claimed and the server fails it at the claim window.
    const c4 = await mkRoom("first");
    await s.req("POST", `/api/rooms/${c4}/launches`, { body: { harness: "sleeper" } });
    assert.ok(await waitFor(() => runner.status().active.length === 1));
    const c5 = await mkRoom("second");
    await s.req("POST", `/api/rooms/${c5}/launches`, { body: { harness: "sleeper" } });
    await new Promise((r) => setTimeout(r, 1200));
    await s.app.service.tick();
    const l5 = await state(c5);
    assert.equal(l5.state, "failed");
    assert.equal(l5.reason, "runner did not claim in time");
    assert.ok(logs.some((l) => /at max_concurrent 1/.test(l)));
    await runner.stop();
    assert.equal(runner.status().active.length, 0, "stop cancels what is running");
  } finally {
    await runner?.stop();
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a harness that ignores SIGTERM is killed anyway, on cancel and on reap", async () => {
  const s = await boot({ limits: { rooms_per_hour: 100 } });
  const dir = tmpDataDir();
  let runner;
  let second;
  try {
    const { token } = s.app.auth.createToken("runner-stubborn");
    const file = writeConfig(dir, s, { stubborn: { command: [NODE, "-e", IGNORES_SIGTERM] } });
    runner = new Runner(loadRunnerConfig(file, { TEST_RUNNER_TOKEN: token }), { log: () => {}, killAfterMs: 300 });
    await runner.start();
    assert.ok(await waitFor(() => runner.connected));
    const mk = async (t) => (await s.req("POST", "/api/rooms", { body: { title: t, name: "host" } })).data.room.code;

    const c1 = await mk("cancel");
    await s.req("POST", `/api/rooms/${c1}/launches`, { body: { harness: "stubborn" } });
    assert.ok(await waitFor(() => runner.status().active.length === 1));
    const pid1 = runner.status().active[0].pid;
    runner.cancel(runner.status().active[0].launch, "test");
    await new Promise((r) => setTimeout(r, 150));
    assert.doesNotThrow(() => process.kill(pid1, 0), "SIGTERM was ignored");
    assert.ok(await waitFor(() => { try { process.kill(pid1, 0); return false; } catch { return true; } }, 3000), "SIGKILL got it");

    const c2 = await mk("reap");
    await s.req("POST", `/api/rooms/${c2}/launches`, { body: { harness: "stubborn" } });
    assert.ok(await waitFor(() => runner.status().active.length === 1));
    const pid2 = runner.status().active[0].pid;
    runner.active.clear();
    runner.stopped = true;
    runner.controller.abort();
    second = new Runner(loadRunnerConfig(file, { TEST_RUNNER_TOKEN: token }), { log: () => {}, killAfterMs: 300 });
    await second.start();
    assert.ok(await waitFor(() => { try { process.kill(pid2, 0); return false; } catch { return true; } }, 3000), "reap escalates to SIGKILL");
  } finally {
    await second?.stop();
    await runner?.stop();
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the runner reconnects after its stream drops and reaps a leftover process on restart", async () => {
  const s = await boot({ limits: { rooms_per_hour: 100 } });
  const dir = tmpDataDir();
  let runner;
  let second;
  try {
    const { token } = s.app.auth.createToken("runner-flaky");
    const file = writeConfig(dir, s, { sleeper: { command: [NODE, "-e", NEVER_EXITS] } });
    const logs = [];
    runner = new Runner(loadRunnerConfig(file, { TEST_RUNNER_TOKEN: token }), { log: (l) => logs.push(l) });
    await runner.start();
    assert.ok(await waitFor(() => runner.connected));
    runner.controller.abort(); // the stream drops
    assert.ok(await waitFor(() => logs.some((l) => /connection .* lost/.test(l))));
    assert.ok(await waitFor(() => logs.filter((l) => /connected to/.test(l)).length >= 2, 5000), "reconnected");

    // Leave a process behind as a crashed runner would: a run record with a live pid.
    const code = (await s.req("POST", "/api/rooms", { body: { title: "orphan", name: "host" } })).data.room.code;
    await s.req("POST", `/api/rooms/${code}/launches`, { body: { harness: "sleeper" } });
    assert.ok(await waitFor(() => runner.status().active.length === 1));
    const pid = runner.status().active[0].pid;
    runner.active.clear(); // forget it without killing, as a crash would
    runner.stopped = true;
    runner.controller.abort();
    assert.doesNotThrow(() => process.kill(pid, 0), "still running");
    second = new Runner(loadRunnerConfig(file, { TEST_RUNNER_TOKEN: token }), { log: (l) => logs.push(l) });
    await second.start();
    assert.ok(await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }), "reaped on restart");
    assert.ok(logs.some((l) => /reaped pid/.test(l)));
  } finally {
    await second?.stop();
    await runner?.stop();
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
