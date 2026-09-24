// The runner: a companion process that lives where agent harnesses live and
// starts them into rooms when the server asks. It connects outbound only,
// holds its own list of what it can launch and how, and reports coarse
// lifecycle facts back. The server never sends a command. DESIGN.md 7.4.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TEMPLATE = path.join(here, "..", "templates", "harness", "default.md");
const LOG_CAP_BYTES = 1024 * 1024;
const PLACEHOLDERS = ["token", "mcp_url", "room", "prompt_file", "invitation", "harness", "launch", "title", "objective"];

const expand = (p) => (p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);

/** Read and check runner.json. Commands come only from here; the server sends intent. */
export function loadRunnerConfig(file, env = process.env) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!raw || typeof raw !== "object") throw new Error("runner.json must be a JSON object");
  const name = String(raw.name ?? "").trim();
  if (!/^[A-Za-z0-9_.-]{1,40}$/.test(name)) throw new Error("runner.json: name is required, letters, digits, dot, dash, or underscore");
  const server = String(raw.server ?? "").replace(/\/$/, "");
  if (!/^https?:\/\//.test(server)) throw new Error("runner.json: server must be an http or https URL");
  if (raw.token) throw new Error("runner.json: do not put the token in the file; name the environment variable in token_env");
  const tokenEnv = String(raw.token_env || "MAINDMELD_RUNNER_TOKEN");
  const token = env[tokenEnv];
  if (!token) throw new Error(`environment variable ${tokenEnv} is not set (the runner's mAIndmeld token)`);
  const harnesses = {};
  for (const [key, h] of Object.entries(raw.harnesses || {})) {
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(key)) throw new Error(`runner.json: harness key ${key} must be letters, digits, dot, dash, or underscore`);
    if (!h || typeof h !== "object" || !Array.isArray(h.command) || !h.command.length) throw new Error(`runner.json: harness ${key} needs a command array`);
    if (h.command.some((a) => String(a).includes("{token}"))) throw new Error(`runner.json: harness ${key} puts {token} on the command line; pass it by env or the prompt file`);
    harnesses[key] = {
      command: h.command.map(String),
      cwd: h.cwd ? expand(String(h.cwd)) : undefined,
      env: h.env && typeof h.env === "object" ? Object.fromEntries(Object.entries(h.env).map(([k, v]) => [k, String(v)])) : {},
      timeoutMs: Math.round(Number(h.timeout_minutes ?? 120) * 60_000),
      template: h.template ? expand(String(h.template)) : DEFAULT_TEMPLATE,
    };
    if (!(harnesses[key].timeoutMs > 0)) throw new Error(`runner.json: harness ${key} timeout_minutes must be positive`);
    if (!fs.existsSync(harnesses[key].template)) throw new Error(`runner.json: harness ${key} template ${harnesses[key].template} does not exist`);
  }
  if (!Object.keys(harnesses).length) throw new Error("runner.json: at least one harness is required");
  const stateDir = raw.state_dir ? expand(String(raw.state_dir)) : path.join(path.dirname(path.resolve(file)), "runs");
  return { name, server, token, tokenEnv, maxConcurrent: Math.max(1, Number(raw.max_concurrent ?? 2) || 2), stateDir, harnesses };
}

export function fill(text, values) {
  return String(text).replace(/\{([a-z_]+)\}/g, (m, key) => (PLACEHOLDERS.includes(key) && values[key] !== undefined ? String(values[key]) : m));
}

export class Runner {
  constructor(config, { log = () => {}, fetchImpl = fetch, spawnImpl = spawn } = {}) {
    this.config = config;
    this.log = log;
    this.fetch = fetchImpl;
    this.spawn = spawnImpl;
    this.active = new Map(); // launch id -> { child, harness, timer, promptFile, logFd, cancelled }
    this.stopped = false;
    this.controller = null;
    this.connected = false;
    this.backoffMs = 1000;
    fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  }

  // ---- talking to the server ----

  headers(extra = {}) {
    return { authorization: `Bearer ${this.config.token}`, ...extra };
  }

