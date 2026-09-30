// The picture @instapaid.official posts for each new coin: 1080×1350 (Instagram's 4:5 portrait),
// JPEG, the coin's picture in a coral-to-rose frame on the site's warm dark ground (espresso warming
// to plum and mulberry, a coral glow behind the picture; nothing yellow or gold), and every word on
// one espresso panel in the site's cream, blush and coral.
//
// Text is drawn by sharp (Pango) with the bundled fonts in assets/fonts only, so the card looks the
// same on any host, even one with no fonts at all: Inter for Latin, Greek and Cyrillic, and Noto
// Sans for Japanese, Chinese, Korean, Arabic, Hebrew, Thai and Devanagari names. A name with a
// letter none of them has is left off (never drawn as empty boxes). Every line is measured after it
// is drawn: a line that is too wide or too tall is set smaller; past its smallest size it is cut
// with "…" and clipped to its height. Nothing wraps, nothing leaves the panel, no line overlaps another.
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { limitMarks, stripEmoji, visibleOnly } from './lore.js';
import { sniffImage } from './metadata.js';

const here = dirname(fileURLToPath(import.meta.url));
const FONTS = join(here, '..', 'assets', 'fonts');
const BOLD = { family: 'Inter ExtraBold', file: join(FONTS, 'Inter_800ExtraBold.ttf') };
const SEMI = { family: 'Inter SemiBold', file: join(FONTS, 'Inter_600SemiBold.ttf') };
// For the name, after Inter, Pango tries these in this order for any character Inter lacks.
export const FALLBACK_FONTS = [
  ['Noto Sans JP SemiBold', 'NotoSansJP_600SemiBold-subset.ttf'],
  ['Noto Sans SC SemiBold', 'NotoSansSC_600SemiBold-subset.ttf'],
  ['Noto Sans TC SemiBold', 'NotoSansTC_600SemiBold-subset.ttf'],
  ['Noto Sans KR SemiBold', 'NotoSansKR_600SemiBold-subset.ttf'],
  ['Noto Sans Arabic SemiBold', 'NotoSansArabic_600SemiBold.ttf'],
  ['Noto Sans Hebrew SemiBold', 'NotoSansHebrew_600SemiBold.ttf'],
  ['Noto Sans Thai SemiBold', 'NotoSansThai_600SemiBold.ttf'],
  ['Noto Sans Devanagari SemiBold', 'NotoSansDevanagari_600SemiBold.ttf'],
].map(([family, file]) => ({ family, file: join(FONTS, file) }));
const NAME = { family: [SEMI, ...FALLBACK_FONTS].map((f) => f.family).join(','), file: SEMI.file };
const DEFAULT_PICTURE = join(here, '..', 'public', 'coin-default.png');
// Pictures are at most 4 MB, but a small file can still claim a huge canvas: refuse those.
const READ = { failOn: 'error', limitInputPixels: 40_000_000 };

export const W = 1080;
export const H = 1350;
const PIC = 760; // the picture's side
const RING = 8; // the coral-to-rose frame around it
const PIC_TOP = 64;
// The panel: espresso, opaque enough that every word passes 4.5:1 over the glow behind it.
export const PANEL = { x: 48, y: PIC_TOP + PIC + RING * 2 + 34, w: W - 96, r: 44, fill: '#1a1114', opacity: 0.9 };
PANEL.h = H - 48 - PANEL.y;
const PAD_X = 52;
const MAX_W = PANEL.w - PAD_X * 2;

// The site's own colours (public/app.css :root).
export const COLOURS = {
  ink: '#fff3ea', // cream: the ticker, the name, the handle
  ink2: '#f1d9cf', // blush: "for", "Claim at"
  link: '#ff7a59', // coral: the claim link
};
const { ink: INK, ink2: INK2, link: LINK } = COLOURS;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Control characters, zero-width and direction-override marks never reach Pango; nor do stacks of
// combining marks ("Zalgo"): at most two in a row.
const visible = (s) => limitMarks(visibleOnly(s)).replace(/\s+/g, ' ').trim();

