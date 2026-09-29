// Comment launches on Instagram Login (no Facebook Page): the "comments" webhook in every shape Meta
// uses, reading the post through three fallbacks on graph.instagram.com, the reply through
// /<IG_ID>/mentions, the bot's IG_ID from /me, the webhook subscription, the settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start, signedHook, tick, cfg, POST_PNG } from './helpers.js';
import * as comments from '../src/comments.js';
import {
  mentionEvents, skipMention, isLaunchRequest, commentLore, readMention, replyToMention, replyBlocked, commentLaunchesOff, launchedReply,
} from '../src/comments.js';
import { igAccount, subscribeMessages, describeEntry } from '../src/instagram.js';
import { assertConfig, configNotes } from '../src/config.js';
import { getOrCreateAccount } from '../src/pump.js';

const BOT = '17841499999999999';
const BOT_NAME = 'instapaid.official';
const PERMALINK = 'https://www.instagram.com/p/DAbc123xyz/';
const ASK = '@instapaid.official make a token for this creator: king of sunsets';
const TOKEN = 'IGT-' + 'x'.repeat(40);

/** The app's settings with only the Instagram token: no Facebook Login. A fresh `ig` each time (IG_ID is kept per object). */
const igOnly = (extra = {}) => ({ igUserId: '', fbAccessToken: '', ig: { ...cfg.ig, accessToken: TOKEN }, ...extra });

const ERRORS = {
  mentioned_comment: [10, 'Application does not have permission for this action'],
  mentioned_media: [100, 'Tried accessing nonexisting field (mentioned_media) on node type (User)'],
  media: [100, 'Unsupported get request. Object with ID \'m1\' does not exist'],
  me: [190, 'Invalid OAuth access token - Cannot parse access token'],
  reply: [200, 'Requires instagram_business_manage_comments permission'],
};

/**
 * A stand-in graph.instagram.com (and graph.facebook.com, and the Instagram CDN). `fail` names the
 * calls that answer 400 with Meta's error; `owner` is the post's username (null: Meta leaves it out).
 */
function fakeIg({ fail = [], owner = 'nat.geo', text = ASK, fb = null } = {}) {
  const g = { calls: [], replies: [], fbReplies: [], fail: new Set(fail) };
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  const err = (name) => json({ error: { message: ERRORS[name][1], type: 'OAuthException', code: ERRORS[name][0], fbtrace_id: 'T' } }, 400);
  const post = () => ({
    id: 'm1', media_type: 'IMAGE', media_url: 'https://scontent.cdninstagram.com/p.jpg', caption: 'Sunrise over Baguio',
    permalink: PERMALINK, ...(owner ? { username: owner } : {}),
  });
  g.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.hostname.endsWith('.cdninstagram.com')) return new Response(POST_PNG, { headers: { 'content-type': 'image/png' } });
    const method = init.method ?? 'GET';
    const params = method === 'GET' ? u.searchParams : new URLSearchParams(init.body);
    const path = u.pathname.replace(/^\/v23\.0\//, '');
    const fields = params.get('fields') ?? '';
    g.calls.push({ origin: u.origin, method, path, fields });
    if (u.origin === 'https://graph.facebook.com') {
      assert.equal(params.get('access_token'), 'fb');
      if (method === 'POST') { g.fbReplies.push(Object.fromEntries([...params].filter(([k]) => k !== 'access_token'))); return json({ id: 'r' }); }
      return fb ? json({ id: '42', mentioned_comment: { id: 'c1', text, media: { ...post(), username: fb } } }) : err('mentioned_comment');
    }
    assert.equal(u.origin, 'https://graph.instagram.com');
    assert.equal(params.get('access_token'), TOKEN, 'every call carries the Instagram token');
    if (path === 'me') return g.fail.has('me') ? err('me') : json({ id: 'app-scoped-1', user_id: BOT, username: BOT_NAME });
    if (path === BOT && fields.startsWith('mentioned_comment.comment_id(')) {
      return g.fail.has('mentioned_comment') ? err('mentioned_comment') : json({ id: BOT, mentioned_comment: { id: 'c1', text, media: post() } });
    }
    if (path === BOT && fields.startsWith('mentioned_media.media_id(')) {
      return g.fail.has('mentioned_media') ? err('mentioned_media') : json({ id: BOT, mentioned_media: post() });
    }
    if (path === 'm1' && method === 'GET') return g.fail.has('media') ? err('media') : json(post());
    if (path === `${BOT}/mentions` && method === 'POST') {
      if (g.fail.has('reply')) return err('reply');
      g.replies.push(Object.fromEntries([...params].filter(([k]) => k !== 'access_token')));
      return json({ id: 'reply1' });
    }
    return json({ error: { message: `unknown ${method} ${path}`, code: 100 } }, 404);
  };
  g.reads = () => g.calls.filter((c) => c.method === 'GET' && c.path !== 'me').map((c) => (c.path === BOT ? c.fields.split('.')[0] : c.path));
  return g;
}

