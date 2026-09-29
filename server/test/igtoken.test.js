// The Instagram token renews itself (src/igtoken.js): stored sealed, renewed from day 7 through
// graph.instagram.com/refresh_access_token (a pasted token after 24 hours), swapped in for every caller,
// a failed renewal keeps the old token and warns near the end, a token Meta refuses (190) warns at once
// and every day after, a freshly pasted IG_ACCESS_TOKEN wins, and no log carries a token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { openDb } from '../src/db.js';
import { createTokenKeeper, RENEW_AFTER } from '../src/igtoken.js';
import { createPoster } from '../src/poster.js';
import { replyToMention, readMention } from '../src/comments.js';
import { reply, usernameOf, subscribeMessages } from '../src/instagram.js';

const DAY = 24 * 60 * 60_000;
const PASTED = 'IGAA-pasted-' + 'p'.repeat(40);
const RENEWED = 'IGAA-renewed-' + 'r'.repeat(40);
const RENEWED2 = 'IGAA-renewed2-' + 's'.repeat(40);
const OTHER = 'IGAA-other-' + 'o'.repeat(40);
const TOKENS = [PASTED, RENEWED, RENEWED2, OTHER];
const IG = '17841499999999999';

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

/**
 * A stand-in graph.instagram.com: refresh_access_token gives out `next` tokens in turn, or fails:
 * 'meta' = the token refused (190/463 expired), 'busy' = Meta unavailable (code 2), 'network'.
 */
