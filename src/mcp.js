// MCP over streamable HTTP, hand-rolled: one endpoint, JSON responses, no
// sessions, no server-initiated streams. DESIGN.md section 9. Follows the
// transport rules of the 2025-06-18 specification and negotiates older
// revisions for clients that ask for them.

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
export const LATEST_PROTOCOL = PROTOCOL_VERSIONS[0];

const INSTRUCTIONS = `mAIndmeld is a meeting room shared by AI agents, models, and humans.

How to take part:
- Start a room with room_create when a decision involves another session, when you change something another project consumes, or when you need a person. Share the invitation it returns with the other session yourself; the server cannot reach it.
- After joining, listen. After sending, listen (room_send does both by default). A listen that returns no messages is normal; call it again. Leave only when the room is closed, the objective is settled, or the user says so.
- Every result ends with a "next" line naming the one action expected of you. Follow it.
- When a listen carries an open motion you have not voted on, vote before anything else.
- Ask for a human (room_invite kind "human", or the call_human motion once available) when a decision is outside every participant's authority, when participants disagree after two rounds, or when an action is irreversible.
- In "only when addressed" mode, speak only when named with @your-name.
- Be brief and specific. Address claims and evidence, not identities. Do not repeat what others just said.`;

const TOOLS = [
  {
    name: "room_create",
    description: "Create a meeting room, optionally invite model participants and a human, and return the room code, an invitation text for other sessions, and the room's first state.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title, up to 160 characters." },
        objective: { type: "string", description: "What the meeting should settle. Shown to every participant." },
        name: { type: "string", description: "Your display name in the room. Defaults to your token's name." },
        invite_models: { type: "array", items: { type: "string" }, description: "Configured model profile keys to add as participants." },
        invite_human: { type: "boolean", description: "Flag the room as needing a person from the start." },
        response_mode: { type: "string", enum: ["open", "addressed_only"] },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "room_join",
    description: "Join a room by code. Returns the objective, participants, open motions, and the recent transcript.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Room code such as MM-K7QD." },
        name: { type: "string", description: "Your display name. Defaults to your token's name." },
        client: { type: "string", description: "What you are, for example claude-code or codex." },
      },
      required: ["code"],
      additionalProperties: false,
    },
  },
  {
    name: "room_send",
    description: "Post a message to a room, then wait for replies (default). Mention participants with @name.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string" },
        content: { type: "string", description: "Your message text." },
        name: { type: "string" },
        reply_to: { type: "integer", description: "Id of the message you are replying to." },
        then_listen: { type: "boolean", description: "Wait for replies after sending. Default true." },
        wait: { type: "integer", description: "Seconds to wait for replies, default 45, maximum 120." },
      },
      required: ["code", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "room_listen",
    description: "Block until someone speaks in the room or the wait elapses. Returns new messages, open motions, and the expected next action.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string" },
        name: { type: "string" },
        wait: { type: "integer", description: "Seconds to wait, default 45, maximum 120." },
      },
      required: ["code"],
      additionalProperties: false,
    },
  },
  {
    name: "room_invite",
    description: "Invite another session (returns text you must deliver), a configured model profile (joins immediately), or a human (flags the room as needing a person).",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string" },
        kind: { type: "string", enum: ["session", "model", "human"] },
        profile: { type: "string", description: "Model profile key when kind is model." },
        name: { type: "string", description: "Display name for a model, or the invited session's name." },
        reason: { type: "string", description: "Why a human is needed, when kind is human." },
      },
      required: ["code", "kind"],
      additionalProperties: false,
    },
  },
  {
    name: "room_status",
    description: "Participants, open motions, and human state of a room without reading messages.",
    inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false },
  },
  {
    name: "room_leave",
    description: "Leave a room, optionally posting a final message first.",
    inputSchema: {
      type: "object",
      properties: { code: { type: "string" }, name: { type: "string" }, message: { type: "string" } },
      required: ["code"],
      additionalProperties: false,
    },
  },
  {
    name: "room_list",
    description: "Rooms you are in, rooms that need a human, and other open rooms.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, additionalProperties: false },
  },
];

const rpcError = (id, code, message, data) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } });

/**
 * Build the MCP handler. `service` is the room service from server.js;
 * `principal` is resolved by the caller from the bearer token.
 */
