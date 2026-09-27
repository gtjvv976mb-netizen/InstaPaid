import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start, mentionHook, tick, launcher, POST_PNG, DEFAULT_COIN } from './helpers.js';
import { isLaunchRequest, mentionEvents, launchedReply, existingReply, pendingReply } from '../src/comments.js';
import { blockCreator, unblockCreator } from '../src/blocks.js';

const PERMALINK = 'https://www.instagram.com/p/DAbc123xyz/';
const post = (username, extra = {}) => ({
  id: 'm1', media_type: 'IMAGE', media_url: 'https://scontent.cdninstagram.com/p.jpg', caption: 'Sunrise over Baguio',
  permalink: PERMALINK, username, ...extra,
});
const ask = (username, text = '@instapaid.official make a token for this creator', media = {}) => ({ text, media: post(username, media) });

async function hook(t, id, mediaId = 'm1') {
  assert.equal((await mentionHook(t, id, mediaId)).status, 200);
  await tick();
  await t.drain();
}

test('which comments ask for a coin', () => {
  assert.ok(isLaunchRequest('@instapaid.official make a token for this creator', 'instapaid.official'));
  assert.ok(isLaunchRequest('@InstaPaid.Official launch a coin pls', 'instapaid.official'));
  assert.ok(!isLaunchRequest('make a token for this creator', 'instapaid.official'), 'must tag the bot');
  assert.ok(!isLaunchRequest('@instapaid.official love this', 'instapaid.official'));
  assert.deepEqual(mentionEvents({ object: 'instagram', entry: [{ changes: [{ field: 'comments', value: { id: 1 } }] }] }), []);
});

test('a comment launches a coin for the post owner: named from the post, website = the post, no description', async () => {
  const t = await start({ mentions: { c1: ask('Nat.Geo') } });
  try {
    await hook(t, 'c1');
    assert.equal(t.calls.serverLaunches.length, 1);
    const vault = t.db.prepare(`select vault_pubkey from account where username = 'nat.geo'`).get().vault_pubkey;
    assert.equal(t.calls.serverLaunches[0].vault, vault, 'creator is the post owner\'s vault');

    // Claude got the post's picture (not the default image), its caption, and no lore
    const naming = t.calls.lore[0];
    assert.equal(naming.username, 'nat.geo');
    assert.equal(naming.caption, 'Sunrise over Baguio');
    assert.equal(naming.lore, null);
    assert.equal(naming.image.type, 'image/png');
    assert.equal(naming.image.buf.compare(POST_PNG), 0, 'the post\'s picture, as fetched');

    // metadata: the name and ticker from naming, the post as the website, the post's picture, empty description
    const up = t.calls.uploads[0];
    assert.equal(up.name, 'Geo Coin');
    assert.equal(up.symbol, 'GEO');
    assert.equal(up.website, PERMALINK);
    assert.equal(up.description, '');
    assert.equal(up.image.buf.compare(POST_PNG), 0);
    assert.equal(t.calls.serverLaunches[0].name, 'Geo Coin');

    const row = t.db.prepare('select * from token').get();
    assert.equal(row.source, 'comment');
    assert.equal(row.status, 'live');
    assert.equal(row.post_permalink, PERMALINK);
    assert.equal(row.lore, null);
    assert.equal(row.username, 'nat.geo');

    const r = t.calls.mentionReplies[0];
    assert.equal(r.commentId, 'c1');
    assert.equal(r.message, [
      '$GEO is live for @nat.geo',
      `Coin: pump.fun/coin/${row.mint}`,
      '@nat.geo can claim the creator fees: instapaid.test/u/nat.geo',
      'Fan-made, not by @nat.geo.',
    ].join('\n'));

    const acct = await (await t.get('/api/accounts/nat.geo')).json();
    assert.equal(acct.tokens[0].source, 'comment');
    assert.equal(acct.tokens[0].post_permalink, PERMALINK);
    assert.equal(acct.tokens[0].lore, null);
    const recent = await (await t.get('/api/recent')).json();
    assert.equal(recent.tokens[0].post_permalink, PERMALINK);
  } finally { t.close(); }
});