function fakeGraph({ next = [RENEWED, RENEWED2], fail = null } = {}) {
  const g = { refreshes: [], calls: [], fail };
  const queue = [...next];
  g.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const params = method === 'GET' ? u.searchParams : new URLSearchParams(init.body);
    const token = params.get('access_token') ?? new URLSearchParams(u.search).get('access_token');
    assert.equal(u.origin, 'https://graph.instagram.com');
    if (u.pathname === '/refresh_access_token') {
      g.refreshes.push({ token, grant: params.get('grant_type') });
      if (g.fail === 'network') throw new TypeError(`fetch failed for ${url}`);
      if (g.fail === 'busy') return json({ error: { message: 'An unexpected error has occurred. Please retry your request later.', type: 'OAuthException', code: 2, is_transient: true } }, 503);
      if (g.fail) return json({ error: { message: 'Error validating access token: Session has expired', type: 'OAuthException', code: 190, error_subcode: 463 } }, 400);
      return json({ access_token: queue.shift(), token_type: 'bearer', expires_in: 5_183_944 });
    }
    g.calls.push({ method, path: u.pathname.replace(/^\/v23\.0\//, ''), token });
    const path = u.pathname.replace(/^\/v23\.0\//, '');
    if (path === 'me') return json({ user_id: IG, username: 'instapaid.official' });
    if (path === `${IG}/content_publishing_limit`) return json({ data: [{ quota_usage: 0, config: { quota_total: 100 } }] });
    if (path === `${IG}/media` && method === 'POST') return json({ id: 'c1' });
    if (path === 'c1') return json({ status_code: 'FINISHED' });
    if (path === `${IG}/media_publish`) return json({ id: 'media1' });
    if (path === 'media1') return json({ id: 'media1', permalink: 'https://www.instagram.com/p/X/' });
    if (path === `${IG}/mentions`) return json({ id: 'r1' });
    if (path === 'me/messages') return json({ message_id: 'm' });
    if (path === 'me/subscribed_apps') return json({ success: true });
    if (path === '123') return json({ username: 'fan' });
    return json({ error: { message: `unknown ${method} ${path}`, code: 100 } }, 404);
  };
  return g;
}

/** A keeper over one database file, a clock the test moves, and every log line kept. `boot` is a server start. */
function setup({ graph = fakeGraph(), env = PASTED } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'instapaid-igtoken-'));
  const dbPath = join(dir, 'db.sqlite');
  const vaultMasterKey = randomBytes(32).toString('hex');
  const clock = { t: Date.UTC(2026, 8, 1, 12) };
  const logs = [];
  const log = { log: (...a) => logs.push(['log', a.join(' ')]), warn: (...a) => logs.push(['warn', a.join(' ')]), error: (...a) => logs.push(['error', a.join(' ')]) };
  const ctx = { clock, logs, graph, dir, dbs: [] };
  ctx.boot = (pasted = env) => {
    const db = openDb(dbPath);
    ctx.dbs.push(db);
    const cfg = { vaultMasterKey, igUserId: '', fbAccessToken: '', ig: { accessToken: pasted, graphVersion: 'v23.0' } };
    const keeper = createTokenKeeper({ db, cfg, fetchImpl: graph.fetch, now: () => clock.t, log });
    keeper.load();
    Object.assign(ctx, { db, cfg, keeper });
    return ctx;
  };
  ctx.advance = (ms) => { clock.t += ms; };
  ctx.text = () => logs.map(([, l]) => l).join('\n');
  ctx.done = () => {
    for (const db of ctx.dbs) db.close();
    rmSync(dir, { recursive: true, force: true });
    // No line, in any test, ever carries a token.
    for (const t of TOKENS) assert.ok(!ctx.text().includes(t), 'a token reached the log');
  };
  return ctx.boot();
}

test('renewal: a pasted token after 24 hours, a renewed one not before day 7; stored sealed, swapped in, used after a restart', async () => {
  const ctx = setup();
  try {
    assert.equal(ctx.cfg.ig.accessToken, PASTED);
    assert.equal(ctx.keeper.current().source, 'env');
    assert.match(ctx.text(), /instagram token: IG_ACCESS_TOKEN stored; renewed automatically after 24 hours/);

    // a pasted token's real age is unknown: renewed as soon as Meta allows (24 hours), which tells its true end
    ctx.advance(DAY - 60_000);
    assert.equal(await ctx.keeper.check(), 'fresh');
    assert.equal(ctx.graph.refreshes.length, 0, 'a pasted token here under 24 hours is left alone');

    ctx.advance(2 * 60_000);
    assert.equal(await ctx.keeper.check(), 'renewed');
    assert.deepEqual(ctx.graph.refreshes, [{ token: PASTED, grant: 'ig_refresh_token' }]);
    assert.equal(ctx.cfg.ig.accessToken, RENEWED);
    assert.match(ctx.text(), /instagram token: renewed, valid ~60 days/);
    const row = ctx.db.prepare('select * from ig_token').get();
    assert.equal(row.source, 'renewed');
    assert.equal(row.refreshed_at, ctx.clock.t);
    assert.equal(row.expires_at, ctx.clock.t + 5_183_944_000);
    for (const t of TOKENS) assert.ok(!JSON.stringify(row).includes(t), 'the stored token is sealed');

    // a renewed token is left alone until day 7, then renewed again, from the renewed token
    ctx.advance(DAY);
    assert.equal(await ctx.keeper.check(), 'fresh');
    ctx.advance(RENEW_AFTER - DAY - 60_000);
    assert.equal(await ctx.keeper.check(), 'fresh');
    assert.equal(ctx.graph.refreshes.length, 1, 'a renewed token under 7 days old is left alone');
    ctx.advance(2 * 60_000);
    assert.equal(await ctx.keeper.check(), 'renewed');
    assert.equal(ctx.graph.refreshes[1].token, RENEWED);
    assert.equal(ctx.cfg.ig.accessToken, RENEWED2);

    // a restart with the same IG_ACCESS_TOKEN still set: the renewed token is the one used
    ctx.boot(PASTED);
    assert.equal(ctx.cfg.ig.accessToken, RENEWED2);
    assert.match(ctx.logs.at(-1)[1], /instagram token: using the one renewed on 2026-09-09, valid ~60 days/);
  } finally { ctx.done(); }
});

test('the swapped token reaches every caller: poster, comment reads and replies, DMs, the webhook subscription', async () => {
  const ctx = setup();
  const postsDir = mkdtempSync(join(tmpdir(), 'instapaid-igtoken-posts-'));
  try {
    const cfg = Object.assign(ctx.cfg, {
      publicUrl: 'https://instapaid.test', autoPost: true, postMaxPerDay: 25, postMinGapMin: 20, postMaxAgeH: 24, postsDir,
    });
    // made before the renewal, as at start
    const poster = createPoster({
      db: ctx.db, cfg, fetchImpl: ctx.graph.fetch, now: () => ctx.clock.t, sleep: async () => {}, log: { log() {}, warn() {}, error() {} },
      render: async () => Buffer.from('jpeg'), review: async () => ({ nameOk: true, pictureOk: true }),
    });
    ctx.advance(RENEW_AFTER + 1);
    assert.equal(await ctx.keeper.check(), 'renewed');
    ctx.graph.calls.length = 0;

    const mint = Keypair.generate().publicKey.toBase58();
    ctx.db.prepare(`insert into account (username, vault_pubkey, vault_secret, created_at) values ('nat.geo', ?, 'x', 0)`).run(Keypair.generate().publicKey.toBase58());
    ctx.db.prepare(`insert into token (mint, username, name, symbol, launcher, source, status, created_at) values (?, 'nat.geo', 'G', 'GEO', 'L', 'comment', 'live', ?)`).run(mint, ctx.clock.t);
    assert.equal(await poster.enqueue(mint), true);
    assert.equal(await poster.tick(), 'posted');
    const quiet = { log() {}, warn() {}, error() {} };
    assert.equal(await replyToMention(cfg, { commentId: 'c9', mediaId: 'm9' }, 'hi', ctx.graph.fetch, quiet), true);
    await readMention(cfg, { commentId: 'c9', mediaId: 'm9', text: 'x' }, ctx.graph.fetch, quiet).catch(() => {});
    await reply(cfg.ig, '123', 'hello', ctx.graph.fetch);
    assert.equal(await usernameOf(cfg.ig, '123', ctx.graph.fetch), 'fan');
    assert.equal((await subscribeMessages(cfg.ig, ctx.graph.fetch, ['messages', 'comments'])).ok, true);

    assert.ok(ctx.graph.calls.length >= 10);
    assert.deepEqual([...new Set(ctx.graph.calls.map((c) => c.token))], [RENEWED], 'every call after the renewal carries the new token');
    for (const p of [`${IG}/media_publish`, `${IG}/mentions`, 'me/messages', 'me/subscribed_apps', '123']) {
      assert.ok(ctx.graph.calls.some((c) => c.path === p), `${p} was called`);
    }
  } finally { rmSync(postsDir, { recursive: true, force: true }); ctx.done(); }
});

test('a failed renewal (Meta busy) keeps the old token; within 10 days of the end it warns loudly every day', async () => {
  const graph = fakeGraph({ fail: 'busy' });
  const ctx = setup({ graph });
  try {
    ctx.advance(RENEW_AFTER + 1);
    assert.equal(await ctx.keeper.check(), 'failed');
    assert.equal(ctx.cfg.ig.accessToken, PASTED);
    assert.equal(ctx.keeper.current().source, 'env');
    assert.equal(ctx.keeper.current().expiresAt, Date.UTC(2026, 8, 1, 12) + 60 * DAY, 'a busy answer says nothing about the token');
    assert.match(ctx.text(), /instagram token: renewal failed → 503 \(#2\) An unexpected error has occurred\. Please retry your request later\.; the current token stays in use/);
    assert.ok(!/WARNING/.test(ctx.text()), 'no loud warning while there is time');

    // day 50: 10 days left → a loud warning with each failed daily check
    ctx.advance(43 * DAY);
    assert.equal(await ctx.keeper.check(), 'failed');
    assert.match(ctx.logs.at(-1)[1], /WARNING — IT EXPIRES IN ~10 DAYS \(2026-10-31\) and could not be renewed\. Generate a new token/);
    assert.equal(ctx.logs.at(-1)[0], 'error');
    ctx.advance(DAY);
    assert.equal(await ctx.keeper.check(), 'failed');
    assert.match(ctx.logs.at(-1)[1], /IT EXPIRES IN ~9 DAYS/);
    ctx.advance(10 * DAY);
    assert.equal(await ctx.keeper.check(), 'failed');
    assert.match(ctx.logs.at(-1)[1], /IT EXPIRED ON 2026-10-31/);
    assert.equal(ctx.cfg.ig.accessToken, PASTED);

    // Meta answers again: renewed, the warnings stop
    graph.fail = null;
    const before = ctx.logs.length;
    ctx.advance(DAY);
    assert.equal(await ctx.keeper.check(), 'renewed');
    assert.equal(ctx.cfg.ig.accessToken, RENEWED);
    assert.ok(!ctx.logs.slice(before).some(([, l]) => /WARNING/.test(l)));

    // a network failure: the error is logged without the token that was in the URL
    graph.fail = 'network';
    ctx.advance(RENEW_AFTER + 1);
    assert.equal(await ctx.keeper.check(), 'failed');
    assert.match(ctx.logs.at(-1)[1], /renewal failed → network fetch failed for https:\/\/graph\.instagram\.com\/refresh_access_token\?grant_type=ig_refresh_token&access_token=\[token\]/);
    assert.equal(ctx.cfg.ig.accessToken, RENEWED);
  } finally { ctx.done(); }
});

test('an answer without a token or a lifetime is a failure, not a swap', async () => {
  const graph = fakeGraph();
  const inner = graph.fetch;
  graph.fetch = async (url, init) => (new URL(url).pathname === '/refresh_access_token' ? json({ token_type: 'bearer' }) : inner(url, init));
  const ctx = setup({ graph });
  try {
    ctx.advance(RENEW_AFTER + 1);
    assert.equal(await ctx.keeper.check(), 'failed');
    assert.equal(ctx.cfg.ig.accessToken, PASTED);
    assert.match(ctx.text(), /renewal failed → no access_token or expires_in in the answer/);
  } finally { ctx.done(); }
});

test('a newly pasted IG_ACCESS_TOKEN wins over the stored renewal; the same one pasted again does not', async () => {
  const ctx = setup();
  try {
    ctx.advance(RENEW_AFTER + 1);
    assert.equal(await ctx.keeper.check(), 'renewed');

    ctx.advance(DAY);
    ctx.boot(OTHER);
    assert.equal(ctx.cfg.ig.accessToken, OTHER);
    assert.match(ctx.logs.at(-1)[1], /a new IG_ACCESS_TOKEN replaces the stored one/);
    const row = ctx.keeper.current();
    assert.deepEqual(row, { source: 'env', refreshedAt: ctx.clock.t, expiresAt: ctx.clock.t + 60 * DAY });
    // renewed from the new one, 7 days on
    ctx.advance(RENEW_AFTER + 1);
    assert.equal(await ctx.keeper.check(), 'renewed');
    assert.equal(ctx.graph.refreshes.at(-1).token, OTHER);
    assert.equal(ctx.cfg.ig.accessToken, RENEWED2);

    // restarting with OTHER still set keeps the renewal of it
    ctx.boot(OTHER);
    assert.equal(ctx.cfg.ig.accessToken, RENEWED2);
  } finally { ctx.done(); }
});

test('a stored token that cannot be opened (another VAULT_MASTER_KEY) falls back to IG_ACCESS_TOKEN; no key, no keeping', async () => {
  const ctx = setup();
  try {
    ctx.db.prepare(`update ig_token set token = 'AAAA'`).run();
    ctx.boot(PASTED);
    assert.equal(ctx.cfg.ig.accessToken, PASTED);
    assert.match(ctx.text(), /the stored token could not be opened/);
    assert.equal(ctx.keeper.current().source, 'env');

    const db = openDb(':memory:');
    const logs = [];
    const cfg = { vaultMasterKey: '', ig: { accessToken: PASTED } };
    const k = createTokenKeeper({ db, cfg, fetchImpl: async () => { throw new Error('not asked'); }, log: { log() {}, warn: (l) => logs.push(l), error() {} } });
    k.load();
    assert.equal(await k.check(), 'none');
    assert.equal(cfg.ig.accessToken, PASTED);
    assert.match(logs[0], /not kept or renewed \(VAULT_MASTER_KEY is not set\)/);
    db.close();
  } finally { ctx.done(); }
});

test('one check at a time: two at once make one refresh call', async () => {
  const ctx = setup();
  try {
    ctx.advance(RENEW_AFTER + 1);
    const [a, b] = await Promise.all([ctx.keeper.check(), ctx.keeper.check()]);
    assert.deepEqual([a, b], ['renewed', 'renewed']);
    assert.equal(ctx.graph.refreshes.length, 1);
  } finally { ctx.done(); }
});

test('a token Meta refuses (190) warns at once, marks it expired, and warns every day and at each start until a new one is pasted', async () => {
  // The stored renewal is lost (fresh database) and IG_ACCESS_TOKEN, left in Render, died long ago.
  const graph = fakeGraph({ fail: 'meta' });
  const ctx = setup({ graph });
  try {
    const start = ctx.clock.t;
    assert.equal(await ctx.keeper.check(), 'fresh', 'Meta refuses a refresh under 24 hours, so it is not asked yet');
    assert.equal(ctx.graph.refreshes.length, 0);

    // day 1: the first refresh is refused → the loud warning at once, not the routine line, not in 7 weeks
    ctx.advance(DAY);
    assert.equal(await ctx.keeper.check(), 'failed');
    assert.equal(ctx.graph.refreshes.length, 1);
    assert.equal(ctx.logs.at(-1)[0], 'error');
    assert.match(ctx.logs.at(-1)[1], /^instagram token: WARNING — META REFUSED THE TOKEN IN USE \(400 \(#190\/463\) Error validating access token: Session has expired\): it has expired or been revoked and cannot be renewed\. DM claims, comment launches and the poster are stopped\. Generate a new token .* paste it into IG_ACCESS_TOKEN\.$/);
    assert.ok(!/EXPIRES IN/.test(ctx.text()), 'no made-up end date');
    assert.equal(ctx.keeper.current().expiresAt, ctx.clock.t, 'the stored token is marked expired');
    assert.equal(ctx.cfg.ig.accessToken, PASTED);

    // every daily check after: tried again, and warns again (days 2..52)
    for (let d = 2; d <= 52; d++) {
      ctx.advance(DAY);
      const before = ctx.logs.length;
      assert.equal(await ctx.keeper.check(), 'failed', `day ${d}`);
      const lines = ctx.logs.slice(before).map(([, l]) => l);
      assert.equal(lines.length, 1, `day ${d}: one line`);
      assert.match(lines[0], /WARNING — META REFUSED THE TOKEN IN USE/, `day ${d}`);
    }
    assert.equal(ctx.graph.refreshes.length, 52);
    assert.equal(ctx.keeper.current().expiresAt, start + DAY, 'the mark keeps the day Meta first refused it');

    // a restart with the same dead IG_ACCESS_TOKEN still set warns at start too
    ctx.boot(PASTED);
    assert.equal(ctx.logs.at(-1)[0], 'error');
    assert.match(ctx.logs.at(-1)[1], /instagram token: WARNING — THE TOKEN IN USE EXPIRED OR WAS REFUSED BY META ON 2026-09-02\. DM claims, comment launches and the poster are stopped\. Generate a new token/);

    // a new token pasted: stored, no warning, renewed after 24 hours
    graph.fail = null;
    const before = ctx.logs.length;
    ctx.boot(OTHER);
    assert.equal(ctx.cfg.ig.accessToken, OTHER);
    assert.equal(ctx.keeper.current().expiresAt, ctx.clock.t + 60 * DAY);
    ctx.advance(DAY);
    assert.equal(await ctx.keeper.check(), 'renewed');
    assert.equal(ctx.graph.refreshes.at(-1).token, OTHER);
    assert.equal(ctx.cfg.ig.accessToken, RENEWED);
    assert.ok(!ctx.logs.slice(before).some(([, l]) => /WARNING/.test(l)));
  } finally { ctx.done(); }
});

test('a renewed token that Meta later refuses warns at the next check, before day 7', async () => {
  const graph = fakeGraph({ fail: null });
  const ctx = setup({ graph });
  try {
    ctx.advance(DAY);
    assert.equal(await ctx.keeper.check(), 'renewed');
    // revoked (say, the password changed) at day 7 of the renewed token: the check that day says so loudly
    graph.fail = 'meta';
    ctx.advance(RENEW_AFTER);
    assert.equal(await ctx.keeper.check(), 'failed');
    assert.match(ctx.logs.at(-1)[1], /WARNING — META REFUSED THE TOKEN IN USE/);
    assert.equal(ctx.keeper.current().source, 'renewed');
    assert.equal(ctx.keeper.current().expiresAt, ctx.clock.t);
    // and the next day, though the renewed token is only 8 days old
    ctx.advance(DAY);
    assert.equal(await ctx.keeper.check(), 'failed');
    assert.match(ctx.logs.at(-1)[1], /WARNING — META REFUSED THE TOKEN IN USE/);
  } finally { ctx.done(); }
});
