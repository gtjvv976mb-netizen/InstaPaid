import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import sharp from 'sharp';
import { openDb } from '../src/db.js';
import { createCoinImages, viaGateway, IPFS_GATEWAY, COIN_IMAGE_SIDE } from '../src/coinimages.js';
import { start, launcher, POST_PNG } from './helpers.js';

const CID_META = 'bafkreiatpf2mlnmz6bnd73vv3f2ljzwn24bad5onwu4hy7psgf3kbpskdy';
const CID_IMG = 'bafybeif54mx2wbdakrpsdaffuqmi5qn2mjlnzdhidboacwknr33rfh4bxq';
const quiet = { log() {}, error() {} };

test('IPFS addresses go through pump.fun\'s gateway; anything else is refused', () => {
  assert.equal(viaGateway(`https://ipfs.io/ipfs/${CID_META}`), IPFS_GATEWAY + CID_META);
  assert.equal(viaGateway(`ipfs://${CID_IMG}`), IPFS_GATEWAY + CID_IMG);
  assert.equal(viaGateway(`https://cf-ipfs.com/ipfs/${CID_IMG}/a.png`), `${IPFS_GATEWAY}${CID_IMG}/a.png`);
  for (const bad of ['http://ipfs.io/ipfs/' + CID_IMG, 'https://evil.example/x.png', 'https://ipfs.io/ipfs/short', '', null, 'file:///etc/passwd']) {
    assert.equal(viaGateway(bad), null, String(bad));
  }
});

function setup({ uri = `https://ipfs.io/ipfs/${CID_META}`, answers = {} } = {}) {
  const db = openDb(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'instapaid-coins-'));
  const fetched = [];
  const png = POST_PNG;
  const responses = {
    [IPFS_GATEWAY + CID_META]: () => new Response(JSON.stringify({ name: 'G', image: `https://ipfs.io/ipfs/${CID_IMG}` })),
    [IPFS_GATEWAY + CID_IMG]: () => new Response(png, { headers: { 'content-type': 'image/png' } }),
    ...answers,
  };
  const fetchImpl = async (url) => { fetched.push(String(url)); return (responses[url] ?? (() => new Response('no', { status: 404 })))(); };
  const reads = [];
  const clock = { t: 1_000_000 };
  const images = createCoinImages({ dir, db, fetchImpl, log: quiet, now: () => clock.t, readUri: async (m) => { reads.push(m); return uri; } });
  const coin = (status = 'live') => {
    const mint = Keypair.generate().publicKey.toBase58();
    db.prepare(`insert or ignore into account (username, vault_pubkey, vault_secret, created_at) values ('a', ?, 'x', 0)`).run(Keypair.generate().publicKey.toBase58());
    db.prepare(`insert into token (mint, username, name, symbol, launcher, status, created_at) values (?, 'a', 'N', 'S', 'L', ?, 0)`).run(mint, status);
    return mint;
  };
  return { db, dir, images, fetched, reads, clock, coin, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a coin launched before pictures were kept: recovered once from its metadata, then served from the disk', async () => {
  const s = setup();
  try {
    const mint = s.coin();
    const file = await s.images.get(mint);
    assert.equal(file, join(s.dir, `${mint}.webp`));
    assert.deepEqual(s.fetched, [IPFS_GATEWAY + CID_META, IPFS_GATEWAY + CID_IMG], 'both through pump.fun\'s gateway, never ipfs.io');
    const meta = await sharp(file).metadata();
    assert.equal(meta.format, 'webp');
    assert.equal(meta.width, COIN_IMAGE_SIDE);
    assert.equal(meta.height, COIN_IMAGE_SIDE);

    await s.images.get(mint);
    assert.equal(s.reads.length, 1, 'the chain is read once');
    assert.equal(s.fetched.length, 2);
  } finally { s.done(); }
});

test('only live InstaPaid coins are looked up; a miss waits ten minutes before another try', async () => {
  const s = setup({ uri: 'https://evil.example/meta.json' });
  try {
    assert.equal(await s.images.get(Keypair.generate().publicKey.toBase58()), null, 'not ours');
    assert.equal(await s.images.get(s.coin('prepared')), null, 'not live');
    assert.equal(await s.images.get('../../etc/passwd'), null);
    assert.equal(s.reads.length, 0);

    const mint = s.coin();
    assert.equal(await s.images.get(mint), null, 'metadata not on IPFS: refused');
    assert.equal(s.fetched.length, 0, 'nothing fetched from another host');
    assert.equal(await s.images.get(mint), null);
    assert.equal(s.reads.length, 1, 'not retried at once');
    s.clock.t += 10 * 60_000 + 1;
    await s.images.get(mint);
    assert.equal(s.reads.length, 2, 'tried again after ten minutes');
  } finally { s.done(); }
});

test('a metadata image that is not a picture is not kept', async () => {
  const s = setup({ answers: { [IPFS_GATEWAY + CID_IMG]: () => new Response('<html>nope</html>') } });
  try {
    const mint = s.coin();
    assert.equal(await s.images.get(mint), null);
    assert.ok(!existsSync(join(s.dir, `${mint}.webp`)));
  } finally { s.done(); }
});

test('a website launch keeps its picture, served at /coins/<mint>.webp; unknown coins are 404', async () => {
  const t = await start();
  try {
    const r = await (await t.post('/api/launch/prepare', {
      username: 'bob', name: 'Coin', symbol: 'COIN', launcher: launcher(), imageUrl: 'https://a.cdninstagram.com/p.jpg',
    })).json();
    const res = await t.get(`/coins/${r.mint}.webp`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control'), /max-age=86400/);
    assert.equal((await sharp(Buffer.from(await res.arrayBuffer())).metadata()).format, 'webp');

    assert.equal((await t.get(`/coins/${Keypair.generate().publicKey.toBase58()}.webp`)).status, 404);
    assert.equal((await t.get('/coins/..%2F..%2Fetc%2Fpasswd')).status, 404);
    assert.equal((await t.get(`/coins/${r.mint}.png`)).status, 404);
  } finally { t.close(); }
});
