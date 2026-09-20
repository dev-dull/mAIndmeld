import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { boot } from "./helpers.js";

async function roomWith(s, agents, humans = []) {
  const { data } = await s.req("POST", "/api/rooms", { body: { title: "Motions", name: agents[0], kind: "agent" } });
  const code = data.room.code;
  for (const a of agents.slice(1)) await s.req("POST", `/api/rooms/${code}/join`, { body: { name: a, kind: "agent" } });
  for (const h of humans) await s.req("POST", `/api/rooms/${code}/join`, { body: { name: h, kind: "human" } });
  return code;
}

const get = async (s, code) => (await s.req("GET", `/api/rooms/${code}`)).data.room;

test("motion endpoints: file, deliver through listen, vote, resolve, list", async () => {
  const s = await boot();
  try {
    const code = await roomWith(s, ["a", "b"], ["Ana"]);
    const filed = await s.req("POST", `/api/rooms/${code}/motions`, { body: { type: "close", summary: "Done.", name: "a" } });
    assert.equal(filed.status, 201, JSON.stringify(filed.data));
    assert.equal(filed.data.motion.id, 1);
    assert.equal(filed.data.motion.your_vote, "yes");
    assert.deepEqual(filed.data.motion.tally.pending, ["b"]);

    const list = await s.req("GET", `/api/rooms/${code}/motions`);
    assert.equal(list.data.open.length, 1);

    // b has not polled yet: not delivered, may still speak.
    const early = await s.req("POST", `/api/rooms/${code}/messages`, { body: { sender: "b", content: "one sec" } });
    assert.equal(early.status, 201);

    const poll = await s.req("GET", `/api/rooms/${code}/messages?name=b&wait=0`);
    assert.equal(poll.data.next, "vote");
    assert.equal(poll.data.motions_open[0].delivered, true);
    assert.equal(poll.data.motions_open[0].your_vote, null);
    const blocked = await s.req("POST", `/api/rooms/${code}/messages`, { body: { sender: "b", content: "wait" } });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.data.motion.id, 1);

    const badVoter = await s.req("POST", `/api/rooms/${code}/motions/1/vote`, { body: { vote: "yes", name: "Ana" } });
    assert.equal(badVoter.status, 403);
    const vote = await s.req("POST", `/api/rooms/${code}/motions/1/vote`, { body: { vote: "yes", name: "b" } });
    assert.equal(vote.status, 200);
    assert.equal(vote.data.motion.status, "carried");
    const room = await get(s, code);
    assert.equal(room.status, "closed");
    assert.equal(room.closed_by.how, "motion");
    assert.match(room.messages.at(-2).content, /Motion #1 \(close\) carried by vote: 2 yes, 0 no/);
  } finally {
    await s.close();
  }
});

