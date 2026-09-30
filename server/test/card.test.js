// The poster's card: measured from the rendered JPEG, not from the markup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { renderCard, coinCard, drawableName, fitLine, fontCoverage, FALLBACK_FONTS, COLOURS, W, H } from '../src/card.js';
import { sniffImage } from '../src/metadata.js';

const lum = (r, g, b) => {
  const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

async function pixels(jpeg) {
  const { data, info } = await sharp(jpeg).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.channels, 3);
  return { at: (x, y) => { const i = (y * info.width + x) * 3; return [data[i], data[i + 1], data[i + 2]]; }, width: info.width, height: info.height };
}

const solid = (colour, w = 800, h = 600) => sharp({ create: { width: w, height: h, channels: 3, background: colour } }).png().toBuffer()
  .then((buf) => ({ buf, type: 'image/png' }));

const LONG = {
  symbol: 'WWWWWWWWWW', name: 'W'.repeat(32), username: 'a.very_long.username_30chars_x', publicUrl: 'https://instapaid.fun',
};

test('a 1080×1350 JPEG, with the default picture when the image cannot be read', async () => {
  for (const image of [await solid('#ffffff'), { buf: Buffer.from([1, 2, 3]), type: 'image/png' }, undefined]) {
    const jpeg = await coinCard({ image, symbol: 'GEO', name: 'Golden Hour', username: 'nat.geo', publicUrl: 'https://instapaid.fun' });
    const m = await sharp(jpeg).metadata();
    assert.deepEqual([m.format, m.width, m.height, m.space], ['jpeg', W, H, 'srgb']);
    assert.deepEqual([W, H], [1080, 1350]);
    assert.ok(jpeg.length < 8 * 1024 * 1024, 'under Instagram\'s 8 MB');
  }
});

test('long names and handles stay on one line inside the panel, shrunk or cut with …', async () => {
  const { jpeg, layout } = await renderCard({ image: await solid('#ffffff'), ...LONG });
  const { panel, lines } = layout;
  for (const l of lines) {
    assert.ok(l.x >= panel.x + 40 && l.x + l.w <= panel.x + panel.w - 40, `${l.role} is inside the panel sideways (${l.x}+${l.w})`);
    assert.ok(l.y >= panel.y + 8 && l.y + l.h <= panel.y + panel.h - 8, `${l.role} is inside the panel top to bottom`);
    assert.ok(l.h < 2 * l.size, `${l.role} is one line (${l.h}px at ${l.size}px)`);
  }
  for (let i = 1; i < 3; i++) assert.ok(lines[i].y >= lines[i - 1].y + lines[i - 1].h - 8, 'lines do not overlap');
  assert.ok(lines[2].y + lines[2].h <= lines[3].y, 'the claim line is below the rest');
  const byRole = Object.fromEntries(lines.map((l) => [l.role, l]));
  assert.ok(byRole.ticker.size < 132, 'the long ticker was set smaller');
  assert.equal(byRole.name.cut, true, 'a name too wide even when small is cut');
  assert.equal(byRole.creator.cut, false, 'a 30-character handle always fits whole');
  assert.equal(byRole.claim.cut, false, 'the claim link is never cut');

  // measured on the pixels: the panel's right margin and its padding below the text are empty
  const px = await pixels(jpeg);
  let brightest = 0;
  for (let y = panel.y + 50; y < panel.y + panel.h - 50; y++) {
    for (let x = panel.x + panel.w - 38; x < panel.x + panel.w - 6; x++) brightest = Math.max(brightest, lum(...px.at(x, y)));
  }
  assert.ok(brightest < 0.2, `no text in the panel's right margin (brightest ${brightest.toFixed(3)})`);

  const short = await renderCard({ image: await solid('#ffffff'), symbol: 'GEO', name: 'Golden Hour', username: 'nat.geo', publicUrl: 'https://instapaid.fun' });
  assert.ok(short.layout.lines.every((l) => !l.cut));
  assert.equal(short.layout.lines[0].size, 132, 'a short ticker at full size');
});

