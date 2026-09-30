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
import { normalizeHandle } from './handles.js';

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
        const n = Number(kvGet('scout.backoffs') ?? 0) + 1;
        kvSet('scout.backoffs', n);
        const wait = Math.min(MAX_BACKOFF, 10 * 60_000 * 2 ** Math.min(n - 1, 6));
        kvSet('scout.backoff_until', t + wait);
        kvSet('scout.last_error', e.message);
        log.warn(`scout: ${e.message}; pausing ${Math.round(wait / 60_000)} min`);
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

  return { tick, start, stop, crawling, setCrawling, addSeeds, status, candidates, refresh };
}
