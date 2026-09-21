// The knowledge store: plain files under <data>/kb, designed for retrieval.
// Meetings are markdown with front matter and fixed headings; decisions are
// the retrieval unit, one small file each plus a JSON Lines mirror; the
// topic vocabulary is a fixed YAML subset; INDEX.md is regenerated after
// every write. DESIGN.md 11, 12, and decision 1.

import fs from "node:fs";
import path from "node:path";

export const CONFIDENCE = new Set(["unanimous", "majority", "chair"]);
export const DECISION_STATUSES = new Set(["active", "superseded", "retired", "retired_by_resummarize"]);

const pad = (n, w = 2) => String(n).padStart(w, "0");

export function meetingIdFor(room) {
  const d = new Date(room.closed_at || room.created_at);
  const ymd = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  return `M${ymd}-${room.code.replace(/^MM-/, "")}`;
}

export function slugify(text) {
  return String(text).toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_-]+/g, "-").slice(0, 60) || "meeting";
}

export function topicSlug(name) {
  return String(name).toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s-]/g, "").trim().replace(/[\s-]+/g, "-").slice(0, 60);
}

// ---- a deliberately small YAML subset for topics.yaml ----

function yamlScalar(s) {
  const v = String(s ?? "");
  return /^[A-Za-z0-9 _.,:/()'-]*$/.test(v) && !/^\s|\s$|^$/.test(v) && !/^[-?:,[\]{}#&*!|>'"%@`]/.test(v) ? v : JSON.stringify(v);
}

export function topicsToYaml(topics) {
  const lines = ["# mAIndmeld topic vocabulary. Written by ingest and the sweep; edit with care.", "topics:"];
  for (const t of topics) {
    lines.push(`  - name: ${yamlScalar(t.name)}`);
    lines.push(`    description: ${yamlScalar(t.description || "")}`);
    lines.push(`    aliases: [${(t.aliases || []).map(yamlScalar).join(", ")}]`);
    lines.push(`    created: ${yamlScalar(t.created)}`);
  }
  return `${lines.join("\n")}\n`;
}

function parseScalar(raw) {
  const v = raw.trim();
  if (v.startsWith('"')) return JSON.parse(v);
  return v;
}

export function topicsFromYaml(text) {
  const topics = [];
  let current = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line || line.startsWith("#") || line === "topics:") continue;
    let m;
    if ((m = /^  - name: (.*)$/.exec(line))) {
      current = { name: parseScalar(m[1]), description: "", aliases: [], created: null };
      topics.push(current);
    } else if (current && (m = /^    description: (.*)$/.exec(line))) current.description = parseScalar(m[1]);
    else if (current && (m = /^    aliases: \[(.*)\]$/.exec(line))) {
      current.aliases = m[1].trim() ? m[1].split(",").map((s) => parseScalar(s)) : [];
    } else if (current && (m = /^    created: (.*)$/.exec(line))) current.created = parseScalar(m[1]);
    else throw new Error(`topics.yaml: unexpected line: ${line}`);
  }
  return topics;
}

// ---- front matter (a similarly small subset) ----

function frontMatter(obj) {
  const lines = ["---"];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) lines.push(`${k}: null`);
    else if (Array.isArray(v)) lines.push(`${k}: [${v.map(yamlScalar).join(", ")}]`);
    else if (typeof v === "object") lines.push(`${k}: ${JSON.stringify(v)}`);
    else if (typeof v === "boolean" || typeof v === "number") lines.push(`${k}: ${v}`);
    else lines.push(`${k}: ${yamlScalar(v)}`);
  }
  lines.push("---");
  return lines.join("\n");
}

export class KnowledgeStore {
  constructor(dir) {
    this.dir = dir;
    for (const d of ["meetings", "decisions", "transcripts", "sweeps"]) fs.mkdirSync(path.join(dir, d), { recursive: true, mode: 0o700 });
    this.topicsFile = path.join(dir, "topics.yaml");
    this.decisionsFile = path.join(dir, "decisions.jsonl");
    this.indexFile = path.join(dir, "INDEX.md");
  }

  // ---- topics ----

  topics() {
    if (!fs.existsSync(this.topicsFile)) return [];
    return topicsFromYaml(fs.readFileSync(this.topicsFile, "utf8"));
  }

  saveTopics(topics) {
    this.writeAtomic(this.topicsFile, topicsToYaml(topics));
  }

  addTopics(newTopics, createdAt) {
    const topics = this.topics();
    const known = new Set(topics.flatMap((t) => [t.name, ...(t.aliases || [])]).map(topicSlug));
    const added = [];
    for (const nt of newTopics || []) {
      const name = topicSlug(nt.name);
      if (!name || known.has(name)) continue;
      topics.push({ name, description: String(nt.reason || nt.description || "").slice(0, 200), aliases: [], created: createdAt });
      known.add(name);
      added.push(name);
    }
    if (added.length) this.saveTopics(topics);
    return added;
  }

