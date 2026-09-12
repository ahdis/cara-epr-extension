#!/usr/bin/env node
// Generates icons/icon{16,48,128}.png without dependencies (tiny PNG encoder).
// Design: rounded blue square with a white right-arrow (transfer).
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function draw(size) {
  const s = size;
  const radius = s * 0.22;
  const inRounded = (x, y) => {
    const cx = Math.min(Math.max(x, radius), s - radius), cy = Math.min(Math.max(y, radius), s - radius);
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
  };
  // arrow: shaft from 0.2..0.55 width, head triangle 0.5..0.82
  const inArrow = (x, y) => {
    const u = x / s, v = y / s;
    if (u >= 0.18 && u <= 0.56 && v >= 0.42 && v <= 0.58) return true;
    if (u >= 0.5 && u <= 0.84) { const h = (0.84 - u) / 0.34 * 0.3; return Math.abs(v - 0.5) <= h; }
    return false;
  };
  return png(s, (x, y) => {
    let inside = 0, arrow = 0;
    for (const dx of [0.25, 0.75]) for (const dy of [0.25, 0.75]) { if (inRounded(x + dx, y + dy)) inside++; if (inArrow(x + dx, y + dy)) arrow++; }
    if (!inside) return [0, 0, 0, 0];
    const a = Math.round(inside / 4 * 255);
    const t = arrow / 4;
    const r = Math.round(11 + (255 - 11) * t), g = Math.round(110 + (255 - 110) * t), b = Math.round(153 + (255 - 153) * t);
    return [r, g, b, a];
  });
}
mkdirSync('icons', { recursive: true });
for (const s of [16, 48, 128]) writeFileSync(`icons/icon${s}.png`, draw(s));
console.log('icons written');
