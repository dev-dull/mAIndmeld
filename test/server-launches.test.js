import { test } from "node:test";
import assert from "node:assert/strict";

import { boot } from "./helpers.js";

/** A runner as the server sees it: an SSE subscription that collects events, plus claim and status calls. */
async function connectRunner(s, name, harnesses, token = s.token) {
  const controller = new AbortController();
  const res = await fetch(`${s.base}/api/runner/events?name=${name}&harnesses=${harnesses}`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
  assert.equal(res.status, 200, `runner ${name} connects`);
  const events = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const type = block.match(/^event: (.*)$/m)?.[1];
          const data = block.match(/^data: (.*)$/m)?.[1];
          if (type) events.push({ type, data: data ? JSON.parse(data) : null });
        }
      }
    } catch { /* aborted */ }
  })();
  const waitFor = async (pred, ms = 4000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = events.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 25));
    }
    return null;
  };
  return {
    name,
    events,
    waitFor,
    claim: (id) => s.req("POST", `/api/launches/${id}/claim`, { token, body: { runner: name } }),
    status: (id, body) => s.req("POST", `/api/launches/${id}/status`, { token, body }),
    disconnect: () => controller.abort(),
  };
}

const room = async (s, title = "Launch test") => (await s.req("POST", "/api/rooms", { body: { title, objective: "See a harness join", name: "host" } })).data.room.code;
const sysLines = async (s, code) => (await s.req("GET", `/api/rooms/${code}`)).data.room.messages.filter((m) => m.kind === "system").map((m) => m.content);
const launchesOf = async (s, code) => (await s.req("GET", `/api/rooms/${code}/launches`)).data.launches;

test("no runner online: the request fails at once and leaves nothing behind", async () => {
  const s = await boot({ limits: { rooms_per_hour: 100 } });
  try {
    const code = await room(s);
    const r = await s.req("POST", `/api/rooms/${code}/launches`, { body: { harness: "hermes" } });
    assert.equal(r.status, 409);
    assert.match(r.data.error, /no runner online offers hermes/);
    assert.deepEqual(await launchesOf(s, code), []);
    assert.equal((await s.req("GET", "/api/health", { token: null })).data.launches.active, 0);
  } finally {
    await s.close();
  }
});

test("the happy path: request, runner event, claim with a scoped token, join, exit; the room narrates every step", async () => {
  const s = await boot({ limits: { rooms_per_hour: 100 } });
  try {
    const runner = await connectRunner(s, "laptop", "hermes,pi");
    assert.ok(await runner.waitFor((e) => e.type === "hello"));
    const listed = (await s.req("GET", "/api/runners")).data.runners;
    assert.deepEqual(listed.map((r) => [r.name, r.harnesses, r.online]), [["laptop", ["hermes", "pi"], true]]);

    const code = await room(s);
    const req = await s.req("POST", `/api/rooms/${code}/launches`, { body: { harness: "hermes" } });
    assert.equal(req.status, 201, JSON.stringify(req.data));
    const launch = req.data.launch;
    assert.equal(launch.state, "requested");
    assert.equal(launch.runner, "laptop");
    const ev = await runner.waitFor((e) => e.type === "launch");
    assert.equal(ev.data.launch, launch.id);
    assert.equal(ev.data.room, code);
    assert.equal(ev.data.harness, "hermes");

    // Same harness again while active: the existing launch comes back, nothing new.
    const again = await s.req("POST", `/api/rooms/${code}/launches`, { body: { harness: "hermes" } });
    assert.equal(again.status, 201);
    assert.equal(again.data.launch.id, launch.id);
    assert.equal(again.data.existing, true);

    const claim = await runner.claim(launch.id);
    assert.equal(claim.status, 200, JSON.stringify(claim.data));
    assert.match(claim.data.token, /^mm_/);
    assert.equal(claim.data.room.code, code);
    assert.equal(claim.data.mcp_url, `${s.base}/mcp`);
    assert.ok(claim.data.invitation.includes(code));
    assert.equal(claim.data.launch.state, "started");
    assert.equal((await runner.claim(launch.id)).status, 409, "second claim loses");
    assert.equal((await s.req("GET", "/api/health", { token: null })).data.runners[0].active, 1);

    // The harness joins with its token; that fact is what marks the launch joined.
    const join = await s.req("POST", `/api/rooms/${code}/join`, { token: claim.data.token, body: { name: "Hermes" } });
    assert.equal(join.status, 200, JSON.stringify(join.data));
    assert.equal(join.data.launch.state, "joined");
    assert.equal(join.data.participant.client, "runner");
    assert.equal((await s.req("POST", `/api/rooms/${code}/messages`, { token: claim.data.token, body: { sender: "Hermes", content: "here with my own tools" } })).status, 201);
    const status = (await s.req("GET", `/api/rooms/${code}`)).data.room;
    assert.equal(status.launches[launch.id].participant, "Hermes");

    const done = await runner.status(launch.id, { state: "exited", exit_code: 0 });
    assert.equal(done.status, 200, JSON.stringify(done.data));
    assert.equal(done.data.launch.state, "exited");
    assert.equal((await s.req("GET", `/api/rooms/${code}`, { token: claim.data.token })).status, 401, "the launch token is revoked when the launch ends");
    assert.equal((await runner.status(launch.id, { state: "failed" })).status, 404, "an ended launch is no longer addressable");
    const lines = await sysLines(s, code);
    assert.ok(lines.some((l) => l === "hermes requested by test on runner laptop."));
    assert.ok(lines.some((l) => l === "hermes starting on runner laptop."));
    assert.ok(lines.some((l) => l === "hermes joined as Hermes."));
    assert.ok(lines.some((l) => l === "hermes exited (code 0)."));
    assert.equal((await s.req("GET", "/api/health", { token: null })).data.launches.active, 0);
    runner.disconnect();
  } finally {
    await s.close();
  }
});

