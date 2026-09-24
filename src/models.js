// Model participants: a server-driven loop that answers in a room on behalf
// of an OpenAI-compatible endpoint. DESIGN.md 7.3 and 10.3.

import { messageText } from "./rooms.js";

const PASS = "[pass]";
const DEBOUNCE_MS = 1500;

export class ModelError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "ModelError";
    this.status = status;
    this.body = body;
  }
}

/** Minimal chat-completions client. Works with llama.cpp, Ollama, vLLM, Gemini, OpenAI. */
export class OpenAIChatClient {
  constructor({ baseUrl, apiKeyEnv, model, timeoutMs = 120_000, extra = {} }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKeyEnv = apiKeyEnv;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.extra = extra;
  }

  apiKey() {
    if (!this.apiKeyEnv) return null;
    const key = process.env[this.apiKeyEnv];
    if (!key) throw new ModelError(`environment variable ${this.apiKeyEnv} is not set`);
    return key;
  }

  async complete(messages, { maxTokens = 600, temperature } = {}) {
    const key = this.apiKey();
    const started = Date.now();
    let res;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model: this.model, messages, max_tokens: maxTokens, ...(temperature !== undefined ? { temperature } : {}), ...this.extra }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ModelError(`${this.model}: ${error.name === "TimeoutError" ? `no answer within ${this.timeoutMs} ms` : error.message}`);
    }
    const text = await res.text();
    if (!res.ok) throw new ModelError(`${this.model}: HTTP ${res.status}`, { status: res.status, body: text.slice(0, 500) });
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new ModelError(`${this.model}: response was not JSON`);
    }
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new ModelError(`${this.model}: empty reply`, { body: text.slice(0, 500) });
    return { text: content.trim(), usage: data.usage || null, ms: Date.now() - started };
  }
}

const DEFAULT_SYSTEM = `You are {name}, a participant in a meeting room shared by AI agents and humans.
Contribute substantively and briefly: one to four sentences unless asked for detail.
Address evidence and claims, not identities. Say plainly when you are unsure or disagree.
Do not restate what others just said. Do not introduce yourself unless asked.
If you have nothing useful to add, reply with exactly ${PASS} and nothing else.`;

/** How many of the newest images a vision profile receives as bytes; older ones stay captions. */
export const INLINE_IMAGES = 4;
/** The window never shrinks below this many messages, whatever the endpoint says. */
export const MIN_WINDOW = 6;
/** A single message longer than this is cut in the model's view; the transcript keeps it whole. */
export const MAX_MESSAGE_CHARS = 4000;

/** Rough size of a prompt: the characters the endpoint will have to read. */
export function promptChars(turns) {
  return turns.reduce((sum, t) => sum + (typeof t.content === "string" ? t.content.length : t.content.reduce((s, p) => s + (p.type === "text" ? p.text.length : 64), 0)), 0);
}

/** An endpoint saying the request is too big: 413, or a 400 that names a length or token limit. */
export function isTooLarge(error) {
  if (error?.status === 413) return true;
  return error?.status === 400 && /too large|too long|maximum context|context length|token limit|tokens? exceed|exceeds the limit|max_tokens|request entity/i.test(`${error.body || ""} ${error.message || ""}`);
}

function clip(text) {
  if (text.length <= MAX_MESSAGE_CHARS) return text;
  return `${text.slice(0, MAX_MESSAGE_CHARS)}\n[… ${text.length - MAX_MESSAGE_CHARS} more characters not shown to models]`;
}

/**
 * Build chat-completion messages from a room transcript. With a vision
 * profile and an image loader, the newest few attachments become image
 * parts (a data URI, since local endpoints cannot fetch); everything else
 * about an image is its caption line. Non-vision profiles never get bytes.
 */
export function buildPrompt(room, name, profile, { loadImage, window: windowSize, maxChars } = {}) {
  let size = windowSize || profile.window || 40;
  let turns = buildTurns(room, name, profile, size, loadImage);
  // An operator who knows the endpoint's per-request limit sets max_prompt_chars;
  // the window shrinks until the prompt fits, down to the floor.
  const limit = maxChars ?? profile.maxPromptChars;
  while (limit && promptChars(turns) > limit && size > MIN_WINDOW) {
    size = Math.max(MIN_WINDOW, Math.floor(size / 2));
    turns = buildTurns(room, name, profile, size, loadImage);
  }
  return turns;
}

