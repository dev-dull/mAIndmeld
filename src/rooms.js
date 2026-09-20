// Room domain logic. Pure functions over the room object; no I/O here, so
// the server can load, mutate synchronously, and save (DESIGN.md 3.1).
// Every time-dependent function takes `nowMs` so tests control the clock.

import crypto from "node:crypto";

export class RoomError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.name = "RoomError";
    this.status = status;
    this.extra = extra;
  }
}

export const PARTICIPANT_KINDS = new Set(["agent", "model", "human"]);
export const RESPONSE_MODES = new Set(["open", "addressed_only"]);
export const DEFAULT_CLOCKS = Object.freeze({ window_ms: 120_000, hard_ms: 600_000 });

// Who may file and vote on each motion type (DESIGN.md 4.4, decision 4).
export const MOTION_TYPES = Object.freeze({
  close: Object.freeze({ eligible: ["agent"] }),
  call_human: Object.freeze({ eligible: ["agent", "model"] }),
});

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
// Senders of system and summary lines; a participant may not impersonate them.
const RESERVED_NAMES = new Set(["room", "system", "maindmeld"]);

export function makeCode() {
  let out = "MM-";
  for (let i = 0; i < 4; i += 1) out += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  return out;
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
export const now = () => iso(Date.now());

// Names: 1 to 80 printable characters, no control characters, no leading @.
export function cleanName(value, what = "name") {
  const name = String(value ?? "").trim();
  if (!name) throw new RoomError(400, `${what} is required`);
  if (name.length > 80) throw new RoomError(400, `${what} must be 80 characters or fewer`);
  if (/[\p{Cc}]/u.test(name)) throw new RoomError(400, `${what} contains control characters`);
  if (name.startsWith("@")) throw new RoomError(400, `${what} must not start with @`);
  if (RESERVED_NAMES.has(name.toLowerCase())) throw new RoomError(400, `${what} "${name}" is reserved`);
  return name;
}

function cleanText(value, what, max, required) {
  const text = String(value ?? "").trim();
  if (required && !text) throw new RoomError(400, `${what} is required`);
  if (text.length > max) throw new RoomError(400, `${what} must be ${max} characters or fewer`);
  return text;
}

export function cleanKind(value) {
  const kind = String(value ?? "agent").trim().toLowerCase();
  if (!PARTICIPANT_KINDS.has(kind)) throw new RoomError(400, `kind must be one of ${[...PARTICIPANT_KINDS].join(", ")}`);
  return kind;
}

const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();
const hasName = (list, name) => list.some((n) => sameName(n, name));

export function findParticipant(room, name) {
  return room.participants.find((p) => sameName(p.name, name)) || null;
}

function lastMessageId(room) {
  return room.next_message_id - 1;
}

function recomputeHumanPresent(room) {
  room.human_present = room.participants.some((p) => p.kind === "human");
}

function pushMessage(room, message, nowMs = Date.now()) {
  message.id = room.next_message_id;
  room.next_message_id += 1;
  message.created_at = iso(nowMs);
  room.messages.push(message);
  room.updated_at = message.created_at;
  return message;
}

export function addSystemMessage(room, content, data = null, nowMs = Date.now()) {
  return pushMessage(room, { kind: "system", sender: "room", content, data }, nowMs);
}

export function parseMentions(room, content) {
  const found = new Set();
  for (const p of room.participants) {
    const escaped = p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|[^\\p{L}\\p{N}_])@${escaped}(?=$|[^\\p{L}\\p{N}_])`, "iu");
    if (re.test(content)) found.add(p.name);
  }
  return [...found];
}

// ---------------------------------------------------------------- rooms

export function createRoom({ title, objective, creator, responseMode, code, clocks }, nowMs = Date.now()) {
  const name = cleanName(creator?.name, "creator name");
  const kind = cleanKind(creator?.kind);
  const mode = responseMode ? String(responseMode) : "open";
  if (!RESPONSE_MODES.has(mode)) throw new RoomError(400, `response_mode must be one of ${[...RESPONSE_MODES].join(", ")}`);
  const stamp = iso(nowMs);
  const room = {
    format: 2,
    code: code || makeCode(),
    title: cleanText(title, "title", 160, true),
    objective: cleanText(objective, "objective", 4000, false),
    status: "open",
    created_by: { name, kind },
    created_at: stamp,
    updated_at: stamp,
    closed_at: null,
    closed_by: null,
    summary: null,
    human_required: false,
    human_present: false,
    human_acknowledged_at: null,
    held: null,
    ingest_grace_until: null,
    clock_config: { ...DEFAULT_CLOCKS, ...(clocks || {}) },
    response_mode: mode,
    participants: [],
    messages: [],
    motions: [],
    others_joined: 0,
    next_message_id: 1,
    next_motion_id: 1,
  };
  addSystemMessage(room, `${name} created the room.${room.objective ? ` Objective: ${room.objective}` : ""}`, null, nowMs);
  room.participants.push({
    name,
    kind,
    client: creator?.client ? cleanText(creator.client, "client", 40, false) : null,
    joined_at: stamp,
    last_seen_at: stamp,
    cursor: lastMessageId(room),
  });
  recomputeHumanPresent(room);
  return room;
}

/** Fill fields that older room files lack. Called by the store on read. */
export function upgradeRoom(room) {
  room.human_acknowledged_at ??= null;
  room.held ??= null;
  room.ingest_grace_until ??= null;
  room.clock_config ??= { ...DEFAULT_CLOCKS };
  room.motions ??= [];
  room.next_motion_id ??= room.motions.length + 1;
  room.others_joined ??= Math.max(0, room.participants.filter((p) => !sameName(p.name, room.created_by?.name ?? "")).length);
  room.format = 2;
  return room;
}

export function joinRoom(room, { name, kind, client }, nowMs = Date.now()) {
  if (room.status !== "open") throw new RoomError(409, `Room ${room.code} is ${room.status}`);
  const cleaned = cleanName(name);
  const k = cleanKind(kind);
  const existing = findParticipant(room, cleaned);
  if (existing) {
    if (existing.kind !== k) {
      throw new RoomError(409, `${existing.name} is already in the room as ${existing.kind}`);
    }
    existing.last_seen_at = iso(nowMs);
    return { participant: existing, rejoined: true };
  }
  const participant = {
    name: cleaned,
    kind: k,
    client: client ? cleanText(client, "client", 40, false) : null,
    joined_at: iso(nowMs),
    last_seen_at: iso(nowMs),
    cursor: lastMessageId(room),
  };
  room.participants.push(participant);
  if (!sameName(cleaned, room.created_by.name)) room.others_joined = (room.others_joined || 0) + 1;
  const joined = addSystemMessage(room, `${cleaned} joined as ${k}.`, null, nowMs);
  participant.cursor = joined.id;
  recomputeHumanPresent(room);
  return { participant, rejoined: false };
}

export function leaveRoom(room, name, finalMessage, nowMs = Date.now()) {
  const participant = findParticipant(room, cleanName(name));
  if (!participant) throw new RoomError(404, `${name} is not in room ${room.code}`);
  if (finalMessage && room.status === "open") {
    pushMessage(room, { kind: participant.kind, sender: participant.name, content: cleanText(finalMessage, "message", 20000, true), reply_to: null, mentions: parseMentions(room, finalMessage) }, nowMs);
  }
  room.participants = room.participants.filter((p) => p !== participant);
  addSystemMessage(room, `${participant.name} left.`, null, nowMs);
  recomputeHumanPresent(room);
  return participant;
}

/** The first open motion delivered to `name` that they have not voted on. */
export function pendingVoteFor(room, name) {
  for (const m of room.motions) {
    if (m.status !== "open") continue;
    const voter = m.eligible.find((n) => sameName(n, name)); // keys use the canonical spelling
    if (voter && m.delivered_to[voter] !== undefined && m.votes[voter] === undefined) return m;
  }
  return null;
}

function addressedSinceLastOwn(room, participant) {
  let start = 0;
  for (let i = room.messages.length - 1; i >= 0; i -= 1) {
    if (sameName(room.messages[i].sender, participant.name)) {
      start = i + 1;
      break;
    }
  }
  return room.messages.slice(start).some((m) => (m.mentions || []).some((n) => sameName(n, participant.name)));
}

export function sendMessage(room, { sender, content, reply_to }, maxBytes, nowMs = Date.now()) {
  if (room.status !== "open") throw new RoomError(409, `Room ${room.code} is ${room.status}`);
  const participant = findParticipant(room, cleanName(sender, "sender"));
  if (!participant) throw new RoomError(403, `${sender} is not a participant in ${room.code}; join first`);
  const text = cleanText(content, "content", Infinity, true);
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new RoomError(413, `content exceeds ${maxBytes} bytes`);
  if (participant.kind !== "human") {
    // DESIGN.md 6.5: enforced, not merely described.
    const pending = pendingVoteFor(room, participant.name);
    if (pending) throw new RoomError(409, `vote on motion #${pending.id} (${pending.type}) before sending anything else`, { motion: pending });
    if (room.response_mode === "addressed_only" && !addressedSinceLastOwn(room, participant)) {
      throw new RoomError(409, "the room is in only-when-addressed mode; wait until someone names you with @" + participant.name, { response_mode: "addressed_only" });
    }
  }
  let replyTo = null;
  if (reply_to !== undefined && reply_to !== null) {
    replyTo = Number(reply_to);
    if (!Number.isInteger(replyTo) || replyTo < 1 || replyTo >= room.next_message_id) {
      throw new RoomError(400, "reply_to must reference an existing message id");
    }
  }
  const message = pushMessage(room, {
    kind: participant.kind,
    sender: participant.name,
    content: text,
    reply_to: replyTo,
    mentions: parseMentions(room, text),
    provisional: room.human_required && !room.human_present ? true : undefined,
  }, nowMs);
  participant.last_seen_at = message.created_at;
  return message;
}