  // ---- decisions ----

  decisions() {
    if (!fs.existsSync(this.decisionsFile)) return [];
    return fs.readFileSync(this.decisionsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

  saveDecisions(list) {
    this.writeAtomic(this.decisionsFile, list.map((d) => JSON.stringify(d)).join("\n") + (list.length ? "\n" : ""));
    for (const d of list) this.writeDecisionFile(d);
  }

  writeDecisionFile(d) {
    const fm = frontMatter({
      id: d.id,
      topic: d.topic,
      status: d.status,
      date: d.date,
      meeting: d.meeting,
      confidence: d.confidence,
      provisional: d.provisional,
      supersedes: d.supersedes || [],
      superseded_by: d.superseded_by || null,
      replaced_by: d.replaced_by || null,
      reviewed_by: d.reviewed_by || null,
    });
    const body = `${fm}\n${d.statement}\n\n${d.rationale ? `Rationale: ${d.rationale}\n` : ""}`;
    this.writeAtomic(path.join(this.dir, "decisions", `${d.id}.md`), body);
  }

  // ---- meetings ----

  meetingPath(meetingId, room) {
    const date = (room.closed_at || room.created_at).slice(0, 10);
    const year = date.slice(0, 4);
    return path.join(this.dir, "meetings", year, `${date}-${room.code}-${slugify(room.title)}.md`);
  }

  listMeetings() {
    const out = [];
    const root = path.join(this.dir, "meetings");
    for (const year of fs.existsSync(root) ? fs.readdirSync(root) : []) {
      const dir = path.join(root, year);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".md")) continue;
        const text = fs.readFileSync(path.join(dir, f), "utf8");
        const meta = parseFrontMatter(text);
        out.push({ ...meta, file: path.join("meetings", year, f) });
      }
    }
    return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }

  readMeeting(meetingId) {
    const m = this.listMeetings().find((x) => x.id === meetingId);
    if (!m) return null;
    return { ...m, markdown: fs.readFileSync(path.join(this.dir, m.file), "utf8") };
  }

  /**
   * Write everything for one ingested meeting. `note` is a validated note.
   * Returns { meetingId, decisionIds, superseded, topicsAdded, notePath }.
   */
  writeNote(room, note, { adapter, model, resummarize = false, warnings = [] } = {}) {
    const meetingId = meetingIdFor(room);
    const date = (room.closed_at || room.created_at).slice(0, 10);
    const stamp = new Date().toISOString();

    // Raw transcript first; it is never modified afterwards.
    const transcriptPath = path.join(this.dir, "transcripts", `${room.code}.json`);
    if (!fs.existsSync(transcriptPath)) this.writeAtomic(transcriptPath, JSON.stringify(room, null, 2));

    const topicsAdded = this.addTopics(note.new_topics, date);
    let all = this.decisions();

    // Resummarize: retire this meeting's previous decisions, keep numbering.
    let next = 1;
    const previous = all.filter((d) => d.meeting === meetingId);
    if (previous.length) {
      next = Math.max(...previous.map((d) => Number(d.id.split("-").at(-1)))) + 1;
      if (!resummarize) throw new Error(`${meetingId} already has decisions; use resummarize`);
    }

    const created = [];
    for (const d of note.decisions || []) {
      const id = `${meetingId.replace(/^M/, "D-M")}-${pad(next)}`;
      next += 1;
      created.push({
        id,
        meeting: meetingId,
        room: room.code,
        date,
        topic: topicSlug(d.topic),
        status: "active",
        statement: d.statement.trim(),
        rationale: (d.rationale || "").trim(),
        confidence: d.confidence,
        provisional: Boolean(d.provisional),
        supersedes: d.supersedes || [],
        superseded_by: null,
        replaced_by: null,
        reviewed_by: null,
        created_at: stamp,
      });
    }
    if (previous.length) {
      for (const p of previous) {
        if (p.status === "active" || p.status === "superseded") {
          p.status = "retired_by_resummarize";
          p.replaced_by = created.map((c) => c.id);
          p.updated_at = stamp;
        }
      }
    }
    // Close-time supersession (DESIGN.md 12).
    const superseded = [];
    for (const c of created) {
      for (const oldId of c.supersedes) {
        const old = all.find((d) => d.id === oldId);
        if (old && old.status === "active") {
          old.status = "superseded";
          old.superseded_by = c.id;
          old.updated_at = stamp;
          superseded.push(oldId);
        }
      }
    }
    all = all.concat(created);

    // The note is written before the decisions: if the process dies between
    // the two, a rerun rewrites the note and adds the decisions, whereas
    // orphaned decisions would need retiring first.
    const notePath = this.meetingPath(meetingId, room);
    // Everyone who spoke counts, including those who left before the close.
    const participants = [...new Set([...room.participants.map((p) => p.name), ...room.messages.filter((m) => m.kind !== "system" && m.kind !== "summary").map((m) => m.sender)])];
    const fm = frontMatter({
      id: meetingId,
      date,
      room: room.code,
      title: note.title || room.title,
      participants,
      topics: (note.topics || []).map(topicSlug),
      decisions: created.map((c) => c.id),
      human_involved: Boolean(note.human_involved),
      summarizer: { adapter, model: model || null },
      resummarized_at: resummarize ? stamp : null,
    });
    const lines = [fm, "", `# ${note.title || room.title}`, "", "## Summary", "", note.summary.trim(), "", "## Decisions", ""];
    if (created.length) for (const c of created) lines.push(`- **${c.id}** (${c.topic}${c.provisional ? ", provisional" : ""}, ${c.confidence}): ${c.statement}${c.supersedes.length ? ` Supersedes ${c.supersedes.join(", ")}.` : ""}`);
    else lines.push("None recorded.");
    lines.push("", "## Open questions", "");
    for (const q of note.open_questions || []) lines.push(`- ${q}`);
    if (!(note.open_questions || []).length) lines.push("None.");
    lines.push("", "## Action items", "");
    for (const a of note.action_items || []) lines.push(`- ${a.owner ? `**${a.owner}**: ` : ""}${a.text}`);
    if (!(note.action_items || []).length) lines.push("None.");
    lines.push("", "## Participants", "");
    for (const [name, text] of Object.entries(note.participants_summary || {})) lines.push(`- **${name}**: ${text}`);
    if (!Object.keys(note.participants_summary || {}).length) lines.push(participants.join(", "));
    if (warnings.length) lines.push("", "## Notes from ingest", "", ...warnings.map((w) => `- ${w}`));
    if (resummarize) lines.push("", `_Resummarized ${stamp}; earlier decisions of this meeting are retired and point to their replacements._`);
    lines.push("");
    this.writeAtomic(notePath, lines.join("\n"));
    this.saveDecisions(all);
    this.writeIndex();
    return { meetingId, decisionIds: created.map((c) => c.id), superseded, topicsAdded, notePath: path.relative(this.dir, notePath) };
  }

  // ---- index ----

  writeIndex() {
    const decisions = this.decisions();
    const meetings = this.listMeetings();
    const topics = this.topics();
    const active = decisions.filter((d) => d.status === "active" && !d.provisional);
    const provisional = decisions.filter((d) => d.status === "active" && d.provisional);
    const byTopic = new Map();
    for (const d of active) byTopic.set(d.topic, [...(byTopic.get(d.topic) || []), d]);
    const lines = ["# mAIndmeld knowledge index", "", `Generated ${new Date().toISOString()}. ${meetings.length} meetings, ${active.length} active decisions, ${topics.length} topics.`, "", "## Active decisions by topic", ""];
    for (const t of [...byTopic.keys()].sort()) {
      lines.push(`### ${t}`, "");
      for (const d of byTopic.get(t)) lines.push(`- ${d.id} (${d.date}): ${d.statement}`);
      lines.push("");
    }
    if (!byTopic.size) lines.push("None yet.", "");
    if (provisional.length) {
      lines.push("## Provisional decisions (reached before a called human arrived)", "");
      for (const d of provisional) lines.push(`- ${d.id} (${d.topic}, ${d.date}): ${d.statement}`);
      lines.push("");
    }
    lines.push("## Topics", "");
    for (const t of topics) lines.push(`- ${t.name}${t.description ? `: ${t.description}` : ""}${t.aliases?.length ? ` (aliases: ${t.aliases.join(", ")})` : ""}`);
    if (!topics.length) lines.push("None yet.");
    lines.push("", "## Recent meetings", "");
    for (const m of meetings.slice(0, 30)) lines.push(`- ${m.date} ${m.id}: ${m.title} (${(m.decisions || []).length} decisions) — ${m.file}`);
    if (!meetings.length) lines.push("None yet.");
    lines.push("");
    this.writeAtomic(this.indexFile, lines.join("\n"));
  }

  index() {
    return fs.existsSync(this.indexFile) ? fs.readFileSync(this.indexFile, "utf8") : "";
  }

  writeAtomic(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
}

/** Read the front matter of a note into an object (same subset the writer emits). */
export function parseFrontMatter(text) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(": ");
    if (idx === -1) continue;
    const key = line.slice(0, idx);
    const raw = line.slice(idx + 2).trim();
    if (raw === "null") out[key] = null;
    else if (raw === "true" || raw === "false") out[key] = raw === "true";
    else if (/^\[.*\]$/.test(raw)) out[key] = raw.slice(1, -1).trim() ? raw.slice(1, -1).split(",").map((s) => parseScalar(s)) : [];
    else if (raw.startsWith("{")) out[key] = JSON.parse(raw);
    else if (/^\d+$/.test(raw)) out[key] = Number(raw);
    else out[key] = parseScalar(raw);
  }
  return out;
}
