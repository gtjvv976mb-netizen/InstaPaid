import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start, mentionHook, tick } from './helpers.js';
import { isLaunchRequest, mentionEvents, launchedReply } from '../src/comments.js';
import { cleanCoin } from '../src/lore.js';

const post = (username, extra = {}) => ({
  id: 'm1', media_type: 'IMAGE', media_url: 'https://scontent.cdninstagram.com/p.jpg', caption: 'Sunrise over Baguio', username, ...extra,
});
const ask = (username, text = '@instapaid.verify make a token for this creator', media = {}) => ({ text, media: post(username, media) });

async function hook(t, id) {
  assert.equal((await mentionHook(t, id)).status, 200);
  await tick();
  await t.drain();
}

test('which comments ask for a coin', () => {
  assert.ok(isLaunchRequest('@instapaid.verify make a token for this creator', 'instapaid.verify'));
  assert.ok(isLaunchRequest('@InstaPaid.Verify launch a coin pls', 'instapaid.verify'));
  assert.ok(!isLaunchRequest('make a token for this creator', 'instapaid.verify'), 'must tag the bot');
  assert.ok(!isLaunchRequest('@instapaid.verify love this', 'instapaid.verify'));
  assert.deepEqual(mentionEvents({ object: 'instagram', entry: [{ changes: [{ field: 'comments', value: { id: 1 } }] }] }), []);
});

test('model output is cleaned before it is posted or put on-chain', () => {
  const c = cleanCoin({ name: 'x'.repeat(50), symbol: '$sun-rise!!', lore: 'y'.repeat(900) }, 'a');
  assert.equal(c.name.length, 32);
  assert.equal(c.symbol, 'SUNRISE');
  assert.equal(c.lore.length, 400);
  assert.equal(cleanCoin({ symbol: '$' }, 'nat.geo').symbol, 'NATGEO');
});

test('a comment launches a coin for the post owner, paid by the server, and replies with links and lore', async () => {
  const t = await start({ mentions: { c1: ask('Nat.Geo') } });
  try {
    await hook(t, 'c1');
    assert.equal(t.calls.serverLaunches.length, 1);
    const vault = t.db.prepare(`select vault_pubkey from account where username = 'nat.geo'`).get().vault_pubkey;
    assert.equal(t.calls.serverLaunches[0].vault, vault, 'creator is the post owner\'s vault');
    assert.deepEqual(t.calls.lore[0], { username: 'nat.geo', caption: 'Sunrise over Baguio' });
    const r = t.calls.mentionReplies[0];
    assert.equal(r.commentId, 'c1');
    assert.match(r.message, /\$GEO is live for @nat\.geo/);
    assert.match(r.message, /A legend of maps\./);
    assert.match(r.message, /pump\.fun\/coin\/\w+/);
    assert.match(r.message, /instapaid\.test\/u\/nat\.geo/);
    assert.match(r.message, /Fan-made, not by @nat\.geo/);
    const acct = await (await t.get('/api/accounts/nat.geo')).json();
    assert.equal(acct.tokens[0].lore, 'A legend of maps.');
    assert.equal(acct.tokens[0].source, 'comment');
  } finally { t.close(); }
});

test('webhook retries and repeat requests never launch twice', async () => {
  const t = await start({ mentions: { c1: ask('alice'), c2: ask('alice') } });
  try {
    await hook(t, 'c1');
    await hook(t, 'c1'); // Meta retry
    await hook(t, 'c2'); // another fan asks for the same creator
    assert.equal(t.calls.serverLaunches.length, 1);
    assert.equal(t.calls.mentionReplies.length, 2);
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
    n: ask('alice', '@instapaid.verify nice pic'),
    o: { text: '@instapaid.verify make a token', media: { id: 'm', media_url: 'https://scontent.cdninstagram.com/x.jpg' } },
    s: ask('instapaid.verify'),
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

test('a failed launch replies once and records why; carousel posts use the default image', async () => {
  const t = await start({ mentions: { a: ask('u1') }, launchFails: true });
  try {
    await hook(t, 'a');
    assert.match(t.calls.mentionReplies[0].message, /didn't go through/);
    assert.equal(t.db.prepare(`select status, note from comment_request`).get().note, 'rpc down');
  } finally { t.close(); }
  const c = await start({ mentions: { a: ask('u1', undefined, { media_type: 'CAROUSEL_ALBUM', media_url: undefined }) } });
  try {
    await hook(c, 'a');
    assert.equal(c.calls.serverLaunches.length, 1);
  } finally { c.close(); }
});

test('reply fits in an Instagram comment', () => {
  const m = launchedReply({ username: 'a'.repeat(30), name: 'n', symbol: 'ABCDEFGHIJ', mint: 'x'.repeat(44), lore: 'y'.repeat(400), publicUrl: 'https://instapaid.example' });
  assert.ok(m.length < 2200);
});
