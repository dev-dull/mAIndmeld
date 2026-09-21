// Shared browser code for the lobby, room, and login pages. Vanilla, no build.

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const timeOf = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const ago = (iso) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};

function toast(text) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 2200);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  if (res.status === 401 && !location.pathname.startsWith("/login")) {
    location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
    throw new Error("sign in required");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function whoAmI() {
  const me = await api("GET", "/api/session");
  const who = $("#who");
  if (who) who.innerHTML = `${esc(me.name)} <button id="signout" class="small">Sign out</button>`;
  $("#signout")?.addEventListener("click", async () => {
    await api("DELETE", "/api/session");
    location.href = "/login";
  });
  return me;
}

// ---------- login ----------

function initLogin() {
  const form = $("#login-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    $("#login-error").textContent = "";
    try {
      await api("POST", "/api/session", { token: $("#token").value.trim(), name: $("#name").value.trim() || undefined });
      const next = new URLSearchParams(location.search).get("next") || "/";
      location.href = next.startsWith("/") ? next : "/";
    } catch (error) {
      $("#login-error").textContent = error.message;
    }
  });
}

// ---------- lobby ----------

function roomCard(r) {
  const people = r.participants.map((p) => `<span class="badge ${p.kind}">${esc(p.name)}</span>`).join(" ");
  const note = r.ingest?.note_id ? `<a href="/notes/${esc(r.ingest.note_id)}">note ${esc(r.ingest.note_id)}</a>` : r.status === "closing" ? "summarizing…" : r.ingest?.status === "pending" ? "summary pending" : "";
  return `<a class="room-card ${r.human_required && !r.human_present ? "needs" : ""}" href="/rooms/${r.code}">
    <div class="title">${esc(r.title)} <span class="badge status ${r.status === "closing" ? "closing" : ""}">${esc(r.status)}</span></div>
    <div class="meta"><span>${r.code}</span><span>${r.message_count} messages</span><span>${ago(r.updated_at)}</span>${note ? `<span>${note}</span>` : ""}</div>
    <div class="meta">${people || '<span class="empty">nobody here</span>'}</div>
  </a>`;
}

function initNote() {
  whoAmI().catch(() => {});
  const id = location.pathname.split("/")[2];
  api("GET", `/api/kb/meetings/${id}`).then(({ meeting }) => {
    document.title = `${meeting.title} · mAIndmeld`;
    $("#note-title").textContent = meeting.title;
    $("#note-meta").innerHTML = [
      `<span>${esc(meeting.date)}</span>`,
      `<span><a href="/rooms/${esc(meeting.room)}">room ${esc(meeting.room)}</a></span>`,
      `<span>${(meeting.decisions || []).length} decisions</span>`,
      `<span>${(meeting.topics || []).map((t) => `<span class="badge status">${esc(t)}</span>`).join(" ")}</span>`,
    ].join("");
    $("#note").textContent = meeting.markdown.replace(/^---[\s\S]*?---\n\n?/, "");
  }).catch((e) => { $("#note").textContent = e.message; });
}

async function renderLobby() {
  const { rooms } = await api("GET", "/api/rooms");
  const groups = {
    needs: rooms.filter((r) => r.status === "open" && r.human_required && !r.human_present),
    open: rooms.filter((r) => r.status === "open" && !(r.human_required && !r.human_present)),
    closed: rooms.filter((r) => r.status === "closed" || r.status === "closing").slice(0, 30),
    abandoned: rooms.filter((r) => r.status === "abandoned"),
  };
  for (const [key, list] of Object.entries(groups)) {
    const el = $(`#rooms-${key}`);
    if (!el) continue;
    el.innerHTML = list.length ? list.map(roomCard).join("") : `<div class="empty">${key === "needs" ? "No room is waiting on you." : "None."}</div>`;
  }
}

