// Fan-out for room changes: long-poll waiters wake, SSE subscribers get an
// event, and the lobby stream hears about every room. In-memory by design;
// the single process is the only writer (DESIGN.md 3.1).

const HEARTBEAT_MS = 25_000;

export class RoomEvents {
  constructor() {
    this.waiters = new Map(); // code -> Set<resolve>
    this.subscribers = new Map(); // code -> Set<res>
    this.lobby = new Set(); // Set<res>
  }

  /** Resolve after a change to the room or after `seconds`, whichever first. */
  waitForChange(code, seconds) {
    return new Promise((resolve) => {
      const set = this.waiters.get(code) || new Set();
      const done = () => {
        clearTimeout(timer);
        set.delete(done);
        if (set.size === 0) this.waiters.delete(code);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, seconds) * 1000);
      set.add(done);
      this.waiters.set(code, set);
    });
  }

  /** Announce a change. `event` is { type, ...payload } and goes to SSE. */
  notify(code, event) {
    for (const resolve of [...(this.waiters.get(code) || [])]) resolve();
    const payload = `event: ${event.type}\ndata: ${JSON.stringify({ code, ...event })}\n\n`;
    for (const res of this.subscribers.get(code) || []) this.write(res, payload);
    for (const res of this.lobby) this.write(res, payload);
  }

  write(res, payload) {
    try {
      res.write(payload);
    } catch {
      // A dead socket is removed by its close handler.
    }
  }

  /** Attach an HTTP response as an SSE subscriber. `code` null means lobby. */
  subscribe(code, res) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(`: connected\n\n`);
    const set = code ? this.subscribers.get(code) || new Set() : this.lobby;
    set.add(res);
    if (code) this.subscribers.set(code, set);
    const heartbeat = setInterval(() => this.write(res, `: ping\n\n`), HEARTBEAT_MS);
    const cleanup = () => {
      clearInterval(heartbeat);
      set.delete(res);
      if (code && set.size === 0) this.subscribers.delete(code);
    };
    res.on("close", cleanup);
    res.on("error", cleanup);
  }

  counts() {
    let subscribers = 0;
    for (const set of this.subscribers.values()) subscribers += set.size;
    let waiters = 0;
    for (const set of this.waiters.values()) waiters += set.size;
    return { waiters, subscribers, lobby: this.lobby.size };
  }
}
