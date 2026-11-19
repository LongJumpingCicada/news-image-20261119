// Re-encode a truecolour PNG as a small palette PNG, so the entry fits the
// gate's 1 MiB cap while keeping every edge and letter crisp. The palette is
// built by median cut over the image's own colours, which keeps the ink navy,
// the accent red and the newsprint cream apart instead of collapsing them.
// Usage: node tools/make-png.mjs <in.png> <out.png> [colours]

import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';

const [input, output, colourArg] = process.argv.slice(2);
const COLOURS = Number(colourArg ?? 64);

function readChunks(buf) {
  let off = 8;
  const chunks = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    chunks.push({ type, data: buf.subarray(off + 8, off + 8 + len) });
    off += len + 12;
  }
  return chunks;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decode(buf) {
  const chunks = readChunks(buf);
  const ihdr = chunks.find((c) => c.type === 'IHDR').data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colourType = ihdr[9];
  if (bitDepth !== 8 || colourType !== 2) throw new Error(`expected 8-bit RGB, got depth ${bitDepth} type ${colourType}`);
  const raw = inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  const stride = width * 3;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : pixels.subarray((y - 1) * stride, y * stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= 3 ? cur[x - 3] : 0;
      const up = prev ? prev[x] : 0;
      const upLeft = prev && x >= 3 ? prev[x - 3] : 0;
      let v = line[x];
      if (filter === 1) v += left;
      else if (filter === 2) v += up;
      else if (filter === 3) v += (left + up) >> 1;
      else if (filter === 4) v += paeth(left, up, upLeft);
      cur[x] = v & 0xff;
    }
  }
  return { width, height, pixels };
}

function histogram(pixels) {
  const counts = new Map();
  for (let i = 0; i < pixels.length; i += 3) {
    const key = (pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([key, count]) => ({ r: (key >> 16) & 0xff, g: (key >> 8) & 0xff, b: key & 0xff, count }));
}

function medianCut(colours, maxColours) {
  const buckets = [colours];
  const rank = (bucket) => {
    let lo = [255, 255, 255];
    let hi = [0, 0, 0];
    let total = 0;
    for (const c of bucket) {
      lo = [Math.min(lo[0], c.r), Math.min(lo[1], c.g), Math.min(lo[2], c.b)];
      hi = [Math.max(hi[0], c.r), Math.max(hi[1], c.g), Math.max(hi[2], c.b)];
      total += c.count;
    }
    const spread = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    return { total, spread, lo, hi };
  };
  while (buckets.length < maxColours) {
    let pick = -1;
    let pickScore = 0;
    for (let i = 0; i < buckets.length; i += 1) {
      if (buckets[i].length < 2) continue;
      const { total, spread } = rank(buckets[i]);
      const score = total * spread;
      if (score > pickScore) {
        pickScore = score;
        pick = i;
      }
    }
    if (pick < 0) break;
    const bucket = buckets[pick];
    const { lo, hi } = rank(bucket);
    const widths = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    const channel = widths[0] >= widths[1] && widths[0] >= widths[2] ? 'r' : widths[1] >= widths[2] ? 'g' : 'b';
    const sorted = [...bucket].sort((a, b) => a[channel] - b[channel]);
    const half = sorted.reduce((sum, c) => sum + c.count, 0) / 2;
    let acc = 0;
    let split = 1;
    for (let i = 0; i < sorted.length - 1; i += 1) {
      acc += sorted[i].count;
      if (acc >= half) {
        split = i + 1;
        break;
      }
    }
    buckets.splice(pick, 1, sorted.slice(0, split), sorted.slice(split));
  }
  return buckets.map((bucket) => {
    let r = 0;
    let g = 0;
    let b = 0;
    let total = 0;
    for (const c of bucket) {
      r += c.r * c.count;
      g += c.g * c.count;
      b += c.b * c.count;
      total += c.count;
    }
    return [Math.round(r / total), Math.round(g / total), Math.round(b / total)];
  });
}

function nearest(palette, r, g, b) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < palette.length; i += 1) {
    const dr = r - palette[i][0];
    const dg = g - palette[i][1];
    const db = b - palette[i][2];
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

const { width, height, pixels } = decode(readFileSync(input));
const palette = medianCut(histogram(pixels), COLOURS);
const cache = new Map();
const index = Buffer.alloc(width * height);
for (let i = 0, p = 0; i < pixels.length; i += 3, p += 1) {
  const key = (pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2];
  let idx = cache.get(key);
  if (idx === undefined) {
    idx = nearest(palette, pixels[i], pixels[i + 1], pixels[i + 2]);
    cache.set(key, idx);
  }
  index[p] = idx;
}

const scanlines = Buffer.alloc(height * (width + 1));
for (let y = 0; y < height; y += 1) {
  scanlines[y * (width + 1)] = 0;
  index.copy(scanlines, y * (width + 1) + 1, y * width, (y + 1) * width);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(width, 0);
ihdr.writeUInt32BE(height, 4);
ihdr[8] = 8;
ihdr[9] = 3;
const out = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('PLTE', Buffer.from(palette.flat())),
  chunk('IDAT', deflateSync(scanlines, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(output, out);
console.log(JSON.stringify({ output, bytes: out.length, colours: palette.length, width, height }));
