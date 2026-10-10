// The launcher bot: the scout reads public profiles and ranks creators; the bot launches for the top
// one only when switched on, within its limits, and says the bot made the coin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProfile, scoreProfile, parseWatchlist, shortcodeOf, bestPost, discoverProfile } from '../src/scout.js';
import { postCaption } from '../src/poster.js';
import { start, cfg } from './helpers.js';

const NOW = Date.now();
const HOUR = 3_600_000;

/** instagram.com's profile JSON for a made-up public creator. */
function profileJson(username, { followers = 50_000, likes = 4_000, comments = 120, ageH = 20, isPrivate = false, related = [] } = {}) {
  const post = (i) => ({
    node: {
      shortcode: `${username.replace(/\W/g, '')}${i}`, taken_at_timestamp: Math.floor((NOW - (ageH + i * 24) * HOUR) / 1000),
      edge_liked_by: { count: likes - i * 100 }, edge_media_to_comment: { count: comments },
      is_video: false, display_url: `https://scontent.cdninstagram.com/${username}-${i}.jpg`,
      edge_media_to_caption: { edges: [{ node: { text: `Post ${i} by ${username}` } }] },
    },
  });
  return {
    data: {
      user: {
        username, full_name: username.toUpperCase(), is_private: isPrivate, is_verified: false,
        edge_followed_by: { count: followers },
        edge_owner_to_timeline_media: { count: 12, edges: [0, 1, 2].map(post) },
        edge_related_profiles: { edges: related.map((u) => ({ node: { username: u } })) },
      },
    },
  };
}

