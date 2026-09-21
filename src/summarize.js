// The summarizer contract: an envelope in, a validated note out. Three
// adapters satisfy it (an OpenAI-compatible profile, headless Claude Code,
// or any executable), with one retry carrying the validation errors and a
// circuit breaker around whichever adapter is configured. DESIGN.md 10.

import { spawn } from "node:child_process";

import { OpenAIChatClient } from "./models.js";
import { CONFIDENCE, topicSlug } from "./kb.js";

export const NOTE_SCHEMA_TEXT = `Return one JSON object and nothing else, with these fields:
{
  "title": string (short, specific),
  "summary": string (three to six sentences),
  "topics": [string]  (choose from context.topics by name; add new ones only via new_topics),
  "new_topics": [{"name": string (lowercase-kebab-case, one to three words naming a reusable subject such as "retry-policy" or "api-contract", never a meeting title), "reason": string}],
  "decisions": [{
    "topic": string (exactly one topic, from topics or new_topics),
    "statement": string (one sentence, at most 200 characters, the decision itself),
    "rationale": string (at most two sentences),
    "supersedes": [string] (ids from context.active_decisions that this replaces; usually empty),
    "confidence": "unanimous" | "majority" | "chair",
    "provisional": boolean (true if reached while a called human was absent; see provisional_message_ids)
  }],
  "open_questions": [string],
  "action_items": [{"owner": string, "text": string}],
  "participants_summary": {"<name>": string (one clause on what they contributed)},
  "human_involved": boolean
}
Record only decisions the participants actually reached. Do not invent action items.`;

// ---- redaction ----

const SECRET_PATTERNS = [
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bmm_[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abp]-[A-Za-z0-9-]{20,}\b/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/g,
  // No generic long-hex rule: it would redact git commit hashes and digests.
];

export function redact(text) {
  let count = 0;
  let out = String(text);
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m) => {
      count += 1;
      return `${m.slice(0, 4)}…[redacted]`;
    });
  }
  return { text: out, count };
}

// ---- envelope ----

export function buildEnvelope(room, kb, { maxDecisions = 40 } = {}) {
  const topics = kb.topics();
  const transcriptText = room.messages.map((m) => m.content).join("\n").toLowerCase();
  const matches = (t) => [t.name, ...(t.aliases || [])].some((w) => w && transcriptText.includes(String(w).toLowerCase().replace(/-/g, " ")) || transcriptText.includes(String(w).toLowerCase()));
  const hot = new Set(topics.filter(matches).map((t) => t.name));
  const active = kb.decisions().filter((d) => d.status === "active" && hot.has(d.topic)).slice(-maxDecisions);
  let redactions = 0;
  const messages = room.messages.map((m) => {
    const r = redact(m.content);
    redactions += r.count;
    return { id: m.id, kind: m.kind, sender: m.sender, content: r.text, created_at: m.created_at, provisional: m.provisional || undefined };
  });
  const closing = room.motions.filter((m) => m.type === "close" && m.status === "carried").at(-1) || null;
  return {
    envelope: {
      maindmeld: { version: 1, kind: "transcript" },
      room: { code: room.code, title: room.title, objective: room.objective, created_at: room.created_at, closed_at: room.closed_at, closed_by: room.closed_by, human_acknowledged_at: room.human_acknowledged_at },
      participants: room.participants.map((p) => ({ name: p.name, kind: p.kind })).concat(
        // People who left before close still count as participants of the meeting.
        room.messages.filter((m) => m.kind !== "system" && m.kind !== "summary" && !room.participants.some((p) => p.name === m.sender)).map((m) => ({ name: m.sender, kind: m.kind })).filter((p, i, arr) => arr.findIndex((q) => q.name === p.name) === i),
      ),
      closing: { summary: room.summary, motion: closing ? { id: closing.id, proposer: closing.proposer, summary: closing.summary, outcome: closing.outcome } : null },
      messages,
      provisional_message_ids: room.messages.filter((m) => m.provisional).map((m) => m.id),
      context: {
        topics: topics.map((t) => ({ name: t.name, description: t.description, aliases: t.aliases || [] })),
        active_decisions: active.map((d) => ({ id: d.id, topic: d.topic, statement: d.statement, date: d.date })),
      },
    },
    redactions,
  };
}

// ---- validation ----

