// The scout: finds trending Instagram creators for the launcher bot (src/app.js autoLaunch).
//
// It reads public profiles the way instagram.com's own page does, with no login: a profile gives its
// follower count, its latest 12 posts (likes, comments, time, photo) and ~50 related accounts. From a
// few seed accounts it walks outward through the related ones, scores each creator on how much
// engagement their last week of posts drew, and keeps the ranking in the scout_profile table.
//
// Slow on purpose: one profile at a time, a pause between each (SCOUT_INTERVAL_S), and a growing
// pause whenever Instagram says "slow down" (429) or asks for a login (401/403). Nothing here spends
// anything or posts anything; the launch is src/app.js's, and only when the owner turns it on.
//
// The watchlist (bot_watch): creators the owner pasted in /admin. The bot launches for them before
// the shortlist, without needing a score. instagram.com answers Render's datacenter address with 429
// every time, so a watched creator's profile is read the official way first when it can be: Meta's
// Business Discovery API (Business and Creator accounts only, and no related accounts, which is why
// the scout's walk keeps to instagram.com's page). It is documented for Facebook Login (IG_USER_ID +
// IG_FB_ACCESS_TOKEN); the same call with the Instagram token on graph.instagram.com is tried too,
// and dropped once Meta refuses the field.
import { normalizeHandle } from './handles.js';
import { graph as igGraph, graphCall, igAccount } from './instagram.js';
import { fbLogin, graphBase } from './comments.js';

// instagram.com's own web app id: its profile JSON answers only requests that carry it.
const WEB_APP_ID = '936619743392459';
const DAY = 24 * 60 * 60_000;
const WEEK = 7 * DAY;
export const RECHECK_AFTER = 3 * DAY; // a checked profile is read again after this
const MAX_BACKOFF = 6 * 60 * 60_000;
const MAX_FRONTIER = 20_000; // profiles kept, checked or waiting
const RELATED_PER_PROFILE = 24;

export class ScoutError extends Error {
  constructor(message, { status = 0, slowDown = false, missing = false } = {}) {
    super(message); this.status = status; this.slowDown = slowDown; this.missing = missing;
  }
}

