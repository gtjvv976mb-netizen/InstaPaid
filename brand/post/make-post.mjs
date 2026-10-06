// The "how it works" carousel for @instapaid.official: six 1080×1350 slides (Instagram's 4:5).
// Run from the repo root: node brand/post/make-post.mjs. Pictures: the ad's keyframes (brand/ad).
// slide-6.jpg says comment launches wait on Meta; slide-6-live.jpg replaces it once they are live.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const sharp = createRequire(join(root, 'server', 'package.json'))('sharp');
const W = 1080, H = 1350;
const CREAM = '#fff3ea', PEACH = '#ff9a7a', CORAL = '#ff6f6f', INK = '#2a1215', SOFT = '#f1d9cf';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const font = 'font-family="DejaVu Sans"';
const bg = `<defs><radialGradient id="bg" cx="25%" cy="15%" r="95%"><stop offset="0" stop-color="#7a2d57"/>
  <stop offset=".55" stop-color="#4f1d3b"/><stop offset="1" stop-color="#2c1022"/></radialGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>`;
const lines = (arr, { x = W / 2, y, size, lh = size * 1.22, fill = CREAM, bold = true, anchor = 'middle' }) => arr.map((l, i) => {
  const [text, color] = Array.isArray(l) ? l : [l, fill];
  return `<text x="${x}" y="${y + i * lh}" text-anchor="${anchor}" ${font}${bold ? ' font-weight="bold"' : ''} font-size="${size}" fill="${color}">${esc(text)}</text>`;
}).join('');
const footer = `${lines(['instapaid.fun'], { y: 1318, size: 30, fill: SOFT })}`;

