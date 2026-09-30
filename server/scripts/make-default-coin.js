// Draw public/coin-default.png: the picture a coin wears when its post shares no picture with us
// (app.js DEFAULT_IMAGE, uploaded to pump.fun's IPFS for good) and the card's picture then (card.js).
//
// The site's coin (public/media/coin.webp, the plum glass coin with the glowing @) centred on the
// site's own ground: espresso at the corners warming to plum and mulberry in the middle, with a soft
// coral glow behind the coin. Square, opaque (no transparency: pump.fun and wallets draw a PNG's clear
// parts on white or black as they please), no text, no gold. 1024×1024 PNG, well under the 4 MB an
// image may be, and readable from 1024 down to a 64px wallet icon.
//
//   npm run default-coin                      # from public/media/coin.webp
//   npm run default-coin -- path/to/coin.png  # from a bigger transparent render of the same coin
import sharp from 'sharp';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = process.argv[2] || join(here, '..', 'public', 'media', 'coin.webp');
const OUT = join(here, '..', 'public', 'coin-default.png');
const S = 1024;
const COIN_H = 760; // the coin's height on the square (its width follows, about 655)

const ground = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}"><defs>
  <radialGradient id="g" cx=".5" cy=".46" r=".72">
    <stop offset="0" stop-color="#5a2340"/><stop offset=".45" stop-color="#3a1a28"/>
    <stop offset=".8" stop-color="#22161b"/><stop offset="1" stop-color="#1a1114"/>
  </radialGradient>
  <radialGradient id="glow" cx=".5" cy=".5" r=".5">
    <stop offset="0" stop-color="#ff7a59" stop-opacity=".7"/><stop offset=".5" stop-color="#ff5c8a" stop-opacity=".3"/>
    <stop offset="1" stop-color="#a3345f" stop-opacity="0"/>
  </radialGradient></defs>
  <rect width="${S}" height="${S}" fill="url(#g)"/>
  <circle cx="${S / 2}" cy="${S / 2}" r="${S * 0.5}" fill="url(#glow)"/>
</svg>`);

const coin = await sharp(SRC).trim({ threshold: 1 }).resize({ height: COIN_H, kernel: 'lanczos3' }).png().toBuffer({ resolveWithObject: true });
// A soft shadow under the coin, so its dark edge does not melt into the dark ground.
const shadow = await sharp(coin.data).ensureAlpha().extractChannel('alpha').toBuffer()
  .then((a) => sharp({ create: { width: coin.info.width, height: coin.info.height, channels: 3, background: '#0b0608' } })
    .joinChannel(a).png().toBuffer())
  .then((s) => sharp(s).extend({ top: 40, bottom: 40, left: 40, right: 40, background: { r: 0, g: 0, b: 0, alpha: 0 } }).blur(22)
    .ensureAlpha(0.5).linear([1, 1, 1, 0.55], [0, 0, 0, 0]).png().toBuffer());
const left = Math.round((S - coin.info.width) / 2), top = Math.round((S - coin.info.height) / 2);

await sharp(ground)
  .composite([
    { input: shadow, left: left - 40 + 10, top: top - 40 + 22 },
    { input: coin.data, left, top },
  ])
  .flatten({ background: '#1a1114' })
  .removeAlpha()
  .toColourspace('srgb')
  .png({ compressionLevel: 9, adaptiveFiltering: true, palette: true, quality: 100, dither: 1, colours: 256 })
  .toFile(OUT)
  .then((info) => console.log(`${OUT}: ${info.width}×${info.height}, ${(info.size / 1024).toFixed(0)} KB`));