/** The code points a font's cmap maps to a glyph (formats 4 and 12, which every font here has). */
export function fontCoverage(buf) {
  const out = new Set();
  const tables = buf.readUInt16BE(4);
  let cmap = -1;
  for (let i = 0; i < tables; i++) {
    const rec = 12 + i * 16;
    if (buf.toString('latin1', rec, rec + 4) === 'cmap') { cmap = buf.readUInt32BE(rec + 8); break; }
  }
  if (cmap < 0) return out;
  let best = null;
  for (let i = 0, n = buf.readUInt16BE(cmap + 2); i < n; i++) {
    const rec = cmap + 4 + i * 8;
    const platform = buf.readUInt16BE(rec), encoding = buf.readUInt16BE(rec + 2);
    const at = cmap + buf.readUInt32BE(rec + 4), format = buf.readUInt16BE(at);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (unicode && format === 12) best = { at, format };
    else if (unicode && format === 4 && best?.format !== 12) best = { at, format };
  }
  if (best?.format === 12) {
    for (let g = 0, n = buf.readUInt32BE(best.at + 12); g < n; g++) {
      const rec = best.at + 16 + g * 12;
      const start = buf.readUInt32BE(rec), end = buf.readUInt32BE(rec + 4), glyph = buf.readUInt32BE(rec + 8);
      for (let c = start; c <= end; c++) if (glyph + (c - start)) out.add(c);
    }
  } else if (best?.format === 4) {
    const segs = buf.readUInt16BE(best.at + 6) / 2;
    const ends = best.at + 14, starts = ends + segs * 2 + 2, deltas = starts + segs * 2, ranges = deltas + segs * 2;
    for (let s = 0; s < segs; s++) {
      const end = buf.readUInt16BE(ends + s * 2), start = buf.readUInt16BE(starts + s * 2);
      const delta = buf.readInt16BE(deltas + s * 2), range = buf.readUInt16BE(ranges + s * 2);
      for (let c = start; c <= end && c !== 0xffff; c++) {
        let glyph;
        if (!range) glyph = (c + delta) & 0xffff;
        else {
          const g = buf.readUInt16BE(ranges + s * 2 + range + (c - start) * 2);
          glyph = g ? (g + delta) & 0xffff : 0;
        }
        if (glyph) out.add(c);
      }
    }
  }
  return out;
}

let coverage;
/** Every code point the name's fonts can draw. */
function nameCoverage() {
  if (!coverage) {
    coverage = new Set();
    for (const f of [SEMI, ...FALLBACK_FONTS]) for (const c of fontCoverage(readFileSync(f.file))) coverage.add(c);
  }
  return coverage;
}

/**
 * The name as the card can draw it: visible characters, no emoji, at most two marks in a row.
 * A symbol no bundled font has is left out; a letter, digit or mark none has means the name is
 * not drawn at all (''), rather than as boxes.
 */
export function drawableName(name) {
  const cover = nameCoverage();
  let out = '';
  for (const ch of visible(stripEmoji(visibleOnly(name)))) {
    if (ch === ' ' || cover.has(ch.codePointAt(0))) out += ch;
    else if (/[\p{L}\p{N}\p{M}]/u.test(ch)) return '';
  }
  out = out.replace(/\s+/g, ' ').trim();
  return /[\p{L}\p{N}]/u.test(out) ? out : '';
}

// Pango sees a font file only once it has been given it; after that it can fall back to it.
let primed;
function primeFonts() {
  primed ??= (async () => {
    for (const f of FALLBACK_FONTS) {
      await sharp({ text: { text: '.', font: `${f.family} 8`, fontfile: f.file, rgba: true } }).png().toBuffer();
    }
  })();
  return primed;
}

// An invisible "|" after every line: Pango crops a line to its ink, and the bar reaches from above
// the capitals to below the descenders, so every line of one size has the same height and top
// whatever its letters are, and lines stack evenly.
const STRUT = '<span foreground="#ffffff" fgalpha="1">|</span>';