  async api(method, p, body) {
    const res = await this.fetch(`${this.config.server}${p}`, { method, headers: this.headers(body ? { "content-type": "application/json" } : {}), body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  /** Reap processes from a previous run of this runner, then connect. */
  async start() {
    this.reap();
    this.loop = this.connectLoop();
    return this;
  }

  async stop() {
    this.stopped = true;
    this.controller?.abort();
    for (const id of [...this.active.keys()]) this.cancel(id, "runner stopping");
    await new Promise((r) => setTimeout(r, 50));
    await this.loop?.catch(() => {});
  }

  async connectLoop() {
    while (!this.stopped) {
      try {
        await this.subscribe();
        this.backoffMs = 1000;
      } catch (error) {
        if (this.stopped) break;
        this.connected = false;
        this.log(`connection to ${this.config.server} lost (${error.message}); retrying in ${this.backoffMs / 1000} s`);
      }
      if (this.stopped) break;
      await new Promise((r) => setTimeout(r, this.backoffMs));
      this.backoffMs = Math.min(30_000, this.backoffMs * 2);
    }
  }

  async subscribe() {
    this.controller = new AbortController();
    const harnesses = Object.keys(this.config.harnesses).join(",");
    const url = `${this.config.server}/api/runner/events?name=${encodeURIComponent(this.config.name)}&harnesses=${encodeURIComponent(harnesses)}`;
    const res = await this.fetch(url, { headers: this.headers({ accept: "text/event-stream" }), signal: this.controller.signal });
    if (res.status !== 200) throw new Error(`server answered ${res.status}${res.status === 403 ? " (is this a scoped token?)" : ""}`);
    this.connected = true;
    this.log(`connected to ${this.config.server} as runner ${this.config.name}, offering ${harnesses}`);
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const type = block.match(/^event: (.*)$/m)?.[1];
        const data = block.match(/^data: (.*)$/m)?.[1];
        if (!type) continue;
        let parsed = null;
        try {
          parsed = data ? JSON.parse(data) : null;
        } catch {
          continue;
        }
        this.onEvent(type, parsed).catch((e) => this.log(`event ${type}: ${e.message}`));
      }
    }
    throw new Error("stream ended");
  }

  async onEvent(type, data) {
    if (type === "launch") return this.onLaunch(data);
    if (type === "cancel") return this.cancel(data.launch, data.reason || "cancelled by the server");
  }

  // ---- launches ----

  async onLaunch(data) {
    const harness = this.config.harnesses[data.harness];
    if (!harness) return this.log(`launch ${data.launch}: harness ${data.harness} is not in my config; ignoring`);
    if (this.active.has(data.launch)) return;
    if (this.active.size >= this.config.maxConcurrent) {
      return this.log(`launch ${data.launch}: at max_concurrent ${this.config.maxConcurrent}; not claiming (the server will time it out)`);
    }
    const claim = await this.api("POST", `/api/launches/${data.launch}/claim`, { runner: this.config.name });
    if (claim.status === 409) return this.log(`launch ${data.launch}: already claimed`);
    if (claim.status !== 200) return this.log(`launch ${data.launch}: claim failed with ${claim.status}: ${claim.data.error || ""}`);
    const c = claim.data;
    const values = { token: c.token, mcp_url: c.mcp_url, room: c.room.code, invitation: c.invitation, harness: data.harness, launch: data.launch, title: c.room.title, objective: c.room.objective || "" };
    const promptFile = path.join(this.config.stateDir, `${data.launch}.prompt.md`);
    values.prompt_file = promptFile;
    try {
      fs.writeFileSync(promptFile, fill(fs.readFileSync(harness.template, "utf8"), values), { mode: 0o600 });
    } catch (error) {
      await this.report(data.launch, "failed", `could not write the prompt file: ${error.message}`);
      return;
    }
    const env = {
      ...process.env,
      MAINDMELD_TOKEN: c.token,
      MAINDMELD_MCP_URL: c.mcp_url,
      MAINDMELD_ROOM: c.room.code,
      MAINDMELD_LAUNCH: data.launch,
      MAINDMELD_PROMPT_FILE: promptFile,
      ...Object.fromEntries(Object.entries(harness.env).map(([k, v]) => [k, fill(v, values)])),
    };
    const [program, ...args] = harness.command.map((a) => fill(a, values));
    const logFile = path.join(this.config.stateDir, `${data.launch}.log`);
    let logFd = null;
    try {
      logFd = fs.openSync(logFile, "w", 0o600);
    } catch {
      logFd = null;
    }
    let child;
    try {
      child = this.spawn(program, args, { cwd: harness.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      this.cleanupFiles(data.launch, promptFile, logFd);
      await this.report(data.launch, "failed", `could not start ${program}: ${error.message}`);
      return;
    }
    const entry = { child, harness: data.harness, promptFile, logFd, cancelled: null, written: 0, timer: null };
    this.active.set(data.launch, entry);
    this.writeRun(data.launch, { pid: child.pid, harness: data.harness, room: c.room.code, started_at: new Date().toISOString() });
    const sink = (chunk) => {
      if (logFd === null || entry.written >= LOG_CAP_BYTES) return;
      const slice = chunk.subarray(0, Math.max(0, LOG_CAP_BYTES - entry.written));
      entry.written += slice.length;
      try {
        fs.writeSync(logFd, slice);
      } catch {
        // The log is a convenience.
      }
    };
    child.stdout?.on("data", sink);
    child.stderr?.on("data", sink);
    child.once("error", (error) => {
      this.finish(data.launch, "failed", `could not start ${program}: ${error.message}`).catch(() => {});
    });
    child.once("exit", (code, signal) => {
      const e = this.active.get(data.launch);
      if (!e) return;
      if (e.cancelled) this.finish(data.launch, "failed", e.cancelled, code).catch(() => {});
      else if (code === 0) this.finish(data.launch, "exited", null, 0).catch(() => {});
      else this.finish(data.launch, "failed", signal ? `killed by ${signal}` : `exit code ${code}`, code).catch(() => {});
    });
    entry.timer = setTimeout(() => this.cancel(data.launch, `timed out after ${Math.round(harness.timeoutMs / 60_000)} min`), harness.timeoutMs);
    entry.timer.unref?.();
    this.log(`launch ${data.launch}: started ${data.harness} (pid ${child.pid}) for room ${c.room.code}`);
  }

  /** Stop a running harness: SIGTERM, then SIGKILL after ten seconds. */
  cancel(id, reason) {
    const e = this.active.get(id);
    if (!e || e.cancelled) return;
    e.cancelled = reason;
    this.log(`launch ${id}: ${reason}; stopping pid ${e.child.pid}`);
    try {
      e.child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
    const hard = setTimeout(() => {
      try {
        e.child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }, 10_000);
    hard.unref?.();
  }

  async finish(id, state, reason, code = null) {
    const e = this.active.get(id);
    if (!e) return;
    this.active.delete(id);
    clearTimeout(e.timer);
    this.cleanupFiles(id, e.promptFile, e.logFd);
    this.log(`launch ${id}: ${state}${reason ? ` (${reason})` : ""}${code !== null ? `, code ${code}` : ""}`);
    await this.report(id, state, reason, code);
  }

  async report(id, state, reason, code = null) {
    try {
      const r = await this.api("POST", `/api/launches/${id}/status`, { state, reason: reason || undefined, exit_code: code === null ? undefined : code });
      if (r.status !== 200 && r.status !== 404) this.log(`launch ${id}: status report answered ${r.status}: ${r.data.error || ""}`);
    } catch (error) {
      this.log(`launch ${id}: could not report ${state}: ${error.message}`);
    }
  }

  cleanupFiles(id, promptFile, logFd) {
    try {
      fs.unlinkSync(promptFile);
    } catch {
      // Not written, or already gone.
    }
    if (logFd !== null) {
      try {
        fs.closeSync(logFd);
      } catch {
        // Already closed.
      }
    }
    try {
      fs.unlinkSync(path.join(this.config.stateDir, `${id}.run.json`));
    } catch {
      // Not written.
    }
  }

  writeRun(id, record) {
    try {
      fs.writeFileSync(path.join(this.config.stateDir, `${id}.run.json`), JSON.stringify(record), { mode: 0o600 });
    } catch {
      // The record only serves reaping after a crash.
    }
  }

  /** After a crash or restart: stop any harness a previous run of this runner left behind. */
  reap() {
    let names = [];
    try {
      names = fs.readdirSync(this.config.stateDir).filter((n) => n.endsWith(".run.json"));
    } catch {
      return;
    }
    for (const n of names) {
      const file = path.join(this.config.stateDir, n);
      try {
        const { pid } = JSON.parse(fs.readFileSync(file, "utf8"));
        if (pid) {
          try {
            process.kill(pid, "SIGTERM");
            this.log(`reaped pid ${pid} from a previous run (${n})`);
          } catch {
            // Not running any more.
          }
        }
      } catch {
        // Unreadable record.
      }
      try {
        fs.unlinkSync(file);
        fs.unlinkSync(file.replace(/\.run\.json$/, ".prompt.md"));
      } catch {
        // Fine.
      }
    }
  }

  status() {
    return { name: this.config.name, server: this.config.server, connected: this.connected, active: [...this.active.entries()].map(([id, e]) => ({ launch: id, harness: e.harness, pid: e.child.pid })) };
  }
}