test('the fan\'s lore becomes the description when Claude passes it, and never goes in the reply', async () => {
  const text = '@instapaid.official make a token for this creator: king of sunsets https://scam.example';
  const t = await start({ mentions: { c1: ask('alice', text) } });
  try {
    await hook(t, 'c1');
    assert.equal(t.calls.lore[0].lore, 'king of sunsets', 'links stripped before Claude sees it');
    assert.equal(t.calls.uploads[0].description, 'king of sunsets');
    assert.equal(t.db.prepare('select lore from token').get().lore, 'king of sunsets');
    assert.doesNotMatch(t.calls.mentionReplies[0].message, /sunsets/);
  } finally { t.close(); }

  const refused = await start({ mentions: { c1: ask('alice', '@instapaid.official make a token: buy now 100x') }, naming: { loreOk: false } });
  try {
    await hook(refused, 'c1');
    assert.equal(refused.calls.lore[0].lore, 'buy now 100x');
    assert.equal(refused.calls.uploads[0].description, '', 'lore_ok false → empty description');
    assert.equal(refused.db.prepare('select lore from token').get().lore, null);
  } finally { refused.close(); }
});

test('a permalink that is not an Instagram https address falls back to the creator\'s page', async () => {
  const t = await start({ mentions: {
    a: ask('alice', undefined, { permalink: 'https://evil.example/p/x' }),
    b: ask('bob', undefined, { permalink: undefined }),
  } });
  try {
    await hook(t, 'a');
    await hook(t, 'b');
    assert.equal(t.calls.uploads[0].website, 'https://instapaid.test/u/alice');
    assert.equal(t.calls.uploads[1].website, 'https://instapaid.test/u/bob');
    assert.deepEqual(t.db.prepare('select post_permalink from token').all().map((r) => r.post_permalink), [null, null]);
  } finally { t.close(); }
});

test('a creator who opted out: no coin, and one polite reply for that creator, without an @', async () => {
  const mentions = { a: ask('alice'), b: ask('alice'), c: ask('alice'), d: ask('alice') };
  const t = await start({ mentions });
  try {
    blockCreator(t.db, 'alice', 'asked by DM');
    await hook(t, 'a', 'm1');
    await hook(t, 'b', 'm1'); // another fan on the same post
    await hook(t, 'c', 'm2'); // another post: still no second reply, so nobody can make us notify them again
    assert.equal(t.calls.serverLaunches.length, 0);
    assert.deepEqual(t.calls.mentionReplies.map((r) => [r.commentId, r.message]), [
      ['a', 'alice has asked not to have coins made for them.'],
    ]);
    assert.doesNotMatch(t.calls.mentionReplies[0].message, /@/, 'the creator is not @mentioned');
    assert.deepEqual(t.db.prepare('select note from comment_request order by comment_id').all().map((r) => r.note),
      ['creator opted out', 'creator opted out', 'creator opted out']);
    const web = await t.post('/api/launch/prepare', {
      username: 'alice', name: 'Coin', symbol: 'COIN', launcher: launcher(), imageUrl: 'https://a.cdninstagram.com/p.jpg',
    });
    assert.equal(web.status, 403);
    assert.match((await web.json()).error, /@alice has asked not to have coins made for them/);

    // blocked again after an unblock: told once more, once
    unblockCreator(t.db, 'alice');
    t.db.prepare(`update comment_request set created_at = created_at - 1000`).run();
    blockCreator(t.db, 'alice');
    await hook(t, 'd', 'm3');
    assert.equal(t.calls.mentionReplies.length, 2);
  } finally { t.close(); }
});

test('webhook retries and repeat requests never launch twice; a repeat gets the existing coin', async () => {
  const t = await start({ mentions: { c1: ask('alice'), c2: ask('alice') } });
  try {
    await hook(t, 'c1');
    await hook(t, 'c1'); // Meta retry
    await hook(t, 'c2'); // another fan asks for the same creator
    assert.equal(t.calls.serverLaunches.length, 1);
    assert.equal(t.calls.mentionReplies.length, 2);
    const row = t.db.prepare('select * from token').get();
    assert.equal(t.calls.mentionReplies[1].message, existingReply({ username: 'alice', ...row, publicUrl: 'https://instapaid.test' }));
    assert.match(t.calls.mentionReplies[1].message, /already has a coin/);
  } finally { t.close(); }
});

test('two comments at once for one creator still make one coin', async () => {
  const t = await start({ mentions: { a: ask('bob'), b: ask('bob') } });
  try {
    await Promise.all([mentionHook(t, 'a'), mentionHook(t, 'b')]);
    await tick(); await t.drain();
    assert.equal(t.calls.serverLaunches.length, 1);
  } finally { t.close(); }
});