test('every line passes 4.5:1 against the panel pixels behind it (white, yellow and dark pictures)', async () => {
  for (const image of [await solid('#ffffff'), await solid('#fde047'), await solid('#000000')]) {
    for (const args of [LONG, { symbol: 'GEO', name: 'Golden Hour', username: 'nat.geo', publicUrl: 'https://instapaid.fun' }]) {
      const { jpeg, layout } = await renderCard({ image, ...args });
      const px = await pixels(jpeg);
      const { panel, lines } = layout;
      const inText = (x, y) => lines.some((l) => x >= l.x - 6 && x < l.x + l.w + 6 && y >= l.y - 6 && y < l.y + l.h + 6);
      // the panel's own pixels: all of it except the rounded corners and the words
      let bg = 0;
      for (let y = panel.y + 4; y < panel.y + panel.h - 4; y += 2) {
        for (let x = panel.x + 48; x < panel.x + panel.w - 48; x += 2) if (!inText(x, y)) bg = Math.max(bg, lum(...px.at(x, y)));
      }
      assert.ok(bg < 0.1, `the panel is dark (${bg.toFixed(3)})`);
      // the words' colour: the brightest 1% of a box. Lines in two colours are measured part by part:
      // the start of the line ("fo" of "for", "Clai" of "Claim at") and its right half (the handle, the link).
      const ink = (l, x0, x1) => {
        const ls = [];
        for (let y = l.y; y < l.y + l.h; y++) for (let x = Math.round(x0); x < Math.round(x1); x++) ls.push(lum(...px.at(x, y)));
        ls.sort((a, b) => b - a);
        return ls[Math.floor(ls.length * 0.01)];
      };
      for (const l of lines) {
        const parts = [['whole', l.x, l.x + l.w]];
        if (l.role === 'creator') parts.push(['"for"', l.x, l.x + 0.9 * l.size], ['handle', l.x + l.w / 2, l.x + l.w]);
        if (l.role === 'claim') parts.push(['"Claim at"', l.x, l.x + 2.5 * l.size], ['link', l.x + l.w / 2, l.x + l.w]);
        for (const [part, x0, x1] of parts) {
          const ratio = contrast(ink(l, x0, x1), bg);
          assert.ok(ratio >= 4.5, `${l.role} (${part}): ${ratio.toFixed(2)}:1`);
        }
      }
    }
  }
});

test('names are text, not markup', async () => {
  const { layout } = await renderCard({
    image: await solid('#ffffff'), symbol: 'AB', name: '<b>Tom & "Jerry"</b> ‮', username: 'x', publicUrl: 'https://instapaid.fun',
  });
  assert.equal(layout.lines.length, 4);
});

// Names in other scripts: drawn with the bundled Noto fonts, the same on a host with no fonts at all.
const SCRIPTS = {
  japanese: '東京の夕焼けと富士山',
  chinese: '上海的日落和风景',
  traditional: '臺灣的風景',
  korean: '서울의 밤 풍경',
  arabic: 'غروب الشمس فوق البحر',
  hebrew: 'שקיעה בים',
  thai: 'พระอาทิตย์ตกที่ทะเล',
  hindi: 'सूर्यास्त का दृश्य',
  mixed: 'Golden 夕焼け 🌅 Hour',
};

test('every script the bundled fonts cover is drawn: a name line with ink, inside the panel', async () => {
  for (const [script, name] of Object.entries(SCRIPTS)) {
    assert.equal(drawableName(name), name.replace(' 🌅', ''), `${script}: nothing dropped but the emoji`);
    const { jpeg, layout } = await renderCard({ image: await solid('#ffffff'), symbol: 'SUN', name, username: 'nat.geo', publicUrl: 'https://instapaid.fun' });
    const line = layout.lines.find((l) => l.role === 'name');
    assert.ok(line, `${script}: a name line`);
    assert.ok(line.x + line.w <= layout.panel.x + layout.panel.w - 40 && line.h < 2 * line.size, `${script}: one line inside the panel`);
    const px = await pixels(jpeg);
    let lit = 0;
    for (let y = line.y; y < line.y + line.h; y++) for (let x = line.x; x < line.x + line.w; x++) if (lum(...px.at(x, y)) > 0.5) lit++;
    assert.ok(lit > line.w * 2, `${script}: the letters are drawn (${lit} bright pixels)`);
  }
});