function initLobby() {
  whoAmI().catch(() => {});
  renderLobby().catch((e) => toast(e.message));
  const es = new EventSource("/api/events");
  let pending = null;
  es.onmessage = es.onerror = null;
  for (const type of ["room", "message", "participant", "motion"]) {
    es.addEventListener(type, () => {
      clearTimeout(pending);
      pending = setTimeout(() => renderLobby().catch(() => {}), 250);
    });
  }
  // A person is being called: say so even when the tab is in the background.
  if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
  es.addEventListener("message", (e) => {
    const { code, message } = JSON.parse(e.data);
    if (message?.data?.action !== "human_called") return;
    if ("Notification" in window && Notification.permission === "granted") {
      const n = new Notification("mAIndmeld: a room needs you", { body: `${code}: ${message.data.reason || message.content}` });
      n.onclick = () => window.open(`/rooms/${code}`, "_blank");
    }
    toast(`Room ${code} needs a human`);
  });
  $("#create-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const { room } = await api("POST", "/api/rooms", { title: $("#new-title").value, objective: $("#new-objective").value });
      location.href = `/rooms/${room.code}`;
    } catch (error) {
      toast(error.message);
    }
  });
}

// ---------- room ----------

const state = { room: null, me: null, seen: new Set() };

function renderMessage(m) {
  if (state.seen.has(m.id)) return;
  state.seen.add(m.id);
  const el = document.createElement("article");
  if (m.kind === "system") {
    el.className = "msg system";
    el.innerHTML = `<div>${esc(m.content)}</div>`;
  } else if (m.kind === "summary") {
    el.className = "msg summary";
    el.innerHTML = `<div class="head"><span class="name">${esc(m.sender)}</span><span class="badge status">closed</span><span class="time">${timeOf(m.created_at)}</span></div><div class="body">${esc(m.content)}</div>`;
  } else {
    el.className = `msg ${m.kind}`;
    el.innerHTML = `<div class="avatar">${esc(m.sender.slice(0, 1).toUpperCase())}</div><div>
      <div class="head"><span class="name">${esc(m.sender)}</span><span class="badge ${m.kind}">${m.kind}</span><span class="time">${timeOf(m.created_at)}</span>${m.provisional ? '<span class="provisional">provisional</span>' : ""}</div>
      <div class="body">${esc(m.content)}</div></div>`;
  }
  const t = $("#transcript");
  const atBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 40;
  t.appendChild(el);
  if (atBottom) t.scrollTop = t.scrollHeight;
}