export function validateNote(note, envelope) {
  const errors = [];
  if (!note || typeof note !== "object" || Array.isArray(note)) return ["note must be a JSON object"];
  const str = (k, max) => {
    if (typeof note[k] !== "string" || !note[k].trim()) errors.push(`${k} must be a non-empty string`);
    else if (max && note[k].length > max) errors.push(`${k} must be at most ${max} characters`);
  };
  str("title", 200);
  str("summary", 4000);
  const vocab = new Set((envelope.context?.topics || []).flatMap((t) => [t.name, ...(t.aliases || [])]).map(topicSlug));
  const declared = new Set();
  for (const nt of Array.isArray(note.new_topics) ? note.new_topics : []) {
    if (!nt || typeof nt.name !== "string" || !topicSlug(nt.name)) errors.push("each new_topics entry needs a name");
    else if (typeof nt.reason !== "string" || !nt.reason.trim()) errors.push(`new topic ${nt.name} needs a reason`);
    else declared.add(topicSlug(nt.name));
  }
  const allowed = (t) => vocab.has(topicSlug(t)) || declared.has(topicSlug(t));
  if (!Array.isArray(note.topics)) errors.push("topics must be an array");
  else for (const t of note.topics) if (typeof t !== "string" || !allowed(t)) errors.push(`topic "${t}" is not in the vocabulary and not declared in new_topics`);
  const knownIds = new Set((envelope.context?.active_decisions || []).map((d) => d.id));
  if (!Array.isArray(note.decisions)) errors.push("decisions must be an array");
  else note.decisions.forEach((d, i) => {
    if (!d || typeof d !== "object") return errors.push(`decision ${i} must be an object`);
    if (typeof d.topic !== "string" || !allowed(d.topic)) errors.push(`decision ${i}: topic "${d.topic}" is not in the vocabulary and not declared in new_topics`);
    if (typeof d.statement !== "string" || !d.statement.trim()) errors.push(`decision ${i}: statement is required`);
    else if (d.statement.length > 200) errors.push(`decision ${i}: statement must be at most 200 characters (one sentence)`);
    if (d.rationale !== undefined && typeof d.rationale !== "string") errors.push(`decision ${i}: rationale must be a string`);
    if (!CONFIDENCE.has(d.confidence)) errors.push(`decision ${i}: confidence must be one of ${[...CONFIDENCE].join(", ")}`);
    if (d.supersedes !== undefined) {
      if (!Array.isArray(d.supersedes)) errors.push(`decision ${i}: supersedes must be an array`);
      else for (const id of d.supersedes) if (!knownIds.has(id)) errors.push(`decision ${i}: supersedes unknown id ${id}; only ids from context.active_decisions are allowed`);
    }
  });
  if (note.open_questions !== undefined && !Array.isArray(note.open_questions)) errors.push("open_questions must be an array of strings");
  if (note.action_items !== undefined) {
    if (!Array.isArray(note.action_items)) errors.push("action_items must be an array");
    else note.action_items.forEach((a, i) => { if (!a || typeof a.text !== "string" || !a.text.trim()) errors.push(`action item ${i} needs text`); });
  }
  if (note.participants_summary !== undefined) {
    if (typeof note.participants_summary !== "object" || note.participants_summary === null || Array.isArray(note.participants_summary)) errors.push("participants_summary must be an object");
    else for (const [k, v] of Object.entries(note.participants_summary)) if (typeof v !== "string") errors.push(`participants_summary.${k} must be a string`);
  }
  if (typeof note.human_involved !== "boolean") errors.push("human_involved must be true or false");
  return errors;
}

/** Take the first balanced {...} block out of a model reply that may contain prose or fences. */
export function extractJson(text) {
  const s = String(text);
  const start = s.indexOf("{");
  if (start === -1) throw new Error("no JSON object in the reply");
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i += 1) {
    const c = s[i];
    if (inString) {
      if (c === "\\") i += 1;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(s.slice(start, i + 1));
    }
  }
  throw new Error("unterminated JSON object in the reply");
}

// ---- adapters ----

export const DEFAULT_PROMPT = `You write the record of a meeting between AI agents and humans so that later meetings can retrieve what was decided without reading the transcript.
Be concrete and faithful. Prefer the participants' own terms. A decision is something they agreed to, not something they discussed.
Use context.topics for topic names; declare a new topic only when none fits. A topic is a short reusable subject that many meetings could share (one to three words, kebab-case, like "retry-policy", "billing", "api-contract"), never this meeting's title or objective. Mark a decision as superseding an entry in context.active_decisions only when it clearly replaces it.
If provisional_message_ids is non-empty, decisions drawn from those messages are provisional unless the human later confirmed them.`;

