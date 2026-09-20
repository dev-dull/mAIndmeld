// File-backed state. One JSON file per room, written atomically by temp file
// and rename, read synchronously. Every file carries a `format` number so a
// newer server can migrate and an older one can refuse. DESIGN.md 3.1, 16.3.

import fs from "node:fs";
import path from "node:path";

export const ROOM_FORMAT = 1;

export class FormatTooNewError extends Error {
  constructor(file, found, supported) {
    super(`${file} is format ${found}; this server understands up to ${supported}. Upgrade mAIndmeld.`);
    this.name = "FormatTooNewError";
    this.status = 500;
  }
}

const ROOM_CODE = /^MM-[A-HJ-NP-Z2-9]{4}$/;

export function isRoomCode(code) {
  return typeof code === "string" && ROOM_CODE.test(code);
}

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.roomsDir = path.join(dataDir, "rooms");
    fs.mkdirSync(this.roomsDir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dataDir, 0o700);
    } catch {
      // Not every filesystem honours modes (mounted volumes, Windows). Fine.
    }
  }

  filePath(name) {
    return path.join(this.dataDir, name);
  }

  readJSON(file, fallback) {
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return fallback;
      throw error;
    }
    return JSON.parse(raw);
  }

  writeJSON(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  roomPath(code) {
    if (!isRoomCode(code)) throw new Error(`Invalid room code ${code}`);
    return path.join(this.roomsDir, `${code}.json`);
  }

  loadRoom(code) {
    if (!isRoomCode(code)) return null;
    const file = this.roomPath(code);
    const room = this.readJSON(file, null);
    if (!room) return null;
    if (typeof room.format !== "number") room.format = 1;
    if (room.format > ROOM_FORMAT) throw new FormatTooNewError(file, room.format, ROOM_FORMAT);
    return room;
  }

  saveRoom(room) {
    room.format = ROOM_FORMAT;
    this.writeJSON(this.roomPath(room.code), room);
  }

  roomExists(code) {
    return isRoomCode(code) && fs.existsSync(this.roomPath(code));
  }

  listRooms() {
    const rooms = [];
    for (const entry of fs.readdirSync(this.roomsDir)) {
      if (!entry.endsWith(".json")) continue;
      const code = entry.slice(0, -5);
      const room = this.loadRoom(code);
      if (room) rooms.push(room);
    }
    return rooms;
  }
}
