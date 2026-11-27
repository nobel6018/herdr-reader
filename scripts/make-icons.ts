// Draws the app icons into web/public/. Run: bun scripts/make-icons.ts
// @see docs/herdr-reader.md

import { deflateSync } from "node:zlib";

const BLUE = [47, 91, 211];
const WHITE = [255, 255, 255];
const PALE = [196, 212, 255];

/** Bubbles in a 0..1 square: [x, y, width, height, color]. */
const SHAPES: [number, number, number, number, number[]][] = [
  [0.18, 0.22, 0.5, 0.17, PALE],
  [0.18, 0.44, 0.38, 0.13, PALE],
  [0.36, 0.64, 0.46, 0.15, WHITE],
];

function insideRounded(px: number, py: number, x: number, y: number, w: number, h: number, r: number): boolean {
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

function pixels(size: number): Buffer {
  const rows = Buffer.alloc(size * (size * 4 + 1));
  const samples = 4;
  for (let j = 0; j < size; j++) {
    const row = j * (size * 4 + 1);
    rows[row] = 0;
    for (let i = 0; i < size; i++) {
      const sum = [0, 0, 0];
      for (let sj = 0; sj < samples; sj++) {
        for (let si = 0; si < samples; si++) {
          const px = (i + (si + 0.5) / samples) / size;
          const py = (j + (sj + 0.5) / samples) / size;
          const shape = SHAPES.find(([x, y, w, h]) => insideRounded(px, py, x, y, w, h, h / 2));
          const color = shape ? shape[4] : BLUE;
          for (let c = 0; c < 3; c++) sum[c]! += color[c]!;
        }
      }
      const at = row + 1 + i * 4;
      for (let c = 0; c < 3; c++) rows[at + c] = Math.round(sum[c]! / (samples * samples));
      rows[at + 3] = 255;
    }
  }
  return rows;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels(size))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const out = new URL("../web/public/", import.meta.url).pathname;
for (const [name, size] of [["icon-192.png", 192], ["icon-512.png", 512], ["apple-touch-icon.png", 180]] as const) {
  await Bun.write(out + name, png(size));
  console.log(`wrote ${name}`);
}