export function setResponseMode(room, mode, by, nowMs = Date.now()) {
  const m = String(mode ?? "");
  if (!RESPONSE_MODES.has(m)) throw new RoomError(400, `response_mode must be one of ${[...RESPONSE_MODES].join(", ")}`);
  if (room.response_mode === m) return false;
  room.response_mode = m;
  addSystemMessage(room, `${by} set response mode to ${m === "addressed_only" ? "only when addressed" : "open"}.`, null, nowMs);
  return true;
}

export function closeRoom(room, { by, kind, summary, how = "direct" }, nowMs = Date.now()) {
  if (room.status === "closed") return false;
  const stamp = iso(nowMs);
  for (const m of room.motions) {
    if (m.status === "open") {
      m.status = "cancelled";
      m.resolved_at = stamp;
      m.outcome = { how: "room_closed", by, reason: null, tally: tally(m) };
    }
  }
  room.status = "closed";
  room.closed_at = stamp;
  room.closed_by = { name: by, kind, how };
  room.summary = summary ? cleanText(summary, "summary", 10000, false) : null;
  pushMessage(room, { kind: "summary", sender: by, content: room.summary || `Room closed by ${by}.` }, nowMs);
  return true;
}

/** Nobody but the creator ever came. Not ingested; listed apart in the lobby. */
export function abandonRoom(room, nowMs = Date.now()) {
  if (room.status !== "open") return false;
  const stamp = iso(nowMs);
  for (const m of room.motions) {
    if (m.status === "open") {
      m.status = "cancelled";
      m.resolved_at = stamp;
      m.outcome = { how: "room_closed", by: null, reason: null, tally: tally(m) };
    }
  }
  room.status = "abandoned";
  room.closed_at = stamp;
  room.closed_by = { name: "room", kind: "system", how: "abandoned" };
  addSystemMessage(room, `Nobody joined ${room.created_by.name}, so the room was marked abandoned.`, { action: "abandoned" }, nowMs);
  return true;
}