/** One public profile, read as instagram.com reads it. Throws ScoutError. */
export async function fetchProfile(username, fetchImpl = fetch) {
  const u = normalizeHandle(username);
  if (!u) throw new ScoutError('not a username', { missing: true });
  let r;
  try {
    r = await fetchImpl(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(u)}`, {
      headers: {
        'x-ig-app-id': WEB_APP_ID,
        accept: 'application/json',
        'user-agent': 'Mozilla/5.0 (compatible; InstaPaidScout/1.0; +https://instapaid.fun/terms)',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new ScoutError(`no answer: ${e.message}`);
  }
  // A redirect is the login page: Instagram wants a signed-in visitor for now.
  if (r.status === 429 || r.status === 401 || r.status === 403 || (r.status >= 300 && r.status < 400)) {
    throw new ScoutError(`Instagram asked us to slow down (${r.status})`, { status: r.status, slowDown: true });
  }
  if (r.status === 404) throw new ScoutError('no such account', { status: 404, missing: true });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) throw new ScoutError(`unexpected answer ${r.status}`, { status: r.status, slowDown: r.status >= 500 });
  const user = j?.data?.user;
  if (!user) throw new ScoutError('no such account', { status: r.status, missing: true });
  return parseProfile(user);
}

/** The fields the scout keeps from instagram.com's profile JSON. */
export function parseProfile(user) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const posts = (user.edge_owner_to_timeline_media?.edges ?? []).map(({ node: n = {} }) => ({
    shortcode: String(n.shortcode ?? ''),
    takenAt: num(n.taken_at_timestamp) * 1000,
    likes: num(n.edge_liked_by?.count ?? n.edge_media_preview_like?.count),
    comments: num(n.edge_media_to_comment?.count),
    isVideo: !!n.is_video,
    imageUrl: String(n.display_url ?? n.thumbnail_src ?? ''),
    caption: String(n.edge_media_to_caption?.edges?.[0]?.node?.text ?? ''),
  })).filter((p) => p.shortcode);
  return {
    username: normalizeHandle(user.username ?? ''),
    fullName: String(user.full_name ?? ''),
    isPrivate: !!user.is_private,
    isVerified: !!user.is_verified,
    followers: num(user.edge_followed_by?.count),
    posts,
    related: (user.edge_related_profiles?.edges ?? [])
      .map(({ node }) => normalizeHandle(node?.username ?? '')).filter(Boolean),
  };
}

/** A post's shortcode from its instagram.com link (/p/, /reel/, /reels/, /tv/), or null. */
export function shortcodeOf(u) {
  try {
    const url = new URL(String(u));
    if (url.protocol !== 'https:' || !/^(www\.)?instagram\.com$/.test(url.hostname)) return null;
    const m = url.pathname.match(/^\/(?:[\w.]+\/)?(?:p|reels?|tv)\/([\w-]{5,40})\/?$/);
    return m ? m[1] : null;
  } catch { return null; }
}

// Meta's rate-limit error codes: application, user, Business Use Case, page.
const RATE_LIMITED = new Set([4, 17, 32, 613, 80002]);
const DISCOVERY_MEDIA = 'caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count';

/**
 * One public Business or Creator profile through Meta's Business Discovery API, in parseProfile's
 * shape (no related accounts):
 *   GET <graph>/<v>/<IG_ID>?fields=business_discovery.username(<u>){followers_count,media.limit(12){…}}
 * `via` 'facebook': graph.facebook.com with IG_FB_ACCESS_TOKEN on IG_USER_ID (documented);
 * 'instagram': graph.instagram.com with the Instagram token on the bot's IG_ID (not documented).
 * Throws ScoutError: slowDown on Meta's rate limits, missing when Meta says there is no such
 * Business or Creator account, unsupported when the field itself is refused.
 */
export async function discoverProfile(cfg, username, via, fetchImpl = fetch) {
  const u = normalizeHandle(username);
  if (!u) throw new ScoutError('not a username', { missing: true });
  const fields = `business_discovery.username(${u}){username,name,followers_count,media.limit(12){${DISCOVERY_MEDIA}}}`;
  let url, token;
  if (via === 'facebook') {
    url = `${graphBase(cfg)}/${cfg.fbGraphVersion || 'v23.0'}/${encodeURIComponent(cfg.igUserId)}`;
    token = cfg.fbAccessToken;
  } else {
    let me;
    try { me = await igAccount(cfg.ig, fetchImpl); } catch (e) { throw new ScoutError(`the bot's IG_ID is unknown: ${e.message}`); }
    url = igGraph(cfg.ig, encodeURIComponent(me.userId));
    token = cfg.ig.accessToken;
  }
  const r = await graphCall(fetchImpl, url, token, { params: { fields } });
  if (!r.ok) {
    const e = r.json?.error ?? {};
    if (r.status === 'network') throw new ScoutError(`no answer: ${r.error}`);
    if (RATE_LIMITED.has(e.code) || r.status === 429) throw new ScoutError(`Meta asked us to slow down (${r.error})`, { status: r.status, slowDown: true });
    if (e.code === 110 || e.error_subcode === 2207013) throw new ScoutError(`not a Business or Creator account Meta can show (${r.error})`, { status: r.status, missing: true });
    throw Object.assign(new ScoutError(`Business Discovery refused: ${r.error}`, { status: r.status }), {
      unsupported: e.code === 100 && /nonexisting field|business_discovery/i.test(String(e.message ?? '')),
    });
  }
  const bd = r.json?.business_discovery;
  if (!bd) throw new ScoutError('Business Discovery answered without the profile');
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const posts = (bd.media?.data ?? []).map((m) => ({
    shortcode: shortcodeOf(m.permalink) ?? '',
    takenAt: Date.parse(String(m.timestamp ?? '').replace(/([+-]\d\d)(\d\d)$/, '$1:$2')) || 0,
    likes: num(m.like_count),
    comments: num(m.comments_count),
    isVideo: m.media_type === 'VIDEO',
    imageUrl: String((m.media_type === 'VIDEO' ? m.thumbnail_url : m.media_url) ?? m.thumbnail_url ?? ''),
    caption: String(m.caption ?? ''),
  })).filter((p) => p.shortcode);
  return {
    username: normalizeHandle(bd.username ?? u) ?? u, fullName: String(bd.name ?? ''), isPrivate: false, isVerified: false,
    followers: num(bd.followers_count), posts, related: [],
  };
}

/**
 * The post a coin is named and pictured from: the one the owner linked when it is among the posts
 * read, else the most engaged one with a picture (any age). null when none has a picture.
 */