test("failure paths: spawn failure, never joins, late join refused, room close cancels, runner offline", async () => {
  const s = await boot({ limits: { rooms_per_hour: 100 }, extra: { launch: { join_timeout_seconds: 1, join_grace_seconds: 0, claim_timeout_seconds: 1, runner_offline_seconds: 1 } } });
  try {
    const runner = await connectRunner(s, "box", "hermes");
    await runner.waitFor((e) => e.type === "hello");

    // Spawn failure: the runner reports failed with a reason; the token dies with it.
    const c1 = await room(s, "spawn fails");
    const l1 = (await s.req("POST", `/api/rooms/${c1}/launches`, { body: { harness: "hermes" } })).data.launch;
    const t1 = (await runner.claim(l1.id)).data.token;
    assert.equal((await runner.status(l1.id, { state: "failed", reason: "hermes: command not found" })).status, 200);
    assert.ok((await sysLines(s, c1)).some((l) => l === "hermes failed: hermes: command not found."));
    assert.equal((await s.req("POST", `/api/rooms/${c1}/join`, { token: t1, body: { name: "Hermes" } })).status, 401);

    // Never joins: the tick times it out, revokes the token, and tells the runner to cancel.
    const c2 = await room(s, "never joins");
    const l2 = (await s.req("POST", `/api/rooms/${c2}/launches`, { body: { harness: "hermes" } })).data.launch;
    const t2 = (await runner.claim(l2.id)).data.token;
    await s.app.service.tick();
    assert.equal((await launchesOf(s, c2))[0].state, "started", "not before the window");
    await new Promise((r) => setTimeout(r, 1100));
    await s.app.service.tick();
    assert.equal((await launchesOf(s, c2))[0].state, "timed_out");
    assert.ok(await runner.waitFor((e) => e.type === "cancel" && e.data.launch === l2.id));
    const late = await s.req("POST", `/api/rooms/${c2}/join`, { token: t2, body: { name: "Hermes" } });
    assert.equal(late.status, 401, "a late join past the grace is refused: the token is gone");
    assert.ok((await sysLines(s, c2)).some((l) => l === "hermes did not join in time."));

    // Room closes while the harness is in it: cancelled, token revoked, runner told.
    const c3 = await room(s, "closes mid-run");
    const l3 = (await s.req("POST", `/api/rooms/${c3}/launches`, { body: { harness: "hermes" } })).data.launch;
    const t3 = (await runner.claim(l3.id)).data.token;
    assert.equal((await s.req("POST", `/api/rooms/${c3}/join`, { token: t3, body: { name: "Hermes" } })).status, 200);
    await s.req("POST", `/api/rooms/${c3}/join`, { body: { name: "Ana", kind: "human" } });
    assert.equal((await s.req("POST", `/api/rooms/${c3}/close`, { body: { name: "Ana", summary: "done" } })).status, 200);
    const cancel = await runner.waitFor((e) => e.type === "cancel" && e.data.launch === l3.id);
    assert.ok(cancel, "runner told to cancel");
    assert.equal(cancel.data.reason, "room closed");
    assert.equal((await launchesOf(s, c3))[0].state, "cancelled");
    assert.equal((await s.req("GET", `/api/rooms/${c3}`, { token: t3 })).status, 401);

    // Runner offline: a request made while it is up, then it disconnects; after the claim window the launch fails.
    const c4 = await room(s, "runner goes away");
    const l4 = (await s.req("POST", `/api/rooms/${c4}/launches`, { body: { harness: "hermes" } })).data.launch;
    runner.disconnect();
    await new Promise((r) => setTimeout(r, 1200));
    await s.app.service.tick();
    const l4now = (await launchesOf(s, c4))[0];
    assert.equal(l4now.state, "failed");
    assert.equal(l4now.reason, "runner offline");
    assert.equal((await s.req("POST", `/api/rooms/${c4}/launches`, { body: { harness: "hermes" } })).status, 409, "and now nobody offers it");
    assert.equal((await s.req("GET", "/api/runners")).data.runners[0].online, false);
    // Reconnect: pending launches are replayed; here there are none left.
    const back = await connectRunner(s, "box", "hermes");
    assert.ok(await back.waitFor((e) => e.type === "hello"));
    assert.equal(back.events.filter((e) => e.type === "launch").length, 0);
    back.disconnect();
    void l4;
  } finally {
    await s.close();
  }
});