test('a name with a letter no bundled font has is left off the card, never drawn as boxes', async () => {
  for (const name of ['მზის ჩასვლა', 'ፀሐይ', 'Sunset ᏣᎳᎩ', '𝕏𝕏𝕏']) {
    assert.equal(drawableName(name), '', name);
    const { layout } = await renderCard({ image: undefined, symbol: 'SUN', name, username: 'nat.geo', publicUrl: 'https://instapaid.fun' });
    assert.deepEqual(layout.lines.map((l) => l.role), ['ticker', 'creator', 'claim'], name);
  }
  // a symbol no font has is dropped, the rest drawn
  assert.equal(drawableName('Sun ☉ Rise'), 'Sun Rise');
  assert.equal(drawableName('☉☉'), '');
});

// Mean per-pixel difference (R+G+B, 0-765) over the name line. Hinting differs between a host's font
// setup and none (measured: about 8); a line of hex-digit boxes against real glyphs measured about 188.
const MAX_NOFONT_DIFF = 40;
test('the card is the same on a host with no fonts installed (only the bundled ones)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'instapaid-nofonts-'));
  try {
    const empty = join(dir, 'empty');
    mkdirSync(empty);
    writeFileSync(join(dir, 'fonts.conf'), `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>${empty}</dir><cachedir>${join(dir, 'cache')}</cachedir></fontconfig>`);
    const args = { symbol: 'TOKYO', name: `${SCRIPTS.japanese} ${SCRIPTS.korean.slice(0, 2)}`, username: 'tokyo.sunset', publicUrl: 'https://instapaid.fun' };
    const script = `import { renderCard } from ${JSON.stringify(new URL('../src/card.js', import.meta.url).href)};
      const r = await renderCard(${JSON.stringify(args)});
      process.stdout.write(JSON.stringify({ jpeg: r.jpeg.toString('base64'), lines: r.layout.lines }));`;
    const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, FONTCONFIG_FILE: join(dir, 'fonts.conf') }, maxBuffer: 64 * 1024 * 1024,
    }).toString());
    const here = await renderCard(args);
    // The same lines in the same places (hinting may differ by a pixel between font setups)
    assert.deepEqual(out.lines.map((l) => l.role), ['ticker', 'name', 'creator', 'claim']);
    for (const [i, l] of out.lines.entries()) {
      const m = here.layout.lines[i];
      assert.ok(l.y === m.y && l.h === m.h && Math.abs(l.w - m.w) <= 3, `${l.role}: ${JSON.stringify(l)} ~ ${JSON.stringify(m)}`);
    }
    // and the name drawn with the same glyphs: boxes of hex digits would differ everywhere
    const a = await pixels(Buffer.from(out.jpeg, 'base64')), b = await pixels(here.jpeg);
    const name = here.layout.lines.find((l) => l.role === 'name');
    let diff = 0, n = 0;
    for (let y = name.y; y < name.y + name.h; y++) {
      for (let x = name.x; x < name.x + name.w; x++) { const p = a.at(x, y), q = b.at(x, y); diff += Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]); n++; }
    }
    assert.ok(diff / n < MAX_NOFONT_DIFF, `the name line is drawn the same (mean difference ${(diff / n).toFixed(2)})`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stacked combining marks ("Zalgo") never push a line into the next one', async () => {
  const marks = '̧̨̣̤̥̦̭̮̰̀́̂̃̄̆̇̈̊̋̌';
  for (const name of [('ẞ' + marks).repeat(3), 'Zalgo ' + ('a' + marks).repeat(6), 'ẞ̶̢̧̛̲̬̝̺̘̣̗̊̏̈́̈̈́͊́̕͠'.repeat(3)]) {
    const { layout } = await renderCard({ image: undefined, symbol: 'ABC', name, username: 'user.name', publicUrl: 'https://instapaid.fun' });
    const byRole = Object.fromEntries(layout.lines.map((l) => [l.role, l]));
    const creator = byRole.creator, claim = byRole.claim;
    assert.ok(creator.y + creator.h <= claim.y, `creator (${creator.y}-${creator.y + creator.h}) ends above the claim line (${claim.y})`);
    if (byRole.name) {
      assert.ok(byRole.name.y + byRole.name.h <= creator.y, 'the name ends where the creator line starts');
      assert.ok(byRole.name.h <= 2 * byRole.name.size);
    }
  }
  // the clamp itself: a line given less height than it needs is clipped to it
  const tall = await fitLine([['ẞ' + marks.slice(0, 2) + 'x', '#ffffff']], { family: 'Inter SemiBold', file: fileURLToPath(new URL('../assets/fonts/Inter_600SemiBold.ttf', import.meta.url)) }, { max: 54, min: 38, step: 2, maxHeight: 40 });
  assert.equal(tall.height, 40);
  assert.equal(tall.clipped, true);
});