const countdown = (iso) => {
  const s = Math.round((Date.parse(iso) - Date.now()) / 1000);
  if (s <= 0) return "now";
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

function renderMotions(room) {
  const open = (room.motions || []).filter((m) => m.status === "open");
  const el = $("#motions");
  if (!open.length) {
    el.innerHTML = '<div class="empty">None open.</div>';
    return;
  }
  el.innerHTML = open.map((m) => {
    const voters = m.eligible.map((n) => {
      const v = m.votes[n];
      const cls = v || (m.delivered_to[n] ? "pending" : "");
      const label = v ? `${n}: ${v}` : m.delivered_to[n] ? `${n}: waiting (${countdown(m.windows[n])})` : `${n}: not yet delivered`;
      return `<span class="voter ${cls}">${esc(label)}</span>`;
    }).join("");
    const what = m.type === "close" ? "Close the meeting" : "Call a human";
    const text = m.type === "close" ? m.summary : m.reason;
    return `<div class="motion" data-id="${m.id}">
      <div class="head">#${m.id} ${what} · by ${esc(m.proposer)}</div>
      ${text ? `<div class="reason">${esc(text)}</div>` : ""}
      <div class="tally">${voters}</div>
      <div class="clock">${room.held ? "on hold" : `hard deadline in ${countdown(m.hard_deadline)}`}</div>
      <div class="buttons">
        <button data-act="carry">Carry now</button>
        <button data-act="cancel" class="danger">${m.type === "close" ? "Veto" : "Cancel"}</button>
        <button data-act="wait">Wait 5 min</button>
      </div>
    </div>`;
  }).join("");
  for (const btn of el.querySelectorAll("button[data-act]")) {
    btn.addEventListener("click", async () => {
      const id = btn.closest(".motion").dataset.id;
      const act = btn.dataset.act;
      try {
        if (act === "wait") await api("POST", `/api/rooms/${room.code}/wait`, { seconds: 300 });
        else await api("POST", `/api/rooms/${room.code}/motions/${id}/override`, { outcome: act });
        toast(act === "wait" ? "Waiting 5 more minutes" : act === "carry" ? "Carried" : "Cancelled");
      } catch (error) {
        toast(error.message);
      }
    });
  }
}

function renderRoomMeta(room) {
  document.title = `${room.title} · mAIndmeld`;
  $("#room-title").textContent = room.title;
  $("#room-code").textContent = room.code;
  $("#room-status").textContent = room.status;
  $("#objective").textContent = room.objective || "No objective set.";
  $("#objective").classList.toggle("hidden", !room.objective);
  const closed = room.status !== "open";
  const inRoom = room.participants.some((p) => p.name.toLowerCase() === state.me?.name.toLowerCase());

  const banner = $("#banner");
  if (room.human_required && !room.human_present) {
    banner.textContent = "The agents voted that they need a person here. Join to be counted as present; then acknowledge or dismiss.";
    banner.classList.remove("hidden");
  } else if (room.human_required && room.human_present && !room.human_acknowledged_at) {
    banner.textContent = "A human was called and you are here. Acknowledge to say so, or dismiss if the agents can carry on alone.";
    banner.classList.remove("hidden");
  } else banner.classList.add("hidden");
  $("#human-box").classList.toggle("hidden", !(room.human_required && inRoom && !closed));

  const held = $("#held-banner");
  if (room.held) {
    held.textContent = `On hold by ${room.held.by} since ${timeOf(room.held.since)}. No motion resolves until resumed.`;
    held.classList.remove("hidden");
  } else held.classList.add("hidden");

  const ingest = $("#ingest-box");
  if (room.status === "closing" || (room.status === "closed" && room.ingest && room.ingest.status !== "skipped")) {
    ingest.classList.remove("hidden");
    const i = room.ingest || {};
    const state = room.status === "closing" ? `Summarizing… (attempt ${i.attempts || 0}${i.last_error ? `, last error: ${i.last_error}` : ""})` : i.status === "done" ? `Summary written.` : `Summary ${i.status}${i.last_error ? `: ${i.last_error}` : ""}`;
    $("#ingest-state").textContent = state;
    $("#note-link").classList.toggle("hidden", !i.note_id);
    if (i.note_id) $("#note-link").href = `/notes/${i.note_id}`;
    $("#ingest-retry").classList.toggle("hidden", i.status === "done" || i.status === "running");
    $("#ingest-skip").classList.toggle("hidden", room.status !== "closing");
  } else ingest.classList.add("hidden");
  $("#hold-btn").classList.toggle("on", Boolean(room.held));
  $("#hold-btn").textContent = room.held ? "Resume the room" : "Hold the room";
  $("#hold-btn").disabled = closed;

  $("#composer textarea").disabled = closed;
  $("#composer button").disabled = closed;
  $("#close-btn").disabled = closed;
  $("#mode-btn").classList.toggle("on", room.response_mode === "addressed_only");
  $("#mode-btn").textContent = room.response_mode === "addressed_only" ? "Only when addressed: on" : "Only when addressed: off";
  const now = Date.now();
  const motionOpen = (room.motions || []).some((m) => m.status === "open");
  $("#people").innerHTML = room.participants.length
    ? room.participants.map((p) => {
        const age = now - Date.parse(p.last_seen_at);
        const dot = age < 90_000 ? "live" : age < 600_000 ? "idle" : "";
        const more = motionOpen && p.kind !== "human" ? `<button class="small" data-more="${esc(p.name)}">give time</button>` : "";
        return `<div class="person"><span class="dot ${dot}"></span><span>${esc(p.name)}</span><span class="badge ${p.kind}">${p.kind}</span>${more}</div>`;
      }).join("")
    : '<div class="empty">Nobody here.</div>';
  for (const btn of $("#people").querySelectorAll("button[data-more]")) {
    btn.addEventListener("click", async () => {
      try {
        await api("POST", `/api/rooms/${room.code}/wait`, { for: btn.dataset.more, seconds: 300 });
        toast(`Gave ${btn.dataset.more} 5 more minutes`);
      } catch (error) {
        toast(error.message);
      }
    });
  }
  $("#join-btn").classList.toggle("hidden", inRoom || closed);
  $("#leave-btn").classList.toggle("hidden", !inRoom || closed);
  renderMotions(room);
}

async function loadRoom(code) {
  const { room, invitation } = await api("GET", `/api/rooms/${code}`);
  state.room = room;
  state.invitation = invitation;
  renderRoomMeta(room);
  for (const m of room.messages) renderMessage(m);
  $("#transcript").scrollTop = $("#transcript").scrollHeight;
}

async function ensureJoined(code) {
  const inRoom = state.room.participants.some((p) => p.name.toLowerCase() === state.me.name.toLowerCase());
  if (!inRoom) await api("POST", `/api/rooms/${code}/join`, { kind: "human" });
}

function initRoom() {
  const code = location.pathname.split("/")[2];
  (async () => {
    state.me = await whoAmI();
    await loadRoom(code);
  })().catch((e) => toast(e.message));

  const es = new EventSource(`/api/rooms/${code}/events`);
  es.addEventListener("message", (e) => renderMessage(JSON.parse(e.data).message));
  es.addEventListener("participant", () => loadRoom(code).catch(() => {}));
  es.addEventListener("room", () => loadRoom(code).catch(() => {}));
  es.addEventListener("motion", () => loadRoom(code).catch(() => {}));
  setInterval(() => state.room && renderRoomMeta(state.room), 5_000);

  $("#hold-btn").addEventListener("click", async () => {
    try {
      await ensureJoined(code);
      await api("POST", `/api/rooms/${code}/hold`, { action: state.room.held ? "resume" : "pause" });
    } catch (error) {
      toast(error.message);
    }
  });
  $("#ingest-retry").addEventListener("click", () => api("POST", `/api/rooms/${code}/ingest`, { force: true }).then(() => toast("Summary requested")).catch((e) => toast(e.message)));
  $("#ingest-skip").addEventListener("click", () => api("POST", `/api/rooms/${code}/ingest`, { action: "skip" }).then(() => toast("Closed without a note")).catch((e) => toast(e.message)));
  $("#ack-btn").addEventListener("click", () => api("POST", `/api/rooms/${code}/human`, { action: "acknowledge" }).then(() => toast("Acknowledged")).catch((e) => toast(e.message)));
  $("#dismiss-btn").addEventListener("click", () => api("POST", `/api/rooms/${code}/human`, { action: "dismiss" }).then(() => toast("Dismissed the call")).catch((e) => toast(e.message)));

  $("#composer").addEventListener("submit", async (e) => {
    e.preventDefault();
    const ta = $("#composer textarea");
    const content = ta.value.trim();
    if (!content) return;
    try {
      await ensureJoined(code);
      await api("POST", `/api/rooms/${code}/messages`, { content });
      ta.value = "";
    } catch (error) {
      toast(error.message);
    }
  });
  $("#composer textarea").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $("#composer").requestSubmit();
    }
  });
  $("#join-btn").addEventListener("click", () => ensureJoined(code).catch((e) => toast(e.message)));
  $("#leave-btn").addEventListener("click", () => api("POST", `/api/rooms/${code}/leave`, {}).catch((e) => toast(e.message)));
  $("#mode-btn").addEventListener("click", async () => {
    const next = state.room.response_mode === "addressed_only" ? "open" : "addressed_only";
    try {
      await api("POST", `/api/rooms/${code}/mode`, { response_mode: next });
    } catch (error) {
      toast(error.message);
    }
  });
  $("#invite-btn").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(state.invitation || "");
      toast("Invitation copied");
    } catch {
      toast("Could not copy; see the room code above");
    }
  });
  $("#close-btn").addEventListener("click", async () => {
    const summary = $("#close-summary").value.trim();
    try {
      await api("POST", `/api/rooms/${code}/close`, { summary: summary || undefined });
      toast("Room closed");
    } catch (error) {
      toast(error.message);
    }
  });
}

const page = document.body.dataset.page;
if (page === "login") initLogin();
if (page === "lobby") initLobby();
if (page === "room") initRoom();
if (page === "note") initNote();
