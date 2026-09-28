// public/favicon.ico from public/mark.svg: 32×32 and 16×16 PNGs in one ICO, for the browsers and
// crawlers that ask for /favicon.ico whatever the page links. Run: node scripts/favicon.js
import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'node:fs';

const svg = readFileSync(new URL('../public/mark.svg', import.meta.url));
const sizes = [32, 16];
const pngs = await Promise.all(sizes.map((s) => sharp(svg).resize(s, s).png().toBuffer()));

const head = Buffer.alloc(6);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const dir = sizes.map((s, i) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(s, 0); e.writeUInt8(s, 1); e.writeUInt8(0, 2); e.writeUInt8(0, 3);
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(pngs[i].length, 8); e.writeUInt32LE(offset, 12);
  offset += pngs[i].length;
  return e;
});
writeFileSync(new URL('../public/favicon.ico', import.meta.url), Buffer.concat([head, ...dir, ...pngs]));
console.log('public/favicon.ico', sizes.join(' and '), 'px');