function buildTurns(room, name, profile, size, loadImage) {
  const system = [
    (profile.systemPrompt || DEFAULT_SYSTEM).replaceAll("{name}", name),
    "",
    `Room: "${room.title}"${room.objective ? `\nObjective: ${room.objective}` : ""}`,
    `Participants: ${room.participants.map((p) => `${p.name} (${p.kind})`).join(", ")}`,
    room.response_mode === "addressed_only"
      ? `The room is in "only when addressed" mode: reply only if the latest messages address @${name} by name; otherwise reply ${PASS}.`
      : "",
    `Messages from others are shown as "sender (kind): text". Reply with your message text only, no name prefix.`,
  ].filter(Boolean).join("\n");

  const window = room.messages.filter((m) => m.kind !== "summary").slice(-size);
  const others = (m) => m.sender.toLowerCase() !== name.toLowerCase();
  const withImages = profile.vision && loadImage ? new Set(window.filter((m) => m.attachment && others(m)).slice(-INLINE_IMAGES).map((m) => m.id)) : new Set();
  const turns = [{ role: "system", content: system }];
  const asParts = (c) => (Array.isArray(c) ? c : [{ type: "text", text: c }]);
  for (const m of window) {
    const mine = m.sender.toLowerCase() === name.toLowerCase();
    const role = mine ? "assistant" : "user";
    const text = clip(messageText(m));
    let content = mine ? text : m.kind === "system" ? `[room] ${text}` : `${m.sender} (${m.kind}): ${text}`;
    if (withImages.has(m.id) && role === "user") {
      const uri = loadImage(room, m.attachment);
      if (uri) content = [{ type: "text", text: content }, { type: "image_url", image_url: { url: uri } }];
    }
    const last = turns.at(-1);
    if (last.role === role && role !== "system") {
      if (typeof last.content === "string" && typeof content === "string") last.content += `\n\n${content}`;
      else last.content = [...asParts(last.content), { type: "text", text: "\n\n" }, ...asParts(content)];
    } else turns.push({ role, content });
  }
  if (turns.at(-1).role === "assistant") turns.push({ role: "user", content: "[room] (waiting for others)" });
  return turns;
}

export class ModelParticipant {
  /**
   * @param {object} opts
   * @param {string} opts.code room code
   * @param {string} opts.name display name in the room
   * @param {string} opts.profileKey config key
   * @param {object} opts.profile normalized profile from config
   * @param {object} opts.hooks { loadRoom, post(code, name, text), on(code, fn), log }
   */
  constructor({ code, name, profileKey, profile, hooks }) {
    this.code = code;
    this.name = name;
    this.profileKey = profileKey;
    this.profile = profile;
    this.hooks = hooks;
    this.client = new OpenAIChatClient(profile);
    this.replies = 0;
    this.failures = 0;
    this.pausedUntil = 0;
    this.lastReplyAt = 0;
    this.timer = null;
    this.busy = false;
    this.pendingAgain = false;
    this.stopped = false;
    this.latencies = [];
    this.unsubscribe = null;
    this.window = profile.window || 40; // effective; shrinks on "too large", grows back one per reply
  }