test("two runners: the request names one or the least busy wins; a scoped token cannot act as a runner", async () => {
  const s = await boot({ limits: { rooms_per_hour: 100 } });
  try {
    const a = await connectRunner(s, "alpha", "hermes");
    const b = await connectRunner(s, "beta", "hermes,opencode");
    await a.waitFor((e) => e.type === "hello");
    await b.waitFor((e) => e.type === "hello");
    const code = await room(s);
    const named = (await s.req("POST", `/api/rooms/${code}/launches`, { body: { harness: "hermes", runner: "beta" } })).data.launch;
    assert.equal(named.runner, "beta");
    assert.ok(await b.waitFor((e) => e.type === "launch" && e.data.launch === named.id));
    assert.equal(a.events.filter((e) => e.type === "launch").length, 0, "alpha is not told");
    const code2 = await room(s, "second");
    const balanced = (await s.req("POST", `/api/rooms/${code2}/launches`, { body: { harness: "hermes" } })).data.launch;
    assert.equal(balanced.runner, "alpha", "beta already has one active launch");
    const wrong = await s.req("POST", `/api/rooms/${code2}/launches`, { body: { harness: "opencode", runner: "alpha" } });
    assert.equal(wrong.status, 409);
    assert.match(wrong.data.error, /does not offer opencode/);
    assert.equal((await s.req("POST", `/api/rooms/${code2}/launches`, { body: { harness: "hermes", runner: "ghost" } })).status, 409);

    // A launch token is not a runner token.
    const claim = await b.claim(named.id);
    const scoped = claim.data.token;
    assert.equal((await fetch(`${s.base}/api/runner/events?name=evil&harnesses=hermes`, { headers: { authorization: `Bearer ${scoped}` } })).status, 403);
    assert.equal((await s.req("POST", `/api/launches/${balanced.id}/claim`, { token: scoped, body: { runner: "evil" } })).status, 403);
    a.disconnect();
    b.disconnect();
  } finally {
    await s.close();
  }
});

test("over MCP: room_invite kind harness requests a launch and room_status lists it", async () => {
  const s = await boot({ limits: { rooms_per_hour: 100 } });
  let nextId = 1;
  const rpc = async (name, args) => {
    const res = await fetch(`${s.base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${s.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }),
    });
    return (await res.json()).result;
  };
  try {
    const none = await rpc("room_create", { title: "MCP launch", name: "agent-a" });
    const code = none.structuredContent.code;
    const refused = await rpc("room_invite", { code, kind: "harness", harness: "hermes", name: "agent-a" });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /no runner online offers hermes/);
    const runner = await connectRunner(s, "laptop", "hermes");
    await runner.waitFor((e) => e.type === "hello");
    const ok = await rpc("room_invite", { code, kind: "harness", harness: "hermes", name: "agent-a" });
    assert.ok(!ok.isError, JSON.stringify(ok));
    assert.match(ok.content[0].text, /Requested: hermes on runner laptop/);
    const status = await rpc("room_status", { code });
    assert.match(status.content[0].text, /Launches: hermes requested on laptop/);
    runner.disconnect();
  } finally {
    await s.close();
  }
});
