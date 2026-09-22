// Tiny valid images built by hand, plus deliberately broken ones.

export const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

// SOI, APP0 (empty), SOF0 (8-bit, 16 high, 32 wide, 3 components), EOI.
export const JPEG_32x16 = Buffer.from([
  0xff, 0xd8,
  0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
  0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x20, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  0xff, 0xd9,
]);

// Header, 2 wide by 3 high, no colour table, an empty extension, trailer.
export const GIF_2x3 = Buffer.concat([
  Buffer.from("GIF89a", "latin1"),
  Buffer.from([0x02, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00]),
  Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x21, 0xfe, 0x00, 0x00]),
  Buffer.from([0x3b]),
]);

// RIFF container with one VP8L chunk declaring 3 wide by 4 high.
export const WEBP_3x4 = (() => {
  const chunk = Buffer.from([0x2f, 0x02, 0xc0, 0x00, 0x00, 0x00]); // signature + 14-bit width-1, height-1, padded to even
  const body = Buffer.concat([Buffer.from("WEBP", "latin1"), Buffer.from("VP8L", "latin1"), Buffer.from([0x05, 0x00, 0x00, 0x00]), chunk]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from("RIFF", "latin1"), size, body]);
})();

/** PNG magic on a body that is not a PNG. */
export const PNG_SPOOF = Buffer.concat([PNG_1x1.subarray(0, 8), Buffer.from("this is text pretending to be a png and it is long enough", "latin1")]);

export const TEXT = Buffer.from("just some text, definitely not an image at all here", "utf8");
