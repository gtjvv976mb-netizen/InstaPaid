// The launcher bot: the scout reads public profiles and ranks creators; the bot launches for the top
// one only when switched on, within its limits, and says the bot made the coin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProfile, scoreProfile } from '../src/scout.js';
import { postCaption } from '../src/poster.js';
import { start } from './helpers.js';

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
