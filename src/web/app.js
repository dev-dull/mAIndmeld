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

// A card is not a link: it holds one (the title) and sometimes another (the
// note), and anchors cannot nest. Clicking the rest of the card still opens
// the room, through the delegated handler in initLobby.
function roomCard(r) {
  const people = r.participants.map((p) => `<span class="badge ${p.kind}">${esc(p.name)}</span>`).join(" ");
  // A note is the outcome of closing, so its link sits with the status badge:
  // "closed 📝" is one fact. The id means nothing to a person; it goes in the tooltip.
  const note = r.ingest?.note_id
    ? `<a class="note-link" href="/notes/${esc(r.ingest.note_id)}" title="Read the meeting note (${esc(r.ingest.note_id)})" aria-label="Read the meeting note">📝</a>`
    : "";
  const summary = !note && r.status === "closing" ? "<span>summarizing…</span>" : !note && r.ingest?.status === "pending" ? "<span>summary pending</span>" : "";
  return `<article class="room-card ${r.human_required && !r.human_present ? "needs" : ""}" data-href="/rooms/${r.code}">
    <div class="card-head"><a class="card-title" href="/rooms/${r.code}">${esc(r.title)}</a><span class="badge status ${r.status === "closing" ? "closing" : ""}">${esc(r.status)}</span>${note}</div>
    <div class="card-meta"><code>${r.code}</code><span>${r.message_count} message${r.message_count === 1 ? "" : "s"}</span><span>${ago(r.updated_at)}</span>${summary}</div>
    <div class="card-people">${people || '<span class="empty">nobody here</span>'}</div>
  </article>`;
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
    const body = meeting.markdown.replace(/^---[\s\S]*?---\n\n?/, "");
    if (window.renderMarkdown) $("#note").innerHTML = window.renderMarkdown(body);
    else $("#note").textContent = body;
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
  // Anywhere on a card opens the room, except an actual link inside it.
  document.addEventListener("click", (e) => {
    const card = e.target.closest(".room-card");
    if (!card || e.target.closest("a") || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey) window.open(card.dataset.href, "_blank");
    else location.href = card.dataset.href;
  });
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

// Inline image with its caption. The plain path is used, not the signed link
// a message may carry: the browser is signed in, and the link would expire.
function attachmentHtml(m) {
  if (!m.attachment) return "";
  const a = m.attachment;
  const code = location.pathname.split("/")[2];
  const src = `/api/rooms/${esc(code)}/attachments/${esc(a.id)}`;
  const alt = esc(a.caption || "image");
  return `<figure class="attachment"><a href="${src}" target="_blank" rel="noopener"><img src="${src}" alt="${alt}" loading="lazy"></a><figcaption>${esc(captionText(a))}</figcaption></figure>`;
}

// The image waiting in the composer, if any. Uploaded on send, not before,
// so a change of mind costs nothing and a failed upload leaves the text alone.
const pending = { file: null, previewUrl: null };

function setPendingImage(file) {
  if (pending.previewUrl) URL.revokeObjectURL(pending.previewUrl);
  pending.file = file || null;
  pending.previewUrl = file ? URL.createObjectURL(file) : null;
  const strip = $("#attach-strip");
  if (!strip) return;
  strip.classList.toggle("hidden", !file);
  if (file) {
    $("#attach-preview").src = pending.previewUrl;
    $("#attach-name").textContent = `${file.name || "pasted image"} · ${Math.round(file.size / 1024)} KB`;
    $("#attach-caption").focus();
  } else {
    $("#attach-preview").removeAttribute("src");
    $("#attach-caption").value = "";
    $("#attach-file").value = "";
  }
}

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

function pickImage(file) {
  if (!file) return;
  if (!IMAGE_TYPES.includes(file.type)) return toast("Only PNG, JPEG, WebP, and GIF images can be attached");
  setPendingImage(file);
}

async function uploadPending(code) {
  const res = await fetch(`/api/rooms/${code}/attachments`, { method: "POST", headers: { "content-type": pending.file.type }, body: pending.file, credentials: "same-origin" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `upload failed (${res.status})`);
  return data.attachment;
}

// A later change to a message already on screen; today that is only an automatic caption arriving.
function updateMessage(m) {
  const el = document.querySelector(`[data-message-id="${m.id}"] figcaption`);
  if (el && m.attachment) el.textContent = captionText(m.attachment);
}

const captionText = (a) => (a.caption_auto ? `${a.caption} · ${a.caption_auto}` : a.caption || "image");

// Wrap @mentions of actual participants in already-escaped prose. The server
// resolved them when the message was sent (m.mentions), so only real names match.
function mentionDecorator(m) {
  const names = m.mentions || [];
  if (!names.length) return null;
  // The prose is already escaped, so names are matched and keyed in their escaped form too.
  const kinds = new Map((state.room?.participants || []).map((p) => [esc(p.name).toLowerCase(), p.kind]));
  const me = state.me?.name ? esc(state.me.name).toLowerCase() : null;
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[^\\p{L}\\p{N}_])@(${names.map((n) => escapeRe(esc(n))).join("|")})(?=$|[^\\p{L}\\p{N}_])`, "giu");
  return (text) => text.replace(re, (all, before, name) => {
    const kind = kinds.get(name.toLowerCase()) || "agent";
    const mine = me && name.toLowerCase() === me ? " me" : "";
    return `${before}<span class="mention ${kind}${mine}" data-person="${name}" title="${kind}">@${name}</span>`;
  });
}

// The body as Markdown (models and agents write it, people paste it); plain escaped text if the renderer is missing.
function bodyHtml(m, decorate = mentionDecorator(m)) {
  if (window.renderMarkdown) return `<div class="md">${window.renderMarkdown(m.content, { decorate })}</div>`;
  const text = esc(m.content);
  return `<div class="text">${decorate ? decorate(text) : text}</div>`;
}

function renderMessage(m) {
  if (state.seen.has(m.id)) return;
  state.seen.add(m.id);
  const el = document.createElement("article");
  el.dataset.messageId = m.id;
  const me = state.me?.name?.toLowerCase();
  const mentionsMe = Boolean(me && (m.mentions || []).some((n) => n.toLowerCase() === me));
  if (m.kind === "system") {
    el.className = "msg system";
    el.innerHTML = `<div>${esc(m.content)}</div>`;
  } else if (m.kind === "summary") {
    el.className = "msg summary";
    el.innerHTML = `<div class="head"><span class="name">${esc(m.sender)}</span><span class="badge status">closed</span><span class="time">${timeOf(m.created_at)}</span></div><div class="body">${bodyHtml(m)}</div>`;
  } else {
    el.className = `msg ${m.kind}`;
    el.innerHTML = `<div class="avatar">${esc(m.sender.slice(0, 1).toUpperCase())}</div><div>
      <div class="head"><span class="name">${esc(m.sender)}</span><span class="badge ${m.kind}">${m.kind}</span><span class="time">${timeOf(m.created_at)}</span>${m.provisional ? '<span class="provisional">provisional</span>' : ""}</div>
      <div class="body">${bodyHtml(m)}${attachmentHtml(m)}</div></div>`;
  }
  if (mentionsMe) el.classList.add("mentions-me");
  for (const span of el.querySelectorAll(".mention[data-person]")) {
    span.addEventListener("click", () => {
      const row = [...document.querySelectorAll("#people .person")].find((p) => (p.dataset.person || "").toLowerCase() === span.dataset.person.toLowerCase());
      if (!row) return;
      row.scrollIntoView({ block: "nearest" });
      row.classList.add("flash");
      setTimeout(() => row.classList.remove("flash"), 1200);
    });
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
      const cls = v || (m.delivered_to[n] ? "pending" : "undelivered");
      const mark = v === "yes" ? "✓" : v === "no" ? "✗" : m.delivered_to[n] ? "…" : "·";
      const label = v ? `${n}: ${v}` : m.delivered_to[n] ? `${n}: waiting (${countdown(m.windows[n])})` : `${n}: not yet delivered`;
      return `<span class="voter ${cls}" title="${esc(label)}"><span class="mark" aria-hidden="true">${mark}</span>${esc(label)}</span>`;
    }).join("");
    const what = m.type === "close" ? "Close the meeting" : "Call a human";
    const text = m.type === "close" ? m.summary : m.reason;
    return `<div class="motion" data-id="${m.id}">
      <div class="head">#${m.id} ${what} · by ${esc(m.proposer)}</div>
      ${text ? `<div class="reason">${esc(text)}</div>` : ""}
      <div class="tally">${voters}</div>
      <div class="clock">${room.held ? "on hold" : `hard deadline in ${countdown(m.hard_deadline)}`}</div>
      <div class="buttons">
        <button data-act="carry" class="human-only">Carry now</button>
        <button data-act="cancel" class="danger human-only">${m.type === "close" ? "Veto" : "Cancel"}</button>
        <button data-act="wait" class="human-only">Wait 5 min</button>
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
  $("#objective-text").textContent = room.objective || "No objective set.";
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
  $("#human-box").classList.toggle("hidden", !(room.human_required && !closed));
  if (room.human_required && !closed && !state.briefFor) {
    state.briefFor = room.code;
    renderBrief(room.code);
  }

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
  $("#composer button[type=submit]").disabled = closed;
  $("#attach-file").disabled = closed;
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
        return `<div class="person" data-person="${esc(p.name)}"><span class="dot ${dot}"></span><span>${esc(p.name)}</span><span class="badge ${p.kind}">${p.kind}</span>${more}</div>`;
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
  renderLaunches(room);
  renderMotions(room);
}

// Typing @ in the composer lists the room's participants; the list follows the
// word under the caret, and Enter or Tab inserts the chosen name.
function initAutocomplete(textarea, participants) {
  const box = $("#autocomplete");
  const order = { human: 0, agent: 1, model: 2 };
  let items = [];
  let index = 0;
  let range = null; // [start, end] of the @word being completed
  const close = () => {
    box.classList.add("hidden");
    box.innerHTML = "";
    items = [];
    range = null;
  };
  const render = () => {
    box.innerHTML = items.map((p, i) => `<div class="option${i === index ? " active" : ""}" role="option" data-i="${i}"><span>@${esc(p.name)}</span><span class="badge ${p.kind}">${p.kind}</span></div>`).join("");
    box.classList.toggle("hidden", !items.length);
  };
  const insert = (p) => {
    if (!range) return;
    const v = textarea.value;
    const replacement = `@${p.name} `;
    textarea.value = v.slice(0, range[0]) + replacement + v.slice(range[1]);
    const caret = range[0] + replacement.length;
    textarea.setSelectionRange(caret, caret);
    close();
    textarea.focus();
  };
  const update = () => {
    const caret = textarea.selectionStart;
    const before = textarea.value.slice(0, caret);
    const m = before.match(/(^|[^\p{L}\p{N}_])@([\p{L}\p{N}_.-]*)$/u);
    if (!m) return close();
    const prefix = m[2].toLowerCase();
    const start = caret - m[2].length - 1;
    items = participants().filter((p) => p.name.toLowerCase().startsWith(prefix)).sort((a, b) => (order[a.kind] ?? 3) - (order[b.kind] ?? 3) || a.name.localeCompare(b.name)).slice(0, 8);
    if (!items.length) return close();
    range = [start, caret];
    index = Math.min(index, items.length - 1);
    render();
  };
  textarea.addEventListener("input", update);
  textarea.addEventListener("click", update);
  textarea.addEventListener("blur", () => setTimeout(close, 150));
  box.addEventListener("mousedown", (e) => {
    const opt = e.target.closest(".option");
    if (!opt) return;
    e.preventDefault();
    insert(items[Number(opt.dataset.i)]);
  });
  return {
    /** Returns true when the key was consumed by the list. */
    handleKey(e) {
      if (!items.length || box.classList.contains("hidden")) return false;
      if (e.key === "ArrowDown") { index = (index + 1) % items.length; render(); e.preventDefault(); return true; }
      if (e.key === "ArrowUp") { index = (index - 1 + items.length) % items.length; render(); e.preventDefault(); return true; }
      if (e.key === "Enter" || e.key === "Tab") { insert(items[index]); e.preventDefault(); return true; }
      if (e.key === "Escape") { close(); e.preventDefault(); return true; }
      return false;
    },
  };
}

// Harness launches in this room: one line per launch with its state; active ones first.
function renderLaunches(room) {
  const el = $("#launches");
  if (!el) return;
  const launches = Object.values(room.launches || {});
  if (!launches.length) return (el.innerHTML = "");
  const order = { started: 0, requested: 1, joined: 2, exited: 3, failed: 3, timed_out: 3, cancelled: 3 };
  launches.sort((a, b) => (order[a.state] ?? 3) - (order[b.state] ?? 3) || (a.requested_at < b.requested_at ? 1 : -1));
  const words = { requested: "requested", started: "starting", joined: "joined", exited: "exited", failed: "failed", timed_out: "timed out", cancelled: "cancelled" };
  el.innerHTML = launches.map((l) => {
    const detail = l.state === "failed" && l.reason ? `: ${esc(l.reason)}` : l.state === "exited" && l.exit_code !== null ? ` (code ${l.exit_code})` : l.runner && l.state !== "joined" ? ` on ${esc(l.runner)}` : "";
    return `<div class="launch" title="launch ${esc(l.id)}"><span class="state ${esc(l.state)}">${words[l.state] || esc(l.state)}</span><span>${esc(l.harness)}${detail}</span></div>`;
  }).join("");
}

// The harnesses online runners offer, for the Invite box. Refreshed on load and on launch events.
async function renderHarnesses(room) {
  const select = $("#harness-select");
  const btn = $("#harness-btn");
  if (!select) return;
  let runners = [];
  try {
    ({ runners } = await api("GET", "/api/runners"));
  } catch {
    runners = [];
  }
  const offers = [];
  for (const r of runners) if (r.online) for (const h of r.harnesses) offers.push({ harness: h, runner: r.name });
  const byHarness = new Map();
  for (const o of offers) byHarness.set(o.harness, [...(byHarness.get(o.harness) || []), o.runner]);
  const closed = room.status !== "open";
  const active = new Set(Object.values(room.launches || {}).filter((l) => ["requested", "started", "joined"].includes(l.state)).map((l) => l.harness));
  const current = select.value;
  select.disabled = closed;
  if (!byHarness.size) {
    select.innerHTML = '<option value="">No runner online</option>';
    btn.disabled = true;
    return;
  }
  select.innerHTML = [...byHarness.entries()].sort().map(([h, rs]) => `<option value="${esc(h)}"${active.has(h) ? " disabled" : ""}>${esc(h)}${rs.length > 1 ? ` (${rs.length} runners)` : ` (${esc(rs[0])})`}${active.has(h) ? " · in the room" : ""}</option>`).join("");
  if ([...byHarness.keys()].includes(current)) select.value = current;
  btn.disabled = closed || !select.value || active.has(select.value);
}

async function loadRoom(code) {
  const { room, invitation } = await api("GET", `/api/rooms/${code}`);
  state.room = room;
  state.invitation = invitation;
  renderRoomMeta(room);
  if (!state.harnessesLoaded) {
    state.harnessesLoaded = true;
    renderHarnesses(room).catch(() => {});
  }
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
  es.addEventListener("message", (e) => {
    const data = JSON.parse(e.data);
    if (data.action === "updated") return updateMessage(data.message);
    renderMessage(data.message);
  });
  es.addEventListener("participant", () => loadRoom(code).catch(() => {}));
  es.addEventListener("room", () => loadRoom(code).catch(() => {}));
  es.addEventListener("motion", () => loadRoom(code).catch(() => {}));
  es.addEventListener("launch", () => loadRoom(code).then(() => renderHarnesses(state.room)).catch(() => {}));
  setInterval(() => state.room && renderRoomMeta(state.room), 5_000);
  // Runners come and go without a room event; refresh the offer list now and then while the room is open.
  setInterval(() => state.room && state.room.status === "open" && renderHarnesses(state.room).catch(() => {}), 30_000);

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
    const caption = $("#attach-caption").value.trim();
    if (!content && !pending.file) return;
    if (pending.file && caption.length < 3) {
      $("#attach-caption").focus();
      return toast("Give the image a caption: what it shows and why it matters");
    }
    const btn = $("#composer button[type=submit]");
    btn.disabled = true;
    $(".attach-btn").classList.add("busy");
    try {
      await ensureJoined(code);
      const body = { content };
      if (pending.file) {
        const a = await uploadPending(code);
        body.attachment_id = a.id;
        body.caption = caption;
      }
      await api("POST", `/api/rooms/${code}/messages`, body);
      ta.value = "";
      setPendingImage(null);
    } catch (error) {
      toast(error.message); // text and image stay in the composer
    } finally {
      btn.disabled = false;
      $(".attach-btn").classList.remove("busy");
    }
  });
  $("#attach-file").addEventListener("change", (e) => pickImage(e.target.files[0]));
  $("#attach-remove").addEventListener("click", () => setPendingImage(null));
  $("#composer textarea").addEventListener("paste", (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.kind === "file" && IMAGE_TYPES.includes(i.type));
    if (!item) return;
    e.preventDefault();
    pickImage(item.getAsFile());
  });
  $("#attach-caption").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      $("#composer").requestSubmit();
    }
  });
  const ac = initAutocomplete($("#composer textarea"), () => state.room?.participants || []);
  $("#composer textarea").addEventListener("keydown", (e) => {
    if (ac.handleKey(e)) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $("#composer").requestSubmit();
    }
  });
  $("#join-btn").addEventListener("click", () => ensureJoined(code).catch((e) => toast(e.message)));
  $("#invite-harness").addEventListener("submit", async (e) => {
    e.preventDefault();
    const harness = $("#harness-select").value;
    if (!harness) return;
    try {
      await ensureJoined(code);
      const { launch, existing } = await api("POST", `/api/rooms/${code}/launches`, { harness });
      toast(existing ? `${harness} is already on its way` : `${harness} requested on runner ${launch.runner}`);
      await loadRoom(code);
      await renderHarnesses(state.room);
    } catch (error) {
      toast(error.message);
    }
  });
  $("#harness-select").addEventListener("change", () => renderHarnesses(state.room).catch(() => {}));
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