export function bestPost(p, postUrl = null) {
  const withPicture = (p?.posts ?? []).filter((x) => x.imageUrl);
  const linked = shortcodeOf(postUrl);
  return withPicture.find((x) => linked && x.shortcode === linked)
    ?? [...withPicture].sort((a, b) => (b.likes + 3 * b.comments) - (a.likes + 3 * a.comments))[0] ?? null;
}

/**
 * Watchlist lines as the owner pastes them: usernames ("@" or not, or instagram.com/<name> links),
 * each optionally followed by a link to one of their posts. → [{ username, postUrl }] (no repeats)
 */
export function parseWatchlist(text, bot = '') {
  const out = new Map();
  for (const line of String(text ?? '').split(/\n+/)) {
    let last = null;
    for (const raw of line.split(/[\s,]+/).filter(Boolean)) {
      const code = shortcodeOf(/^https?:/i.test(raw) ? raw : `https://${raw}`);
      if (code) {
        if (last) out.get(last).postUrl = `https://www.instagram.com/p/${code}/`;
        continue;
      }
      let name = raw;
      try {
        const url = new URL(/^https?:/i.test(raw) ? raw : `https://${raw}`);
        if (/^(www\.)?instagram\.com$/.test(url.hostname)) name = url.pathname.split('/').filter(Boolean)[0] ?? '';
      } catch { /* a plain username */ }
      const u = normalizeHandle(name);
      if (!u || u === bot) { last = null; continue; }
      if (!out.has(u)) out.set(u, { username: u, postUrl: null });
      last = u;
    }
  }
  return [...out.values()];
}

/**
 * How much a creator is trending now: the engagement their posts of the last seven days drew
 * (likes, and comments counted three times), per day, with a boost when that is high for their
 * size. 0 for a private account or one with nothing in the last week.
 */
export function scoreProfile(p, now = Date.now()) {
  if (!p || p.isPrivate) return { score: 0, top: null, recent: 0 };
  const recent = p.posts.filter((x) => x.takenAt && now - x.takenAt <= WEEK && now >= x.takenAt);
  if (!recent.length) return { score: 0, top: null, recent: 0 };
  const eng = (x) => x.likes + 3 * x.comments;
  const total = recent.reduce((s, x) => s + eng(x), 0);
  const span = Math.max(1, (now - Math.min(...recent.map((x) => x.takenAt))) / DAY);
  const perDay = total / span;
  const rate = p.followers ? total / recent.length / p.followers : 0; // engagement per post per follower
  const score = Math.round(perDay * (1 + Math.min(4, rate * 50)));
  // The post the coin is named from: the most engaged recent one that has a picture.
  const top = [...recent].filter((x) => x.imageUrl).sort((a, b) => eng(b) - eng(a))[0] ?? null;
  return { score, top, recent: recent.length };
}

/**
 * deps: { db, cfg, fetchImpl, now, log }. cfg.scout: { intervalS, seeds[], minFollowers, maxFollowers }.
 * Returns { tick, start, stop, crawling, setCrawling, addSeeds, status, candidates, refresh }.
 */