const mark = (px) => sharp(readFileSync(join(root, 'server/public/mark.svg')), { density: 600 }).resize(px, px).png().toBuffer();
async function wordmark(width) {
  const svg = readFileSync(join(root, 'server/public/wordmark.svg'), 'utf8');
  const vb = (svg.match(/viewBox="([^"]+)"/) || [])[1]?.split(/\s+/).map(Number) ?? [0, 0, 116, 27];
  const height = Math.round(width * vb[3] / vb[2]);
  const png = await sharp(Buffer.from(svg.replace(/fill="[^"]*"/g, '').replace('<svg', `<svg fill="${CREAM}"`)), { density: 900 })
    .resize(width, height).png().toBuffer();
  return { png, height };
}

// A step: number pill and heading on top, the keyframe as a rounded card, a sub-line under the heading.
async function step({ n, heading, sub, shot, top }) {
  const card = { x: 60, y: 360, w: 960, h: 895, r: 48 };
  const src = sharp(join(root, `brand/ad/keyframes/${shot}.jpg`));
  const cropH = Math.round(1080 * card.h / card.w);
  const pic = await src.extract({ left: 0, top, width: 1080, height: cropH }).resize(card.w, card.h).toBuffer();
  const rounded = await sharp(pic).composite([{
    input: Buffer.from(`<svg width="${card.w}" height="${card.h}"><rect width="${card.w}" height="${card.h}" rx="${card.r}"/></svg>`),
    blend: 'dest-in',
  }]).png().toBuffer();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${bg}
    <rect x="${W / 2 - 110}" y="48" width="220" height="56" rx="28" fill="${CORAL}"/>
    ${lines([`STEP ${n} OF 4`], { y: 86, size: 26, fill: INK })}
    ${lines(heading, { y: 178, size: 54 })}
    ${lines([sub], { y: 178 + heading.length * 66, size: 30, fill: SOFT, bold: false })}
    <rect x="${card.x - 3}" y="${card.y - 3}" width="${card.w + 6}" height="${card.h + 6}" rx="${card.r + 3}" fill="none" stroke="${CORAL}" stroke-opacity=".6" stroke-width="3"/>
    ${footer}</svg>`;
  return sharp(Buffer.from(svg)).composite([{ input: rounded, left: card.x, top: card.y }]);
}

async function cover() {
  const blurred = await sharp(join(root, 'brand/ad/keyframes/shot3.jpg')).extract({ left: 0, top: 290, width: 1080, height: 1350 })
    .blur(18).modulate({ brightness: 0.75 }).toBuffer();
  const m = await mark(300), w = await wordmark(620);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#1a1114" fill-opacity=".55"/>
    ${lines(['One comment.', ['A coin for the creator.', PEACH]], { y: 760, size: 70, lh: 92 })}
    ${lines(['How it works, in 4 steps'], { y: 960, size: 38, fill: SOFT, bold: false })}
    <rect x="${W / 2 - 200}" y="1030" width="400" height="96" rx="48" fill="${CORAL}"/>
    ${lines(['Swipe  →'], { y: 1093, size: 44, fill: INK })}
    ${footer}</svg>`;
  return sharp(blurred).composite([
    { input: Buffer.from(svg), left: 0, top: 0 },
    { input: m, left: (W - 300) / 2, top: 170 },
    { input: w.png, left: (W - 620) / 2, top: 520 },
  ]);
}

async function status() {
  const m = await mark(170);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${bg}
    <rect x="${W / 2 - 190}" y="300" width="380" height="60" rx="30" fill="${CORAL}"/>
    ${lines(['ALMOST LIVE'], { y: 341, size: 30, fill: INK })}
    ${lines(['Comment launches are', ['waiting on Meta', PEACH]], { y: 450, size: 62, lh: 80 })}
    ${lines([
      'We\'ve asked Meta to approve full access',
      'to Instagram\'s API for our app.',
      'Once it\'s approved, any comment tagging',
      ['@instapaid.official', PEACH],
      'can launch a coin for the creator.',
    ], { y: 640, size: 34, lh: 50, bold: false })}
    <rect x="80" y="930" width="920" height="200" rx="40" fill="#1a1114" fill-opacity=".45" stroke="${CORAL}" stroke-opacity=".55" stroke-width="3"/>
    ${lines(['Until then, launch one yourself:'], { y: 1005, size: 36 })}
    ${lines([['instapaid.fun/launch', PEACH]], { y: 1075, size: 46 })}
    ${lines(['Fan-made meme coins on pump.fun. Not financial advice.', 'Not affiliated with Instagram or Meta.'], { y: 1210, size: 24, lh: 34, fill: SOFT, bold: false })}
    ${footer}</svg>`;
  return sharp(Buffer.from(svg)).composite([{ input: m, left: (W - 170) / 2, top: 90 }]);
}

// The last slide once Meta has approved: comment launches are open to everyone.
async function live() {
  const m = await mark(170);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${bg}
    <rect x="${W / 2 - 160}" y="300" width="320" height="60" rx="30" fill="${CORAL}"/>
    ${lines(['LIVE NOW'], { y: 341, size: 30, fill: INK })}
    ${lines(['Comment launches are', ['live for everyone', PEACH]], { y: 450, size: 62, lh: 80 })}
    ${lines(['Under any public post, comment:'], { y: 640, size: 34, bold: false })}
    ${lines([['@instapaid.official', PEACH], ['make a token for this creator', PEACH]], { y: 712, size: 44, lh: 58 })}
    ${lines(['We launch the coin and reply with the link.'], { y: 850, size: 34, bold: false })}
    <rect x="80" y="930" width="920" height="200" rx="40" fill="#1a1114" fill-opacity=".45" stroke="${CORAL}" stroke-opacity=".55" stroke-width="3"/>
    ${lines(['Or launch one yourself:'], { y: 1005, size: 36 })}
    ${lines([['instapaid.fun/launch', PEACH]], { y: 1075, size: 46 })}
    ${lines(['Fan-made meme coins on pump.fun. Not financial advice.', 'Not affiliated with Instagram or Meta.'], { y: 1210, size: 24, lh: 34, fill: SOFT, bold: false })}
    ${footer}</svg>`;
  return sharp(Buffer.from(svg)).composite([{ input: m, left: (W - 170) / 2, top: 90 }]);
}

const slides = [
  cover(),
  step({ n: 1, heading: ['Find a post you love'], sub: 'Any public post on Instagram.', shot: 'shot1', top: 120 }),
  step({ n: 2, heading: ['Comment: @instapaid.official', [ 'make a token for this creator', PEACH]], sub: 'Tag us in the comments.', shot: 'shot2', top: 260 }),
  step({ n: 3, heading: ['We launch a coin'], sub: 'Named from the post, live on pump.fun. We reply with the link.', shot: 'shot3', top: 300 }),
  step({ n: 4, heading: ['Only the creator claims its fees'], sub: 'They DM us a code to prove it\'s them.', shot: 'shot4', top: 360 }),
  status(),
];
for (const [i, s] of (await Promise.all(slides)).entries()) {
  await s.jpeg({ quality: 92, mozjpeg: true }).toFile(join(here, `slide-${i + 1}.jpg`));
}
await (await live()).jpeg({ quality: 92, mozjpeg: true }).toFile(join(here, 'slide-6-live.jpg'));
console.log('6 slides, and slide-6-live.jpg for after Meta approves, in', here);