test('ignored: no request, no owner, our own post, forged webhook', async () => {
  const t = await start({ mentions: {
    n: ask('alice', '@instapaid.official nice pic'),
    o: { text: '@instapaid.official make a token', media: { id: 'm', media_url: 'https://scontent.cdninstagram.com/x.jpg' } },
    s: ask('instapaid.official'),
  } });
  try {
    for (const id of ['n', 'o', 's']) await hook(t, id);
    assert.equal((await mentionHook(t, 'n2', 'm', 'wrong')).status, 401);
    assert.equal(t.calls.serverLaunches.length, 0);
    assert.equal(t.calls.mentionReplies.length, 0);
    const st = t.db.prepare('select comment_id, status from comment_request order by comment_id').all();
    assert.deepEqual(st.map((r) => r.status), ['skipped', 'skipped', 'skipped']);
  } finally { t.close(); }
});

test('daily budget and a low fee payer pause launches, and say so once', async () => {
  const t = await start({ mentions: { a: ask('u1'), b: ask('u2'), c: ask('u3'), d: ask('u4') } });
  try {
    for (const id of ['a', 'b', 'c', 'd']) await hook(t, id);
    assert.equal(t.calls.serverLaunches.length, 3);
    assert.match(t.calls.mentionReplies[3].message, /paused/);
  } finally { t.close(); }
  const low = await start({ mentions: { a: ask('u1') }, feePayerLamports: 1000n });
  try {
    await hook(low, 'a');
    assert.equal(low.calls.serverLaunches.length, 0);
    assert.match(low.calls.mentionReplies[0].message, /paused/);
  } finally { low.close(); }
});

