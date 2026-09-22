import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { sniffImage, imageDimensions, stripMetadata, Signer, AttachmentFiles, newAttachmentId, ATTACHMENT_ID } from "../src/attachments.js";
import { PNG_1x1, JPEG_32x16, GIF_2x3, WEBP_3x4, PNG_SPOOF, TEXT, JPEG_WITH_EXIF, PNG_WITH_TEXT, WEBP_WITH_EXIF } from "./fixtures-images.js";
import { tmpDataDir } from "./helpers.js";

test("sniffImage recognises the four formats by structure and rejects everything else", () => {
  assert.deepEqual(sniffImage(PNG_1x1), { type: "image/png", ext: "png" });
  assert.deepEqual(sniffImage(JPEG_32x16), { type: "image/jpeg", ext: "jpg" });
  assert.deepEqual(sniffImage(GIF_2x3), { type: "image/gif", ext: "gif" });
  assert.deepEqual(sniffImage(WEBP_3x4), { type: "image/webp", ext: "webp" });
  assert.equal(sniffImage(TEXT), null);
  assert.equal(sniffImage(PNG_SPOOF), null, "a PNG header on a non-PNG body");
  assert.equal(sniffImage(JPEG_32x16.subarray(0, JPEG_32x16.length - 2)), null, "a JPEG without its end marker");
  assert.equal(sniffImage(Buffer.concat([WEBP_3x4, Buffer.from([1, 2, 3])])), null, "a WebP whose RIFF size disagrees with its length");
  assert.equal(sniffImage(Buffer.alloc(4)), null);
  assert.equal(sniffImage("not a buffer"), null);
});

test("imageDimensions reads the header of each format", () => {
  assert.deepEqual(imageDimensions(PNG_1x1, "image/png"), { width: 1, height: 1 });
  assert.deepEqual(imageDimensions(JPEG_32x16, "image/jpeg"), { width: 32, height: 16 });
  assert.deepEqual(imageDimensions(GIF_2x3, "image/gif"), { width: 2, height: 3 });
  assert.deepEqual(imageDimensions(WEBP_3x4, "image/webp"), { width: 3, height: 4 });
  assert.equal(imageDimensions(Buffer.alloc(3), "image/png"), null);
});

test("signed links verify only for the same room, id, key, and time", () => {
  const signer = new Signer();
  const t0 = Date.parse("2026-09-22T12:00:00Z");
  const sig = signer.sign("MM-ABCD", "0123456789abcdef", t0);
  assert.ok(signer.verify("MM-ABCD", "0123456789abcdef", sig, t0 + 60_000));
  assert.ok(!signer.verify("MM-ABCD", "0123456789abcdef", sig, t0 + 6 * 60_000), "expired after five minutes");
  assert.ok(!signer.verify("MM-ABCE", "0123456789abcdef", sig, t0), "another room");
  assert.ok(!signer.verify("MM-ABCD", "0123456789abcdee", sig, t0), "another attachment");
  assert.ok(!signer.verify("MM-ABCD", "0123456789abcdef", `${sig}x`, t0), "tampered");
  assert.ok(!new Signer().verify("MM-ABCD", "0123456789abcdef", sig, t0), "another process's key");
  assert.ok(!signer.verify("MM-ABCD", "0123456789abcdef", "", t0));
  assert.ok(!signer.verify("MM-ABCD", "0123456789abcdef", null, t0));
});

test("attachment files live beside the room file and are written atomically", () => {
  const dir = tmpDataDir();
  try {
    const files = new AttachmentFiles(path.join(dir, "rooms"));
    const id = newAttachmentId();
    assert.match(id, ATTACHMENT_ID);
    const file = files.write("MM-ABCD", id, "png", PNG_1x1);
    assert.equal(file, path.join(dir, "rooms", "MM-ABCD", "attachments", `${id}.png`));
    assert.ok(files.exists("MM-ABCD", id, "png"));
    assert.deepEqual(fs.readdirSync(path.dirname(file)), [`${id}.png`], "no temp file left behind");
    assert.equal(files.remove("MM-ABCD", id, "png"), true);
    assert.equal(files.remove("MM-ABCD", id, "png"), false);
    assert.throws(() => files.pathFor("MM-ABCD", "../../etc/passwd", "png"), /invalid attachment id/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stripMetadata removes EXIF, GPS, comments, and text chunks without touching the image data", () => {
  assert.ok(JPEG_WITH_EXIF.includes("GPSLatitude"), "fixture carries GPS");
  const jpeg = stripMetadata(JPEG_WITH_EXIF, "image/jpeg");
  assert.ok(!jpeg.includes("GPSLatitude") && !jpeg.includes("taken at home"));
  assert.ok(jpeg.equals(JPEG_32x16), "what remains is exactly the metadata-free original");
  assert.deepEqual(sniffImage(jpeg), { type: "image/jpeg", ext: "jpg" });

  const png = stripMetadata(PNG_WITH_TEXT, "image/png");
  assert.ok(!png.includes("Someone Private") && !png.includes("eXIf"));
  assert.ok(png.equals(PNG_1x1));

  assert.ok(WEBP_WITH_EXIF.includes("GPS here"));
  const webp = stripMetadata(WEBP_WITH_EXIF, "image/webp");
  assert.ok(!webp.includes("GPS here") && !webp.includes("EXIF"));
  assert.deepEqual(sniffImage(webp), { type: "image/webp", ext: "webp" }, "RIFF size fixed up");
  assert.equal(webp[20] & 0x0c, 0, "EXIF and XMP flags cleared on VP8X");
  assert.deepEqual(imageDimensions(webp, "image/webp"), { width: 3, height: 4 });

  // A fill byte (0xFF) before a marker is legal; the walker must step over it, not read it as a marker with a length.
  const filled = Buffer.concat([JPEG_WITH_EXIF.subarray(0, 2), Buffer.from([0xff]), JPEG_WITH_EXIF.subarray(2)]);
  const strippedFilled = stripMetadata(filled, "image/jpeg");
  assert.ok(!strippedFilled.includes("GPSLatitude"));
  assert.deepEqual(sniffImage(strippedFilled), { type: "image/jpeg", ext: "jpg" });
  assert.deepEqual(imageDimensions(strippedFilled.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])) ? Buffer.concat([strippedFilled.subarray(0, 2), strippedFilled.subarray(3)]) : strippedFilled, "image/jpeg"), { width: 32, height: 16 });
  assert.ok(stripMetadata(GIF_2x3, "image/gif").equals(GIF_2x3), "GIF passes through");
  assert.ok(stripMetadata(Buffer.from([1, 2, 3]), "image/jpeg").equals(Buffer.from([1, 2, 3])), "garbage passes through untouched");
});