// -------------------------------------------------------------- motions

export function findMotion(room, id) {
  return room.motions.find((m) => m.id === Number(id)) || null;
}

export function openMotions(room) {
  return room.motions.filter((m) => m.status === "open");
}

function tally(motion) {
  const yes = motion.eligible.filter((n) => motion.votes[n] === "yes");
  const no = motion.eligible.filter((n) => motion.votes[n] === "no");
  const pending = motion.eligible.filter((n) => motion.votes[n] === undefined);
  return { yes, no, pending };
}

export function fileMotion(room, { type, proposer, reason, summary }, nowMs = Date.now()) {
  if (room.status !== "open") throw new RoomError(409, `Room ${room.code} is ${room.status}`);
  const spec = MOTION_TYPES[type];
  if (!spec) throw new RoomError(400, `type must be one of ${Object.keys(MOTION_TYPES).join(", ")}`);
  const participant = findParticipant(room, cleanName(proposer, "proposer"));
  if (!participant) throw new RoomError(403, `${proposer} is not a participant in ${room.code}`);
  if (!spec.eligible.includes(participant.kind)) throw new RoomError(403, `a ${participant.kind} may not file a ${type} motion`);
  if (type === "close" && room.human_required && !room.human_present) {
    throw new RoomError(409, "close is blocked: a human was called and has not arrived; they can join or dismiss the call", { human_required: true });
  }
  const existing = openMotions(room).find((m) => m.type === type);
  if (existing) return { motion: existing, existing: true };

  const stamp = iso(nowMs);
  const motion = {
    id: room.next_motion_id,
    type,
    proposer: participant.name,
    reason: cleanText(reason, "reason", 1000, type === "call_human"),
    summary: type === "close" ? cleanText(summary, "summary", 10000, false) : null,
    filed_at: stamp,
    hard_deadline: iso(nowMs + room.clock_config.hard_ms),
    eligible: room.participants.filter((p) => spec.eligible.includes(p.kind)).map((p) => p.name),
    votes: { [participant.name]: "yes" },
    delivered_to: { [participant.name]: stamp },
    windows: {},
    status: "open",
    resolved_at: null,
    outcome: null,
  };
  room.next_motion_id += 1;
  room.motions.push(motion);
  const what = type === "close" ? `moved to close the room${motion.summary ? `: ${motion.summary}` : ""}` : `moved to call a human: ${motion.reason}`;
  const others = motion.eligible.filter((n) => !sameName(n, participant.name));
  addSystemMessage(room, `${participant.name} ${what} (motion #${motion.id}). ${others.length ? `Voters: ${others.join(", ")}.` : "No other eligible voters."}`, { motion_id: motion.id, type, action: "filed" }, nowMs);
  evaluate(room, motion.id, nowMs);
  return { motion, existing: false };
}

