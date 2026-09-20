// Command-line interface: run or manage the server, and act as the
// configured human from a terminal. DESIGN.md section 14.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadConfig, describeConfig } from "./config.js";
import { Store } from "./store.js";
import { Auth } from "./auth.js";

const USAGE = `mAIndmeld — a meeting room for AI agents and the humans who work with them

Usage: maindmeld <command> [options]

Server
  serve                         run the server in the foreground
  start | stop | status         manage a detached server
  open [CODE]                   open the lobby or a room in the browser

Rooms
  rooms                         list rooms
  say CODE "text"               post as the configured human (joins first)
  invite CODE --model PROFILE   add a model participant from a config profile
  invite CODE --human           flag the room as needing a human
  invite CODE                   print the invitation text for another session

Motions (the CLI acts as the configured human unless --as NAME is given)
  motion CODE close|call_human ["text"]   file a motion as --as NAME (an agent)
  vote CODE ID yes|no ["reason"] --as NAME
  override CODE ID carry|cancel ["reason"]
  wait CODE [--for NAME|ingest] [--seconds N]
  hold CODE pause|resume
  human CODE acknowledge|dismiss

Administration
  token create NAME | list | revoke NAME
  config show                   effective configuration, secrets masked

Environment: MAINDMELD_DATA_DIR, MAINDMELD_BIND, MAINDMELD_PORT,
MAINDMELD_PUBLIC_ORIGIN, MAINDMELD_HUMAN_NAME, MAINDMELD_TOKEN
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      flags[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true);
    } else positional.push(a);
  }
  return { positional, flags };
}

class Cli {
  constructor(config, io = { out: console.log, err: console.error }) {
    this.config = config;
    this.io = io;
    this.base = `http://${config.loopback ? "127.0.0.1" : config.bind}:${config.port}`;
    this.pidFile = path.join(config.dataDir, "server.pid");
    this.logFile = path.join(config.dataDir, "server.log");
    this.tokenFile = path.join(config.dataDir, "cli.token");
  }

  // ---- auth for CLI requests ----

  cliToken({ create = false } = {}) {
    if (process.env.MAINDMELD_TOKEN) return process.env.MAINDMELD_TOKEN;
    try {
      return fs.readFileSync(this.tokenFile, "utf8").trim();
    } catch {
      if (!create) return null;
    }
    // The CLI's own credential to the local server. Kept 0600 in the data
    // directory, like any other local tool's credential file.
    const auth = new Auth(new Store(this.config.dataDir));
    let name = "cli";
    let n = 1;
    while (auth.listTokens().some((t) => t.name === name && !t.revoked_at)) name = `cli-${(n += 1)}`;
    const { token } = auth.createToken(name);
    fs.writeFileSync(this.tokenFile, `${token}\n`, { mode: 0o600 });
    return token;
  }

  async api(method, endpoint, body) {
    const token = this.cliToken({ create: true });
    const res = await fetch(this.base + endpoint, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    return data;
  }

  async health() {
    try {
      const res = await fetch(`${this.base}/api/health`, { signal: AbortSignal.timeout(1500) });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  }

  // ---- commands ----

  async serve() {
    const { createApp } = await import("./server.js");
    // No token is created here on purpose: a first foreground or container
    // run must print the bootstrap token, which only happens when none exist.
    const app = createApp(this.config);
    await app.start();
    const shutdown = () => app.stop().then(() => process.exit(0));
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return new Promise(() => {});
  }

  async start() {
    if (await this.health()) {
      this.io.out(`mAIndmeld is already running at ${this.base}`);
      return;
    }
    fs.mkdirSync(this.config.dataDir, { recursive: true, mode: 0o700 });
    this.cliToken({ create: true });
    const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "maindmeld.js");
    const log = fs.openSync(this.logFile, "a");
    const child = spawn(process.execPath, [entry, "serve"], {
      detached: true,
      stdio: ["ignore", log, log],
      env: {
        ...process.env,
        MAINDMELD_DATA_DIR: this.config.dataDir,
        MAINDMELD_BIND: this.config.bind,
        MAINDMELD_PORT: String(this.config.port),
      },
    });
    child.unref();
    fs.writeFileSync(this.pidFile, String(child.pid));
    for (let i = 0; i < 50; i += 1) {
      await sleep(100);
      if (await this.health()) {
        this.io.out(`mAIndmeld is running at ${this.base} (pid ${child.pid}, log ${this.logFile})`);
        return;
      }
    }
    throw new Error(`server did not become healthy; see ${this.logFile}`);
  }

  async stop() {
    let pid;
    try {
      pid = Number(fs.readFileSync(this.pidFile, "utf8").trim());
    } catch {
      this.io.out("no pid file; is the server running detached?");
      return;
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      this.io.out(`process ${pid} is not running`);
      fs.rmSync(this.pidFile, { force: true });
      return;
    }
    for (let i = 0; i < 50; i += 1) {
      await sleep(100);
      if (!(await this.health())) {
        fs.rmSync(this.pidFile, { force: true });
        this.io.out("mAIndmeld stopped");
        return;
      }
    }
    throw new Error(`process ${pid} did not stop`);
  }

  async status() {
    const h = await this.health();
    if (!h) {
      this.io.out(`mAIndmeld is not running at ${this.base}`);
      process.exitCode = 1;
      return;
    }
    const rooms = Object.entries(h.rooms).map(([k, v]) => `${v} ${k}`).join(", ") || "no rooms";
    this.io.out(`mAIndmeld ${h.version} at ${h.public_origin}, up ${h.uptime_s}s, ${rooms}`);
    this.io.out(`limits: ${h.limits.messages_per_minute} msg/min, ${h.limits.rooms_per_hour} rooms/h; ${h.events.subscribers} subscribers, ${h.events.waiters} waiting`);
  }

  async open(code) {
    const target = code ? `${this.base}/rooms/${code.toUpperCase()}` : `${this.base}/`;
    const opener = process.platform === "darwin" ? ["open", [target]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", target]] : ["xdg-open", [target]];
    spawn(opener[0], opener[1], { detached: true, stdio: "ignore" }).unref();
    this.io.out(target);
  }

  async rooms() {
    const { rooms } = await this.api("GET", "/api/rooms");
    if (!rooms.length) return this.io.out("no rooms");
    for (const r of rooms) {
      const who = r.participants.map((p) => `${p.name}[${p.kind[0]}]`).join(" ") || "-";
      this.io.out(`${r.code}  ${r.status.padEnd(9)} ${String(r.message_count).padStart(4)} msgs  ${r.title}  (${who})`);
    }
  }

  async say(code, text) {
    if (!code || !text) throw new Error('usage: maindmeld say CODE "text"');
    const c = code.toUpperCase();
    await this.api("POST", `/api/rooms/${c}/join`, { name: this.config.humanName, kind: "human", client: "cli" });
    const { message } = await this.api("POST", `/api/rooms/${c}/messages`, { sender: this.config.humanName, content: text });
    this.io.out(`#${message.id} ${message.sender}: ${message.content}`);
  }

  async invite(code, flags) {
    if (!code) throw new Error("usage: maindmeld invite CODE --model PROFILE [--name NAME] | --human [--reason TEXT]");
    const c = code.toUpperCase();
    if (flags.model) {
      const result = await this.api("POST", `/api/rooms/${c}/invite`, { kind: "model", profile: flags.model, name: flags.name });
      this.io.out(`${result.rejoined ? "already in" : "joined"} ${c}: ${result.participant.name} (${result.participant.profile})`);
    } else if (flags.human) {
      await this.api("POST", `/api/rooms/${c}/invite`, { kind: "human", reason: typeof flags.reason === "string" ? flags.reason : undefined });
      this.io.out(`${c} now needs a human`);
    } else {
      const result = await this.api("POST", `/api/rooms/${c}/invite`, { kind: "session", name: typeof flags.session === "string" ? flags.session : undefined });
      this.io.out(result.invitation);
    }
  }

  // ---- motions and human powers; the CLI acts as the configured human ----

  async asHuman(code) {
    await this.api("POST", `/api/rooms/${code}/join`, { name: this.config.humanName, kind: "human", client: "cli" });
    return this.config.humanName;
  }

  async motion(code, type, text) {
    if (!code || !type) throw new Error('usage: maindmeld motion CODE close|call_human ["reason or summary"] [--as NAME]');
    const c = code.toUpperCase();
    const body = { type, name: this.flags.as || this.config.humanName };
    if (type === "close") body.summary = text;
    else body.reason = text;
    const { motion, existing } = await this.api("POST", `/api/rooms/${c}/motions`, body);
    this.io.out(`${existing ? "already open" : "filed"}: motion #${motion.id} (${motion.type}) ${motion.status}; waiting on ${motion.tally.pending.join(", ") || "nobody"}`);
  }

  async vote(code, id, vote, reason) {
    if (!code || !id || !vote) throw new Error('usage: maindmeld vote CODE ID yes|no ["reason"] --as NAME');
    const { motion } = await this.api("POST", `/api/rooms/${code.toUpperCase()}/motions/${id}/vote`, { vote, reason, name: this.flags.as || this.config.humanName });
    this.io.out(`motion #${motion.id} is ${motion.status}; ${motion.tally.yes} yes, ${motion.tally.no} no, waiting on ${motion.tally.pending.join(", ") || "nobody"}`);
  }

  async override(code, id, outcome, reason) {
    if (!code || !id || !outcome) throw new Error('usage: maindmeld override CODE ID carry|cancel ["reason"]');
    const c = code.toUpperCase();
    const name = await this.asHuman(c);
    const { motion } = await this.api("POST", `/api/rooms/${c}/motions/${id}/override`, { outcome, reason, name });
    this.io.out(`motion #${motion.id} ${motion.status} (${motion.outcome.how})`);
  }

  async wait(code, flags) {
    if (!code) throw new Error("usage: maindmeld wait CODE [--for NAME|ingest] [--seconds N]");
    const c = code.toUpperCase();
    const name = await this.asHuman(c);
    const r = await this.api("POST", `/api/rooms/${c}/wait`, { name, for: typeof flags.for === "string" ? flags.for : undefined, seconds: flags.seconds });
    this.io.out(`waiting ${r.seconds}s${r.target ? ` for ${r.target}` : ""}`);
  }

  async hold(code, action) {
    if (!code || !["pause", "resume"].includes(action)) throw new Error("usage: maindmeld hold CODE pause|resume");
    const c = code.toUpperCase();
    const name = await this.asHuman(c);
    const r = await this.api("POST", `/api/rooms/${c}/hold`, { name, action });
    this.io.out(r.held ? `held by ${r.held.by}` : "resumed");
  }

  async human(code, action) {
    if (!code || !["acknowledge", "dismiss"].includes(action)) throw new Error("usage: maindmeld human CODE acknowledge|dismiss");
    const c = code.toUpperCase();
    const name = await this.asHuman(c);
    const r = await this.api("POST", `/api/rooms/${c}/human`, { name, action });
    this.io.out(r.human_required ? "acknowledged; the room still counts you as needed" : "dismissed; the room may close without a human");
  }

  async token(action, name) {
    const auth = new Auth(new Store(this.config.dataDir));
    if (action === "create") {
      const { token } = auth.createToken(name);
      this.io.out(`token "${name}": ${token}`);
      this.io.out("shown once; it is stored hashed.");
    } else if (action === "list") {
      const list = auth.listTokens();
      if (!list.length) return this.io.out("no tokens");
      for (const t of list) this.io.out(`${t.name.padEnd(20)} created ${t.created_at}${t.revoked_at ? `  revoked ${t.revoked_at}` : ""}`);
    } else if (action === "revoke") {
      this.io.out(`revoked ${auth.revokeToken(name)}`);
    } else throw new Error("usage: maindmeld token create NAME | list | revoke NAME");
  }

  async configShow() {
    this.io.out(JSON.stringify(describeConfig(this.config), null, 2));
  }
}

export async function run(argv = process.argv.slice(2)) {
  const { positional, flags } = parseArgs(argv);
  const [command, ...args] = positional;
  if (!command || command === "help" || flags.help) {
    console.log(USAGE);
    return;
  }
  const config = loadConfig({ dataDir: flags["data-dir"], port: flags.port, bind: flags.bind });
  const cli = new Cli(config);
  cli.flags = flags;
  const commands = {
    serve: () => cli.serve(),
    start: () => cli.start(),
    stop: () => cli.stop(),
    status: () => cli.status(),
    open: () => cli.open(args[0]),
    rooms: () => cli.rooms(),
    say: () => cli.say(args[0], args.slice(1).join(" ")),
    invite: () => cli.invite(args[0], flags),
    motion: () => cli.motion(args[0], args[1], args.slice(2).join(" ")),
    vote: () => cli.vote(args[0], args[1], args[2], args.slice(3).join(" ")),
    override: () => cli.override(args[0], args[1], args[2], args.slice(3).join(" ")),
    wait: () => cli.wait(args[0], flags),
    hold: () => cli.hold(args[0], args[1]),
    human: () => cli.human(args[0], args[1]),
    token: () => cli.token(args[0], args[1]),
    config: () => (args[0] === "show" ? cli.configShow() : Promise.reject(new Error("usage: maindmeld config show"))),
  };
  const fn = commands[command];
  if (!fn) {
    console.error(`unknown command: ${command}\n`);
    console.log(USAGE);
    process.exitCode = 2;
    return;
  }
  try {
    await fn();
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  }
}
