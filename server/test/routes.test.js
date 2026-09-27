// /healthz, /posts/<mint>.jpg, the database upgrade, and the block script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { Keypair } from '@solana/web3.js';
import sharp from 'sharp';
import { start, mentionHook, launcher } from './helpers.js';
import { openDb } from '../src/db.js';
import { readMention, replyToMention } from '../src/comments.js';
import { sniffImage } from '../src/metadata.js';

test('/healthz answers 200 {ok:true} after a database query, 503 when the database is gone', async () => {
  const t = await start();
  try {
    const r = await t.get('/healthz');
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
    t.db.close();
    const down = await t.get('/healthz');
    assert.equal(down.status, 503);
    assert.deepEqual(await down.json(), { ok: false });
  } finally { t.close(); }
});

test('/posts serves only <mint>.jpg from POSTS_DIR, publicly cached; nothing else, no way out', async () => {
  const t = await start();
  try {
    const mint = Keypair.generate().publicKey.toBase58();
    writeFileSync(join(t.postsDir, `${mint}.jpg`), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    writeFileSync(join(t.postsDir, 'notes.txt'), 'secret');
    writeFileSync(join(t.postsDir, `${mint}.png`), 'png');
    const ok = await t.get(`/posts/${mint}.jpg`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/jpeg');
    assert.match(ok.headers.get('cache-control'), /public/);
    assert.deepEqual([...new Uint8Array(await ok.arrayBuffer())], [0xff, 0xd8, 0xff, 0xd9]);

    for (const bad of [
      '/posts/notes.txt', `/posts/${mint}.png`, `/posts/${mint}.JPG`, `/posts/${mint}.jpg.tmp`,
      '/posts/..%2Fpackage.json', '/posts/..%2F..%2Fpackage.json', '/posts/%2e%2e%2f%2e%2e%2fsrc%2fapp.js',
      `/posts/..%2F${mint}.jpg`, `/posts/src%2F${mint}.jpg`, `/posts/${mint}.jpg%00.png`, '/posts/.jpg',
      `/posts/0OIl${mint.slice(4)}.jpg`, `/posts/${'1'.repeat(31)}.jpg`, `/posts/${'1'.repeat(45)}.jpg`,
      `/posts/${Keypair.generate().publicKey.toBase58()}.jpg`, // a good name that is not there
    ]) {
      const r = await t.get(bad);
      assert.equal(r.status, 404, bad);
      assert.doesNotMatch(await r.text(), /secret|instapaid-server|import /, bad);
    }
  } finally { t.close(); }
});

test('an existing database upgrades in place: new columns and tables, rows kept, twice is fine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'instapaid-db-'));
  try {
    const path = join(dir, 'old.db');
    const old = new Database(path);
    old.exec(`
      create table account (username text primary key, vault_pubkey text not null unique, vault_secret text not null, igsid text, created_at integer not null);
      create table token (mint text primary key, username text not null references account(username), name text not null, symbol text not null,
        launcher text not null, lore text, source text not null default 'web' check (source in ('web','comment')),
        status text not null check (status in ('prepared','live')), signature text, created_at integer not null);
      insert into account values ('alice', 'V', 'S', null, 1);
      insert into token (mint, username, name, symbol, launcher, status, created_at) values ('M', 'alice', 'A', 'A', 'L', 'live', 1);
      insert into account values ('bob', 'V2', 'S', null, 1);
      insert into token (mint, username, name, symbol, launcher, lore, source, status, created_at)
        values ('C', 'bob', 'B', 'B', 'L', 'lore Claude wrote before fans could', 'comment', 'live', 2);
    `);
    old.close();
    for (let i = 0; i < 2; i++) {
      const db = openDb(path);
      assert.ok(db.prepare('pragma table_info(token)').all().some((c) => c.name === 'post_permalink'));
      for (const table of ['post_job', 'creator_block', 'kv']) {
        assert.ok(db.prepare(`select 1 from sqlite_master where type = 'table' and name = ?`).get(table), table);
      }
      assert.deepEqual(db.prepare('select mint, name, post_permalink from token order by mint').all(),
        [{ mint: 'C', name: 'B', post_permalink: null }, { mint: 'M', name: 'A', post_permalink: null }]);
      assert.ok(db.prepare('pragma table_info(token)').all().some((c) => c.name === 'last_valid_height'));
      if (i === 0) {
        assert.equal(db.prepare(`select lore from token where mint = 'C'`).get().lore, null,
          'lore from before fans wrote it is not shown as "Fan lore"');
        db.prepare(`update token set lore = 'a fan wrote this', post_permalink = null where mint = 'C'`).run();
      } else {
        assert.equal(db.prepare(`select lore from token where mint = 'C'`).get().lore, 'a fan wrote this', 'only the upgrade clears lore, once');
      }
      db.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('npm run block / unblock: blocks, skips waiting posts, lists, lifts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'instapaid-block-'));
  const script = fileURLToPath(new URL('../scripts/block-creator.js', import.meta.url));
  const run = (...args) => execFileSync(process.execPath, [script, ...args], {
    cwd: dir, env: { ...process.env, DB_PATH: join(dir, 'x.db') }, encoding: 'utf8',
  });
  try {
    const db = openDb(join(dir, 'x.db'));
    db.prepare(`insert into account (username, vault_pubkey, vault_secret, created_at) values ('alice', 'V', 'S', 1)`).run();
    db.prepare(`insert into token (mint, username, name, symbol, launcher, status, created_at) values ('M', 'alice', 'A', 'A', 'L', 'live', 1)`).run();
    db.prepare(`insert into post_job (mint, status, created_at, next_attempt_at) values ('M', 'queued', 1, 1)`).run();
    db.close();

    assert.match(run('@Alice', 'asked', 'by', 'DM'), /Blocked @alice: no new coins for them, and no posts\. Skipped 1 waiting post\./);
    assert.match(run('list'), /@alice .*\(asked by DM\)/);
    const check = openDb(join(dir, 'x.db'));
    assert.equal(check.prepare(`select status from post_job where mint = 'M'`).get().status, 'skipped');
    check.close();
    assert.match(run('unblock', 'alice'), /Unblocked @alice/);
    assert.match(run('--unblock', 'alice'), /was not blocked/);
    assert.match(run('list'), /Nobody is blocked/);
    assert.throws(() => run('not a handle!'), /not an Instagram username/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('webhooks: the Instagram app secret or META_APP_SECRET; anything else is refused', async () => {
  const t = await start({ config: { metaAppSecret: 'meta-secret' } });
  try {
    assert.equal((await mentionHook(t, 'c1', 'm1', 'app-secret')).status, 200);
    assert.equal((await mentionHook(t, 'c2', 'm1', 'meta-secret')).status, 200);
    assert.equal((await mentionHook(t, 'c3', 'm1', 'other')).status, 401);
  } finally { t.close(); }
  const plain = await start();
  try {
    assert.equal((await mentionHook(plain, 'c1', 'm1', 'meta-secret')).status, 401, 'no second secret unless set');
    assert.equal((await mentionHook(plain, 'c1', 'm1', '')).status, 401);
  } finally { plain.close(); }
});

test('uploads must be the image they say they are: an SVG or other bytes sent as a PNG are refused', async () => {
  const t = await start();
  try {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#f00' } }).png().toBuffer();
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#f00' } }).jpeg().toBuffer();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><text x="10" y="200">ANY TEXT</text></svg>');
    const prepare = (type, buf) => t.post('/api/launch/prepare', {
      username: 'alice', name: 'Coin', symbol: 'COIN', launcher: launcher(), imageBase64: `data:${type};base64,${buf.toString('base64')}`,
    });
    for (const [type, buf] of [['image/png', svg], ['image/png', jpeg], ['image/jpeg', png], ['image/gif', png], ['image/webp', Buffer.from('RIFF0000WEBX')]]) {
      const r = await prepare(type, buf);
      assert.equal(r.status, 400, `${type} with other bytes`);
      assert.match((await r.json()).error, /not the PNG, JPEG, WebP or GIF it says it is/);
    }
    assert.equal((await prepare('image/png', png)).status, 200);
    assert.equal((await prepare('image/jpeg', jpeg)).status, 200);
    assert.equal(t.db.prepare('select count(*) n from token').get().n, 2, 'nothing was prepared for the refused ones');
    assert.equal(sniffImage(Buffer.from('GIF89a......')), 'image/gif');
    assert.equal(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
    assert.equal(sniffImage(null), null);
  } finally { t.close(); }
});

test('GRAPH_BASE_URL: comment reads and replies go to the stand-in Graph API', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(`${init?.method ?? 'GET'} ${new URL(url).origin}${new URL(url).pathname}`);
    return new Response(JSON.stringify({ mentioned_comment: { text: 'hi', media: { id: 'm' } } }), { headers: { 'content-type': 'application/json' } });
  };
  const cfg = { graphBaseUrl: 'http://127.0.0.1:9999', fbGraphVersion: 'v23.0', igUserId: '42', fbAccessToken: 'fb' };
  await readMention(cfg, { commentId: 'c1' }, fetchImpl);
  await replyToMention(cfg, { commentId: 'c1', mediaId: 'm1' }, 'hello', fetchImpl);
  await readMention({ ...cfg, graphBaseUrl: undefined }, { commentId: 'c1' }, fetchImpl);
  assert.deepEqual(seen, ['GET http://127.0.0.1:9999/v23.0/42', 'POST http://127.0.0.1:9999/v23.0/42/mentions', 'GET https://graph.facebook.com/v23.0/42']);
});
