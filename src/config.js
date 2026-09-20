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
      maxTokens: intFrom(p.max_tokens, 600, `profile ${key} max_tokens`),
      maxCallsPerHour: intFrom(p.max_calls_per_hour, 120, `profile ${key} max_calls_per_hour`),
      temperature: p.temperature === undefined ? undefined : Number(p.temperature),
    };
  }
  const abandonAfterSeconds = intFrom(file.abandon_after_seconds, DEFAULTS.abandonAfterSeconds, "abandon_after_seconds");

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
    publicOrigin: configuredOrigin ? configuredOrigin.replace(/\/$/, "") : `http://${isLoopback(bind) ? "127.0.0.1" : "localhost"}:${port}`,
    allowedOrigins: origins,
    warnings,
    humanName: overrides.humanName || env.MAINDMELD_HUMAN_NAME || file.human_name || env.USER || env.USERNAME || "Human",
    sessionDays: intFrom(file.session_days, DEFAULTS.sessionDays, "session_days"),
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
      max_tokens: p.maxTokens,
      max_calls_per_hour: p.maxCallsPerHour,
    }])),
    limits: {
      messages_per_minute: config.limits.messagesPerMinute,
      rooms_per_hour: config.limits.roomsPerHour,
      rooms_open_per_creator: config.limits.roomsOpenPerCreator,
      max_body_bytes: config.limits.maxBodyBytes,
      max_wait_seconds: config.limits.maxWaitSeconds,
    },
  };
}
