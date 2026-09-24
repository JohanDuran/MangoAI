// Generates the placeholder app icon (apps/desktop/assets/icon.png, 512x512) with no dependencies.
// Replace the PNG with real artwork any time; the build only needs a square PNG of 256px or more.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 512;
const SS = 3;

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const rotate = (x, y, cx, cy, deg) => {
  const r = (deg * Math.PI) / 180;
  const dx = x - cx;
  const dy = y - cy;
  return [dx * Math.cos(r) + dy * Math.sin(r), -dx * Math.sin(r) + dy * Math.cos(r)];
};
const inEllipse = (x, y, cx, cy, rx, ry, deg) => {
  const [u, v] = rotate(x, y, cx, cy, deg);
  return (u * u) / (rx * rx) + (v * v) / (ry * ry) <= 1;
};
const inRoundRect = (x, y, r) => {
  const cx = Math.min(Math.max(x, r), N - r);
  const cy = Math.min(Math.max(y, r), N - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

function samplePixel(x, y) {
  if (!inRoundRect(x, y, 104)) return null;
  let color = [28, 29, 36];
  if (inEllipse(x, y, 292, 132, 70, 30, -35)) color = [63, 191, 106];
  if (inEllipse(x, y, 256, 300, 158, 184, -22)) {
    const t = Math.min(1, Math.max(0, (x + y - 200) / 500));
    color = mix([255, 214, 64], [255, 122, 26], t);
    if (inEllipse(x, y, 208, 250, 34, 74, -22)) color = mix(color, [255, 245, 200], 0.55);
  }
  return color;
}

const raw = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0;
  for (let x = 0; x < N; x++) {
    let r = 0, g = 0, b = 0, hits = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const c = samplePixel(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        if (c) { r += c[0]; g += c[1]; b += c[2]; hits++; }
      }
    }
    const o = y * (N * 4 + 1) + 1 + x * 4;
    if (hits) { raw[o] = r / hits; raw[o + 1] = g / hits; raw[o + 2] = b / hits; raw[o + 3] = Math.round((255 * hits) / (SS * SS)); }
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0);
ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);

const target = path.join(root, 'apps/desktop/assets/icon.png');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, png);
console.log(`wrote ${target} (${png.length} bytes)`);