/** A stand-in for instagram.com: profiles by username, or a status for all of them. */
function fakeInstagram(profiles, { status } = {}) {
  const seen = [];
  const f = async (url) => {
    const u = new URL(url).searchParams.get('username');
    seen.push(u);
    if (status) return new Response('{}', { status });
    if (!profiles[u]) return new Response('{"data":{"user":null}}', { status: 200 });
    return new Response(JSON.stringify(profiles[u]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  f.seen = seen;
  return f;
}

test('a profile is scored on its last week of engagement; private or quiet accounts score 0', () => {
  const hot = scoreProfile(parseProfile(profileJson('hot.one').data.user), NOW);
  assert.ok(hot.score > 0);
  assert.equal(hot.recent, 3);
  assert.equal(hot.top.shortcode, 'hotone0', 'the most engaged recent post names the coin');
  assert.equal(scoreProfile(parseProfile(profileJson('shy', { isPrivate: true }).data.user), NOW).score, 0);
  assert.equal(scoreProfile(parseProfile(profileJson('quiet', { ageH: 24 * 30 }).data.user), NOW).score, 0);
});

test('the scout reads nothing until Scouting is on, then walks from the seeds through related accounts', async () => {
  const insta = fakeInstagram({
    'seed.one': profileJson('seed.one', { related: ['friend.a', 'friend.b', 'instapaid.official'] }),
    'friend.a': profileJson('friend.a', { likes: 9_000 }),
  });
  const t = await start({ scoutFetch: insta });
  try {
    t.scout.addSeeds(['seed.one']);
    assert.equal((await t.scout.tick()).outcome, 'off');
    assert.equal(insta.seen.length, 0, 'nothing is read while it is off');
    t.scout.setCrawling(true);
    const r = await t.scout.tick();
    assert.equal(r.username, 'seed.one');
    assert.equal(r.outcome, 'ok');
    const known = t.db.prepare('select username from scout_profile order by username').all().map((x) => x.username);
    assert.deepEqual(known, ['friend.a', 'friend.b', 'seed.one'], 'related accounts are queued; never the bot itself');
    assert.equal((await t.scout.tick()).username, 'friend.a');
    assert.equal((await t.scout.tick()).outcome, 'missing', 'an account that does not exist is marked and skipped');
    assert.deepEqual(t.scout.candidates().map((c) => c.username), ['friend.a', 'seed.one'], 'best first');
  } finally { t.close(); }
});

test('when Instagram says slow down, the scout pauses and backs off', async () => {
  const t = await start({ scoutFetch: fakeInstagram({}, { status: 429 }) });
  try {
    t.scout.addSeeds(['seed.one']);
    t.scout.setCrawling(true);
    assert.equal((await t.scout.tick()).outcome, 'slowed');
    assert.equal((await t.scout.tick()).outcome, 'paused');
    assert.ok(t.scout.status().pausedUntil > Date.now());
  } finally { t.close(); }
});

async function scouted(opts = {}) {
  const insta = fakeInstagram({
    'hot.one': profileJson('hot.one', { likes: 9_000 }),
    'warm.two': profileJson('warm.two', { likes: 2_000 }),
  });
  const t = await start({ scoutFetch: insta, feePayerLamports: 2n * 10n ** 9n, ...opts });
  t.scout.addSeeds(['hot.one', 'warm.two']);
  t.scout.setCrawling(true);
  await t.scout.tick();
  await t.scout.tick();
  return t;
}

test('the bot launches nothing while Auto-launch is off', async () => {
  const t = await scouted();
  try {
    assert.equal(t.bot.botLaunching(), false, 'off by default');
    assert.equal((await t.bot.autoLaunch()).outcome, 'off');
    assert.equal(t.calls.serverLaunches.length, 0);
  } finally { t.close(); }
});

test('switched on, the bot launches for the top creator, from their best post, and says the bot made it', async () => {
  const t = await scouted();
  try {
    t.bot.setBotLaunching(true);
    const r = await t.bot.autoLaunch();
    assert.equal(r.outcome, 'launched');
    assert.equal(r.username, 'hot.one');
    const tok = t.db.prepare('select * from token where mint = ?').get(r.mint);
    assert.equal(tok.origin, 'bot');
    assert.equal(tok.source, 'comment', 'server-paid, like a comment launch');
    assert.equal(tok.post_permalink, 'https://www.instagram.com/p/hotone0/');
    assert.match(t.calls.uploads[0].description, /Launched by the InstaPaid bot/);
    assert.equal(t.calls.lore[0].caption, 'Post 0 by hot.one');
    assert.match(postCaption(tok, 'https://instapaid.test'), /Made by the InstaPaid bot, not by @hot\.one/);
    const recent = await (await t.get('/api/recent')).json();
    assert.equal(recent.tokens[0].origin, 'bot', 'the site labels it');
    // The next run takes the next creator; one coin per creator.
    assert.equal((await t.bot.autoLaunch()).username, 'warm.two');
  } finally { t.close(); }
});

test('the bot stops at its daily cap, a low fee payer, and skips anyone who opted out', async () => {
  const t = await scouted();
  try {
    t.bot.setBotLaunching(true);
    t.db.prepare('insert into creator_block (username, created_at) values (?, ?)').run('hot.one', Date.now());
    assert.equal((await t.bot.autoLaunch()).username, 'warm.two', 'the opted-out creator is skipped');
    t.db.prepare('delete from creator_block').run();
    assert.equal((await t.bot.autoLaunch()).username, 'hot.one');
    assert.equal((await t.bot.autoLaunch()).outcome, 'daily cap', 'SCOUT_MAX_LAUNCHES_PER_DAY is 2 here');
  } finally { t.close(); }
  const poor = await scouted({ feePayerLamports: 3n * 10n ** 8n });
  try {
    poor.bot.setBotLaunching(true);
    assert.equal((await poor.bot.autoLaunch()).outcome, 'fee payer low', '0.3 SOL is under the 0.5 SOL floor');
    assert.equal(poor.calls.serverLaunches.length, 0);
  } finally { poor.close(); }
});

// ---- The watchlist: creators the owner pastes in /admin, launched for before the shortlist.

test('watchlist lines: usernames, profile links, an optional post link each; never the bot, no repeats', () => {
  assert.deepEqual(parseWatchlist(
    '@Nat.Geo https://www.instagram.com/p/DAbc123xyz/?igsh=1\nhttps://instagram.com/foo.bar/ , baz instagram.com/reel/XYZab12/\n'
    + 'instapaid.official https://www.instagram.com/p/Nope12345/\nnat.geo\nnot a/valid!name explore',
    'instapaid.official',
  ), [
    { username: 'nat.geo', postUrl: 'https://www.instagram.com/p/DAbc123xyz/' },
    { username: 'foo.bar', postUrl: null },
    { username: 'baz', postUrl: 'https://www.instagram.com/p/XYZab12/' },
    { username: 'not', postUrl: null },
  ]);
  assert.equal(shortcodeOf('https://www.instagram.com/someone/reel/ABCDE12/'), 'ABCDE12');
  assert.equal(shortcodeOf('https://evil.example/p/ABCDE12/'), null);
  assert.equal(shortcodeOf('http://www.instagram.com/p/ABCDE12/'), null);
  const p = parseProfile(profileJson('pick.me').data.user);
  assert.equal(bestPost(p, 'https://www.instagram.com/p/pickme2/').shortcode, 'pickme2', 'the post the owner linked');
  assert.equal(bestPost(p, 'https://www.instagram.com/p/elsewhere1/').shortcode, 'pickme0', 'else the most engaged');
  assert.equal(bestPost({ posts: [] }), null);
});

/** Meta's Business Discovery answer for a made-up Business account. */
function discovery(username, { followers = 80_000 } = {}) {
  return {
    business_discovery: {
      username, name: username.toUpperCase(), followers_count: followers,
      media: {
        data: [0, 1, 2].map((i) => ({
          caption: `BD post ${i} by ${username}`, media_type: i === 1 ? 'VIDEO' : 'IMAGE',
          media_url: `https://scontent.cdninstagram.com/bd-${username}-${i}.jpg`, thumbnail_url: `https://scontent.cdninstagram.com/bd-${username}-${i}-cover.jpg`,
          permalink: `https://www.instagram.com/p/${username.replace(/\W/g, '')}BD${i}/`,
          timestamp: new Date(NOW - (10 + i * 24) * HOUR).toISOString().replace('.000Z', '+0000'),
          like_count: 5_000 - i * 1_000, comments_count: i === 1 ? 900 : 100,
        })),
      },
    },
  };
}

/**
 * Stand-ins for graph.instagram.com (Business Discovery refused: not documented there), graph.facebook.com
 * (Business Discovery for `business` usernames) and instagram.com (profiles, or a status for all).
 */
function fakeMeta({ business = {}, profiles = {}, webStatus, igDiscovery = false, fbStatus } = {}) {
  const seen = [];
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  const f = async (url) => {
    const u = new URL(url);
    if (u.hostname === 'graph.instagram.com') {
      if (u.pathname.endsWith('/me')) return json({ user_id: '17841499999999999', username: 'instapaid.official' });
      const name = u.searchParams.get('fields').match(/username\(([^)]+)\)/)[1];
      seen.push(`ig:${name}`);
      if (!igDiscovery) return json({ error: { message: 'Tried accessing nonexisting field (business_discovery) on node type (User)', code: 100 } }, 400);
      return business[name] ? json(business[name]) : json({ error: { message: 'Cannot find User', code: 110 } }, 400);
    }
    if (u.hostname === 'graph.facebook.com') {
      const name = u.searchParams.get('fields').match(/username\(([^)]+)\)/)[1];
      seen.push(`fb:${name}`);
      if (fbStatus) return json({ error: { message: 'Application request limit reached', code: 4 } }, fbStatus);
      return business[name] ? json(business[name]) : json({ error: { message: 'Invalid user id', code: 110, error_subcode: 2207013 } }, 400);
    }
    const name = u.searchParams.get('username');
    seen.push(`web:${name}`);
    if (webStatus) return new Response('{}', { status: webStatus });
    if (!profiles[name]) return new Response('', { status: 404 });
    return json(profiles[name]);
  };
  f.seen = seen;
  return f;
}

test('Business Discovery: a Business account read the official way, in the scout\'s shape; Meta\'s errors mapped', async () => {
  const meta = fakeMeta({ business: { 'shop.one': discovery('shop.one') } });
  const c = { ...cfg, ig: { ...cfg.ig } };
  const p = await discoverProfile(c, 'shop.one', 'facebook', meta);
  assert.equal(p.followers, 80_000);
  assert.deepEqual(p.related, []);
  assert.deepEqual(p.posts.map((x) => [x.shortcode, x.isVideo, x.imageUrl.split('/').pop()]),
    [['shoponeBD0', false, 'bd-shop.one-0.jpg'], ['shoponeBD1', true, 'bd-shop.one-1-cover.jpg'], ['shoponeBD2', false, 'bd-shop.one-2.jpg']]);
  assert.ok(Math.abs(p.posts[0].takenAt - (NOW - 10 * HOUR)) < 1000, 'Meta\'s +0000 timestamps are read');
  assert.equal(scoreProfile(p, NOW).top.shortcode, 'shoponeBD1', 'scored like any profile');
  await assert.rejects(discoverProfile(c, 'nobody.here', 'facebook', meta), (e) => e.missing === true);
  await assert.rejects(discoverProfile(c, 'shop.one', 'facebook', fakeMeta({ fbStatus: 400 })), (e) => e.slowDown === true);
  await assert.rejects(discoverProfile(c, 'shop.one', 'instagram', meta), (e) => e.unsupported === true && !e.missing);
});

/** A server whose bot has the watchlist, Auto-launch on, money for it, and these stand-ins. */
async function watching(meta, opts = {}) {
  const t = await start({ scoutFetch: meta, feePayerLamports: 2n * 10n ** 9n, ...opts });
  t.bot.setBotLaunching(true);
  return t;
}

test('the watchlist launches first, from the linked post read through Business Discovery, and never says "trending"', async () => {
  const meta = fakeMeta({
    business: { 'shop.one': discovery('shop.one') },
    profiles: { 'hot.one': profileJson('hot.one', { likes: 9_000 }) },
  });
  const t = await watching(meta);
  try {
    // A trending creator on the shortlist too: the watchlist still goes first.
    t.scout.addSeeds(['hot.one']);
    t.scout.setCrawling(true);
    await t.scout.tick();
    assert.equal(t.scout.candidates()[0].username, 'hot.one');
    assert.equal(t.scout.watch('shop.one https://www.instagram.com/p/shoponeBD2/'), 1);

    const lines = [];
    const saved = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    let r;
    try { r = await t.bot.autoLaunch(); } finally { console.log = saved; }
    assert.deepEqual([r.outcome, r.username, r.from], ['launched', 'shop.one', 'watchlist']);
    const tok = t.db.prepare('select * from token where mint = ?').get(r.mint);
    assert.equal(tok.origin, 'bot');
    assert.equal(tok.post_permalink, 'https://www.instagram.com/p/shoponeBD2/', 'the post the owner linked');
    assert.equal(t.calls.lore[0].caption, 'BD post 2 by shop.one');
    assert.match(t.calls.uploads[0].description, /^Creator fees go to Instagram @shop\.one.*Launched by the InstaPaid bot, not by @shop\.one/);
    assert.doesNotMatch(t.calls.uploads[0].description, /trending/);
    assert.ok(lines.some((l) => l.includes('for @shop.one (watchlist, profile via facebook)')), lines.join('\n'));
    assert.deepEqual(meta.seen.filter((x) => x.endsWith('shop.one')), ['ig:shop.one', 'fb:shop.one'], 'never instagram.com when Meta answers');
    assert.equal(t.scout.watchlist()[0].mint, r.mint);
    // Next run: the watchlist is done, so the shortlist; and the Instagram-token try is not made again.
    assert.equal((await t.bot.autoLaunch()).username, 'hot.one');
    t.scout.watch('other.shop');
    await t.bot.autoLaunch();
    assert.ok(!meta.seen.includes('ig:other.shop'), 'Business Discovery with the Instagram token was dropped once refused');
  } finally { t.close(); }
});

test('a watched creator nothing can read waits (unless the owner linked a post); a missing account is noted; opt-outs never launch', async () => {
  const meta = fakeMeta({ webStatus: 429 });
  const t = await watching(meta, { config: { igUserId: '', fbAccessToken: '' } });
  try {
    t.scout.watch('just.name\nlinked.one https://www.instagram.com/p/LinkedPost1/\nopted.out https://www.instagram.com/p/Opted12345/');
    t.db.prepare('insert into creator_block (username, created_at) values (?, ?)').run('opted.out', Date.now());
    const r = await t.bot.autoLaunch();
    assert.deepEqual([r.outcome, r.username], ['launched', 'linked.one']);
    const w = Object.fromEntries(t.scout.watchlist().map((x) => [x.username, x]));
    assert.match(w['just.name'].note, /^profile not readable \(Instagram asked us to slow down \(429\)\); add a link to one of their posts/);
    assert.equal(w['just.name'].mint, null);
    const tok = t.db.prepare('select * from token where mint = ?').get(r.mint);
    assert.equal(tok.post_permalink, 'https://www.instagram.com/p/LinkedPost1/', 'the linked post is the coin\'s link');
    assert.equal(t.calls.lore[0].image, undefined, 'no picture could be read: the default coin picture, and Claude names it from the username');
    assert.ok(t.scout.status().pausedUntil > Date.now(), 'instagram.com\'s 429 starts the scout\'s pause');
    assert.ok(!t.scout.watched().some((x) => x.username === 'opted.out'));
    // While paused, instagram.com is not asked again; after two tries the bot gives up on just.name.
    const before = meta.seen.length;
    assert.equal((await t.bot.autoLaunch()).outcome, 'no candidate');
    assert.equal(meta.seen.length, before);
    assert.match(t.scout.watchlist().find((x) => x.username === 'just.name').note, /instagram\.com asked us to pause until/);
    assert.equal(t.scout.watched().length, 0, 'two tries, then it waits for the owner to paste it again');
    t.scout.watch('just.name');
    assert.equal(t.scout.watched()[0].username, 'just.name', 'pasting again resets the tries');
  } finally { t.close(); }

  const gone = await watching(fakeMeta({ profiles: {} }), { config: { igUserId: '', fbAccessToken: '' } });
  try {
    gone.scout.watch('no.such.person https://www.instagram.com/p/Whatever12/');
    assert.equal((await gone.bot.autoLaunch()).outcome, 'no candidate');
    assert.match(gone.scout.watchlist()[0].note, /^no such account/, 'instagram.com says there is none: not launched, even with a link');
    assert.equal(gone.calls.serverLaunches.length, 0);
  } finally { gone.close(); }
});
