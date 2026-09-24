// Configuration: a config file for structure, environment variables for
// anything that differs per deployment, secrets only from the environment.
// See DESIGN.md section 14.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULTS = Object.freeze({
  bind: "127.0.0.1",
  port: 7340,
  publicOrigin: null,
  humanName: null,
  sessionDays: 30,
  limits: Object.freeze({
    messagesPerMinute: 120,
    roomsPerHour: 20,
    roomsOpenPerCreator: 3,
    maxBodyBytes: 64 * 1024,
    maxWaitSeconds: 300,
    maxAttachmentBytes: 2 * 1024 * 1024,
    maxRoomAttachmentBytes: 20 * 1024 * 1024,
    attachmentOrphanSeconds: 3600,
  }),
  abandonAfterSeconds: 900,
});

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLoopback(bind) {
  return LOOPBACK.has(bind);
}

function readConfigFile(file) {
  if (!file || !fs.existsSync(file)) return {};
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Config file ${file} must contain a JSON object`);
  }
  return parsed;
}

function intFrom(value, fallback, name) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got ${value}`);
  return n;
}

/**
 * Build the effective configuration. Precedence: explicit overrides, then
 * environment, then the config file, then defaults.
 */
export function loadConfig(overrides = {}, env = process.env) {
  const dataDir = path.resolve(
    overrides.dataDir || env.MAINDMELD_DATA_DIR || path.join(os.homedir(), ".maindmeld"),
  );
  const configFile = overrides.configFile || env.MAINDMELD_CONFIG || path.join(dataDir, "config.json");
  const file = readConfigFile(configFile);
  const fileLimits = file.limits && typeof file.limits === "object" ? file.limits : {};

  const bind = overrides.bind || env.MAINDMELD_BIND || file.bind || DEFAULTS.bind;
  const port = intFrom(overrides.port ?? env.MAINDMELD_PORT ?? file.port, DEFAULTS.port, "port");
  const configuredOrigin = overrides.publicOrigin || env.MAINDMELD_PUBLIC_ORIGIN || file.public_origin || null;

  const limits = {
    messagesPerMinute: intFrom(fileLimits.messages_per_minute, DEFAULTS.limits.messagesPerMinute, "messages_per_minute"),
    roomsPerHour: intFrom(fileLimits.rooms_per_hour, DEFAULTS.limits.roomsPerHour, "rooms_per_hour"),
    roomsOpenPerCreator: intFrom(fileLimits.rooms_open_per_creator, DEFAULTS.limits.roomsOpenPerCreator, "rooms_open_per_creator"),
    maxBodyBytes: intFrom(fileLimits.max_body_bytes, DEFAULTS.limits.maxBodyBytes, "max_body_bytes"),
    maxWaitSeconds: intFrom(fileLimits.max_wait_seconds, DEFAULTS.limits.maxWaitSeconds, "max_wait_seconds"),
    maxAttachmentBytes: intFrom(fileLimits.max_attachment_bytes, DEFAULTS.limits.maxAttachmentBytes, "max_attachment_bytes"),
    maxRoomAttachmentBytes: intFrom(fileLimits.max_room_attachment_bytes, DEFAULTS.limits.maxRoomAttachmentBytes, "max_room_attachment_bytes"),
    attachmentOrphanSeconds: intFrom(fileLimits.attachment_orphan_seconds, DEFAULTS.limits.attachmentOrphanSeconds, "attachment_orphan_seconds"),
  };

  // Origins the browser may send on a mutating request. In loopback mode the
  // same server answers on several spellings of its own address.
  const origins = new Set();
  const warnings = [];
  if (configuredOrigin) origins.add(configuredOrigin.replace(/\/$/, ""));
  if (isLoopback(bind) || !configuredOrigin) {
    // Loopback, or a wide bind with nothing configured (the plain
    // `docker run -p` case): accept the local spellings of this port so the
    // browser works out of the box. Anything reached by another hostname
    // needs MAINDMELD_PUBLIC_ORIGIN.
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) origins.add(`http://${host}:${port}`);
    if (!isLoopback(bind)) {
      warnings.push(`bound to ${bind} with no MAINDMELD_PUBLIC_ORIGIN; browser sign-in works only via localhost:${port} until you set it`);
    }
  }

  const profiles = {};
  for (const [key, p] of Object.entries(file.profiles || {})) {
    if (!p || typeof p !== "object") throw new Error(`profile ${key} must be an object`);
    if (!p.base_url || !p.model) throw new Error(`profile ${key} needs base_url and model`);
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(key)) throw new Error(`profile key ${key} must be letters, digits, dot, dash, or underscore`);
    profiles[key] = {
      baseUrl: String(p.base_url),
      model: String(p.model),
      apiKeyEnv: p.api_key_env ? String(p.api_key_env) : null,
      displayName: p.display_name ? String(p.display_name) : key,
      systemPrompt: p.system_prompt ? String(p.system_prompt) : null,
      extra: p.extra && typeof p.extra === "object" ? p.extra : {},
      timeoutMs: intFrom(p.timeout_ms, 120_000, `profile ${key} timeout_ms`),
      replyBudget: intFrom(p.reply_budget, 30, `profile ${key} reply_budget`),
      minGapMs: intFrom(p.min_gap_ms, 3000, `profile ${key} min_gap_ms`),
      window: intFrom(p.window, 40, `profile ${key} window`),
      maxPromptChars: p.max_prompt_chars === undefined ? null : intFrom(p.max_prompt_chars, 0, `profile ${key} max_prompt_chars`),
      maxTokens: intFrom(p.max_tokens, 600, `profile ${key} max_tokens`),
      maxCallsPerHour: intFrom(p.max_calls_per_hour, 120, `profile ${key} max_calls_per_hour`),
      temperature: p.temperature === undefined ? undefined : Number(p.temperature),
      vision: p.vision === true,
      imageMaxPx: intFrom(p.image_max_px, 1024, `profile ${key} image_max_px`),
    };
  }
  const abandonAfterSeconds = intFrom(file.abandon_after_seconds, DEFAULTS.abandonAfterSeconds, "abandon_after_seconds");

  let summarizer = null;
  if (file.summarizer && typeof file.summarizer === "object") {
    const s = file.summarizer;
    const adapter = String(s.adapter || "");
    if (!["openai-compatible", "claude-headless", "command"].includes(adapter)) throw new Error(`summarizer.adapter must be openai-compatible, claude-headless, or command`);
    if (adapter === "openai-compatible" && !s.profile) throw new Error("summarizer.profile is required for the openai-compatible adapter");
    if (adapter === "command" && !s.command) throw new Error("summarizer.command is required for the command adapter");
    let prompt = null;
    if (s.prompt_file) prompt = fs.readFileSync(path.resolve(path.dirname(configFile), String(s.prompt_file)), "utf8");
    summarizer = {
      adapter,
      profile: s.profile ? String(s.profile) : null,
      command: s.command ? String(s.command) : null,
      args: Array.isArray(s.args) ? s.args.map(String) : [],
      model: s.model ? String(s.model) : null,
      prompt,
      timeoutMs: intFrom(s.timeout_ms, 180_000, "summarizer.timeout_ms"),
    };
  }
  let captions = null;
  if (file.captions && typeof file.captions === "object" && file.captions.profile) {
    const key = String(file.captions.profile);
    if (!profiles[key]) throw new Error(`captions.profile names ${key}, which is not a configured profile`);
    captions = { profile: key };
  }

  const kbDir = path.resolve(file.kb_dir ? String(file.kb_dir) : path.join(dataDir, "kb"));
  const searchFile = file.search && typeof file.search === "object" ? file.search : {};
  const search = {
    embeddingsProfile: searchFile.embeddings_profile ? String(searchFile.embeddings_profile) : null,
    injectLimit: Math.min(10, intFrom(searchFile.inject_limit, 5, "search.inject_limit")),
  };
  if (search.embeddingsProfile && !profiles[search.embeddingsProfile]) throw new Error(`search.embeddings_profile ${search.embeddingsProfile} is not a configured profile`);
  const sweepFile = file.sweep && typeof file.sweep === "object" ? file.sweep : {};
  const sweep = {
    intervalDays: intFrom(sweepFile.interval_days, 7, "sweep.interval_days"),
    modelPairs: intFrom(sweepFile.model_pairs, 40, "sweep.model_pairs"),
  };
  const closingMaxSeconds = intFrom(file.closing_max_seconds, 1800, "closing_max_seconds");
  const ingestRetrySeconds = intFrom(file.ingest_retry_seconds, 3600, "ingest_retry_seconds");

  const clocksFile = file.clocks && typeof file.clocks === "object" ? file.clocks : {};
  const clocks = {
    window_ms: intFrom(clocksFile.window_seconds, 120, "clocks.window_seconds") * 1000,
    hard_ms: intFrom(clocksFile.hard_seconds, 600, "clocks.hard_seconds") * 1000,
  };

  const notifiers = [];
  for (const n of Array.isArray(file.notifiers) ? file.notifiers : []) {
    if (!n || typeof n !== "object" || !n.type) throw new Error("each notifier needs a type");
    if (n.type === "webhook" && !n.url) throw new Error("webhook notifier needs a url");
    if (n.type === "ntfy" && !n.topic) throw new Error("ntfy notifier needs a topic");
    const secret = n.secret_env ? env[n.secret_env] : undefined;
    const token = n.token_env ? env[n.token_env] : undefined;
    notifiers.push({ type: String(n.type), url: n.url, topic: n.topic, secret, token });
  }

  return {
    dataDir,
    configFile,
    bind,
    port,
    profiles,
    clocks,
    notifiers,
    abandonAfterSeconds,
    summarizer,
    kbDir,
    closingMaxSeconds,
    ingestRetrySeconds,
    search,
    sweep,
    publicOrigin: configuredOrigin ? configuredOrigin.replace(/\/$/, "") : `http://${isLoopback(bind) ? "127.0.0.1" : "localhost"}:${port}`,
    allowedOrigins: origins,
    warnings,
    humanName: overrides.humanName || env.MAINDMELD_HUMAN_NAME || file.human_name || env.USER || env.USERNAME || "Human",
    sessionDays: intFrom(file.session_days, DEFAULTS.sessionDays, "session_days"),
    captions,
    limits,
    loopback: isLoopback(bind),
  };
}

