// Room domain logic. Pure functions over the room object; no I/O here, so
// the server can load, mutate synchronously, and save (DESIGN.md 3.1).

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

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
// Senders of system and summary lines; a participant may not impersonate them.
const RESERVED_NAMES = new Set(["room", "system", "maindmeld"]);

export function makeCode() {
  let out = "MM-";
  for (let i = 0; i < 4; i += 1) out += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  return out;
}

export const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

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

export function findParticipant(room, name) {
  return room.participants.find((p) => sameName(p.name, name)) || null;
}

function lastMessageId(room) {
  return room.next_message_id - 1;
}

function recomputeHumanPresent(room) {
  room.human_present = room.participants.some((p) => p.kind === "human");
}

function pushMessage(room, message) {
  message.id = room.next_message_id;
  room.next_message_id += 1;
  message.created_at = now();
  room.messages.push(message);
  room.updated_at = message.created_at;
  return message;
}

export function addSystemMessage(room, content, data = null) {
  return pushMessage(room, { kind: "system", sender: "room", content, data });
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

export function createRoom({ title, objective, creator, responseMode, code }) {
  const name = cleanName(creator?.name, "creator name");
  const kind = cleanKind(creator?.kind);
  const mode = responseMode ? String(responseMode) : "open";
  if (!RESPONSE_MODES.has(mode)) throw new RoomError(400, `response_mode must be one of ${[...RESPONSE_MODES].join(", ")}`);
  const stamp = now();
  const room = {
    format: 1,
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
    response_mode: mode,
    participants: [],
    messages: [],
    motions: [],
    next_message_id: 1,
  };
  addSystemMessage(room, `${name} created the room.${room.objective ? ` Objective: ${room.objective}` : ""}`);
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

export function joinRoom(room, { name, kind, client }) {
  if (room.status !== "open") throw new RoomError(409, `Room ${room.code} is ${room.status}`);
  const cleaned = cleanName(name);
  const k = cleanKind(kind);
  const existing = findParticipant(room, cleaned);
  if (existing) {
    if (existing.kind !== k) {
      throw new RoomError(409, `${existing.name} is already in the room as ${existing.kind}`);
    }
    existing.last_seen_at = now();
    return { participant: existing, rejoined: true };
  }
  const participant = {
    name: cleaned,
    kind: k,
    client: client ? cleanText(client, "client", 40, false) : null,
    joined_at: now(),
    last_seen_at: now(),
    cursor: lastMessageId(room),
  };
  room.participants.push(participant);
  const joined = addSystemMessage(room, `${cleaned} joined as ${k}.`);
  participant.cursor = joined.id;
  recomputeHumanPresent(room);
  return { participant, rejoined: false };
}

export function leaveRoom(room, name, finalMessage) {
  const participant = findParticipant(room, cleanName(name));
  if (!participant) throw new RoomError(404, `${name} is not in room ${room.code}`);
  if (finalMessage && room.status === "open") {
    sendMessage(room, { sender: participant.name, content: finalMessage }, Infinity);
  }
  room.participants = room.participants.filter((p) => p !== participant);
  addSystemMessage(room, `${participant.name} left.`);
  recomputeHumanPresent(room);
  return participant;
}

export function sendMessage(room, { sender, content, reply_to }, maxBytes) {
  if (room.status !== "open") throw new RoomError(409, `Room ${room.code} is ${room.status}`);
  const participant = findParticipant(room, cleanName(sender, "sender"));
  if (!participant) throw new RoomError(403, `${sender} is not a participant in ${room.code}; join first`);
  const text = cleanText(content, "content", Infinity, true);
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new RoomError(413, `content exceeds ${maxBytes} bytes`);
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
  });
  participant.last_seen_at = message.created_at;
  return message;
}

export function setResponseMode(room, mode, by) {
  const m = String(mode ?? "");
  if (!RESPONSE_MODES.has(m)) throw new RoomError(400, `response_mode must be one of ${[...RESPONSE_MODES].join(", ")}`);
  if (room.response_mode === m) return false;
  room.response_mode = m;
  addSystemMessage(room, `${by} set response mode to ${m === "addressed_only" ? "only when addressed" : "open"}.`);
  return true;
}

export function closeRoom(room, { by, kind, summary, how = "direct" }) {
  if (room.status === "closed") return false;
  const stamp = now();
  room.status = "closed";
  room.closed_at = stamp;
  room.closed_by = { name: by, kind, how };
  room.summary = summary ? cleanText(summary, "summary", 10000, false) : null;
  pushMessage(room, {
    kind: "summary",
    sender: by,
    content: room.summary || `Room closed by ${by}.`,
  });
  return true;
}

/** Messages a participant has not read, excluding their own. */
export function unreadFor(room, participant) {
  return room.messages.filter((m) => m.id > participant.cursor && !sameName(m.sender, participant.name));
}

export function messagesAfter(room, after) {
  return room.messages.filter((m) => m.id > after);
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
    response_mode: room.response_mode,
    participants: room.participants.map(({ name, kind, client, last_seen_at }) => ({ name, kind, client, last_seen_at })),
    message_count: room.messages.length,
    open_motions: room.motions.filter((m) => m.status === "open").length,
  };
}