test('a failed launch replies once and records why; carousel posts use the default image, and Claude gets none', async () => {
  const t = await start({ mentions: { a: ask('u1') }, launchFails: true });
  try {
    await hook(t, 'a');
    assert.equal(t.calls.mentionReplies.length, 1);
    assert.match(t.calls.mentionReplies[0].message, /didn't go through/);
    assert.equal(t.db.prepare(`select status, note from comment_request`).get().note, 'rpc down');
    assert.equal(t.db.prepare('select count(*) n from token').get().n, 0);
  } finally { t.close(); }
  const c = await start({ mentions: { a: ask('u1', undefined, { media_type: 'CAROUSEL_ALBUM', media_url: undefined }) } });
  try {
    await hook(c, 'a');
    assert.equal(c.calls.serverLaunches.length, 1);
    assert.equal(c.calls.lore[0].image, undefined, 'the default picture is not the post: Claude names from the caption');
    assert.equal(c.calls.uploads[0].image.buf.compare(DEFAULT_COIN), 0);
  } finally { c.close(); }
});

test('reply fits in an Instagram comment', () => {
  const m = launchedReply({ username: 'a'.repeat(30), symbol: 'ABCDEFGHIJ', mint: 'x'.repeat(44), publicUrl: 'https://instapaid.fun' });
  assert.ok(m.length < 300);
  assert.ok(m.includes('instapaid.fun/u/' + 'a'.repeat(30)));
});

// A launch whose confirmation is lost may still land: it is recorded before it is sent, counts as
// the creator's coin and against the day's budget, and the fan is never told to try again until
// the chain says it failed.
test('a lost confirmation that landed: live, the fan told once, no second launch', async () => {
  const t = await start({ mentions: { a: ask('alice'), b: ask('alice') }, launchFails: 'lost' });
  try {
    t.chain.outcome = 'live';
    await hook(t, 'a');
    assert.equal(t.calls.serverLaunches.length, 1);
    const row = t.db.prepare('select * from token').get();
    assert.equal(row.status, 'live');
    assert.equal(row.signature, 'sig1');
    assert.equal(row.last_valid_height, 1000);
    assert.equal(t.calls.statusChecks.length, 1, 'the chain was asked before any reply');
    assert.deepEqual(t.calls.statusChecks[0], { mint: row.mint, vault: t.db.prepare('select vault_pubkey v from account').get().v, signature: 'sig1', lastValidBlockHeight: 1000 });
    assert.equal(t.calls.mentionReplies[0].message, launchedReply({ username: 'alice', symbol: 'GEO', mint: row.mint, publicUrl: 'https://instapaid.test' }));
    await hook(t, 'b');
    assert.equal(t.calls.serverLaunches.length, 1);
    assert.match(t.calls.mentionReplies[1].message, /already has a coin/);
  } finally { t.close(); }
});

test('a lost confirmation that expired: dropped, "try again", and the next request launches', async () => {
  const t = await start({ mentions: { a: ask('alice'), b: ask('alice') }, launchFails: 'lost' });
  try {
    t.chain.outcome = 'failed';
    await hook(t, 'a');
    assert.match(t.calls.mentionReplies[0].message, /didn't go through/);
    assert.equal(t.db.prepare('select count(*) n from token').get().n, 0, 'the recorded launch is gone');
    t.chain.launchFails = false;
    await hook(t, 'b');
    assert.equal(t.calls.serverLaunches.length, 2);
    assert.equal(t.db.prepare(`select count(*) n from token where status = 'live'`).get().n, 1);
  } finally { t.close(); }
});

test('an RPC that refuses the send: nothing can land, so the recorded launch goes and the fan may retry', async () => {
  const t = await start({ mentions: { a: ask('alice') }, launchFails: 'refused' });
  try {
    await hook(t, 'a');
    assert.match(t.calls.mentionReplies[0].message, /didn't go through/);
    assert.equal(t.calls.statusChecks.length, 0, 'a refusal is final: no need to ask the chain');
    assert.equal(t.db.prepare('select count(*) n from token').get().n, 0);
  } finally { t.close(); }
});

test('still unknown: the fan is told it is on its way (not to retry), the creator is taken, and it settles later', async () => {
  const t = await start({ mentions: { a: ask('alice'), b: ask('alice'), c: ask('bob') }, launchFails: 'lost', config: { maxServerLaunchesPerDay: 2 } });
  try {
    t.chain.outcome = 'pending';
    await hook(t, 'a');
    const row = t.db.prepare('select * from token').get();
    assert.equal(row.status, 'prepared');
    assert.equal(row.source, 'comment');
    const waiting = pendingReply({ username: 'alice', publicUrl: 'https://instapaid.test' });
    assert.equal(t.calls.mentionReplies[0].message, waiting);
    assert.doesNotMatch(waiting, /try again/i);
    assert.equal(t.db.prepare(`select status, mint, note from comment_request where comment_id = 'a'`).get().note, 'sent, not confirmed yet');

    // another fan asks for the same creator while it is unknown: asked again, no second launch
    await hook(t, 'b');
    assert.equal(t.calls.serverLaunches.length, 1);
    assert.equal(t.calls.mentionReplies[1].message, waiting);
    // it counts against the day's budget: with a budget of 2, one more launch is allowed, not two
    t.chain.launchFails = false;
    await hook(t, 'c');
    assert.equal(t.calls.serverLaunches.length, 2);
    assert.equal(t.db.prepare(`select count(*) n from token where source = 'comment'`).get().n, 2);

    // the periodic check finds it landed: live, and the first fan gets the real reply
    t.chain.outcome = 'live';
    assert.deepEqual(await t.settlePending(), { [row.mint]: 'live' });
    assert.equal(t.db.prepare('select status from token where mint = ?').get(row.mint).status, 'live');
    const last = t.calls.mentionReplies.at(-1);
    assert.equal(last.commentId, 'a');
    assert.equal(last.message, launchedReply({ username: 'alice', symbol: 'GEO', mint: row.mint, publicUrl: 'https://instapaid.test' }));
    assert.deepEqual(await t.settlePending(), {}, 'nothing left to settle');
  } finally { t.close(); }
});

test('an unknown launch that later expires is dropped by the periodic check, and the creator can have a coin again', async () => {
  const t = await start({ mentions: { a: ask('alice'), b: ask('alice') }, launchFails: 'lost' });
  try {
    await hook(t, 'a');
    const mint = t.db.prepare('select mint from token').get().mint;
    t.chain.outcome = 'failed';
    assert.deepEqual(await t.settlePending(), { [mint]: 'failed' });
    assert.equal(t.db.prepare('select count(*) n from token').get().n, 0);
    t.chain.launchFails = false;
    await hook(t, 'b');
    assert.equal(t.db.prepare(`select count(*) n from token where status = 'live'`).get().n, 1);
    assert.match(t.calls.mentionReplies.at(-1).message, /is live for @alice/);
  } finally { t.close(); }
});

test('/api/launch/confirm only confirms website launches', async () => {
  const t = await start({ mentions: { a: ask('alice') }, launchFails: 'lost' });
  try {
    await hook(t, 'a');
    const mint = t.db.prepare('select mint from token').get().mint;
    const r = await t.post('/api/launch/confirm', { mint, signature: 'forged' });
    assert.equal(r.status, 404);
    assert.equal(t.db.prepare('select signature, status from token').get().signature, 'sig1');
  } finally { t.close(); }
});
