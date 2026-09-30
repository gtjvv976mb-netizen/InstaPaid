import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Keypair } from '@solana/web3.js';
import { openDb } from '../src/db.js';
import { createMintPool, MINT_SUFFIX } from '../src/mintpool.js';
import { start, mentionHook, tick, launcher } from './helpers.js';

const KEY = 'a'.repeat(64);
const quiet = { log() {}, error() {} };

/** A seed whose address ends in `suffix` (short suffixes only: this is the slow, plain search). */
function seedEndingIn(suffix) {
  for (;;) {
    const seed = randomBytes(32);
    if (Keypair.fromSeed(seed).publicKey.toBase58().endsWith(suffix)) return [...seed];
  }
}

test('the stock hands out each address once, oldest first, and is empty after', () => {
  const db = openDb(':memory:');
  let clock = 1;
  const pool = createMintPool({ db, masterKey: KEY, size: 5, suffix: 'p', log: quiet, now: () => clock++ });
  const a = seedEndingIn('p'), b = seedEndingIn('p');
  assert.ok(pool.add(a));
  assert.ok(pool.add(b));
  assert.ok(pool.add(a), 'the same key twice is one row');
  assert.equal(pool.count(), 2);

  const row = db.prepare('select * from mint_key limit 1').get();
  assert.ok(!row.secret.includes(Buffer.from(Keypair.fromSeed(Uint8Array.from(a)).secretKey).toString('base64')), 'sealed, not stored plain');

  const first = pool.take(), second = pool.take();
  assert.equal(first.publicKey.toBase58(), Keypair.fromSeed(Uint8Array.from(a)).publicKey.toBase58());
  assert.equal(second.publicKey.toBase58(), Keypair.fromSeed(Uint8Array.from(b)).publicKey.toBase58());
  assert.ok(first.publicKey.toBase58().endsWith('p'));
  assert.equal(pool.take(), null, 'empty: the launch gets a random address');
  assert.equal(pool.count(), 0);
});

test('the stock refuses a key without the suffix, and skips one sealed under another key', () => {
  const db = openDb(':memory:');
  const pool = createMintPool({ db, masterKey: KEY, size: 5, suffix: 'p', log: quiet });
  let wrong;
  do wrong = [...randomBytes(32)]; while (Keypair.fromSeed(Uint8Array.from(wrong)).publicKey.toBase58().endsWith('p'));
  assert.equal(pool.add(wrong), false);
  assert.equal(pool.add([1, 2, 3]), false, 'not a seed');
  assert.equal(pool.count(), 0);

  const other = createMintPool({ db, masterKey: 'b'.repeat(64), size: 5, suffix: 'p', log: quiet });
  assert.ok(other.add(seedEndingIn('p')));
  assert.equal(pool.take(), null, 'opened with the wrong key: not used');
  assert.equal(pool.count(), 0, 'and not offered again');
});

test('the search runs until the stock is full, stops, and starts again when an address is taken', async () => {
  const db = openDb(':memory:');
  const started = [];
  const grinder = (suffix) => {
    const child = new EventEmitter();
    child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('exit')); };
    started.push({ suffix, child });
    return child;
  };
  const pool = createMintPool({ db, masterKey: KEY, size: 2, suffix: 'p', grinder, log: quiet });
  pool.start();
  assert.equal(started.length, 1);
  assert.equal(started[0].suffix, 'p');
  started[0].child.emit('message', { seed: seedEndingIn('p') });
  assert.ok(!started[0].child.killed);
  started[0].child.emit('message', { seed: seedEndingIn('p') });
  assert.ok(started[0].child.killed, 'full: the search stops');
  await tick(0);
  assert.equal(pool.searching, false);

  assert.ok(pool.take());
  assert.equal(started.length, 2, 'taking one starts the search again');
  pool.stop();
  assert.ok(started[1].child.killed);
});

test('size 0 never searches', () => {
  const db = openDb(':memory:');
  let forks = 0;
  const pool = createMintPool({ db, masterKey: KEY, size: 0, grinder: () => { forks++; }, log: quiet });
  pool.start();
  assert.equal(pool.take(), null);
  assert.equal(forks, 0);
});

test('the real search finds addresses with the suffix and stops when the stock is full', { timeout: 60_000 }, async () => {
  const db = openDb(':memory:');
  const pool = createMintPool({ db, masterKey: KEY, size: 2, suffix: 'pu', log: quiet });
  pool.start();
  try {
    while (pool.count() < 2 || pool.searching) await tick(100);
    const a = pool.take(), b = pool.take();
    for (const kp of [a, b]) assert.ok(kp.publicKey.toBase58().endsWith('pu'), kp.publicKey.toBase58());
    assert.notEqual(a.publicKey.toBase58(), b.publicKey.toBase58());
  } finally { pool.stop(); }
});

test('launches use the stock: a website launch and a comment launch get addresses ending in the suffix', async () => {
  const db = openDb(':memory:');
  const pool = createMintPool({ db, masterKey: KEY, size: 5, suffix: 'p', log: quiet });
  for (let i = 0; i < 2; i++) pool.add(seedEndingIn('p'));
  const t = await start({
    mintPool: pool,
    mentions: { c1: { text: '@instapaid.official make a token for this creator',
      media: { id: 'm1', media_type: 'IMAGE', media_url: 'https://scontent.cdninstagram.com/p.jpg', permalink: 'https://www.instagram.com/p/x/', username: 'alice' } } },
  });
  try {
    const web = await (await t.post('/api/launch/prepare', {
      username: 'bob', name: 'Coin', symbol: 'COIN', launcher: launcher(), imageUrl: 'https://a.cdninstagram.com/p.jpg',
    })).json();
    assert.ok(web.mint.endsWith('p'), web.mint);

    assert.equal((await mentionHook(t, 'c1', 'm1')).status, 200);
    await tick();
    await t.drain();
    const comment = t.db.prepare(`select mint from token where username = 'alice'`).get().mint;
    assert.ok(comment.endsWith('p'), comment);
    assert.notEqual(comment, web.mint);

    // The stock is empty now: the next launch still works, with a random address.
    const next = await t.post('/api/launch/prepare', {
      username: 'carol', name: 'Coin', symbol: 'COIN', launcher: launcher(), imageUrl: 'https://a.cdninstagram.com/p.jpg',
    });
    assert.equal(next.status, 200);
    assert.equal(t.calls.mints.at(-1), undefined);
  } finally { t.close(); }
});

test('the default suffix is "pump"', () => assert.equal(MINT_SUFFIX, 'pump'));