export function createScout({ db, cfg, fetchImpl = fetch, now = Date.now, log = console }) {
  const sc = cfg.scout ?? {};
  const kvGet = (k) => db.prepare('select value from kv where key = ?').get(k)?.value ?? null;
  const kvSet = (k, v) => db.prepare('insert into kv (key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(k, String(v));
  const bot = String(cfg.ig?.botUsername ?? '').toLowerCase();

  const addSeeds = (names, priority = 1e12) => {
    const add = db.prepare(
      `insert into scout_profile (username, priority, found_via, created_at) values (?, ?, 'seed', ?)
       on conflict(username) do update set priority = max(priority, excluded.priority)`
    );
    let n = 0;
    db.transaction(() => {
      for (const raw of names) {
        const u = normalizeHandle(String(raw).replace(/^@/, '').trim());
        if (u && u !== bot) { add.run(u, priority, now()); n++; }
      }
    })();
    return n;
  };
  // The seeds from the settings, and every creator who already has a coin.
  addSeeds(sc.seeds ?? []);
  addSeeds(db.prepare('select distinct username from token').all().map((r) => r.username), 1e9);

  const crawling = () => kvGet('scout.crawl') === '1';
  const setCrawling = (on) => kvSet('scout.crawl', on ? '1' : '0');
  const backoffUntil = () => Number(kvGet('scout.backoff_until') ?? 0);

  /** A growing pause after a "slow down": 10 min, doubling to 6 h. */
  function slowedDown(e, t = now()) {
    const n = Number(kvGet('scout.backoffs') ?? 0) + 1;
    kvSet('scout.backoffs', n);
    const wait = Math.min(MAX_BACKOFF, 10 * 60_000 * 2 ** Math.min(n - 1, 6));
    kvSet('scout.backoff_until', t + wait);
    kvSet('scout.last_error', e.message);
    log.warn(`scout: ${e.message}; pausing ${Math.round(wait / 60_000)} min`);
  }

  // Business Discovery with the Instagram token: unknown until Meta answers once (true / false).
  let igDiscovery = null;
  /**
   * A watched creator's profile, by the first way that answers: Business Discovery with the
   * Instagram token (until Meta refuses the field once), then with Facebook Login (when set), then
   * instagram.com's own page (not while the scout's "slow down" pause runs; a new "slow down" starts
   * it). → profile + { via: 'instagram' | 'facebook' | 'web' }. Throws the last way's ScoutError,
   * `missing` only when instagram.com was asked too (Meta sees Business and Creator accounts only).
   */
  async function readProfile(username) {
    const ways = [];
    if (cfg.ig?.accessToken && igDiscovery !== false) ways.push(['instagram', () => discoverProfile(cfg, username, 'instagram', fetchImpl)]);
    if (fbLogin(cfg)) ways.push(['facebook', () => discoverProfile(cfg, username, 'facebook', fetchImpl)]);
    const webOk = backoffUntil() <= now();
    if (webOk) ways.push(['web', () => fetchProfile(username, fetchImpl)]);
    let last = new ScoutError(`instagram.com asked us to pause until ${new Date(backoffUntil()).toISOString()}`);
    for (const [via, run] of ways) {
      try {
        const p = await run();
        if (via === 'instagram' && igDiscovery !== true) { igDiscovery = true; log.log('scout: profiles can be read through Business Discovery with the Instagram token'); }
        return { ...p, via };
      } catch (e) {
        if (via === 'instagram' && e.unsupported) { igDiscovery = false; log.log(`scout: Business Discovery is not available with the Instagram token (${e.message})`); }
        if (via === 'web' && e.slowDown) slowedDown(e);
        last = e;
      }
    }
    // Meta finds no Business or Creator account by that name: a personal account may still exist.
    if (last.missing && !webOk) throw new ScoutError(last.message);
    throw last;
  }

  /** The next profile to read: never read first, highest priority; then the stalest. */
  const next = () => db.prepare(
    `select username from scout_profile
      where status != 'missing' and (checked_at is null or checked_at < ?)
      order by checked_at is not null, priority desc, checked_at limit 1`
  ).get(now() - RECHECK_AFTER)?.username;

  const save = db.prepare(
    `update scout_profile set checked_at = ?, status = ?, followers = ?, is_private = ?, is_verified = ?, full_name = ?,
            score = ?, recent_posts = ?, top_shortcode = ?, top_image = ?, top_caption = ?, top_taken_at = ?, note = ?
      where username = ?`
  );
  const addRelated = db.prepare(
    `insert into scout_profile (username, priority, found_via, created_at) values (?, ?, ?, ?)
     on conflict(username) do update set priority = max(priority, excluded.priority)`
  );

  /** Read one profile and store what it says. Returns what happened, for the log and the tests. */
  async function refresh(username) {
    const t = now();
    let p;
    try {
      p = await fetchProfile(username, fetchImpl);
    } catch (e) {
      if (e.slowDown) {
        slowedDown(e, t);
        return { username, outcome: 'slowed' };
      }
      save.run(t, e.missing ? 'missing' : 'error', null, 0, 0, null, 0, 0, null, null, null, null, e.message.slice(0, 200), username);
      return { username, outcome: e.missing ? 'missing' : 'error' };
    }
    kvSet('scout.backoffs', 0);
    const s = scoreProfile(p, t);
    const tooSmall = p.followers < (sc.minFollowers ?? 0);
    const tooBig = sc.maxFollowers > 0 && p.followers > sc.maxFollowers;
    const status = p.isPrivate ? 'private' : tooSmall ? 'small' : tooBig ? 'big' : 'ok';
    save.run(t, status, p.followers, p.isPrivate ? 1 : 0, p.isVerified ? 1 : 0, p.fullName.slice(0, 120),
      status === 'ok' ? s.score : 0, s.recent, s.top?.shortcode ?? null, s.top?.imageUrl ?? null,
      s.top ? s.top.caption.slice(0, 2200) : null, s.top?.takenAt ?? null, null, username);
    // Walk on through the related accounts; a trending creator's neighbours are looked at sooner.
    const room = MAX_FRONTIER - db.prepare('select count(*) n from scout_profile').get().n;
    if (room > 0) {
      const via = `related:${username}`;
      db.transaction(() => {
        for (const r of p.related.slice(0, Math.min(RELATED_PER_PROFILE, room))) if (r !== bot) addRelated.run(r, s.score, via, t);
      })();
    }
    return { username, outcome: status, score: s.score, followers: p.followers };
  }

  /** One step: read the next profile, unless the scout is off or Instagram asked for a pause. */
  async function tick() {
    if (!crawling()) return { outcome: 'off' };
    if (backoffUntil() > now()) return { outcome: 'paused' };
    const u = next();
    if (!u) return { outcome: 'idle' };
    return refresh(u);
  }

  let timer = null, busy = false;
  const start = () => {
    if (timer) return;
    const every = Math.max(15, Number(sc.intervalS) || 60) * 1000;
    timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try { const r = await tick(); if (r.outcome !== 'off' && r.outcome !== 'paused' && r.outcome !== 'idle') log.log(`scout: @${r.username} ${r.outcome}${r.score != null ? ` score ${r.score}` : ''}`); }
      catch (e) { log.error('scout failed', e); }
      finally { busy = false; }
    }, every);
    timer.unref?.();
  };
  const stop = () => { clearInterval(timer); timer = null; };

  /** The shortlist: scored, public creators within the size limits, best first. */
  const candidates = ({ limit = 20, freshWithin = 2 * DAY } = {}) => db.prepare(
    `select s.* from scout_profile s
      where s.status = 'ok' and s.score > 0 and s.top_shortcode is not null and s.checked_at >= ?
        and s.launched_mint is null and coalesce(s.attempts, 0) < 2
        and not exists (select 1 from creator_block b where b.username = s.username)
        and not exists (select 1 from token t where t.username = s.username)
      order by s.score desc limit ?`
  ).all(now() - freshWithin, limit);

  const status = () => {
    const c = db.prepare(
      `select count(*) total, sum(checked_at is not null) checked, sum(status = 'ok' and score > 0) scored from scout_profile`
    ).get();
    return {
      crawling: crawling(), total: c.total, checked: c.checked ?? 0, scored: c.scored ?? 0,
      pausedUntil: backoffUntil() > now() ? backoffUntil() : null, lastError: kvGet('scout.last_error'),
    };
  };

  // ---- The watchlist (bot_watch): creators the owner pasted, launched for first, oldest first.
  /** Adds (or updates the post link of) each creator in the pasted text. → how many lines were taken. */
  const watch = (text) => {
    const rows = parseWatchlist(text, bot).slice(0, 200);
    const add = db.prepare(
      `insert into bot_watch (username, post_url, added_at) values (?, ?, ?)
       on conflict(username) do update set post_url = coalesce(excluded.post_url, post_url), attempts = 0, note = null`
    );
    db.transaction(() => { for (const r of rows) add.run(r.username, r.postUrl, now()); })();
    return rows.length;
  };
  const unwatch = (username) => db.prepare('delete from bot_watch where username = ?').run(normalizeHandle(String(username)) ?? '').changes;
  /** Every watched creator, with its coin if it has one, for /admin. */
  const watchlist = () => db.prepare(
    `select w.username, w.post_url, w.added_at, w.attempts, w.note, w.launched_at,
            coalesce(w.launched_mint, (select t.mint from token t where t.username = w.username order by t.created_at desc limit 1)) mint,
            (select t.symbol from token t where t.username = w.username order by t.created_at desc limit 1) symbol,
            exists (select 1 from creator_block b where b.username = w.username) blocked
       from bot_watch w order by w.added_at, w.rowid`
  ).all();
  /** The ones the bot may launch for now: no coin, not opted out, fewer than 2 tries. */
  const watched = ({ limit = 5 } = {}) => db.prepare(
    `select w.* from bot_watch w
      where w.launched_mint is null and w.attempts < 2
        and not exists (select 1 from creator_block b where b.username = w.username)
        and not exists (select 1 from token t where t.username = w.username)
      order by w.added_at, w.rowid limit ?`
  ).all(limit);

  return {
    tick, start, stop, crawling, setCrawling, addSeeds, status, candidates, refresh,
    readProfile, watch, unwatch, watchlist, watched,
  };
}