/** The documented Instagram Login payload: field and value on the entry itself. */
const documented = ({ id = 'c1', text = ASK, from = { id: '5566778899', username: 'fan.one' }, media = { id: 'm1', media_product_type: 'FEED' } } = {}) => ({
  object: 'instagram', entry: [{ id: BOT, time: 1790000000, field: 'comments', value: { id, from, text, media } }],
});
/** The same inside changes[] (as the dashboard's Test sends it). */
const inChanges = (opts) => {
  const d = documented(opts);
  const { field, value, ...entry } = d.entry[0];
  return { object: 'instagram', entry: [{ ...entry, changes: [{ field, value }] }] };
};

/** Everything the server logs while fn runs. */
async function logged(fn) {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(saved)) console[k] = (...a) => lines.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' '));
  try { await fn(); } finally { Object.assign(console, saved); }
  return lines;
}

async function app(g, extra = {}) {
  return start({ config: igOnly(extra), comments, fetchImpl: g.fetch });
}
async function hook(t, payload) {
  assert.equal((await signedHook(t, payload)).status, 200);
  await tick();
  await t.drain();
}

test('comment events: the documented entry.field/value, changes[] "comments" and "mentions"; nothing else', () => {
  const want = { field: 'comments', commentId: 'c1', mediaId: 'm1', botId: BOT, text: ASK, fromId: '5566778899', fromUsername: 'fan.one', productType: 'FEED' };
  assert.deepEqual(mentionEvents(documented()), [want]);
  assert.deepEqual(mentionEvents(inChanges()), [want]);
  assert.deepEqual(mentionEvents({ object: 'instagram', entry: [{ id: '42', changes: [{ field: 'mentions', value: { comment_id: 'c9', media_id: 'm9' } }] }] }),
    [{ field: 'mentions', commentId: 'c9', mediaId: 'm9', botId: '42' }]);
  assert.deepEqual(mentionEvents(documented({ media: {} })), [], 'no post id: nothing to read or answer');
  assert.deepEqual(mentionEvents({ object: 'page', entry: documented().entry }), []);
  assert.deepEqual(mentionEvents({ object: 'instagram', entry: [{ id: BOT, messaging: [{ sender: { id: '1' }, message: { text: 'hi' } }] }] }), []);
});

test('which comments are worth reading: the bot\'s own (by id or name), Stories and non-requests are not', () => {
  const [ev] = mentionEvents(documented());
  assert.equal(skipMention(ev, BOT_NAME), null);
  assert.equal(skipMention({ ...ev, fromId: BOT }, BOT_NAME), 'our own comment', 'the webhook\'s entry.id is the bot');
  assert.equal(skipMention({ ...ev, fromId: '1', botId: null }, BOT_NAME, ['1']), 'our own comment');
  assert.equal(skipMention({ ...ev, fromId: '9', fromUsername: 'InstaPaid.Official' }, BOT_NAME), 'our own comment');
  assert.equal(skipMention({ ...ev, productType: 'STORY' }, BOT_NAME), 'a Story');
  assert.equal(skipMention({ ...ev, text: '@instapaid.official love this' }, BOT_NAME), 'not a launch request');
  assert.equal(skipMention({ ...ev, text: 'make a token for this creator' }, BOT_NAME), 'not a launch request', 'must name the bot');
  assert.equal(skipMention({ field: 'mentions', commentId: 'c', mediaId: 'm' }, BOT_NAME), null, 'no text yet: read it first');
});