function runProcess(cmd, args, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} produced no answer within ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${cmd} exited ${code}: ${err.trim().slice(0, 300)}`));
      else resolve(out);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export function createAdapter(config) {
  const s = config.summarizer;
  if (!s) return null;
  const prompt = s.prompt || DEFAULT_PROMPT;
  const timeoutMs = s.timeoutMs || 180_000;
  const request = (envelope) => `${prompt}\n\n${NOTE_SCHEMA_TEXT}\n\nTRANSCRIPT ENVELOPE:\n${JSON.stringify(envelope)}`;

  if (s.adapter === "openai-compatible") {
    const profile = config.profiles[s.profile];
    if (!profile) throw new Error(`summarizer profile ${s.profile} is not configured`);
    const client = new OpenAIChatClient({ ...profile, timeoutMs, extra: { ...(profile.extra || {}), response_format: { type: "json_object" } } });
    const fallback = new OpenAIChatClient({ ...profile, timeoutMs });
    return {
      name: "openai-compatible",
      model: profile.model,
      async run(envelope) {
        const turns = [{ role: "system", content: `${prompt}\n\n${NOTE_SCHEMA_TEXT}` }, { role: "user", content: `TRANSCRIPT ENVELOPE:\n${JSON.stringify(envelope)}` }];
        let text;
        try {
          ({ text } = await client.complete(turns, { maxTokens: 4000, temperature: 0.2 }));
        } catch (error) {
          // Some servers reject response_format; try once without it.
          if (error.status === 400) ({ text } = await fallback.complete(turns, { maxTokens: 4000, temperature: 0.2 }));
          else throw error;
        }
        return extractJson(text);
      },
    };
  }
  if (s.adapter === "claude-headless") {
    if (!config.loopback) throw new Error("the claude-headless summarizer runs only in local mode");
    const args = ["-p", "--output-format", "text", "--strict-mcp-config", "--max-turns", "1", ...(s.model ? ["--model", s.model] : [])];
    return {
      name: "claude-headless",
      model: s.model || "claude-code-default",
      async run(envelope) {
        const out = await runProcess("claude", args, `${request(envelope)}\n\nReply with the JSON object only.`, timeoutMs);
        return extractJson(out);
      },
    };
  }
  if (s.adapter === "command") {
    if (!s.command) throw new Error("the command summarizer needs a command");
    return {
      name: "command",
      model: s.command,
      async run(envelope) {
        const out = await runProcess(s.command, s.args || [], JSON.stringify(envelope), timeoutMs);
        return extractJson(out);
      },
    };
  }
  throw new Error(`unknown summarizer adapter ${s.adapter}`);
}

/** Five consecutive failures, or a 429, open the breaker for 10 min doubling to 1 h. */
export class Breaker {
  constructor() {
    this.failures = 0;
    this.openUntil = 0;
    this.opens = 0;
  }

  state() {
    return { open: Date.now() < this.openUntil, until: this.openUntil ? new Date(this.openUntil).toISOString() : null, consecutive_failures: this.failures };
  }

  isOpen() {
    return Date.now() < this.openUntil;
  }

  success() {
    this.failures = 0;
  }

  failure({ rateLimited = false } = {}) {
    this.failures += 1;
    if (this.failures >= 5 || rateLimited) {
      const pause = Math.min(3_600_000, 600_000 * 2 ** this.opens);
      this.opens += 1;
      this.openUntil = Date.now() + pause;
      return pause;
    }
    return 0;
  }
}

/**
 * Run the adapter with one validation retry. Returns { note, attempts,
 * warnings }. Throws on failure with `.errors` when validation failed.
 */
export async function summarize(adapter, envelope, { log = () => {} } = {}) {
  const warnings = [];
  let attempt = 0;
  let input = envelope;
  let lastErrors = [];
  while (attempt < 2) {
    attempt += 1;
    const note = await adapter.run(input);
    const errors = validateNote(note, envelope);
    if (!errors.length) {
      if (attempt > 1) warnings.push(`the summarizer needed a retry: ${lastErrors.join("; ")}`);
      return { note, attempts: attempt, warnings };
    }
    lastErrors = errors;
    log(`summarizer attempt ${attempt} returned an invalid note: ${errors.join("; ")}`);
    input = { ...envelope, retry: { attempt, errors, instruction: "Your previous note failed validation. Fix every listed error and return the whole note again." } };
  }
  const error = new Error(`note failed validation after ${attempt} attempts: ${lastErrors.join("; ")}`);
  error.errors = lastErrors;
  throw error;
}
