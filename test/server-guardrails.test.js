import { test } from "node:test";
import assert from "node:assert/strict";

import { boot } from "./helpers.js";

const get = async (s, code) => (await s.req("GET", `/api/rooms/${code}`)).data.room;

test("an agent may hold at most N open rooms; humans are not limited", async () => {
  const s = await boot({ limits: { rooms_open_per_creator: 2, rooms_per_hour: 100 } });
  try {
    for (let i = 0; i < 2; i += 1) assert.equal((await s.req("POST", "/api/rooms", { body: { title: `r${i}`, name: "bot" } })).status, 201);
    const third = await s.req("POST", "/api/rooms", { body: { title: "r2", name: "bot" } });
    assert.equal(third.status, 429);
    assert.equal(third.data.limit, "rooms_open");
    assert.match(third.data.error, /already has 2 open rooms/);
    for (let i = 0; i < 3; i += 1) assert.equal((await s.req("POST", "/api/rooms", { body: { title: `h${i}`, name: "Ana", kind: "human" } })).status, 201);
    const other = await s.req("POST", "/api/rooms", { body: { title: "other", name: "Bot" } });
    assert.equal(other.status, 429, "the count is case-insensitive");
  } finally {
    await s.close();
  }
});

test("a room an agent opened and nobody joined is abandoned after the window; joined or human-created rooms are not", async () => {
  // Three seconds, not one: on a slow CI runner the setup requests below can
  // take longer than a second, which made the "not before the window" check flake.
  const s = await boot({ extra: { abandon_after_seconds: 3 }, limits: { rooms_per_hour: 100 } });
  try {
    const started = Date.now();
    const lonely = (await s.req("POST", "/api/rooms", { body: { title: "lonely", name: "bot" } })).data.room.code;
    const joined = (await s.req("POST", "/api/rooms", { body: { title: "joined", name: "bot2" } })).data.room.code;
    await s.req("POST", `/api/rooms/${joined}/join`, { body: { name: "friend" } });
    const human = (await s.req("POST", "/api/rooms", { body: { title: "human", name: "Ana", kind: "human" } })).data.room.code;
    await s.req("POST", `/api/rooms/${lonely}/motions`, { body: { type: "call_human", reason: "anyone?", name: "bot" } });

    assert.ok(Date.now() - started < 2500, "setup took too long for this test's window; raise abandon_after_seconds");
    let tick = await s.app.service.tick();
    assert.deepEqual(tick.abandoned, [], "not before the window");
    await new Promise((r) => setTimeout(r, Math.max(0, 3400 - (Date.now() - started))));
    tick = await s.app.service.tick();
    assert.deepEqual(tick.abandoned, [lonely]);
    const room = await get(s, lonely);
    assert.equal(room.status, "abandoned");
    assert.equal(room.closed_by.how, "abandoned");
    assert.match(room.messages.at(-1).content, /marked abandoned/);
    assert.equal((await get(s, joined)).status, "open");
    assert.equal((await get(s, human)).status, "open");
    const list = await s.req("GET", "/api/rooms?status=abandoned");
    assert.equal(list.data.rooms.length, 1);
    const health = await s.req("GET", "/api/health");
    assert.equal(health.data.scheduler.abandon_candidates, 0);
    assert.equal(health.data.scheduler.abandon_after_seconds, 3);
    assert.equal((await s.req("POST", `/api/rooms/${lonely}/join`, { body: { name: "late" } })).status, 409);
  } finally {
    await s.close();
  }
});

test("invitees at creation: a human invite flags the room and an unknown profile reports without failing", async () => {
  const s = await boot();
  try {
    const r = await s.req("POST", "/api/rooms", { body: { title: "with invites", objective: "settle it", invite_models: ["nope"], invite_human: true } });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.room.human_required, true);
    assert.equal(r.data.invites.length, 2);
    assert.equal(r.data.invites[0].ok, false);
    assert.match(r.data.invites[0].error, /no model profile named nope/);
    assert.equal(r.data.invites[1].kind, "human");
    assert.match(r.data.room.messages.at(-1).content, /asked for a human to join.*settle it/);
  } finally {
    await s.close();
  }
});