test('the command with or without the "@", any case; never inside another handle or an e-mail address', () => {
  for (const ok of ['instapaid.official make a token for this creator', 'InstaPaid.Official launch a coin pls',
    'hey @instapaid.official, make a coin!', 'make a token instapaid.official']) assert.ok(isLaunchRequest(ok, BOT_NAME), ok);
  for (const no of ['notinstapaid.official make a token', 'mail hello@instapaid.official make a token',
    '@instapaid.officials make a token', '@instapaid.official.fake make a token', 'instapaid make a token']) assert.ok(!isLaunchRequest(no, BOT_NAME), no);
  assert.equal(commentLore('instapaid.official make a token for this creator: king of sunsets', BOT_NAME), 'king of sunsets');
  assert.equal(commentLore('make a token: king of sunsets instapaid.official', BOT_NAME), 'king of sunsets');
});

test('the bot\'s IG_ID comes from /me?fields=user_id,username, once; a failed lookup is asked again', async () => {
  const g = fakeIg();
  const ig = { accessToken: TOKEN, graphVersion: 'v23.0' };
  assert.deepEqual(await igAccount(ig, g.fetch), { userId: BOT, username: BOT_NAME });
  assert.deepEqual(await igAccount(ig, g.fetch), { userId: BOT, username: BOT_NAME });
  assert.deepEqual(g.calls, [{ origin: 'https://graph.instagram.com', method: 'GET', path: 'me', fields: 'user_id,username' }]);

  const bad = fakeIg({ fail: ['me'] });
  const ig2 = { accessToken: TOKEN, graphVersion: 'v23.0' };
  await assert.rejects(igAccount(ig2, bad.fetch), /GET \/me → 400 \(#190\) Invalid OAuth access token/);
  bad.fail.delete('me');
  assert.equal((await igAccount(ig2, bad.fetch)).userId, BOT);
  assert.equal(bad.calls.length, 2);
  assert.equal((await igAccount({ userId: '7', accessToken: TOKEN }, async () => { throw new Error('not asked'); })).userId, '7');
});

test('a mention on another account\'s post, read through each fallback in turn, launches and replies via /<IG_ID>/mentions', async () => {
  const cases = [
    { fail: [], reads: ['mentioned_comment'] },
    { fail: ['mentioned_comment'], reads: ['mentioned_comment', 'mentioned_media'] },
    { fail: ['mentioned_comment', 'mentioned_media'], reads: ['mentioned_comment', 'mentioned_media', 'm1'] },
  ];
  for (const [i, c] of cases.entries()) {
    const g = fakeIg({ fail: c.fail });
    const t = await app(g);
    try {
      const lines = await logged(() => hook(t, i === 1 ? inChanges() : documented()));
      assert.deepEqual(g.reads().filter((p) => p !== 'p.jpg'), c.reads, `case ${i}`);
      const tries = lines.filter((l) => l.startsWith('mention: read post via'));
      assert.equal(tries.length, c.reads.length);
      if (c.fail.includes('mentioned_comment')) {
        assert.equal(tries[0], 'mention: read post via mentioned_comment → 400 (#10) Application does not have permission for this action');
      }
      if (c.fail.includes('mentioned_media')) assert.match(tries[1], /^mention: read post via mentioned_media → 400 \(#100\) Tried accessing nonexisting field/);
      assert.match(tries.at(-1), / → 200, owner @nat\.geo$/);

      const row = t.db.prepare('select * from token').get();
      assert.equal(row.username, 'nat.geo', 'the coin is for the post\'s owner');
      assert.equal(row.post_permalink, PERMALINK);
      assert.equal(row.lore, 'king of sunsets');
      assert.equal(t.calls.lore[0].caption, 'Sunrise over Baguio');
      assert.equal(t.calls.lore[0].image.buf.compare(POST_PNG), 0, 'the post\'s photo');

      assert.equal(g.replies.length, 1);
      assert.deepEqual(g.replies[0], {
        comment_id: 'c1', media_id: 'm1',
        message: launchedReply({ username: 'nat.geo', name: row.name, symbol: row.symbol, mint: row.mint, lore: 'king of sunsets',
          postPermalink: PERMALINK, photo: true, posted: false, publicUrl: 'https://instapaid.test' }),
      });
      assert.equal(g.calls.filter((x) => x.path === 'me').length, 1, 'IG_ID read once from /me');
      assert.ok(g.calls.every((x) => x.origin !== 'https://graph.facebook.com'), 'no Facebook Graph at all');
      assert.ok(lines.includes('mention: replied via Instagram Login → 200'));
      assert.ok(lines.every((l) => !l.includes(TOKEN) && !l.includes('king of sunsets')), 'no token, no comment text in the logs');
    } finally { t.close(); }
  }
});

test('all three reads fail: no launch, no reply, and the log says so', async () => {
  const g = fakeIg({ fail: ['mentioned_comment', 'mentioned_media', 'media'] });
  const t = await app(g);
  try {
    const lines = await logged(() => hook(t, documented()));
    assert.deepEqual(lines.filter((l) => l.startsWith('mention: ')), [
      'mention: read post via mentioned_comment → 400 (#10) Application does not have permission for this action',
      'mention: read post via mentioned_media → 400 (#100) Tried accessing nonexisting field (mentioned_media) on node type (User)',
      'mention: read post via media → 400 (#100) Unsupported get request. Object with ID \'m1\' does not exist',
      'mention: could not read the post — see the lines above',
    ]);
    assert.equal(t.calls.serverLaunches.length, 0);
    assert.equal(g.replies.length, 0);
    assert.equal(g.calls.filter((c) => c.method === 'POST').length, 0, 'nothing posted anywhere');
    assert.deepEqual(t.db.prepare('select status, note from comment_request').get(), { status: 'failed', note: 'could not read the post' });
  } finally { t.close(); }

  // an answer without the owner's username does not count either
  const noOwner = fakeIg({ owner: null });
  const u = await app(noOwner);
  try {
    const lines = await logged(() => hook(u, documented()));
    assert.equal(lines.filter((l) => l.endsWith('→ 200, no owner username')).length, 3);
    assert.equal(u.calls.serverLaunches.length, 0);
    assert.equal(noOwner.replies.length, 0);
  } finally { u.close(); }
});

test('with the Facebook Login settings too, graph.facebook.com is the last try, and the fallback for a refused reply', async () => {
  const g = fakeIg({ fail: ['mentioned_comment', 'mentioned_media', 'media', 'reply'], fb: 'nat.geo' });
  const t = await start({ config: igOnly({ igUserId: '42', fbAccessToken: 'fb' }), comments, fetchImpl: g.fetch });
  try {
    const lines = await logged(() => hook(t, documented()));
    assert.ok(lines.includes('mention: read post via Facebook Login mentioned_comment → 200, owner @nat.geo'));
    assert.equal(t.calls.serverLaunches.length, 1);
    assert.ok(lines.includes('mention: reply via Instagram Login → 400 (#200) Requires instagram_business_manage_comments permission'));
    assert.equal(g.fbReplies.length, 1);
    assert.equal(g.fbReplies[0].comment_id, 'c1');
  } finally { t.close(); }
});

test('the IG_ID cannot be read: the two /<IG_ID> reads are skipped, /<media id> is still tried', async () => {
  const g = fakeIg({ fail: ['me'] });
  const lines = [];
  const log = { log: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) };
  const got = await readMention({ ig: { accessToken: TOKEN, graphVersion: 'v23.0' } }, { commentId: 'c1', mediaId: 'm1', text: ASK }, g.fetch, log);
  assert.equal(got.media.username, 'nat.geo');
  assert.equal(got.text, ASK, 'the webhook\'s text when the read does not carry it');
  assert.equal(got.via, 'media');
  assert.match(lines[0], /^mention: read post via mentioned_comment → skipped \(the bot's IG_ID is unknown: GET \/me → 400 \(#190\)/);
  assert.match(lines[2], /^mention: read post via media → 200, owner @nat\.geo$/);
  assert.equal(await replyToMention({ ig: { accessToken: TOKEN, graphVersion: 'v23.0' } }, { commentId: 'c1', mediaId: 'm1' }, 'hi', g.fetch, log), false);
  assert.equal(g.replies.length, 0);
});

test('a comment on the bot\'s own post is not a launch request', async () => {
  // Meta does not say whose post it is: the read does (the owner is the bot), so nothing happens.
  const g = fakeIg({ fail: ['mentioned_comment', 'mentioned_media'], owner: BOT_NAME });
  const t = await app(g);
  try {
    await logged(() => hook(t, documented()));
    assert.equal(t.calls.serverLaunches.length, 0);
    assert.equal(g.replies.length, 0);
    assert.deepEqual(t.db.prepare('select status, note from comment_request').get(), { status: 'skipped', note: 'our own post' });
  } finally { t.close(); }

  // one of the poster's own posts is known without asking Instagram
  const h = fakeIg();
  const u = await app(h);
  try {
    getOrCreateAccount(u.db, 'alice', u.cfg.vaultMasterKey);
    u.db.prepare(`insert into token (mint, username, name, symbol, launcher, status, created_at) values ('M', 'alice', 'A', 'A', 'L', 'live', 1)`).run();
    u.db.prepare(`insert into post_job (mint, status, media_id, created_at, next_attempt_at) values ('M', 'posted', 'm1', 1, 1)`).run();
    await logged(() => hook(u, documented()));
    assert.equal(h.calls.filter((c) => c.path !== 'me').length, 0, 'no Graph call');
    assert.equal(u.calls.serverLaunches.length, 0);
    assert.equal(u.db.prepare('select note from comment_request').get().note, 'our own post');
  } finally { u.close(); }
});

test('the bot\'s own reply coming back as a comment is ignored before anything is read', async () => {
  const g = fakeIg();
  const t = await app(g);
  try {
    const echo = launchedReply({ username: 'nat.geo', name: 'Geo', symbol: 'GEO', mint: 'x'.repeat(44), lore: 'make a coin', publicUrl: 'https://instapaid.test' })
      + '\nmake a token @instapaid.official';
    const lines = await logged(async () => {
      await hook(t, documented({ id: 'r1', text: echo, from: { id: BOT, username: BOT_NAME } }));
      await hook(t, documented({ id: 'r2', text: echo, from: { username: BOT_NAME } }));
    });
    assert.ok(lines.includes('mention: comment r1 (comments) ignored: our own comment'));
    assert.ok(lines.includes('mention: comment r2 (comments) ignored: our own comment'));
    assert.equal(g.calls.length, 0);
    assert.equal(t.db.prepare('select count(*) n from comment_request').get().n, 0);
  } finally { t.close(); }
});

test('the command without the "@" launches too', async () => {
  const g = fakeIg({ text: 'instapaid.official make a token for this creator' });
  const t = await app(g);
  try {
    await logged(() => hook(t, documented({ text: 'instapaid.official make a token for this creator' })));
    assert.equal(t.calls.serverLaunches.length, 1);
    assert.equal(g.replies.length, 1);
    assert.equal(t.calls.lore[0].lore, null);
  } finally { t.close(); }
});

test('Stories and comments that do not ask are ignored; private posts send no webhook at all', async () => {
  const g = fakeIg();
  const t = await app(g);
  try {
    const lines = await logged(async () => {
      await hook(t, documented({ id: 's1', media: { id: 'm1', media_product_type: 'STORY' } }));
      await hook(t, documented({ id: 'n1', text: 'love this @instapaid.official' }));
    });
    assert.ok(lines.includes('mention: comment s1 (comments) ignored: a Story'));
    assert.ok(lines.includes('mention: comment n1 (comments) ignored: not a launch request'));
    assert.equal(g.calls.length, 0);
    assert.equal(t.calls.serverLaunches.length, 0);
  } finally { t.close(); }
});

test('COMMENT_LAUNCHES=0 (or no token at all): comment events are logged and left alone; DMs still work', async () => {
  assert.equal(commentLaunchesOff({ commentLaunches: false, ig: { accessToken: TOKEN } }), 'COMMENT_LAUNCHES is 0');
  assert.equal(commentLaunchesOff({ ig: { accessToken: '' } }), 'IG_ACCESS_TOKEN is not set');
  assert.equal(commentLaunchesOff({ ig: { accessToken: TOKEN } }), null);
  assert.equal(commentLaunchesOff({ ig: {}, igUserId: '1', fbAccessToken: 'fb' }), null, 'the Facebook Login path alone');
  const g = fakeIg();
  const t = await app(g, { commentLaunches: false });
  try {
    const lines = await logged(() => hook(t, documented()));
    assert.ok(lines.includes('mention: 1 comment event not handled: comment launches are off (COMMENT_LAUNCHES is 0)'));
    assert.equal(g.calls.length, 0);
    assert.equal(t.db.prepare('select count(*) n from comment_request').get().n, 0);
  } finally { t.close(); }
});

test('every webhook entry\'s shape is logged: keys, fields, text length; never the text', async () => {
  const g = fakeIg();
  const t = await app(g, { commentLaunches: false });
  try {
    const secret = 'my private DM words';
    const lines = await logged(async () => {
      await hook(t, documented());
      await hook(t, inChanges());
      await hook(t, { object: 'instagram', entry: [{ id: BOT, time: 1, messaging: [{ sender: { id: '77' }, recipient: { id: BOT }, timestamp: 1, message: { mid: 'x', text: secret } }] }] });
    });
    assert.ok(lines.includes(`webhook: entry 1/1 entry={field,id,time,value} field=comments value={from,id,media,text} from={id,username} media={id,media_product_type} text=${ASK.length} chars`), lines.join('\n'));
    assert.ok(lines.includes(`webhook: entry 1/1 entry={changes,id,time} changes[field=comments value={from,id,media,text} from={id,username} media={id,media_product_type} text=${ASK.length} chars]`));
    assert.ok(lines.includes(`webhook: entry 1/1 entry={id,messaging,time} messaging[{message,recipient,sender,timestamp} message={mid,text} text=${secret.length} chars]`));
    assert.ok(lines.some((l) => l.startsWith('webhook: object=instagram entries=1 messaging=0 changes=[] fields=[comments]')));
    assert.ok(lines.every((l) => !l.includes(secret) && !l.includes('king of sunsets')));
    assert.match(describeEntry(null), /entry=object/);
  } finally { t.close(); }
});

test('subscribed_apps: messages and comments, and Meta\'s answer is kept for the log', async () => {
  let seen;
  const r = await subscribeMessages({ graphVersion: 'v23.0', accessToken: TOKEN }, async (url, init) => {
    seen = { url, init };
    return new Response('{"success":true}', { status: 200 });
  }, ['messages', 'comments']);
  assert.deepEqual(r, { ok: true, answer: '{"success":true}' });
  assert.match(seen.url, /^https:\/\/graph\.instagram\.com\/v23\.0\/me\/subscribed_apps\?subscribed_fields=messages,comments&access_token=IGT-/);
  assert.equal(seen.init.method, 'POST');
  const bad = await subscribeMessages({ graphVersion: 'v23.0', accessToken: TOKEN }, async () => new Response(
    '{"error":{"message":"Unsupported post request","code":100}}', { status: 400 }), ['messages', 'comments']);
  assert.equal(bad.reason, 'Instagram said 400: (#100) Unsupported post request');
});

test('settings: no IG_FB_ACCESS_TOKEN is fine; a half Facebook Login setup is only noted; IG_GRAPH_BASE_URL is checked', () => {
  const hex = 'a'.repeat(64);
  const base = {
    vaultMasterKey: hex, sessionSecret: hex, feePayerSecret: 'k', platformFeeBps: 0,
    ig: { appSecret: 's', accessToken: TOKEN, verifyToken: 'v', graphBaseUrl: 'https://graph.instagram.com' },
    igUserId: '', fbAccessToken: '', graphBaseUrl: 'https://graph.facebook.com', commentLaunches: true,
  };
  assert.doesNotThrow(() => assertConfig(base));
  assert.deepEqual(configNotes(base), []);
  assert.doesNotThrow(() => assertConfig({ ...base, igUserId: '1784' }));
  assert.deepEqual(configNotes({ ...base, igUserId: '1784' }),
    ['IG_USER_ID is set without IG_FB_ACCESS_TOKEN: the Facebook Login path is off, and Instagram Login (IG_ACCESS_TOKEN) is used']);
  assert.throws(() => assertConfig({ ...base, ig: { ...base.ig, graphBaseUrl: 'http://evil.example' } }), /IG_GRAPH_BASE_URL must be an https address/);
  assert.doesNotThrow(() => assertConfig({ ...base, ig: { ...base.ig, graphBaseUrl: 'http://127.0.0.1:9999' } }));
});

/** The documented body, but the comment's id under value.comment_id (no value.id). */
const withCommentId = (opts) => {
  const d = documented(opts);
  const { id, ...rest } = d.entry[0].value;
  d.entry[0].value = { comment_id: id, ...rest };
  return d;
};
const commentIdInChanges = (opts) => {
  const d = withCommentId(opts);
  const { field, value, ...entry } = d.entry[0];
  return { object: 'instagram', entry: [{ ...entry, changes: [{ field, value }] }] };
};

test('comment events: the comment id as value.comment_id, and the post id as value.media_id, in both shapes', () => {
  const want = { field: 'comments', commentId: 'c1', mediaId: 'm1', botId: BOT, text: ASK, fromId: '5566778899', fromUsername: 'fan.one', productType: 'FEED' };
  assert.deepEqual(mentionEvents(withCommentId()), [want]);
  assert.deepEqual(mentionEvents(commentIdInChanges()), [want]);
  const flat = { object: 'instagram', entry: [{ id: BOT, field: 'comments', value: { comment_id: 'c1', media_id: 'm1', text: ASK, from: { id: '5566778899', username: 'fan.one' } } }] };
  assert.deepEqual(mentionEvents(flat), [{ ...want, productType: null }]);
  // both present: the documented value.id wins
  const both = documented();
  both.entry[0].value.comment_id = 'other';
  assert.equal(mentionEvents(both)[0].commentId, 'c1');
});

test('a comment event with no comment id or no post id is dropped with one log line, not silently', async () => {
  const why = [];
  assert.deepEqual(mentionEvents(documented({ id: null }), (w) => why.push(w)), []);
  assert.deepEqual(mentionEvents(documented({ media: {} }), (w) => why.push(w)), []);
  assert.deepEqual(mentionEvents({ object: 'instagram', entry: [{ id: '42', changes: [{ field: 'mentions', value: { media_id: 'm9' } }] }] }, (w) => why.push(w)), []);
  assert.deepEqual(why, [
    'a "comments" event with no comment id (value={from,id,media,text})',
    'a "comments" event with no post id (value={from,id,media,text})',
    'a "mentions" event with no comment id (value={media_id})',
  ]);

  const g = fakeIg();
  const t = await app(g);
  try {
    const lines = await logged(() => hook(t, documented({ id: null })));
    assert.ok(lines.includes('mention: comment event ignored: a "comments" event with no comment id (value={from,id,media,text})'), lines.join('\n'));
    assert.equal(g.calls.length, 0);
  } finally { t.close(); }
});

test('a comment whose id comes as value.comment_id launches and is answered, in both shapes', async () => {
  for (const body of [withCommentId(), commentIdInChanges()]) {
    const g = fakeIg();
    const t = await app(g);
    try {
      await logged(() => hook(t, body));
      assert.equal(t.calls.serverLaunches.length, 1);
      assert.equal(t.db.prepare('select username from token').get().username, 'nat.geo');
      assert.deepEqual(t.db.prepare('select comment_id, media_id, status from comment_request').get(), { comment_id: 'c1', media_id: 'm1', status: 'launched' });
      assert.equal(g.replies.length, 1);
      assert.equal(g.replies[0].comment_id, 'c1');
      assert.equal(g.replies[0].media_id, 'm1');
    } finally { t.close(); }
  }
});

test('the bot\'s IG_ID cannot be read: the post is read, but no coin is launched that no reply could announce', async () => {
  const g = fakeIg({ fail: ['me'] });
  const t = await app(g);
  try {
    const lines = await logged(() => hook(t, documented()));
    assert.ok(lines.includes('mention: read post via media → 200, owner @nat.geo'));
    assert.equal(t.calls.serverLaunches.length, 0, 'no coin');
    assert.equal(t.calls.uploads.length, 0, 'nothing uploaded');
    assert.equal(t.db.prepare('select count(*) n from token').get().n, 0);
    assert.equal(g.calls.filter((c) => c.method === 'POST').length, 0, 'nothing posted anywhere');
    assert.deepEqual(t.db.prepare('select status, username, note from comment_request').get(), { status: 'failed', username: 'nat.geo', note: 'bot IG_ID unknown' });
    assert.ok(lines.some((l) => /^mention: comment c1 not launched: no reply could be sent \(the bot's IG_ID is unknown: GET \/me → 400 \(#190\)/.test(l)), lines.join('\n'));
    assert.equal(g.calls.filter((c) => c.path === 'me').length, 3, 'asked by the read, then twice before the launch');
  } finally { t.close(); }
});

test('a /me that fails once and then answers: the launch goes ahead and the fan gets the reply', async () => {
  const g = fakeIg({ fail: ['me'] });
  const inner = g.fetch;
  let mes = 0;
  g.fetch = async (url, init) => {
    if (new URL(url).pathname.endsWith('/me') && ++mes === 2) g.fail.delete('me');
    return inner(url, init);
  };
  const t = await app(g);
  try {
    await logged(() => hook(t, documented()));
    assert.equal(t.calls.serverLaunches.length, 1);
    assert.equal(g.replies.length, 1);
    assert.equal(t.db.prepare('select status from comment_request').get().status, 'launched');
  } finally { t.close(); }
});

test('replyBlocked: nothing to ask with the Facebook Login fallback; the Instagram path needs the IG_ID', async () => {
  assert.equal(await replyBlocked({ ig: { accessToken: TOKEN }, igUserId: '42', fbAccessToken: 'fb' }, async () => { throw new Error('not asked'); }), null);
  assert.equal(await replyBlocked({ ig: { accessToken: TOKEN, graphVersion: 'v23.0' } }, fakeIg().fetch), null);
  assert.match(await replyBlocked({ ig: { accessToken: TOKEN, graphVersion: 'v23.0' } }, fakeIg({ fail: ['me'] }).fetch), /^the bot's IG_ID is unknown: GET \/me → 400/);
});

test('.env.example copied as .env starts: empty or absent IG_GRAPH_BASE_URL / GRAPH_BASE_URL mean the real Graph APIs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'instapaid-env-'));
  copyFileSync(new URL('../.env.example', import.meta.url), join(dir, '.env'));
  const script = `import(${JSON.stringify(new URL('../src/config.js', import.meta.url).href)}).then((m) => {
    m.assertConfig(); console.log(JSON.stringify([m.config.ig.graphBaseUrl, m.config.graphBaseUrl]));
  })`;
  const hex = 'a'.repeat(64);
  const secrets = { VAULT_MASTER_KEY: hex, SESSION_SECRET: hex, FEE_PAYER_SECRET: 'k', IG_APP_SECRET: 's', IG_ACCESS_TOKEN: TOKEN, IG_WEBHOOK_VERIFY_TOKEN: 'v' };
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/GRAPH_BASE_URL/.test(k)));
  for (const extra of [{}, { IG_GRAPH_BASE_URL: '', GRAPH_BASE_URL: '' }, { IG_GRAPH_BASE_URL: '  ', GRAPH_BASE_URL: ' ' }]) {
    const out = execFileSync(process.execPath, ['-e', script], { cwd: dir, env: { ...clean, ...secrets, ...extra }, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(out.trim().split('\n').at(-1)), ['https://graph.instagram.com', 'https://graph.facebook.com'], JSON.stringify(extra));
  }
  // An .env with the old empty lines behaves the same.
  writeFileSync(join(dir, '.env'), 'IG_GRAPH_BASE_URL=\nGRAPH_BASE_URL=\n');
  const out = execFileSync(process.execPath, ['-e', script], { cwd: dir, env: { ...clean, ...secrets }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out.trim().split('\n').at(-1)), ['https://graph.instagram.com', 'https://graph.facebook.com']);
  rmSync(dir, { recursive: true, force: true });
});
