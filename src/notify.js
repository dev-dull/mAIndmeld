// Notifiers: tell a person that a room needs them. Fired when a call-a-human
// motion carries or a human is invited. Pluggable, several may be active,
// failures are logged and never block. DESIGN.md 8.3.

import crypto from "node:crypto";
import { execFile } from "node:child_process";

const TIMEOUT_MS = 5000;

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

function desktop(title, text) {
  return new Promise((resolve, reject) => {
    const done = (err) => (err ? reject(err) : resolve());
    if (process.platform === "darwin") {
      const esc = (s) => String(s).replace(/["\\]/g, "\\$&");
      execFile("osascript", ["-e", `display notification "${esc(text)}" with title "${esc(title)}"`], done);
    } else if (process.platform === "linux") {
      execFile("notify-send", [title, text], done);
    } else {
      reject(new Error(`no desktop notifier on ${process.platform}`));
    }
  });
}

export function createNotifier(config, log) {
  const targets = config.notifiers || [];

  async function deliver(target, payload) {
    const title = `mAIndmeld: ${payload.room.title}`;
    const text = `${payload.reason ? `${payload.reason} ` : ""}(${payload.room.code})`;
    switch (target.type) {
      case "webhook": {
        const body = JSON.stringify(payload);
        const headers = {};
        if (target.secret) headers["x-maindmeld-signature"] = crypto.createHmac("sha256", target.secret).update(body).digest("hex");
        await postJson(target.url, payload, headers);
        return;
      }
      case "ntfy": {
        const base = (target.url || "https://ntfy.sh").replace(/\/$/, "");
        const res = await fetch(`${base}/${target.topic}`, {
          method: "POST",
          headers: {
            title,
            click: payload.room.url,
            priority: "high",
            tags: "raising_hand",
            ...(target.token ? { authorization: `Bearer ${target.token}` } : {}),
          },
          body: text,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return;
      }
      case "desktop":
        if (!config.loopback) throw new Error("desktop notifier only runs in local mode");
        await desktop(title, text);
        return;
      default:
        throw new Error(`unknown notifier type ${target.type}`);
    }
  }

  return {
    targets: targets.map((t) => t.type),
    /** A room needs a person. `why` is human_called or invited. */
    async humanNeeded(room, reason, why = "human_called") {
      const payload = {
        event: why,
        at: new Date().toISOString(),
        reason: reason || null,
        room: { code: room.code, title: room.title, objective: room.objective, url: `${config.publicOrigin}/rooms/${room.code}` },
        brief_url: `${config.publicOrigin}/api/rooms/${room.code}/brief`,
      };
      await Promise.all(targets.map(async (t) => {
        try {
          await deliver(t, payload);
        } catch (error) {
          log(`notifier ${t.type} failed for ${room.code}: ${error.message}`);
        }
      }));
      return payload;
    },
  };
}
