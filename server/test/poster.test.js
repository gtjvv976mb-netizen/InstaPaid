// The auto-poster against a fake Graph API: the publish sequence, pacing, retries, the circuit
// breaker, opt-outs, and never posting a coin twice, also across a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import sharp from 'sharp';
import { openDb } from '../src/db.js';
import { createPoster, postCaption, CAPTION_MAX, BACKOFF } from '../src/poster.js';
import { blockCreator } from '../src/blocks.js';
import { start, mentionHook, tick, launcher } from './helpers.js';

const IG = '17841400000000000';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY_MS = 24 * HOUR;

/** A fake graph.facebook.com: containers, their status, publishing, the feed, the quota. */
function fakeGraph({ statuses = ['FINISHED'], quota = { usage: 0, total: 100 } } = {}) {
  const g = { calls: [], containers: new Map(), feed: [], quota, statuses, fail: { create: 0, publish: 0, lost: 0, quota: 0, status: 0 } };
  let n = 0;
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  const err = (message, status = 400) => json({ error: { message, type: 'OAuthException', code: 9004 } }, status);
  g.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const params = method === 'GET' ? u.searchParams : new URLSearchParams(init.body);
    assert.equal(u.origin, 'https://graph.facebook.com');
    assert.equal(params.get('access_token'), 'fb', 'every call carries the Facebook-Login token');
    const path = u.pathname.replace(/^\/v23\.0\//, '');
    g.calls.push({ method, path, params: Object.fromEntries([...params].filter(([k]) => k !== 'access_token')) });
    if (path === `${IG}/content_publishing_limit`) {
      if (g.fail.quota-- > 0) return err('quota lookup failed', 500);
      return json({ data: [{ quota_usage: g.quota.usage, config: { quota_total: g.quota.total, quota_duration: 86400 } }] });
    }
    if (path === `${IG}/media` && method === 'POST') {
      if (g.fail.create-- > 0) return err('Media upload failed', 400);
      const id = `c${++n}`;
      g.containers.set(id, { seq: [...g.statuses], caption: params.get('caption'), imageUrl: params.get('image_url'), published: false });
      return json({ id });
    }
    if (path === `${IG}/media` && method === 'GET') return json({ data: [...g.feed].reverse() });
    if (path === `${IG}/media_publish` && method === 'POST') {
      const c = g.containers.get(params.get('creation_id'));
      if (!c) return err('no such container');
      if (c.published) return err('This media has already been published');
      if (g.fail.publish-- > 0) return err('An unknown error occurred', 500);
      c.published = true;
      const id = `media${g.feed.length + 1}`;
      g.feed.push({ id, caption: c.caption, permalink: `https://www.instagram.com/p/POST${g.feed.length + 1}/` });
      if (g.fail.lost-- > 0) throw new TypeError('fetch failed'); // published, but the answer never arrives
      return json({ id });
    }
    if (g.containers.has(path)) {
      if (g.fail.status-- > 0) return err('status unavailable', 500);
      const c = g.containers.get(path);
      const code = c.published ? 'PUBLISHED' : (c.seq.length > 1 ? c.seq.shift() : c.seq[0]);
      return json({ status_code: code, id: path });
    }
    const media = g.feed.find((m) => m.id === path);
    if (media) return json({ id: media.id, permalink: media.permalink });
    return err(`unknown ${method} ${path}`, 404);
  };
  g.count = (method, path) => g.calls.filter((c) => c.method === method && c.path === path).length;
  return g;
}