// ---------- sweeps ----------

async function renderSweeps() {
  const { sweeps, state } = await api("GET", "/api/kb/sweeps");
  $("#sweep-state").textContent = state.last_sweep_at ? `Last sweep ${ago(state.last_sweep_at)} (${state.last_sweep_id}).` : "No sweep has run yet.";
  const el = $("#sweeps");
  if (!sweeps.length) {
    el.innerHTML = '<div class="empty">No sweeps.</div>';
    return;
  }
  const reports = await Promise.all(sweeps.slice(0, 10).map((s) => api("GET", `/api/kb/sweeps/${s.id}`).then((r) => r.sweep)));
  el.innerHTML = reports.map((r) => `<section class="panel-box">
    <h3>${esc(r.id)} · ${ago(r.ran_at)} · ${r.topics_checked.length} topics · ${r.proposals.length} proposals</h3>
    ${r.proposals.length ? r.proposals.map((p, i) => `<div class="motion" data-sweep="${esc(r.id)}" data-n="${i + 1}">
      <div class="head">${i + 1}. ${p.type === "supersede" ? `Supersede ${esc(p.older)} with ${esc(p.newer)}` : `Merge topics ${esc(p.topics.join(" and "))}`} <span class="badge status">${esc(p.confidence || "topic")}</span></div>
      <div class="reason">${esc(p.reason)}${p.rule ? ` (rule ${esc(p.rule)})` : ""}</div>
      ${p.decision ? `<div class="clock">${esc(p.decision.action)} by ${esc(p.decision.by)} ${ago(p.decision.at)}</div>` : `<div class="buttons"><button data-act="apply">Apply</button><button data-act="reject" class="danger">Reject</button></div>`}
    </div>`).join("") : '<div class="empty">No proposals.</div>'}
  </section>`).join("");
  for (const btn of el.querySelectorAll("button[data-act]")) {
    btn.addEventListener("click", async () => {
      const box = btn.closest(".motion");
      try {
        await api("POST", `/api/kb/sweeps/${box.dataset.sweep}/proposals/${box.dataset.n}`, { action: btn.dataset.act });
        toast(btn.dataset.act === "apply" ? "Applied" : "Rejected");
        renderSweeps();
      } catch (error) {
        toast(error.message);
      }
    });
  }
}