/** One line of text as a transparent PNG, and its size. `parts` = [[text, colour], ...]. */
async function drawLine(parts, font, size) {
  const markup = parts.map(([t, c]) => `<span foreground="${c}">${esc(t)}</span>`).join('') + STRUT;
  const { data, info } = await sharp({
    text: { text: markup, font: `${font.family} ${size}`, fontfile: font.file, rgba: true, wrap: 'none' },
  }).png().toBuffer({ resolveWithObject: true });
  return { png: data, width: info.width, height: info.height, size };
}

/** A line taller than `maxHeight` (marks stacked above and below) keeps its middle. */
async function clipHeight(line, maxHeight) {
  if (!(line.height > maxHeight)) return line;
  const h = Math.max(1, Math.floor(maxHeight));
  const png = await sharp(line.png).extract({ left: 0, top: Math.floor((line.height - h) / 2), width: line.width, height: h }).png().toBuffer();
  return { ...line, png, height: h, clipped: true };
}

/**
 * The biggest size from `max` down to `min` at which the line fits `maxWidth` and `maxHeight`.
 * Below `min` the last part is shortened with "…" (earlier parts, like "for @", stay whole), and a
 * line still too tall is clipped to `maxHeight`.
 */
export async function fitLine(parts, font, { max, min, maxWidth = MAX_W, maxHeight = Infinity, step = 4 }) {
  let line;
  for (let size = max; size > min; size -= step) {
    line = await drawLine(parts, font, size);
    if (line.width <= maxWidth && line.height <= maxHeight) return { ...line, cut: false };
  }
  line = await drawLine(parts, font, min);
  if (line.width <= maxWidth) return clipHeight({ ...line, cut: false }, maxHeight);
  const head = parts.slice(0, -1);
  const [last, colour] = parts[parts.length - 1];
  const chars = [...last];
  let lo = 0, hi = chars.length - 1, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const attempt = await drawLine([...head, [chars.slice(0, mid).join('').trimEnd() + '…', colour]], font, min);
    if (attempt.width <= maxWidth) { best = attempt; lo = mid + 1; } else hi = mid - 1;
  }
  return clipHeight({ ...(best ?? await drawLine([['…', colour]], font, min)), cut: true }, maxHeight);
}

async function picture(image) {
  const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${PIC}" height="${PIC}"><rect width="${PIC}" height="${PIC}" rx="44" fill="#fff"/></svg>`);
  const shape = (input) => sharp(input, READ).rotate()
    .resize(PIC, PIC, { fit: 'cover', position: 'attention' })
    .composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
  // Only a real PNG, JPEG, GIF or WebP: never an SVG or anything else sharp could also open.
  if (image?.buf?.length && sniffImage(image.buf)) {
    try { return await shape(Buffer.from(image.buf)); } catch { /* not a picture sharp can read */ }
  }
  try { return await shape(readFileSync(DEFAULT_PICTURE)); } catch { /* no default either */ }
  return sharp({ create: { width: PIC, height: PIC, channels: 4, background: '#7a2e57' } })
    .composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
}