/** Record delivery to an eligible voter; starts their vote window. */
export function deliverMotions(room, name, nowMs = Date.now()) {
  const delivered = [];
  for (const m of openMotions(room)) {
    const voter = m.eligible.find((n) => sameName(n, name));
    if (!voter || m.delivered_to[voter] !== undefined) continue;
    m.delivered_to[voter] = iso(nowMs);
    m.windows[voter] = iso(nowMs + room.clock_config.window_ms);
    delivered.push(m);
  }
  return delivered;
}

export function castVote(room, id, { name, vote, reason }, nowMs = Date.now()) {
  const motion = findMotion(room, id);
  if (!motion) throw new RoomError(404, `no motion #${id} in ${room.code}`);
  if (motion.status !== "open") throw new RoomError(409, `motion #${id} is ${motion.status}`);
  const voter = motion.eligible.find((n) => sameName(n, cleanName(name, "voter")));
  if (!voter) throw new RoomError(403, `${name} is not an eligible voter on motion #${id}`);
  const v = String(vote ?? "").toLowerCase();
  if (v !== "yes" && v !== "no") throw new RoomError(400, "vote must be yes or no");
  if (motion.votes[voter] !== undefined) throw new RoomError(409, `${voter} already voted ${motion.votes[voter]} on motion #${id}`);
  const why = cleanText(reason, "reason", 1000, v === "no");
  motion.votes[voter] = v;
  motion.delivered_to[voter] ??= iso(nowMs);
  addSystemMessage(room, `${voter} voted ${v} on motion #${id}${why ? `: ${why.replace(/[.!?]+$/, "")}` : ""}.`, { motion_id: id, action: "voted", vote: v }, nowMs);
  evaluate(room, id, nowMs);
  return motion;
}

