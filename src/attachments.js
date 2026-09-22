// Image attachments: sniffing the bytes, the per-room files, and the signed
// URLs agents fetch with. No decoding happens here; the checks are structural
// (magic bytes plus the trailer each format requires), which is enough to
// reject a spoofed header without pulling in an image library. Issue #2.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const IMAGE_TYPES = Object.freeze({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" });
export const ATTACHMENT_ID = /^[a-f0-9]{16}$/;
export const SIGNED_URL_TTL_MS = 5 * 60 * 1000;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

/**
 * Identify an image by its bytes. Returns { type, ext } or null. Each format
 * must open and close correctly: a PNG header on a non-PNG body fails the
 * IHDR and IEND checks, a truncated JPEG lacks its EOI marker, and so on.
 */
export function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  if (buf.subarray(0, 8).equals(PNG_MAGIC)) {
    const ihdr = buf.subarray(12, 16).toString("latin1") === "IHDR";
    const iend = buf.subarray(buf.length - 12).equals(PNG_IEND);
    return ihdr && iend ? { type: "image/png", ext: "png" } : null;
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9 ? { type: "image/jpeg", ext: "jpg" } : null;
  }
  const head = buf.subarray(0, 6).toString("latin1");
  if (head === "GIF87a" || head === "GIF89a") {
    return buf[buf.length - 1] === 0x3b ? { type: "image/gif", ext: "gif" } : null;
  }
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") {
    const declared = buf.readUInt32LE(4);
    return declared + 8 === buf.length || declared + 9 === buf.length ? { type: "image/webp", ext: "webp" } : null;
  }
  return null;
}

/** Width and height from the header, or null. Used later for size checks; cheap, so it is stored at upload. */
export function imageDimensions(buf, type) {
  try {
    if (type === "image/png") return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (type === "image/gif") return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (type === "image/jpeg") {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) return null;
        const marker = buf[i + 1];
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
      return null;
    }
    if (type === "image/webp") {
      const chunk = buf.subarray(12, 16).toString("latin1");
      if (chunk === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (chunk === "VP8L") {
        const b = buf.readUInt32LE(21);
        return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
      }
      if (chunk === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
  } catch {
    return null;
  }
  return null;
}

export function newAttachmentId() {
  return crypto.randomBytes(8).toString("hex");
}

/**
 * HMAC signatures for attachment URLs. The key is made per process and kept
 * in memory only, so nothing secret touches disk; a restart invalidates
 * outstanding links, which the short expiry makes harmless.
 */
export class Signer {
  constructor(key = crypto.randomBytes(32)) {
    this.key = key;
  }

  mac(code, id, exp) {
    return crypto.createHmac("sha256", this.key).update(`${code}\n${id}\n${exp}`).digest("base64url");
  }

  sign(code, id, nowMs = Date.now(), ttlMs = SIGNED_URL_TTL_MS) {
    const exp = Math.floor((nowMs + ttlMs) / 1000);
    return `${exp}.${this.mac(code, id, exp)}`;
  }

  verify(code, id, sig, nowMs = Date.now()) {
    if (typeof sig !== "string") return false;
    const dot = sig.indexOf(".");
    if (dot < 1) return false;
    const exp = Number(sig.slice(0, dot));
    const mac = sig.slice(dot + 1);
    if (!Number.isInteger(exp) || exp * 1000 < nowMs) return false;
    const expected = this.mac(code, id, exp);
    return mac.length === expected.length && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected));
  }
}

/** The files themselves: <rooms dir>/<code>/attachments/<id>.<ext>, next to <code>.json. */
export class AttachmentFiles {
  constructor(roomsDir) {
    this.roomsDir = roomsDir;
  }

  dir(code) {
    return path.join(this.roomsDir, code, "attachments");
  }

  pathFor(code, id, ext) {
    if (!ATTACHMENT_ID.test(id)) throw new Error(`invalid attachment id ${id}`);
    return path.join(this.dir(code), `${id}.${ext}`);
  }

  write(code, id, ext, buf) {
    const file = this.pathFor(code, id, ext);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buf, { mode: 0o600 });
    fs.renameSync(tmp, file);
    return file;
  }

  exists(code, id, ext) {
    return fs.existsSync(this.pathFor(code, id, ext));
  }

  remove(code, id, ext) {
    try {
      fs.unlinkSync(this.pathFor(code, id, ext));
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }
}