function background() {
  const px = (W - PIC) / 2 - RING, cx = W / 2, cy = PIC_TOP + PIC / 2;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs>
    <linearGradient id="ground" x1="0" y1="0" x2=".35" y2="1">
      <stop offset="0" stop-color="#1a1114"/><stop offset=".45" stop-color="#2e1520"/>
      <stop offset=".8" stop-color="#4a1d33"/><stop offset="1" stop-color="#5c2240"/>
    </linearGradient>
    <radialGradient id="glow" cx="${cx}" cy="${cy}" r="${W * 0.72}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ff7a59" stop-opacity=".55"/><stop offset=".5" stop-color="#ff5c8a" stop-opacity=".26"/>
      <stop offset="1" stop-color="#a3345f" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="low" cx="${W * 0.15}" cy="${H * 0.95}" r="${W * 0.7}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#a3345f" stop-opacity=".45"/><stop offset="1" stop-color="#7a2e57" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ff7a59"/><stop offset=".5" stop-color="#ff5c8a"/><stop offset="1" stop-color="#c94b8c"/>
    </linearGradient>
    <filter id="soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="28"/></filter></defs>
    <rect width="${W}" height="${H}" fill="url(#ground)"/>
    <rect width="${W}" height="${H}" fill="url(#low)"/>
    <rect width="${W}" height="${H}" fill="url(#glow)"/>
    <rect x="${px + 10}" y="${PIC_TOP - RING + 26}" width="${PIC + RING * 2 - 20}" height="${PIC + RING * 2 - 10}" rx="${44 + RING}" fill="#0b0608" fill-opacity=".55" filter="url(#soft)"/>
    <rect x="${px}" y="${PIC_TOP - RING}" width="${PIC + RING * 2}" height="${PIC + RING * 2}" rx="${44 + RING}" fill="url(#ring)"/>
    <rect x="${PANEL.x}" y="${PANEL.y}" width="${PANEL.w}" height="${PANEL.h}" rx="${PANEL.r}" fill="${PANEL.fill}" fill-opacity="${PANEL.opacity}"/>
    <rect x="${PANEL.x + 1}" y="${PANEL.y + 1}" width="${PANEL.w - 2}" height="${PANEL.h - 2}" rx="${PANEL.r - 1}" fill="none" stroke="#ffd6c4" stroke-opacity=".14" stroke-width="2"/>
  </svg>`);
}

/**
 * Draw the card. Returns the JPEG and where everything went (the tests sample those boxes).
 * image: {buf, type} of the coin's picture; anything else falls back to the default coin.
 * When the name cannot be drawn (see drawableName) the card has no name line.
 */
export async function renderCard({ image, symbol, name, username, publicUrl }) {
  await primeFonts();
  const host = String(publicUrl || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const handle = visible(username).replace(/^@/, '');
  const [pic, ticker, creator, claim] = await Promise.all([
    picture(image),
    fitLine([[`$${visible(symbol)}`, INK]], BOLD, { max: 132, min: 64 }),
    fitLine([['for ', INK2], [`@${handle}`, INK2]], SEMI, { max: 42, min: 28, step: 2 }),
    fitLine([['Claim at ', INK2], [`${host}/u/${handle}`, LINK]], SEMI, { max: 36, min: 22, step: 2 }),
  ]);

  // Top to bottom inside the panel; the claim line sits on the panel's foot, and the name gets
  // whatever height the ticker and creator lines leave above it.
  const x = PANEL.x + PAD_X;
  const claimY = PANEL.y + PANEL.h - 30 - claim.height;
  const top = PANEL.y + 22;
  const room = claimY - 8 - top;
  const text = drawableName(name);
  const title = text
    ? await fitLine([[text, INK]], NAME, { max: 54, min: 38, step: 2, maxHeight: room - (ticker.height - 6) - creator.height })
    : null;
  const block = ticker.height - 6 + (title?.height ?? 0) + creator.height;
  let y = top + Math.max(0, Math.floor((room - block) / 2)); // a smaller ticker leaves room: centre the block
  const lines = [];
  lines.push({ ...ticker, x, y, role: 'ticker' }); y += ticker.height - 6;
  if (title) { lines.push({ ...title, x, y, role: 'name' }); y += title.height; }
  lines.push({ ...creator, x, y, role: 'creator' });
  lines.push({ ...claim, x, y: claimY, role: 'claim' });

  const jpeg = await sharp(background())
    .composite([
      { input: pic, left: (W - PIC) / 2, top: PIC_TOP },
      ...lines.map((l) => ({ input: l.png, left: l.x, top: l.y })),
    ])
    .flatten({ background: '#000000' })
    .toColourspace('srgb')
    .jpeg({ quality: 88, mozjpeg: true, chromaSubsampling: '4:2:0' })
    .toBuffer();
  return {
    jpeg,
    layout: {
      width: W, height: H,
      panel: { x: PANEL.x, y: PANEL.y, w: PANEL.w, h: PANEL.h },
      picture: { x: (W - PIC) / 2, y: PIC_TOP, w: PIC, h: PIC },
      lines: lines.map(({ role, x: lx, y: ly, width, height, size, cut, clipped }) => ({
        role, x: lx, y: ly, w: width, h: height, size, cut, clipped: !!clipped,
      })),
    },
  };
}

/** Just the JPEG. */
export async function coinCard(args) {
  return (await renderCard(args)).jpeg;
}