/** Apply the resolution rules. Returns the motion if it resolved now, else null. */
export function evaluate(room, id, nowMs = Date.now()) {
  const motion = findMotion(room, id);
  if (!motion || motion.status !== "open") return null;
  if (room.held) return null; // nothing resolves while a human holds the room
  const { yes, no, pending } = tally(motion);
  const windowPassed = (n) => motion.windows[n] !== undefined && Date.parse(motion.windows[n]) <= nowMs;
  const allAccounted = pending.every(windowPassed);
  const pastHard = nowMs >= Date.parse(motion.hard_deadline);
  const silent = pending.filter((n) => windowPassed(n) || pastHard);

  if (motion.type === "close") {
    if (no.length) return resolveMotion(room, motion, { carried: false, how: "votes", silent: [] }, nowMs);
    if (pending.length === 0) return resolveMotion(room, motion, { carried: true, how: motion.eligible.length === 1 ? "lone_proposer" : "votes", silent: [] }, nowMs);
    if (allAccounted) return resolveMotion(room, motion, { carried: true, how: "silence", silent }, nowMs);
    if (pastHard) return resolveMotion(room, motion, { carried: true, how: "hard_deadline", silent }, nowMs);
    return null;
  }
  // call_human: tie carries (decision 3 and DESIGN.md 6.3)
  if (pending.length === 0 || allAccounted || pastHard) {
    const carried = yes.length >= no.length;
    const how = pending.length === 0 ? (motion.eligible.length === 1 ? "lone_proposer" : "votes") : allAccounted ? "silence" : "hard_deadline";
    return resolveMotion(room, motion, { carried, how, silent }, nowMs);
  }
  return null;
}

export function resolveMotion(room, motion, { carried, how, by = null, reason = null, silent = [] }, nowMs = Date.now()) {
  const stamp = iso(nowMs);
  const t = tally(motion);
  motion.status = carried ? "carried" : "cancelled";
  motion.resolved_at = stamp;
  motion.outcome = { how, by, reason, tally: { yes: t.yes, no: t.no, silent } };
  const counts = `${t.yes.length} yes, ${t.no.length} no${silent.length ? `, ${silent.length} silent (${silent.join(", ")})` : ""}`;
  const verb = carried ? "carried" : "was cancelled";
  const via = { votes: "by vote", silence: "by silence", hard_deadline: "at the hard deadline", lone_proposer: "with no other voters", override: `by ${by}'s override`, veto: `by ${by}'s veto`, room_closed: "because the room closed" }[how] || how;
  addSystemMessage(room, `Motion #${motion.id} (${motion.type}) ${verb} ${via}: ${counts}.${reason ? ` ${reason}` : ""}`, { motion_id: motion.id, type: motion.type, action: "resolved", status: motion.status, how }, nowMs);
  if (carried && motion.type === "close") {
    closeRoom(room, { by: by || motion.proposer, kind: by ? "human" : "agent", summary: motion.summary, how: by ? "override" : "motion" }, nowMs);
  } else if (carried && motion.type === "call_human" && !room.human_required) {
    room.human_required = true;
    addSystemMessage(room, `A human has been called. Continue on what does not need them; close is blocked until they arrive or dismiss.`, { action: "human_called", reason: motion.reason }, nowMs);
  }
  return motion;
}

export function overrideMotion(room, id, { by, outcome, reason }, nowMs = Date.now()) {
  const motion = findMotion(room, id);
  if (!motion) throw new RoomError(404, `no motion #${id} in ${room.code}`);
  if (motion.status !== "open") throw new RoomError(409, `motion #${id} is ${motion.status}`);
  const o = String(outcome ?? "");
  if (o !== "carry" && o !== "cancel") throw new RoomError(400, "outcome must be carry or cancel");
  const how = o === "cancel" && motion.type === "close" ? "veto" : "override";
  const { pending } = tally(motion);
  return resolveMotion(room, motion, { carried: o === "carry", how, by, reason: cleanText(reason, "reason", 1000, false) || null, silent: pending }, nowMs);
}

const MAX_WAIT_S = 3600;

export function waitRoom(room, { by, target, seconds }, nowMs = Date.now()) {
  const secs = Math.min(MAX_WAIT_S, Math.max(1, Math.floor(Number(seconds) || 300)));
  const ms = secs * 1000;
  const later = (isoStr) => iso(Math.max(Date.parse(isoStr), nowMs) + ms);
  if (target === "ingest") {
    room.ingest_grace_until = iso(Math.max(Date.parse(room.ingest_grace_until || 0), nowMs) + ms);
    addSystemMessage(room, `${by} asked to keep waiting ${secs}s for the summary.`, { action: "wait", target, seconds: secs }, nowMs);
    return { target, seconds: secs };
  }
  if (target) {
    const participant = findParticipant(room, cleanName(target, "participant"));
    if (!participant) throw new RoomError(404, `${target} is not in room ${room.code}`);
    for (const m of openMotions(room)) {
      const voter = m.eligible.find((n) => sameName(n, participant.name));
      if (!voter) continue;
      m.windows[voter] = later(m.windows[voter] || iso(nowMs));
      if (Date.parse(m.hard_deadline) < Date.parse(m.windows[voter])) m.hard_deadline = m.windows[voter];
    }
    addSystemMessage(room, `${by} gave ${participant.name} ${secs}s more.`, { action: "wait", target: participant.name, seconds: secs }, nowMs);
    return { target: participant.name, seconds: secs };
  }
  for (const m of openMotions(room)) {
    m.hard_deadline = later(m.hard_deadline);
    for (const n of Object.keys(m.windows)) m.windows[n] = later(m.windows[n]);
  }
  addSystemMessage(room, `${by} asked the room to keep waiting ${secs}s.`, { action: "wait", target: null, seconds: secs }, nowMs);
  return { target: null, seconds: secs };
}