/** Effective configuration with nothing secret in it, for `config show`. */
export function describeConfig(config) {
  return {
    data_dir: config.dataDir,
    config_file: config.configFile,
    bind: config.bind,
    port: config.port,
    public_origin: config.publicOrigin,
    allowed_origins: [...config.allowedOrigins],
    human_name: config.humanName,
    session_days: config.sessionDays,
    clocks: { window_seconds: config.clocks.window_ms / 1000, hard_seconds: config.clocks.hard_ms / 1000 },
    abandon_after_seconds: config.abandonAfterSeconds,
    kb_dir: config.kbDir,
    search: { embeddings_profile: config.search.embeddingsProfile, inject_limit: config.search.injectLimit },
    sweep: { interval_days: config.sweep.intervalDays, model_pairs: config.sweep.modelPairs },
    closing_max_seconds: config.closingMaxSeconds,
    ingest_retry_seconds: config.ingestRetrySeconds,
    captions: config.captions,
    summarizer: config.summarizer ? { adapter: config.summarizer.adapter, profile: config.summarizer.profile, command: config.summarizer.command, model: config.summarizer.model, timeout_ms: config.summarizer.timeoutMs, prompt_overridden: Boolean(config.summarizer.prompt) } : null,
    notifiers: (config.notifiers || []).map((n) => ({ type: n.type, url: n.url, topic: n.topic, secret_set: Boolean(n.secret), token_set: Boolean(n.token) })),
    profiles: Object.fromEntries(Object.entries(config.profiles || {}).map(([k, p]) => [k, {
      base_url: p.baseUrl,
      model: p.model,
      display_name: p.displayName,
      api_key_env: p.apiKeyEnv,
      key_present: p.apiKeyEnv ? Boolean(process.env[p.apiKeyEnv]) : null,
      timeout_ms: p.timeoutMs,
      reply_budget: p.replyBudget,
      min_gap_ms: p.minGapMs,
      window: p.window,
      max_prompt_chars: p.maxPromptChars,
      max_tokens: p.maxTokens,
      max_calls_per_hour: p.maxCallsPerHour,
      vision: p.vision,
      image_max_px: p.imageMaxPx,
    }])),
    limits: {
      messages_per_minute: config.limits.messagesPerMinute,
      rooms_per_hour: config.limits.roomsPerHour,
      rooms_open_per_creator: config.limits.roomsOpenPerCreator,
      max_body_bytes: config.limits.maxBodyBytes,
      max_wait_seconds: config.limits.maxWaitSeconds,
      max_attachment_bytes: config.limits.maxAttachmentBytes,
      max_room_attachment_bytes: config.limits.maxRoomAttachmentBytes,
      attachment_orphan_seconds: config.limits.attachmentOrphanSeconds,
    },
  };
}