  start() {
    this.unsubscribe = this.hooks.on(this.code, (event) => this.onEvent(event));
    return this;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.unsubscribe) this.unsubscribe();
  }

  status() {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const pick = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);
    return {
      room: this.code,
      name: this.name,
      profile: this.profileKey,
      replies: this.replies,
      failures: this.failures,
      window: this.window,
      window_max: this.profile.window || 40,
      paused_until: this.pausedUntil ? new Date(this.pausedUntil).toISOString() : null,
      latency_ms: { p50: pick(0.5), p95: pick(0.95), n: sorted.length },
    };
  }

  suspendUnavailable(ms) {
    this.pausedUntil = 0;
    this.suspendedUntil = Date.now() + ms;
  }

  onEvent(event) {
    if (this.stopped) return;
    if (event.type === "room" && event.room?.status && event.room.status !== "open") return this.stop();
    if (event.type === "motion" && event.action === "filed" && event.motion?.type === "call_human") {
      const mine = (event.motion.eligible || []).some((n) => n.toLowerCase() === this.name.toLowerCase());
      if (mine && event.motion.proposer.toLowerCase() !== this.name.toLowerCase()) {
        this.voteOn(event.motion).catch((e) => this.hooks.log(`model ${this.name} vote: ${e.message}`));
      }
      return;
    }
    if (event.type !== "message") return;
    const m = event.message;
    if (!m || m.kind === "system" || m.kind === "summary") return;
    if (m.sender.toLowerCase() === this.name.toLowerCase()) return;
    this.schedule();
  }

  schedule() {
    if (this.busy) {
      this.pendingAgain = true;
      return;
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.reply().catch((e) => this.hooks.log(`model ${this.name}: ${e.message}`)), DEBOUNCE_MS);
  }

  /**
   * One completion, retried with a smaller window when the endpoint says the
   * request is too large. A 413 is deterministic, so it is neither a failure
   * nor a reason to pause: the same room simply needs a shorter view.
   */
  async completeWithinLimit(room) {
    for (;;) {
      const turns = buildPrompt(room, this.name, this.profile, { loadImage: this.hooks.loadImage, window: this.window });
      try {
        return await this.client.complete(turns, { maxTokens: this.profile.maxTokens ?? 600, temperature: this.profile.temperature });
      } catch (error) {
        if (!isTooLarge(error) || this.window <= MIN_WINDOW) throw error;
        const before = this.window;
        this.window = Math.max(MIN_WINDOW, Math.floor(this.window / 2));
        this.hooks.log(`model ${this.name} in ${this.code}: request too large (${error.message}); window ${before} -> ${this.window}, retrying`);
      }
    }
  }

  /** A call-a-human motion was filed and this model is a voter. Decide yes or no. */
  async voteOn(motion) {
    if (this.stopped) return;
    const room = this.hooks.loadRoom(this.code);
    if (!room) return;
    const tail = room.messages.slice(-12).filter((m) => m.kind !== "system").map((m) => `${m.sender} (${m.kind}): ${messageText(m)}`).join("\n");
    const turns = [
      { role: "system", content: `You are ${this.name}, a participant in a meeting room. Answer with "yes" or "no" on the first line and one sentence of reasoning on the second line. Nothing else.` },
      { role: "user", content: `${motion.proposer} moved to call a human into the room. Reason: ${motion.reason}\n\nRecent discussion:\n${tail || "(none)"}\n\nShould a human be called? Vote yes if the decision is outside the participants' authority, if participants disagree after two rounds, if information only a person has is needed, or if an action is irreversible. Otherwise vote no.` },
    ];
    let vote = "yes";
    let reason = "could not reach the model; defaulting to calling a human";
    try {
      const { text } = await this.client.complete(turns, { maxTokens: 80, temperature: 0 });
      const [first, ...rest] = text.split("\n");
      vote = /^\s*no\b/i.test(first) ? "no" : "yes";
      reason = (rest.join(" ").trim() || first).slice(0, 300);
    } catch (error) {
      this.hooks.log(`model ${this.name} in ${this.code}: vote fell back to yes: ${error.message}`);
    }
    await this.hooks.vote(this.code, this.name, motion.id, vote, reason);
  }

  async reply() {
    if (this.stopped || this.busy) return;
    if (Date.now() < this.pausedUntil && !(this.suspendedUntil > Date.now())) return;
    const room = this.hooks.loadRoom(this.code);
    if (!room || room.status !== "open") return this.stop();
    if (!room.participants.some((p) => p.name.toLowerCase() === this.name.toLowerCase())) return this.stop();
    const budget = this.profile.replyBudget ?? 30;
    if (this.replies >= budget) {
      this.hooks.log(`model ${this.name} in ${this.code}: reply budget of ${budget} spent`);
      return;
    }
    const gap = this.profile.minGapMs ?? 3000;
    const sinceLast = Date.now() - this.lastReplyAt;
    if (sinceLast < gap) {
      this.timer = setTimeout(() => this.reply().catch(() => {}), gap - sinceLast);
      return;
    }
    // Nothing new from others since our last reply: stay quiet.
    const lastOther = [...room.messages].reverse().find((m) => m.kind !== "system" && m.kind !== "summary" && m.sender.toLowerCase() !== this.name.toLowerCase());
    if (!lastOther || Date.parse(lastOther.created_at) < this.lastReplyAt) return;
    if (room.response_mode === "addressed_only") {
      const addressed = room.messages.slice(-5).some((m) => (m.mentions || []).some((n) => n.toLowerCase() === this.name.toLowerCase()) && Date.parse(m.created_at) >= this.lastReplyAt);
      if (!addressed) return;
    }

    if (this.hooks.allowCall && !this.hooks.allowCall(this.profileKey)) {
      this.hooks.log(`model ${this.name} in ${this.code}: hourly call cap for profile ${this.profileKey} reached; staying quiet`);
      this.lastReplyAt = Date.now();
      return;
    }
    this.busy = true;
    this.pendingAgain = false;
    try {
      const { text, ms } = await this.completeWithinLimit(room);
      this.latencies.push(ms);
      if (this.latencies.length > 200) this.latencies.shift();
      this.hooks.record?.(this.profileKey, { ms });
      this.failures = 0;
      if (this.window < (this.profile.window || 40)) this.window += 1; // creep back toward the configured window
      this.lastReplyAt = Date.now();
      if (text.replace(/[\s.]+$/, "").toLowerCase() === PASS) {
        this.hooks.log(`model ${this.name} in ${this.code}: passed (${ms} ms)`);
      } else {
        this.replies += 1;
        await this.hooks.post(this.code, this.name, text);
        this.hooks.log(`model ${this.name} in ${this.code}: replied (${ms} ms)`);
      }
    } catch (error) {
      this.failures += 1;
      this.hooks.record?.(this.profileKey, { failure: true, timeout: /no answer within/.test(error.message) });
      this.hooks.log(`model ${this.name} in ${this.code}: failure ${this.failures}: ${error.message}`);
      if (this.failures >= 3) {
        const pause = Math.min(3_600_000, 600_000 * 2 ** (this.failures - 3));
        this.pausedUntil = Date.now() + pause;
        await this.hooks.system(this.code, `${this.name} is unavailable (${error.message}); pausing for ${Math.round(pause / 60000)} min.`);
      }
    } finally {
      this.busy = false;
      if (this.pendingAgain && !this.stopped) this.schedule();
    }
  }
}
