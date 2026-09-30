import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { sniffImage } from './metadata.js';

export const COIN_IMAGE_SIDE = 256;
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// pump.fun's own IPFS gateway. The public ipfs.io gateway that pump.fun's upload names in every
// coin's metadata no longer serves files (it answers 429 "switching to a service worker gateway").
export const IPFS_GATEWAY = 'https://pump.mypinata.cloud/ipfs/';
const MAX_BYTES = 12 * 1024 * 1024;
const RETRY_MS = 10 * 60_000;
const READ = { failOn: 'error', limitInputPixels: 40_000_000 };

/** An IPFS address (ipfs://cid, or any gateway's /ipfs/cid) on pump.fun's gateway; null for anything else. */
export function viaGateway(u) {
  const m = String(u ?? '').match(/^(?:ipfs:\/\/|https:\/\/[^/?#]+\/ipfs\/)([a-zA-Z0-9]{46,100})(\/[^?#]*)?$/);
  return m ? IPFS_GATEWAY + m[1] + (m[2] ?? '') : null;
}

async function fetchBytes(fetchImpl, url, timeoutMs = 20_000) {
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`${r.status} from ${new URL(url).hostname}`);
  if (Number(r.headers.get('content-length') ?? 0) > MAX_BYTES) throw new Error('too large');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('too large');
  return buf;
}

/**
 * Each coin's picture, shown on the site at /coins/<mint>.webp: a 256 px square kept on the disk.
 * Saved when the coin launches; a coin launched before that (or whose copy is gone) gets it once
 * from its own metadata — the uri on chain, then its image — through pump.fun's IPFS gateway.
 * Only coins InstaPaid launched are looked up, and a miss is not tried again for ten minutes.
 *
 * readUri(mint): the metadata uri on chain (src/pump.js metadataUri).
 */
export function createCoinImages({ dir, db, readUri, fetchImpl = fetch, log = console, now = Date.now }) {
  const path = (mint) => join(dir, `${mint}.webp`);
  const failedAt = new Map();
  const inflight = new Map();

  async function save(mint, image) {
    if (!dir || !MINT_RE.test(mint) || !image?.buf?.length || !sniffImage(image.buf)) return false;
    const webp = await sharp(Buffer.from(image.buf), { ...READ, animated: false }).rotate()
      .resize(COIN_IMAGE_SIDE, COIN_IMAGE_SIDE, { fit: 'cover' }).webp({ quality: 82 }).toBuffer();
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${path(mint)}.tmp`, webp);
    renameSync(`${path(mint)}.tmp`, path(mint)); // never a half-written picture at the public address
    return true;
  }

  async function recover(mint) {
    const uri = viaGateway(await readUri(mint));
    if (!uri) throw new Error('no IPFS metadata on chain');
    const meta = JSON.parse((await fetchBytes(fetchImpl, uri)).toString('utf8'));
    const img = viaGateway(meta?.image);
    if (!img) throw new Error('metadata has no IPFS image');
    const buf = await fetchBytes(fetchImpl, img, 30_000);
    if (!sniffImage(buf)) throw new Error('not a picture');
    return save(mint, { buf });
  }

  /** The picture's path on disk, recovered first when needed; null when there is none (yet). */
  async function get(mint) {
    if (!dir || !MINT_RE.test(mint)) return null;
    if (existsSync(path(mint))) return path(mint);
    if (!db.prepare(`select 1 from token where mint = ? and status = 'live'`).get(mint)) return null;
    if (now() - (failedAt.get(mint) ?? -Infinity) < RETRY_MS) return null;
    if (!inflight.has(mint)) {
      inflight.set(mint, recover(mint)
        .catch((e) => { failedAt.set(mint, now()); log.error(`coin picture ${mint}: ${e.message}`); return false; })
        .finally(() => inflight.delete(mint)));
    }
    return (await inflight.get(mint)) ? path(mint) : null;
  }

  return { save, get, path };
}