/** A poster over its own database, with a clock the test moves. `review` stands in for Claude's check of website launches. */
function setup({ config = {}, graph = fakeGraph(), render, review = async () => ({ nameOk: true, pictureOk: true }) } = {}) {
  const db = openDb(':memory:');
  const postsDir = mkdtempSync(join(tmpdir(), 'instapaid-poster-'));
  const cfg = {
    publicUrl: 'https://instapaid.test', igUserId: IG, fbAccessToken: 'fb', fbGraphVersion: 'v23.0',
    autoPost: true, postMaxPerDay: 25, postMinGapMin: 20, postMaxAgeH: 24, postsDir, ...config,
  };
  const clock = { t: Date.UTC(2026, 8, 27, 12) };
  const logs = [];
  const log = { log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')), warn: () => {} };
  const reviews = [];
  const make = () => createPoster({
    db, cfg, fetchImpl: graph.fetch, now: () => clock.t, sleep: async () => {}, log,
    render: render ?? (async () => Buffer.from('jpeg')),
    review: async (args) => { reviews.push(args); return review(args); },
  });
  const ctx = { db, cfg, clock, graph, logs, postsDir, reviews, poster: make(), restart: () => { ctx.poster = make(); return ctx.poster; } };
  ctx.coin = (username = 'nat.geo', extra = {}) => {
    const mint = Keypair.generate().publicKey.toBase58();
    db.prepare(`insert or ignore into account (username, vault_pubkey, vault_secret, created_at) values (?, ?, 'x', 0)`)
      .run(username, Keypair.generate().publicKey.toBase58());
    db.prepare(
      `insert into token (mint, username, name, symbol, launcher, lore, source, post_permalink, status, created_at)
       values (?, ?, ?, ?, 'L', ?, ?, ?, 'live', ?)`
    ).run(mint, username, extra.name ?? 'Golden Hour', extra.symbol ?? 'GEO', extra.lore ?? null, extra.source ?? 'comment',
      extra.post_permalink ?? null, clock.t);
    return mint;
  };
  ctx.job = (mint) => db.prepare('select * from post_job where mint = ?').get(mint);
  ctx.advance = (ms) => { clock.t += ms; };
  ctx.done = () => rmSync(postsDir, { recursive: true, force: true });
  return ctx;
}

test('caption: exact words, the creator tagged, the lore quoted, within Instagram\'s limits', () => {
  const mint = '7'.repeat(44);
  const c = postCaption({ username: 'nat.geo', symbol: 'GEO', mint, lore: 'king of sunsets', post_permalink: 'https://www.instagram.com/p/DAbc/' }, 'https://instapaid.fun');
  assert.equal(c, '$GEO is live for @nat.geo 🚀\n\n'
    + '@nat.geo — this coin\'s creator fees are yours. Only you can claim them: instapaid.fun/u/nat.geo\n\n'
    + '"king of sunsets"\n\n'
    + 'Original post: https://www.instagram.com/p/DAbc/\n'
    + `Coin: pump.fun/coin/${mint}\n\n`
    + 'Fan-made, not by @nat.geo. Not financial advice.\n#memecoin #solana #pumpfun');

  const plain = postCaption({ username: 'alice', symbol: 'ALI', mint, lore: null, post_permalink: null }, 'https://instapaid.fun');
  assert.equal(plain, '$ALI is live for @alice 🚀\n\n'
    + '@alice — this coin\'s creator fees are yours. Only you can claim them: instapaid.fun/u/alice\n\n'
    + `Coin: pump.fun/coin/${mint}\n\n`
    + 'Fan-made, not by @alice. Not financial advice.\n#memecoin #solana #pumpfun');

  // a lore full of tags and mentions is quoted, not tagged; the worst case still fits
  const nasty = postCaption({
    username: 'a'.repeat(30), symbol: 'ABCDEFGHIJ', mint,
    lore: ('#tag @someone ＠wide ＃wide ').repeat(40).slice(0, 400), post_permalink: `https://www.instagram.com/p/${'x'.repeat(250)}/`,
  }, 'https://instapaid.fun');
  assert.ok(nasty.length <= CAPTION_MAX, nasty.length);
  assert.equal((nasty.match(/#[\p{L}\p{N}_]/gu) ?? []).length, 3, 'only our three hashtags');
  const handles = new Set((nasty.match(/@[\w.]+/g) ?? []).map((h) => h.replace(/\.+$/, '')));
  assert.deepEqual([...handles], ['@' + 'a'.repeat(30)], 'only the creator is mentioned');
  assert.ok((nasty.match(/@/g) ?? []).length <= 20);

  const huge = postCaption({ username: 'u', symbol: 'U', mint, lore: 'z'.repeat(5000), post_permalink: null }, 'https://instapaid.fun');
  assert.ok(huge.length <= CAPTION_MAX);
  assert.match(huge, /"z+…"/);
});

test('publish: publishing limit, container with the card and caption, wait for FINISHED, publish, permalink', async () => {
  const ctx = setup({ graph: fakeGraph({ statuses: ['IN_PROGRESS', 'IN_PROGRESS', 'FINISHED'] }) });
  try {
    const mint = ctx.coin('nat.geo', { lore: 'king of sunsets', post_permalink: 'https://www.instagram.com/p/DAbc/' });
    assert.equal(await ctx.poster.enqueue(mint, { buf: Buffer.from([1]), type: 'image/png' }), true);
    assert.ok(existsSync(join(ctx.postsDir, `${mint}.jpg`)), 'the card is drawn when the coin goes live');
    assert.equal(await ctx.poster.enqueue(mint), false, 'one job per coin');

    assert.equal(await ctx.poster.tick(), 'posted');
    const seq = ctx.graph.calls.map((c) => `${c.method} ${c.path}`);
    assert.deepEqual(seq, [
      `GET ${IG}/content_publishing_limit`,
      `POST ${IG}/media`,
      'GET c1', 'GET c1', 'GET c1',
      `POST ${IG}/media_publish`,
      'GET media1',
    ]);
    assert.deepEqual(ctx.graph.calls[0].params, { fields: 'quota_usage,config' });
    const create = ctx.graph.calls[1].params;
    assert.equal(create.image_url, `https://instapaid.test/posts/${mint}.jpg`);
    assert.equal(create.caption, postCaption(ctx.db.prepare('select * from token').get(), 'https://instapaid.test'));
    assert.match(create.caption, /"king of sunsets"/);
    assert.deepEqual(ctx.graph.calls[2].params, { fields: 'status_code,status' });
    assert.deepEqual(ctx.graph.calls[5].params, { creation_id: 'c1' });
    assert.deepEqual(ctx.graph.calls[6].params, { fields: 'permalink' });

    const j = ctx.job(mint);
    assert.equal(j.status, 'posted');
    assert.equal(j.container_id, 'c1');
    assert.equal(j.media_id, 'media1');
    assert.equal(j.permalink, 'https://www.instagram.com/p/POST1/');
    assert.equal(j.attempts, 1);
    assert.equal(j.posted_at, ctx.clock.t);
    assert.equal(await ctx.poster.tick(), 'gap');
  } finally { ctx.done(); }
});

test('the publishing limit is checked first: used up → nothing is made this tick', async () => {
  const ctx = setup({ graph: fakeGraph({ quota: { usage: 100, total: 100 } }) });
  try {
    const mint = ctx.coin();
    await ctx.poster.enqueue(mint);
    assert.equal(await ctx.poster.tick(), 'quota');
    assert.equal(ctx.graph.count('POST', `${IG}/media`), 0);
    assert.equal(ctx.job(mint).status, 'queued');
    assert.equal(ctx.job(mint).attempts, 0, 'a full quota is not a failed attempt');
    ctx.graph.quota.usage = 99;
    assert.equal(await ctx.poster.tick(), 'posted');
  } finally { ctx.done(); }
});

test('pacing: at least POST_MIN_GAP_MIN apart, at most POST_MAX_PER_DAY in any 24 hours', async () => {
  const ctx = setup({ config: { postMaxPerDay: 2, postMinGapMin: 20, postMaxAgeH: 100 } });
  try {
    const [a, b, c] = [ctx.coin('a1'), ctx.coin('a2'), ctx.coin('a3')];
    for (const m of [a, b, c]) await ctx.poster.enqueue(m);
    assert.equal(await ctx.poster.tick(), 'posted');
    assert.equal(ctx.job(a).status, 'posted', 'oldest first');
    ctx.advance(19 * MIN);
    assert.equal(await ctx.poster.tick(), 'gap');
    ctx.advance(1 * MIN);
    assert.equal(await ctx.poster.tick(), 'posted');
    assert.equal(ctx.job(b).status, 'posted');
    ctx.advance(3 * HOUR);
    assert.equal(await ctx.poster.tick(), 'daily-cap');
    assert.equal(ctx.job(c).status, 'queued');
    ctx.advance(21 * HOUR - 20 * MIN + 1); // 24 h after the first post
    assert.equal(await ctx.poster.tick(), 'posted');
    assert.equal(ctx.graph.feed.length, 3);
  } finally { ctx.done(); }
});

test('a coin not posted within POST_MAX_AGE_H is skipped', async () => {
  const ctx = setup({ graph: fakeGraph({ quota: { usage: 100, total: 100 } }) });
  try {
    const mint = ctx.coin();
    await ctx.poster.enqueue(mint);
    assert.equal(await ctx.poster.tick(), 'quota');
    ctx.advance(24 * HOUR + 1);
    ctx.graph.quota.usage = 0;
    assert.equal(await ctx.poster.tick(), 'idle');
    assert.equal(ctx.job(mint).status, 'skipped');
    assert.match(ctx.job(mint).last_error, /within 24 h/);
    assert.equal(ctx.graph.count('POST', `${IG}/media`), 0);
  } finally { ctx.done(); }
});

test('retries: 5 min, 30 min, 2 h, then failed; a failure then a success posts once', async () => {
  const ctx = setup();
  try {
    const mint = ctx.coin();
    await ctx.poster.enqueue(mint);
    ctx.graph.fail.create = 1;
    assert.equal(await ctx.poster.tick(), 'failed');
    let j = ctx.job(mint);
    assert.equal(j.status, 'queued');
    assert.equal(j.attempts, 1);
    assert.equal(j.next_attempt_at, ctx.clock.t + 5 * MIN);
    assert.match(j.last_error, /Media upload failed/);
    assert.doesNotMatch(j.last_error, /fb/, 'no token in errors');
    ctx.advance(5 * MIN - 1);
    assert.equal(await ctx.poster.tick(), 'idle');
    ctx.advance(1);
    assert.equal(await ctx.poster.tick(), 'posted');
    assert.equal(ctx.job(mint).attempts, 2);
    assert.equal(ctx.graph.feed.length, 1);
  } finally { ctx.done(); }

  const worse = setup();
  try {
    const mint = worse.coin();
    await worse.poster.enqueue(mint);
    worse.graph.fail.create = 99;
    const waits = [];
    for (let i = 0; i < 4; i++) {
      assert.equal(await worse.poster.tick(), 'failed');
      const j = worse.job(mint);
      if (j.status === 'queued') { waits.push(j.next_attempt_at - worse.clock.t); worse.clock.t = j.next_attempt_at; }
    }
    assert.deepEqual(waits, BACKOFF);
    assert.deepEqual(BACKOFF, [5 * MIN, 30 * MIN, 2 * HOUR]);
    const j = worse.job(mint);
    assert.equal(j.status, 'failed');
    assert.equal(j.attempts, 4, 'the first try and three retries');
    worse.advance(10 * HOUR);
    assert.equal(await worse.poster.tick(), 'idle', 'a failed job is not tried again');
  } finally { worse.done(); }
});

test('circuit breaker: 3 failures in a row pause posting for an hour, and it is logged', async () => {
  const ctx = setup();
  try {
    const mints = [ctx.coin('u1'), ctx.coin('u2'), ctx.coin('u3')];
    for (const m of mints) await ctx.poster.enqueue(m);
    ctx.graph.fail.create = 2;
    ctx.graph.fail.quota = 0;
    assert.equal(await ctx.poster.tick(), 'failed');
    assert.equal(await ctx.poster.tick(), 'failed'); // u2 (u1 waits 5 min)
    ctx.graph.fail.quota = 1; // a failing lookup counts too
    assert.equal(await ctx.poster.tick(), 'error');
    assert.ok(ctx.logs.some((l) => /3 failures in a row; posting paused for an hour/.test(l)));
    ctx.advance(10 * MIN);
    assert.equal(await ctx.poster.tick(), 'paused');
    assert.equal(ctx.graph.calls.length, 5, 'nothing is called while paused');
    // survives a restart: the pause is in the database
    ctx.restart();
    assert.equal(await ctx.poster.tick(), 'paused');
    ctx.advance(50 * MIN);
    assert.equal(await ctx.poster.tick(), 'posted');
  } finally { ctx.done(); }
});

test('restart during a post: the stored container is published once, not made again', async () => {
  const ctx = setup();
  try {
    const mint = ctx.coin();
    await ctx.poster.enqueue(mint);
    // what the database holds when the process dies after the container is made, before media_publish
    ctx.graph.containers.set('c9', { seq: ['FINISHED'], caption: 'x', published: false });
    ctx.db.prepare(`update post_job set status = 'posting', attempts = 1, container_id = 'c9' where mint = ?`).run(mint);
    ctx.restart();
    assert.equal(await ctx.poster.tick(), 'posted');
    assert.equal(ctx.graph.count('POST', `${IG}/media`), 0, 'no new container');
    assert.equal(ctx.graph.count('POST', `${IG}/media_publish`), 1);
    assert.equal(ctx.graph.feed.length, 1);
    assert.equal(ctx.job(mint).status, 'posted');
    assert.equal(ctx.job(mint).attempts, 2);
  } finally { ctx.done(); }
});

test('restart after the post went out but before it was recorded: found on the feed, never posted again', async () => {
  const ctx = setup();
  try {
    const mint = ctx.coin();
    await ctx.poster.enqueue(mint);
    ctx.graph.containers.set('c9', { seq: ['FINISHED'], caption: `… pump.fun/coin/${mint} …`, published: true });
    ctx.graph.feed.push({ id: 'media77', caption: `… pump.fun/coin/${mint} …`, permalink: 'https://www.instagram.com/p/SEVENTY7/' });
    ctx.db.prepare(`update post_job set status = 'posting', attempts = 1, container_id = 'c9' where mint = ?`).run(mint);
    ctx.restart();
    assert.equal(await ctx.poster.tick(), 'posted');
    assert.equal(ctx.graph.count('POST', `${IG}/media_publish`), 0);
    assert.equal(ctx.graph.count('POST', `${IG}/media`), 0);
    const j = ctx.job(mint);
    assert.equal(j.status, 'posted');
    assert.equal(j.media_id, 'media77');
    assert.equal(j.permalink, 'https://www.instagram.com/p/SEVENTY7/');
  } finally { ctx.done(); }
});

test('a publish whose answer is lost is retried as a lookup, not a second post', async () => {
  const ctx = setup();
  try {
    const mint = ctx.coin();
    await ctx.poster.enqueue(mint);
    ctx.graph.fail.lost = 1;
    assert.equal(await ctx.poster.tick(), 'failed');
    assert.equal(ctx.job(mint).status, 'queued');
    assert.equal(ctx.job(mint).container_id, 'c1', 'the container is kept');
    ctx.advance(5 * MIN);
    ctx.restart(); // and a restart in between changes nothing
    assert.equal(await ctx.poster.tick(), 'posted');
    assert.equal(ctx.graph.count('POST', `${IG}/media_publish`), 1);
    assert.equal(ctx.graph.feed.length, 1);
    assert.equal(ctx.job(mint).media_id, 'media1');
    assert.equal(ctx.job(mint).permalink, 'https://www.instagram.com/p/POST1/');
    ctx.advance(HOUR);
    assert.equal(await ctx.poster.tick(), 'idle');
    assert.equal(ctx.graph.feed.length, 1);
  } finally { ctx.done(); }
});

test('a container Instagram rejects (ERROR) is dropped and the retry makes a new one', async () => {
  const ctx = setup({ graph: fakeGraph({ statuses: ['ERROR'] }) });
  try {
    const mint = ctx.coin();
    await ctx.poster.enqueue(mint);
    assert.equal(await ctx.poster.tick(), 'failed');
    assert.equal(ctx.job(mint).container_id, null);
    assert.match(ctx.job(mint).last_error, /container ERROR/);
    ctx.graph.statuses = ['FINISHED'];
    ctx.advance(5 * MIN);
    assert.equal(await ctx.poster.tick(), 'posted');
    assert.equal(ctx.graph.count('POST', `${IG}/media`), 2);
    assert.equal(ctx.graph.feed.length, 1);
  } finally { ctx.done(); }
});

test('opted-out creators: not queued, and queued posts are skipped', async () => {
  const ctx = setup();
  try {
    const before = ctx.coin('alice');
    const after = ctx.coin('bob');
    blockCreator(ctx.db, 'alice');
    assert.equal(await ctx.poster.enqueue(before), false);
    assert.equal(ctx.job(before), undefined);
    assert.equal(await ctx.poster.enqueue(after), true);
    assert.equal(blockCreator(ctx.db, '@Bob', 'asked by DM'), 1, 'their waiting post is skipped');
    assert.equal(ctx.job(after).status, 'skipped');
    assert.equal(await ctx.poster.tick(), 'idle');
    assert.equal(ctx.graph.calls.length, 0);
    // blocked while a post was half made: skipped unless it already went out
    const carol = ctx.coin('carol');
    await ctx.poster.enqueue(carol);
    ctx.graph.containers.set('c5', { seq: ['FINISHED'], caption: 'x', published: false });
    ctx.db.prepare(`update post_job set status = 'posting', container_id = 'c5' where mint = ?`).run(carol);
    blockCreator(ctx.db, 'carol');
    assert.equal(await ctx.poster.tick(), 'skipped');
    assert.equal(ctx.graph.count('POST', `${IG}/media_publish`), 0);
  } finally { ctx.done(); }
});

test('a website launch\'s picture is kept small until confirm; one sharp cannot read is not kept', async () => {
  const ctx = setup();
  try {
    const mint = ctx.coin();
    const big = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#3366ff' } }).png().toBuffer();
    assert.equal(await ctx.poster.keepSource(mint, { buf: big, type: 'image/png' }), true);
    const kept = await sharp(join(ctx.postsDir, 'src', `${mint}.jpg`)).metadata();
    assert.deepEqual([kept.format, kept.width, kept.height], ['jpeg', 1080, 720]);
    const other = ctx.coin('bob');
    assert.equal(await ctx.poster.keepSource(other, { buf: Buffer.from([1, 2, 3]), type: 'image/png' }), false);
    assert.equal(await ctx.poster.keepSource('../../etc/passwd', { buf: big, type: 'image/png' }), false);
    assert.deepEqual(readdirSync(join(ctx.postsDir, 'src')), [`${mint}.jpg`]);
  } finally { ctx.done(); }
});

test('AUTO_POST off (or no https PUBLIC_URL, or no Instagram user): nothing is drawn, queued or called', async () => {
  for (const config of [{ autoPost: false }, { publicUrl: 'http://localhost:8787' }, { igUserId: '' }]) {
    const ctx = setup({ config });
    try {
      const mint = ctx.coin();
      assert.ok(ctx.poster.off());
      assert.equal(await ctx.poster.enqueue(mint, { buf: Buffer.from([1]), type: 'image/png' }), false);
      assert.equal(await ctx.poster.keepSource(mint, await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).png().toBuffer().then((buf) => ({ buf, type: 'image/png' }))), false);
      assert.equal(await ctx.poster.tick(), 'off');
      assert.equal(ctx.graph.calls.length, 0);
      assert.equal(ctx.db.prepare('select count(*) n from post_job').get().n, 0);
      assert.deepEqual(readdirSync(ctx.postsDir), []);
    } finally { ctx.done(); }
  }
});

test('in the app: a comment launch and a website launch each queue one post with a real card', async () => {
  const g = fakeGraph();
  const t = await start({
    config: { autoPost: true },
    graph: g.fetch,
    mentions: { c1: { text: '@instapaid.official make a token for this creator: king of sunsets', media: {
      id: 'm1', media_type: 'IMAGE', media_url: 'https://scontent.cdninstagram.com/p.jpg', caption: 'Sunrise',
      permalink: 'https://www.instagram.com/p/DAbc/', username: 'nat.geo',
    } } },
  });
  try {
    assert.equal((await mentionHook(t, 'c1')).status, 200);
    await tick(); await t.drain();
    const comment = t.db.prepare(`select * from token where source = 'comment'`).get();
    assert.equal(t.db.prepare('select status from post_job where mint = ?').get(comment.mint).status, 'queued');
    // the post was queued, so the reply promises it (in the future tense: it has not gone out yet)
    assert.ok(t.calls.mentionReplies[0].message.includes("📣 We'll post it on our feed and tag @nat.geo."));
    const card = await sharp(join(t.postsDir, `${comment.mint}.jpg`)).metadata();
    assert.deepEqual([card.format, card.width, card.height], ['jpeg', 1080, 1350]);

    // website: the picture is kept at prepare, the card drawn at confirm
    const upload = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#3366ff' } }).png().toBuffer();
    const p = await (await t.post('/api/launch/prepare', {
      username: 'alice', name: 'Alice Coin', symbol: 'ALI', launcher: launcher(),
      imageBase64: `data:image/png;base64,${upload.toString('base64')}`,
    })).json();
    assert.ok(existsSync(join(t.postsDir, 'src', `${p.mint}.jpg`)), 'the upload is kept (as a small JPEG)');
    assert.equal(t.db.prepare('select count(*) n from post_job where mint = ?').get(p.mint).n, 0, 'nothing before it is live');
    assert.equal((await t.post('/api/launch/confirm', { mint: p.mint, signature: 's' })).status, 200);
    assert.equal((await t.post('/api/launch/confirm', { mint: p.mint, signature: 's' })).status, 200);
    await t.poster.settled(); // confirm answers first; Claude's check and the card come after
    assert.equal(t.db.prepare('select count(*) n from post_job where mint = ?').get(p.mint).n, 1);
    assert.equal(t.calls.reviews.length, 1, 'the website launch was checked, once');
    assert.equal(t.calls.reviews[0].name, 'Alice Coin');
    assert.equal(t.calls.reviews[0].symbol, 'ALI');
    assert.equal(t.calls.reviews[0].image.type, 'image/jpeg', 'Claude sees the kept picture');
    assert.ok(existsSync(join(t.postsDir, `${p.mint}.jpg`)));
    assert.ok(!existsSync(join(t.postsDir, 'src', `${p.mint}.jpg`)), 'the kept picture is removed once drawn');
    // the card shows the uploaded picture: its middle is the upload's blue
    const { data } = await sharp(join(t.postsDir, `${p.mint}.jpg`)).extract({ left: 520, top: 420, width: 40, height: 40 }).raw().toBuffer({ resolveWithObject: true });
    assert.ok(Math.abs(data[0] - 0x33) < 12 && Math.abs(data[2] - 0xff) < 12, `picture is the upload (${data[0]},${data[1]},${data[2]})`);

    // the worker posts the comment coin first; its card is public at the address Instagram is given
    assert.equal(await t.poster.tick(), 'posted');
    const create = g.calls.find((c) => c.method === 'POST' && c.path.endsWith('/media'));
    assert.equal(create.params.image_url, `https://instapaid.test/posts/${comment.mint}.jpg`);
    assert.match(create.params.caption, /"king of sunsets"/);
    assert.match(create.params.caption, /Original post: https:\/\/www\.instagram\.com\/p\/DAbc\//);
    const served = await t.get(`/posts/${comment.mint}.jpg`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/jpeg');
  } finally { t.close(); }
});

test('in the app with AUTO_POST off: launches work and nothing is queued or kept', async () => {
  const t = await start({ mentions: { c1: { text: '@instapaid.official make a token', media: {
    id: 'm1', media_type: 'IMAGE', media_url: 'https://scontent.cdninstagram.com/p.jpg', username: 'nat.geo',
  } } } });
  try {
    await mentionHook(t, 'c1'); await tick(); await t.drain();
    const p = await (await t.post('/api/launch/prepare', {
      username: 'alice', name: 'A', symbol: 'A', launcher: launcher(), imageUrl: 'https://a.cdninstagram.com/p.jpg',
    })).json();
    await t.post('/api/launch/confirm', { mint: p.mint, signature: 's' });
    assert.equal(t.db.prepare(`select count(*) n from token where status = 'live'`).get().n, 2);
    assert.equal(t.db.prepare('select count(*) n from post_job').get().n, 0);
    assert.deepEqual(readdirSync(t.postsDir), []);
    assert.equal(await t.poster.tick(), 'off');
  } finally { t.close(); }
});

// Nobody can make our account mention the same creator again and again, and a burst of website
// launches cannot push comment launches back.
test('one post per creator in POST_CREATOR_GAP_DAYS: a second coin is skipped with the reason, later ones allowed', async () => {
  const ctx = setup({ config: { postCreatorGapDays: 30, postMaxAgeH: 0 } });
  try {
    const first = ctx.coin('victim.person', { source: 'web' });
    const second = ctx.coin('victim.person', { source: 'web' });
    assert.equal(await ctx.poster.enqueue(first), true);
    assert.equal(await ctx.poster.enqueue(second), false);
    assert.equal(ctx.job(second).status, 'skipped');
    assert.match(ctx.job(second).last_error, /another coin for @victim\.person is waiting/);
    assert.equal(await ctx.poster.tick(), 'posted');
    ctx.advance(DAY_MS);
    const third = ctx.coin('victim.person', { source: 'comment' });
    assert.equal(await ctx.poster.enqueue(third), false);
    assert.match(ctx.job(third).last_error, /@victim\.person was posted about in the last 30 days/);
    ctx.advance(30 * DAY_MS);
    const fourth = ctx.coin('victim.person', { source: 'comment' });
    assert.equal(await ctx.poster.enqueue(fourth), true, '30 days on, a new coin is posted again');
    // a post that failed for good does not count: the creator's next coin may be posted
    ctx.db.prepare(`update post_job set status = 'failed' where mint = ?`).run(fourth);
    const fifth = ctx.coin('victim.person');
    assert.equal(await ctx.poster.enqueue(fifth), true);
    // and 0 switches the limit off
    const off = setup({ config: { postCreatorGapDays: 0 } });
    try {
      assert.equal(await off.poster.enqueue(off.coin('a')), true);
      assert.equal(await off.poster.enqueue(off.coin('a')), true);
    } finally { off.done(); }
  } finally { ctx.done(); }
});

test('comment launches are posted before website launches queued earlier', async () => {
  const ctx = setup({ config: { postCreatorGapDays: 0 } });
  try {
    const web1 = ctx.coin('w1', { source: 'web' });
    const web2 = ctx.coin('w2', { source: 'web' });
    await ctx.poster.enqueue(web1);
    await ctx.poster.enqueue(web2);
    ctx.advance(10 * MIN);
    const comment = ctx.coin('c1', { source: 'comment' });
    await ctx.poster.enqueue(comment);
    assert.equal(await ctx.poster.tick(), 'posted');
    assert.equal(ctx.job(comment).status, 'posted', 'the comment launch went first');
    assert.equal(ctx.job(web1).status, 'queued');
    ctx.advance(20 * MIN);
    assert.equal(await ctx.poster.tick(), 'posted');
    assert.equal(ctx.job(web1).status, 'posted', 'then the website launches, oldest first');
  } finally { ctx.done(); }
});

test('the review scenario: 26 website coins for one handle and a comment coin 10 minutes later', async () => {
  const ctx = setup();
  try {
    const web = [];
    for (let i = 0; i < 26; i++) web.push(ctx.coin('victim.person', { source: 'web' }));
    for (const m of web) await ctx.poster.enqueue(m);
    ctx.advance(10 * MIN);
    const legit = ctx.coin('real.creator', { source: 'comment' });
    await ctx.poster.enqueue(legit);
    const postedAt = {};
    for (let m = 0; m < 26 * 60; m++) {
      await ctx.poster.tick();
      for (const mint of [legit, ...web]) if (!postedAt[mint] && ctx.job(mint).status === 'posted') postedAt[mint] = ctx.clock.t;
      ctx.advance(MIN);
    }
    const count = ctx.db.prepare(`select k.username, j.status, count(*) n from post_job j join token k using (mint) group by 1, 2 order by 1, 2`).all();
    assert.deepEqual(count, [
      { username: 'real.creator', status: 'posted', n: 1 },
      { username: 'victim.person', status: 'posted', n: 1 },
      { username: 'victim.person', status: 'skipped', n: 25 },
    ]);
    const start = Date.UTC(2026, 8, 27, 12);
    assert.ok(postedAt[legit] - start <= 30 * MIN, `the real creator's post went out within 30 minutes (${(postedAt[legit] - start) / MIN} min)`);
  } finally { ctx.done(); }
});

test('website launches are checked by Claude: a failed name or no Claude means no post; a failed picture means the default coin', async () => {
  const upload = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#3366ff' } }).png().toBuffer();
  const verdicts = { 'good.name': { nameOk: true, pictureOk: true }, 'bad.name': { nameOk: false, pictureOk: true }, 'bad.picture': { nameOk: true, pictureOk: false }, 'no.claude': null };
  const { renderCard } = await import('../src/card.js');
  const ctx = setup({ review: async ({ username }) => verdicts[username], render: async (a) => (await renderCard(a)).jpeg });
  try {
    const mints = {};
    for (const u of Object.keys(verdicts)) {
      mints[u] = ctx.coin(u, { source: 'web', name: `${u} coin`, symbol: 'WEB' });
      assert.equal(await ctx.poster.keepSource(mints[u], { buf: upload, type: 'image/png' }), true);
    }
    for (const u of Object.keys(verdicts)) await ctx.poster.enqueue(mints[u]);
    assert.deepEqual(ctx.reviews.map((r) => [r.username, r.name, r.symbol, r.image?.type]), Object.keys(verdicts).map((u) => [u, `${u} coin`, 'WEB', 'image/jpeg']));

    assert.equal(ctx.job(mints['good.name']).status, 'queued');
    assert.equal(ctx.job(mints['bad.name']).status, 'skipped');
    assert.match(ctx.job(mints['bad.name']).last_error, /name or ticker did not pass/);
    assert.equal(ctx.job(mints['no.claude']).status, 'skipped');
    assert.match(ctx.job(mints['no.claude']).last_error, /Claude unavailable/);
    assert.equal(ctx.job(mints['bad.picture']).status, 'queued');
    assert.match(ctx.job(mints['bad.picture']).last_error, /picture did not pass/);
    // no card and no kept picture for the ones not posted; the kept pictures are gone for all
    assert.ok(!existsSync(join(ctx.postsDir, `${mints['bad.name']}.jpg`)));
    assert.deepEqual(readdirSync(join(ctx.postsDir, 'src')), []);

    const centre = async (mint) => {
      const { data } = await sharp(join(ctx.postsDir, `${mint}.jpg`)).extract({ left: 520, top: 420, width: 40, height: 40 }).raw().toBuffer({ resolveWithObject: true });
      return [data[0], data[1], data[2]];
    };
    const blue = (px) => Math.abs(px[0] - 0x33) < 14 && Math.abs(px[2] - 0xff) < 14;
    assert.ok(blue(await centre(mints['good.name'])), 'a passed picture is drawn');
    assert.ok(!blue(await centre(mints['bad.picture'])), 'a failed picture is not drawn');

    // comment launches are named by Claude from the creator's own post: no second check
    const n = ctx.reviews.length;
    await ctx.poster.enqueue(ctx.coin('commenter', { source: 'comment' }), { buf: upload, type: 'image/png' });
    assert.equal(ctx.reviews.length, n);
  } finally { ctx.done(); }
});

test('kept pictures are sniffed: an SVG or anything else sent as a PNG is never kept or drawn', async () => {
  const ctx = setup();
  try {
    const svgs = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#fff"/><text x="10" y="200" font-size="40">ANY TEXT</text></svg>',
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"/>',
    ];
    for (const svg of svgs) assert.equal(await ctx.poster.keepSource(ctx.coin(), { buf: Buffer.from(svg), type: 'image/png' }), false);
    const tiff = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).tiff().toBuffer();
    assert.equal(await ctx.poster.keepSource(ctx.coin(), { buf: tiff, type: 'image/png' }), false);
    assert.ok(!existsSync(join(ctx.postsDir, 'src')) || readdirSync(join(ctx.postsDir, 'src')).length === 0);
    // and the card never draws one: the default coin instead
    const { renderCard } = await import('../src/card.js');
    const svgCard = await renderCard({ image: { buf: Buffer.from(svgs[0]), type: 'image/png' }, symbol: 'A', name: 'A', username: 'a', publicUrl: 'https://x' });
    const defaultCard = await renderCard({ image: null, symbol: 'A', name: 'A', username: 'a', publicUrl: 'https://x' });
    const px = async (jpeg) => [...(await sharp(jpeg).extract({ left: 520, top: 420, width: 1, height: 1 }).raw().toBuffer())];
    assert.deepEqual(await px(svgCard.jpeg), await px(defaultCard.jpeg));
  } finally { ctx.done(); }
});

test('GRAPH_BASE_URL: the poster calls the stand-in, not graph.facebook.com', async () => {
  const hosts = [];
  const graph = fakeGraph();
  const ctx = setup({
    config: { graphBaseUrl: 'http://127.0.0.1:9999/' },
    graph: { ...graph, fetch: (url, init) => { const u = new URL(url); hosts.push(u.origin); return graph.fetch(`https://graph.facebook.com${u.pathname}${u.search}`, init); } },
  });
  try {
    await ctx.poster.enqueue(ctx.coin());
    assert.equal(await ctx.poster.tick(), 'posted');
    assert.deepEqual([...new Set(hosts)], ['http://127.0.0.1:9999']);
  } finally { ctx.done(); }
});

test('POST_WEB_LAUNCHES=0: website launches are never posted (nor checked); comment launches still are', async () => {
  const ctx = setup({ config: { postWebLaunches: false } });
  try {
    const web = ctx.coin('w1', { source: 'web' });
    await ctx.poster.keepSource(web, { buf: await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).png().toBuffer(), type: 'image/png' });
    assert.equal(await ctx.poster.enqueue(web), false);
    assert.equal(ctx.job(web).status, 'skipped');
    assert.match(ctx.job(web).last_error, /POST_WEB_LAUNCHES=0/);
    assert.equal(ctx.reviews.length, 0);
    assert.deepEqual(readdirSync(join(ctx.postsDir, 'src')), [], 'its kept picture is gone');
    assert.equal(await ctx.poster.enqueue(ctx.coin('c1', { source: 'comment' })), true);
  } finally { ctx.done(); }
});