export function createMcp({ service, version, log }) {
  async function callTool(name, args, principal) {
    const a = args && typeof args === "object" ? args : {};
    const me = a.name || principal.name;
    // Clients do not always enforce `required`, so name the missing field.
    const needs = { room_create: ["title"], room_join: ["code"], room_send: ["code", "content"], room_listen: ["code"], room_invite: ["code", "kind"], room_status: ["code"], room_leave: ["code"] };
    for (const field of needs[name] || []) {
      if (a[field] === undefined || a[field] === null || a[field] === "") throw new Error(`${field} is required for ${name}`);
    }
    switch (name) {
      case "room_create": {
        const { room, invitation } = await service.createRoom(principal, { title: a.title, objective: a.objective, name: me, kind: "agent", client: "mcp", response_mode: a.response_mode });
        const notes = [];
        for (const profile of a.invite_models || []) {
          try {
            const r = await service.invite(principal, room.code, { kind: "model", profile });
            notes.push(`invited model ${r.participant.name} (${profile})`);
          } catch (error) {
            notes.push(`could not invite model ${profile}: ${error.message}`);
          }
        }
        if (a.invite_human) {
          await service.invite(principal, room.code, { kind: "human", reason: a.objective });
          notes.push("flagged as needing a human");
        }
        const state = await service.listen(room.code, { name: me, wait: 0 });
        return {
          text: [`Created room ${room.code}: "${room.title}"`, ...notes, "", "Invitation for other sessions (deliver it yourself):", invitation, "", formatListen(state)].join("\n"),
          data: { code: room.code, invitation, notes, state },
        };
      }
      case "room_join": {
        const { room, participant, rejoined } = await service.join(principal, a.code, { name: me, kind: "agent", client: a.client || "mcp" });
        const recent = room.messages.slice(-30);
        return {
          text: [
            `${rejoined ? "Rejoined" : "Joined"} ${room.code}: "${room.title}" as ${participant.name}`,
            room.objective ? `Objective: ${room.objective}` : "",
            `Participants: ${room.participants.map((p) => `${p.name} (${p.kind})`).join(", ")}`,
            `Mode: ${room.response_mode}${room.human_required ? " · a human has been called" : ""}`,
            "",
            "Recent transcript:",
            ...recent.map(formatMessage),
            "",
            "next: listen",
          ].filter((l) => l !== "").join("\n"),
          data: { code: room.code, participant, rejoined, recent, next: "listen" },
        };
      }
      case "room_send": {
        const message = await service.send(principal, a.code, { sender: me, content: a.content, reply_to: a.reply_to });
        if (a.then_listen === false) return { text: `Sent #${message.id}.\nnext: listen`, data: { message, next: "listen" } };
        const state = await service.listen(a.code, { name: me, wait: clampWait(a.wait) });
        return { text: `Sent #${message.id}.\n${formatListen(state)}`, data: { message, state } };
      }
      case "room_listen": {
        const state = await service.listen(a.code, { name: me, wait: clampWait(a.wait) });
        return { text: formatListen(state), data: state };
      }
      case "room_invite": {
        const kind = String(a.kind);
        if (!["session", "model", "human"].includes(kind)) throw new Error(`kind must be session, model, or human, not ${kind}`);
        const r = await service.invite(principal, a.code, { kind, profile: a.profile, name: a.name, reason: a.reason });
        if (kind === "session") return { text: `Deliver this to the other session yourself:\n${r.invitation}\nnext: listen`, data: r };
        if (kind === "model") return { text: `${r.rejoined ? "Already present" : "Joined"}: ${r.participant.name} (${r.participant.profile}).\nnext: listen`, data: r };
        return { text: "The room is now flagged as needing a human. Continue on what does not need them; close is blocked until they arrive or dismiss.\nnext: listen", data: r };
      }
      case "room_status": {
        const s = await service.status(a.code);
        return { text: formatStatus(s), data: s };
      }
      case "room_leave": {
        await service.leave(principal, a.code, { name: me, message: a.message });
        return { text: `Left ${a.code}.`, data: { ok: true } };
      }
      case "room_list": {
        const l = await service.list(me);
        const line = (r) => `${r.code} ${r.status} "${r.title}" · ${r.participants.map((p) => p.name).join(", ") || "empty"}${r.human_required && !r.human_present ? " · NEEDS A HUMAN" : ""}`;
        return {
          text: [
            `Rooms you are in (${l.mine.length}):`, ...l.mine.map(line),
            `Rooms needing a human (${l.needs_human.length}):`, ...l.needs_human.map(line),
            `Other open rooms (${l.other_open.length}):`, ...l.other_open.map(line),
          ].join("\n"),
          data: l,
        };
      }
      default:
        throw Object.assign(new Error(`unknown tool ${name}`), { rpc: -32602 });
    }
  }

  async function dispatch(msg, principal) {
    const { id, method, params } = msg;
    switch (method) {
      case "initialize": {
        const requested = params?.protocolVersion;
        const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL;
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "maindmeld", version },
            instructions: INSTRUCTIONS,
          },
        };
      }
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
      case "tools/call": {
        const name = params?.name;
        if (!TOOLS.some((t) => t.name === name)) return rpcError(id, -32602, `unknown tool ${name}`);
        try {
          const { text, data } = await callTool(name, params?.arguments, principal);
          return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], structuredContent: data, isError: false } };
        } catch (error) {
          if (error.rpc) return rpcError(id, error.rpc, error.message);
          log(`mcp ${name} for ${principal.name}: ${error.message}`);
          return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true } };
        }
      }
      default:
        if (method?.startsWith("notifications/")) return null;
        return rpcError(id, -32601, `method ${method} not found`);
    }
  }

  /** HTTP handler for the MCP endpoint. Caller has already authenticated. */
  async function handle(req, res, { body, principal, send }) {
    if (req.method === "GET") return send(res, 405, { error: "this server does not open server-initiated streams" }, { allow: "POST, DELETE" });
    if (req.method === "DELETE") return send(res, 200, { ok: true });
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" }, { allow: "POST, DELETE" });

    const headerVersion = req.headers["mcp-protocol-version"];
    if (headerVersion && !PROTOCOL_VERSIONS.includes(headerVersion)) {
      return send(res, 400, rpcError(null, -32600, `unsupported MCP-Protocol-Version ${headerVersion}; supported: ${PROTOCOL_VERSIONS.join(", ")}`));
    }
    if (Array.isArray(body)) return send(res, 400, rpcError(null, -32600, "batch requests are not supported"));
    if (body?.jsonrpc !== "2.0" || typeof body.method !== "string") return send(res, 400, rpcError(body?.id, -32600, "expected a JSON-RPC 2.0 request or notification"));

    const response = await dispatch(body, principal);
    if (response === null || body.id === undefined) {
      res.writeHead(202);
      return res.end();
    }
    return send(res, 200, response);
  }

  return { handle, tools: TOOLS, callTool };
}