export function holdRoom(room, by, nowMs = Date.now()) {
  if (room.status !== "open") throw new RoomError(409, `Room ${room.code} is ${room.status}`);
  if (room.held) throw new RoomError(409, `room is already held by ${room.held.by}`);
  room.held = { by, since: iso(nowMs) };
  addSystemMessage(room, `${by} put the room on hold; no motion resolves until it is resumed.`, { action: "hold", by }, nowMs);
  return room.held;
}

export function resumeRoom(room, by, nowMs = Date.now()) {
  if (!room.held) throw new RoomError(409, "room is not held");
  const delta = Math.max(0, nowMs - Date.parse(room.held.since));
  const shift = (isoStr) => iso(Date.parse(isoStr) + delta);
  for (const m of openMotions(room)) {
    m.hard_deadline = shift(m.hard_deadline);
    for (const n of Object.keys(m.windows)) m.windows[n] = shift(m.windows[n]);
  }
  const heldBy = room.held.by;
  room.held = null;
  addSystemMessage(room, `${by} resumed the room${heldBy !== by ? ` (held by ${heldBy})` : ""}; clocks moved forward ${Math.round(delta / 1000)}s.`, { action: "resume", by, delta_ms: delta }, nowMs);
  return delta;
}

export function humanAction(room, { name, action }, nowMs = Date.now()) {
  const participant = findParticipant(room, cleanName(name));
  if (!participant || participant.kind !== "human") throw new RoomError(403, `${name} is not a human participant in ${room.code}`);
  if (action === "acknowledge") {
    room.human_acknowledged_at = iso(nowMs);
    addSystemMessage(room, `${participant.name} is here and acknowledged the call.`, { action: "acknowledge", by: participant.name }, nowMs);
    return { human_required: room.human_required, acknowledged: true };
  }
  if (action === "dismiss") {
    room.human_required = false;
    addSystemMessage(room, `${participant.name} dismissed the call for a human; the room may close without one.`, { action: "dismiss", by: participant.name }, nowMs);
    return { human_required: false, acknowledged: false };
  }
  throw new RoomError(400, "action must be acknowledge or dismiss");
}

/** Messages a participant has not read, excluding their own. */
export function unreadFor(room, participant) {
  return room.messages.filter((m) => m.id > participant.cursor && !sameName(m.sender, participant.name));
}

export function messagesAfter(room, after) {
  return room.messages.filter((m) => m.id > after);
}

/** A motion as a voter sees it. */
export function motionView(motion, name) {
  const t = tally(motion);
  return {
    ...motion,
    tally: { yes: t.yes.length, no: t.no.length, pending: t.pending },
    your_vote: name ? motion.votes[motion.eligible.find((n) => sameName(n, name))] ?? null : null,
    delivered: name ? motion.delivered_to[motion.eligible.find((n) => sameName(n, name)) ?? name] !== undefined : null,
    eligible_for_you: name ? hasName(motion.eligible, name) : null,
  };
}

export function summarizeRoom(room) {
  return {
    code: room.code,
    title: room.title,
    objective: room.objective,
    status: room.status,
    created_by: room.created_by,
    created_at: room.created_at,
    updated_at: room.updated_at,
    closed_at: room.closed_at,
    human_required: room.human_required,
    human_present: room.human_present,
    human_acknowledged_at: room.human_acknowledged_at,
    held: room.held,
    response_mode: room.response_mode,
    participants: room.participants.map(({ name, kind, client, last_seen_at }) => ({ name, kind, client, last_seen_at })),
    message_count: room.messages.length,
    open_motions: openMotions(room).length,
  };
}