test('font coverage is read from the font files themselves', () => {
  const inter = fontCoverage(readFileSync(new URL('../assets/fonts/Inter_600SemiBold.ttf', import.meta.url)));
  for (const ch of 'Aa0 $@.éßЖΩ') assert.ok(inter.has(ch.codePointAt(0)), ch);
  assert.ok(!inter.has('東'.codePointAt(0)));
  const jp = fontCoverage(readFileSync(new URL('../assets/fonts/NotoSansJP_600SemiBold-subset.ttf', import.meta.url)));
  for (const ch of '東京のカ夕焼') assert.ok(jp.has(ch.codePointAt(0)), ch);
  assert.ok(FALLBACK_FONTS.every((f) => fontCoverage(readFileSync(f.file)).size > 30), 'every fallback font is there and readable');
});

// Hue 38-70°, saturated and bright: yellow and gold. The old card (the Instagram rainbow and a gold
// claim link) measured about 1% of its pixels here; the site's palette (coral 11°, peach 24°) none.
const hsv = (r, g, b) => {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, mx ? d / mx : 0, mx / 255];
};
const isGold = ([r, g, b]) => { const [h, s, v] = hsv(r, g, b); return h >= 38 && h <= 70 && s > 0.35 && v > 0.45; };

test('the card is the site\'s warm dark palette: nothing yellow or gold outside the picture', async () => {
  for (const c of Object.values(COLOURS)) assert.ok(!isGold([1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16))), c);
  for (const image of [undefined, await solid('#ffffff'), await solid('#fde047')]) {
    const { jpeg, layout } = await renderCard({ image, ...LONG });
    const px = await pixels(jpeg);
    const { picture: p } = layout;
    let gold = 0, n = 0;
    for (let y = 0; y < H; y += 2) {
      for (let x = 0; x < W; x += 2) {
        if (x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h) continue; // the post's own picture may be anything
        n++;
        if (isGold(px.at(x, y))) gold++;
      }
    }
    assert.equal(gold, 0, `${gold} of ${n} pixels outside the picture are yellow or gold`);
  }
});

test('the default coin: a square, opaque 1024 PNG on the warm dark ground, with no gold, readable at 64px', async () => {
  const buf = readFileSync(new URL('../public/coin-default.png', import.meta.url));
  assert.equal(sniffImage(buf), 'image/png');
  assert.ok(buf.length < 1024 * 1024, `well under the 4 MB an image may be (${buf.length} bytes)`);
  const m = await sharp(buf).metadata();
  assert.deepEqual([m.width, m.height, m.hasAlpha], [1024, 1024, false]);
  const { data } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  let gold = 0;
  for (let i = 0; i < data.length; i += 3) if (isGold([data[i], data[i + 1], data[i + 2]])) gold++;
  assert.equal(gold, 0, 'no yellow or gold pixels');
  // the corners are the site's espresso; the glowing @ in the middle still stands out at 64px
  const small = await pixels(await sharp(buf).resize(64).png().toBuffer());
  for (const [x, y] of [[1, 1], [62, 1], [1, 62], [62, 62]]) assert.ok(lum(...small.at(x, y)) < 0.03, `corner ${x},${y} is dark`);
  let bright = 0, face = 1;
  for (let y = 20; y < 44; y++) {
    for (let x = 20; x < 44; x++) { const l = lum(...small.at(x, y)); bright = Math.max(bright, l); face = Math.min(face, l); }
  }
  assert.ok(contrast(bright, face) > 7, `the @ against the coin's face at 64px: ${contrast(bright, face).toFixed(1)}:1`);
});