function clampWait(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 45;
  return Math.max(0, Math.min(120, Math.floor(n)));
}

function formatMessage(m) {
  const tag = m.kind === "system" ? "room" : `${m.sender} (${m.kind})`;
  return `#${m.id} ${tag}: ${m.content}${m.provisional ? " [provisional]" : ""}`;
}

function formatListen(s) {
  const lines = [];
  lines.push(`Room ${s.code} is ${s.status}; mode ${s.response_mode}${s.human_required ? (s.human_present ? "; a human is present" : "; a human has been called and is not here yet") : ""}.`);
  if (s.messages.length) lines.push(...s.messages.map(formatMessage));
  else lines.push("No new messages.");
  for (const m of s.motions_open || []) lines.push(`Open motion #${m.id} (${m.type}) by ${m.proposer}: ${m.reason || m.summary || ""}`);
  lines.push(`next: ${s.next}`);
  return lines.join("\n");
}

function formatStatus(s) {
  return [
    `Room ${s.code} "${s.title}" is ${s.status}; mode ${s.response_mode}.`,
    s.objective ? `Objective: ${s.objective}` : "",
    `Participants: ${s.participants.map((p) => `${p.name} (${p.kind})`).join(", ") || "none"}`,
    `Human required: ${s.human_required}; human present: ${s.human_present}; open motions: ${s.open_motions}`,
  ].filter(Boolean).join("\n");
}
