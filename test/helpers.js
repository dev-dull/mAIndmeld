import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/config.js";
import { createApp } from "../src/server.js";

process.env.MAINDMELD_QUIET = "1";

export function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "maindmeld-test-"));
}

/** Boot a server on an ephemeral port with its own data directory. */
export async function boot({ limits, extra, env } = {}) {
  const dataDir = tmpDataDir();
  // Tests open many rooms as one agent; the per-creator cap is tested where it matters.
  const mergedLimits = { rooms_open_per_creator: 100, ...(limits || {}) };
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ ...(extra || {}), limits: mergedLimits }));
  const config = loadConfig({ dataDir, port: 0 }, { USER: "tester", ...(env || {}) });
  const app = createApp(config);
  const { token } = app.auth.createToken("test");
  await app.start();
  const base = config.publicOrigin;

  async function req(method, endpoint, { body, token: t = token, cookie, origin, raw } = {}) {
    const headers = {};
    if (t) headers.authorization = `Bearer ${t}`;
    if (cookie) headers.cookie = cookie;
    if (origin) headers.origin = origin;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(base + endpoint, { method, headers, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data, headers: res.headers };
  }

  async function close() {
    await app.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  return { app, config, base, token, dataDir, req, close };
}
