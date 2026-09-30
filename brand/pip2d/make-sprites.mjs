// Green-screen clips → transparent sprite sheets for the 2D Pip.
// node make.mjs <outDir>. Reads clips/<name>.mp4, writes <outDir>/pip-<name>.webp and pip-sprites.json.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('/home/user/instapaid/server/package.json');
const sharp = require('sharp');

const FFMPEG = execFileSync('python3', ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())']).toString().trim();
const OUT = process.argv[2];
const FPS = 10, H = 260, COLS = 10;
const CLIPS = ['walk', 'idle', 'wave', 'jump', 'dance', 'press', 'look', 'cheer'];
mkdirSync(OUT, { recursive: true });

// Alpha from how green a pixel is (Pip has no green in him), then take the green out of the edges.
function key(buf) {
  for (let i = 0; i < buf.length; i += 4) {
    const r = buf[i], g = buf[i + 1], b = buf[i + 2];
    const m = Math.max(r, b);
    // How much green outweighs red and blue, relative to brightness: the screen and its shadows
    // (even dark ones) are green-dominant; Pip's coral, magenta, plum and white never are.
    const k = (g - m) / (g + 12);
    const a = 1 - Math.min(1, Math.max(0, (k - 0.03) / 0.1));
    if (g > m) buf[i + 1] = m + Math.min(g - m, 4); // despill the edges
    buf[i + 3] = Math.round(a * 255);
  }
  return buf;
}

const frames = {};
let W0 = 0, H0 = 0;
for (const name of CLIPS) {
  const dir = `frames/${name}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  execFileSync(FFMPEG, ['-v', 'error', '-i', `clips/${name}.mp4`, '-vf', `fps=${FPS}`, `${dir}/%03d.png`]);
  frames[name] = [];
  for (const f of readdirSync(dir).sort()) {
    const { data, info } = await sharp(`${dir}/${f}`).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    W0 = info.width; H0 = info.height;
    frames[name].push(key(data));
  }
}

// One crop for all the front-facing clips (so switching never jumps), its own for the walk; both
// with the feet on the bottom edge and the body centred.
function bbox(names) {
  let x0 = W0, y0 = H0, x1 = 0, y1 = 0;
  for (const n of names) for (const buf of frames[n]) {
    for (let y = 0; y < H0; y += 2) for (let x = 0; x < W0; x += 2) {
      if (buf[(y * W0 + x) * 4 + 3] > 140) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  const pad = Math.round(H0 * 0.01);
  // Centre horizontally on the image centre so the character's anchor stays put.
  const half = Math.max(W0 / 2 - x0, x1 - W0 / 2) + pad;
  return { left: Math.max(0, Math.round(W0 / 2 - half)), top: Math.max(0, y0 - pad), width: Math.min(W0, Math.round(half * 2)), height: Math.min(H0 - Math.max(0, y0 - pad), y1 - y0 + pad * 2) };
}
const boxes = { front: bbox(CLIPS.filter((n) => n !== 'walk')), walk: bbox(['walk']) };
console.log('boxes', JSON.stringify(boxes), 'source', W0, 'x', H0);

const meta = { fps: FPS, clips: {} };
for (const name of CLIPS) {
  const box = boxes[name === 'walk' ? 'walk' : 'front'];
  const fh = H, fw = Math.round((box.width / box.height) * H);
  const list = frames[name];
  const rows = Math.ceil(list.length / COLS);
  const tiles = await Promise.all(list.map((buf, i) => sharp(buf, { raw: { width: W0, height: H0, channels: 4 } })
    .extract(box).resize(fw, fh).png().toBuffer().then((input) => ({ input, left: (i % COLS) * fw, top: Math.floor(i / COLS) * fh }))));
  await sharp({ create: { width: fw * COLS, height: fh * rows, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(tiles).webp({ quality: 78, alphaQuality: 82, effort: 6 }).toFile(`${OUT}/pip-${name}.webp`);
  meta.clips[name] = { frames: list.length, cols: COLS, w: fw, h: fh };
  console.log(name, list.length, 'frames', fw, 'x', fh);
}
writeFileSync(`${OUT}/pip-sprites.json`, JSON.stringify(meta));