function initSweeps() {
  whoAmI().catch(() => {});
  renderSweeps().catch((e) => toast(e.message));
  for (const [id, all] of [["#run-sweep", false], ["#run-sweep-all", true]]) {
    $(id).addEventListener("click", async () => {
      try {
        const { sweep } = await api("POST", "/api/kb/sweeps/run", { all });
        toast(`Sweep ${sweep.id}: ${sweep.proposals.length} proposals`);
        renderSweeps();
      } catch (error) {
        toast(error.message);
      }
    });
  }
}

async function renderBrief(code) {
  try {
    const b = await api("GET", `/api/rooms/${code}/brief`);
    const el = $("#brief");
    if (!el) return;
    el.innerHTML = [
      b.called ? `<div><strong>Why you were called:</strong> ${esc(b.called.reason || "no reason given")} <span class="badge status">${esc(b.called.how)}${b.called.by ? ` by ${esc(b.called.by)}` : ""}</span></div>` : "",
      `<div><strong>What is needed:</strong> ${esc(b.needed)}</div>`,
      b.provisional_messages ? `<div class="provisional">${b.provisional_messages} message${b.provisional_messages === 1 ? "" : "s"} decided things while you were away.</div>` : "",
      b.recent.length ? `<div class="reason">Recent: ${b.recent.map((m) => `${esc(m.sender)}: ${esc(m.content.slice(0, 140))}`).join(" · ")}</div>` : "",
    ].join("");
  } catch {
    // The brief is a convenience; the transcript is still there.
  }
}

const page = document.body.dataset.page;
if (page === "login") initLogin();
if (page === "lobby") initLobby();
if (page === "room") initRoom();
if (page === "note") initNote();
if (page === "sweeps") initSweeps();