test("human powers: override and veto, wait, hold and resume, acknowledge and dismiss, and who may use them", async () => {
  const s = await boot();
  try {
    const code = await roomWith(s, ["a", "b"], ["Ana"]);
    await s.req("POST", `/api/rooms/${code}/motions`, { body: { type: "close", name: "a" } });

    const agentVeto = await s.req("POST", `/api/rooms/${code}/motions/1/veto`, { body: { name: "b" } });
    assert.equal(agentVeto.status, 403, "agents cannot veto");
    const veto = await s.req("POST", `/api/rooms/${code}/motions/1/veto`, { body: { name: "Ana", reason: "not yet" } });
    assert.equal(veto.status, 200);
    assert.equal(veto.data.motion.outcome.how, "veto");
    assert.equal((await get(s, code)).status, "open");

    await s.req("POST", `/api/rooms/${code}/motions`, { body: { type: "close", name: "a" } });
    const wait = await s.req("POST", `/api/rooms/${code}/wait`, { body: { name: "Ana", for: "b", seconds: 60 } });
    assert.equal(wait.status, 200);
    assert.deepEqual(wait.data, { target: "b", seconds: 60 });
    const badWait = await s.req("POST", `/api/rooms/${code}/wait`, { body: { name: "Ana", for: "ghost" } });
    assert.equal(badWait.status, 404);

    const hold = await s.req("POST", `/api/rooms/${code}/hold`, { body: { name: "Ana", action: "pause" } });
    assert.equal(hold.status, 200);
    assert.equal(hold.data.held.by, "Ana");
    const voteHeld = await s.req("POST", `/api/rooms/${code}/motions/2/vote`, { body: { vote: "yes", name: "b" } });
    assert.equal(voteHeld.data.motion.status, "open", "unanimous but held");
    const resume = await s.req("POST", `/api/rooms/${code}/hold`, { body: { name: "Ana", action: "resume" } });
    assert.equal(resume.status, 200);
    assert.equal(resume.data.held, null);
    // Resolution happens on the next tick or evaluate; force a tick.
    const ticked = await s.app.service.tick();
    assert.equal(ticked.length, 1);
    assert.equal(ticked[0].status, "carried");
    assert.equal((await get(s, code)).status, "closed");

    // Session principals count as humans under their display name.
    const code2 = await roomWith(s, ["a"]);
    const login = await s.req("POST", "/api/session", { token: null, origin: s.config.publicOrigin, body: { token: s.token, name: "Bo" } });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    await s.req("POST", `/api/rooms/${code2}/invite`, { body: { kind: "human", reason: "please" } });
    assert.equal((await get(s, code2)).human_required, true);
    const dismissAgent = await s.req("POST", `/api/rooms/${code2}/human`, { body: { action: "dismiss", name: "a" } });
    assert.equal(dismissAgent.status, 403);
    await s.req("POST", `/api/rooms/${code2}/join`, { token: null, cookie, origin: s.config.publicOrigin, body: { kind: "human" } });
    const ack = await s.req("POST", `/api/rooms/${code2}/human`, { token: null, cookie, origin: s.config.publicOrigin, body: { action: "acknowledge" } });
    assert.equal(ack.status, 200);
    assert.ok((await get(s, code2)).human_acknowledged_at);
    const dismiss = await s.req("POST", `/api/rooms/${code2}/human`, { token: null, cookie, origin: s.config.publicOrigin, body: { action: "dismiss" } });
    assert.equal(dismiss.data.human_required, false);
    const override = await s.req("POST", `/api/rooms/${code2}/motions/9/override`, { token: null, cookie, origin: s.config.publicOrigin, body: { outcome: "carry" } });
    assert.equal(override.status, 404);
  } finally {
    await s.close();
  }
});

test("the scheduler resolves a silent motion after the window and the hard deadline bounds undelivered voters", async () => {
  const s = await boot({ extra: { clocks: { window_seconds: 1, hard_seconds: 2 } } });
  try {
    const code = await roomWith(s, ["a", "b", "c"]);
    await s.req("POST", `/api/rooms/${code}/motions`, { body: { type: "close", name: "a" } });
    await s.req("GET", `/api/rooms/${code}/messages?name=b&wait=0`); // delivered to b, never to c
    assert.equal((await s.app.service.tick()).length, 0);
    await new Promise((r) => setTimeout(r, 2100));
    const resolved = await s.app.service.tick();
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].how, "hard_deadline");
    const room = await get(s, code);
    assert.equal(room.status, "closed");
    assert.deepEqual(room.motions[0].outcome.tally.silent, ["b", "c"]);
    const health = await s.req("GET", "/api/health");
    assert.equal(health.data.scheduler.rooms_with_motions, 0);
    assert.equal(health.data.clocks.window_seconds, 1);
  } finally {
    await s.close();
  }
});

test("a carried call-a-human motion fires the webhook notifier with a signature", async () => {
  const received = [];
  const hook = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    received.push({ sig: req.headers["x-maindmeld-signature"], body: JSON.parse(body) });
    res.writeHead(204);
    res.end();
  });
  await new Promise((r) => hook.listen(0, "127.0.0.1", r));
  const s = await boot({
    extra: { notifiers: [{ type: "webhook", url: `http://127.0.0.1:${hook.address().port}/hook`, secret_env: "HOOK_SECRET" }] },
    env: { HOOK_SECRET: "s3cret" },
  });
  try {
    const code = await roomWith(s, ["a", "b"]);
    await s.req("POST", `/api/rooms/${code}/motions`, { body: { type: "call_human", reason: "money", name: "a" } });
    await s.req("POST", `/api/rooms/${code}/motions/1/vote`, { body: { vote: "yes", name: "b" } });
    const end = Date.now() + 3000;
    while (!received.length && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    assert.equal(received.length, 1);
    assert.equal(received[0].body.event, "human_called");
    assert.equal(received[0].body.reason, "money");
    assert.equal(received[0].body.room.code, code);
    assert.match(received[0].body.room.url, new RegExp(`/rooms/${code}$`));
    assert.match(received[0].sig, /^[0-9a-f]{64}$/);
    assert.equal((await s.req("GET", "/api/health")).data.notifiers[0], "webhook");
  } finally {
    await s.close();
    hook.close();
  }
});
