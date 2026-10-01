import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire('/home/user/instapaid/server/package.json');
const sharp = require('sharp');
const W = 1080, H = 1920;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
// A caption card: bold cream words on a soft dark pill, lower third.
async function caption(file, lines, { y = 1380, accent = [] } = {}) {
  const size = 58, lh = 74, padX = 44, padY = 36;
  const widths = lines.map((l) => l.length * size * 0.66);
  const w = Math.min(W - 40, Math.max(...widths) + padX * 2), h = lines.length * lh + padY * 2 - (lh - size);
  const x = (W - w) / 2;
  const text = lines.map((l, i) => `<text x="${W / 2}" y="${y + padY + size * 0.82 + i * lh}" text-anchor="middle" font-family="DejaVu Sans" font-weight="bold" font-size="${size}" fill="${accent.includes(i) ? '#ff9a7a' : '#fff3ea'}">${esc(l)}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="44" fill="#1a1114" fill-opacity=".72"/>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="44" fill="none" stroke="#ff7a59" stroke-opacity=".55" stroke-width="3"/>${text}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}
await caption('c0.png', ['See a post you love?']);
await caption('c1.png', ['Comment:', '@instapaid.official', 'make a token for this creator'], { accent: [1] });
await caption('c2.png', ['We launch a coin,', 'named from the post']);
await caption('c3.png', ['Only the creator', 'can claim its fees'], { accent: [1] });
// The end card's words and mark, over a blurred frame (ffmpeg adds the frame).
const mark = await sharp(readFileSync('/home/user/instapaid/server/public/mark.svg'), { density: 600 }).resize(300, 300).png().toBuffer();
const word = readFileSync('/home/user/instapaid/server/public/wordmark.svg', 'utf8');
const vb = (word.match(/viewBox="([^"]+)"/) || [])[1]?.split(/\s+/).map(Number) ?? [0, 0, 116, 27];
const ww = 620, wh = Math.round(ww * vb[3] / vb[2]);
const wordPng = await sharp(Buffer.from(word.replace(/fill="[^"]*"/g, '').replace('<svg', '<svg fill="#fff3ea"')), { density: 900 }).resize(ww, wh).png().toBuffer();
const endSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#1a1114" fill-opacity=".62"/>
  <text x="${W / 2}" y="1130" text-anchor="middle" font-family="DejaVu Sans" font-weight="bold" font-size="70" fill="#fff3ea">One comment.</text>
  <text x="${W / 2}" y="1220" text-anchor="middle" font-family="DejaVu Sans" font-weight="bold" font-size="70" fill="#ff9a7a">A coin for the creator.</text>
  <rect x="${W / 2 - 250}" y="1330" width="500" height="110" rx="55" fill="#ff6f6f"/>
  <text x="${W / 2}" y="1403" text-anchor="middle" font-family="DejaVu Sans" font-weight="bold" font-size="54" fill="#2a1215">instapaid.fun</text>
  <text x="${W / 2}" y="1760" text-anchor="middle" font-family="DejaVu Sans" font-size="30" fill="#f1d9cf">Fan-made meme coins on pump.fun. Not financial advice.</text>
  <text x="${W / 2}" y="1805" text-anchor="middle" font-family="DejaVu Sans" font-size="30" fill="#f1d9cf">Not affiliated with Instagram or Meta.</text>
</svg>`;
await sharp(Buffer.from(endSvg)).composite([
  { input: mark, left: (W - 300) / 2, top: 560 },
  { input: wordPng, left: Math.round((W - ww) / 2), top: 900 },
]).png().toFile('end.png');
console.log('ok', wh);
