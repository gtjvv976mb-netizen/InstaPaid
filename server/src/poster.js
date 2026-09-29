// The auto-poster: @instapaid.official posts the coins that go live on its own feed, with a card
// (src/card.js) and a caption that mentions the creator so they know they can claim.
//
// What gets posted: at most one coin per creator in POST_CREATOR_GAP_DAYS (30), so nobody can make
// our account mention the same person again and again; comment launches before website launches, so
// a burst of website launches cannot push them back; and a website launch only after Claude has
// checked its name, ticker and picture (src/lore.js reviewCoin), since whoever launched it chose
// them. A picture that fails is swapped for the default coin; a name or ticker that fails, or no
// Claude at all, means no post. Comment launches are named by Claude from the creator's own post.
//
// Instagram Content Publishing API. By default with Instagram Login: the Instagram token
// (IG_ACCESS_TOKEN, needs instagram_business_content_publish) on graph.instagram.com, the bot's
// IG_ID read from GET /me?fields=user_id,username. Only when IG_USER_ID and IG_FB_ACCESS_TOKEN are
// both set, with that Facebook-Login token on graph.facebook.com instead (instagram_content_publish).
//   POST /{ig-user-id}/media {image_url, caption}  → a container
//   GET  /{container-id}?fields=status_code         → until FINISHED
//   POST /{ig-user-id}/media_publish {creation_id}  → the post (media id)
//   GET  /{media-id}?fields=permalink
// The card must be a public JPEG: ${PUBLIC_URL}/posts/<mint>.jpg.
//
// At most once per coin, also across restarts: post_job is keyed by mint, and the container id is
// stored before media_publish. A job that has a container is only ever published after Instagram
// says that container is FINISHED (not PUBLISHED), so a publish whose answer was lost is found,
// not repeated. Instagram's API cannot delete a post: take one down in the Instagram app.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { coinCard } from './card.js';
import { isBlocked } from './blocks.js';
import { reviewCoin, visibleOnly } from './lore.js';
import { graphBase, fbLogin } from './comments.js';
import { graph as igGraph, igAccount, describeError } from './instagram.js';
import { sniffImage } from './metadata.js';

export const MINT_FILE_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}\.jpg$/;
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const BACKOFF = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000]; // after the 1st, 2nd and 3rd failure
export const MAX_ATTEMPTS = 1 + BACKOFF.length; // the first try and three retries
export const BREAKER_FAILURES = 3;
export const BREAKER_PAUSE = 60 * 60_000;
const TICK_MS = 60_000;
const DAY = 24 * 60 * 60_000;
const SOURCE_TTL = 48 * 60 * 60_000; // pictures of web launches that were never confirmed
const SOURCE_SIDE = 1080; // kept pictures are shrunk to this, so a flood of prepares cannot fill the disk
const READ = { failOn: 'error', limitInputPixels: 40_000_000 };

// Instagram's documents say 100 API posts in 24 hours in one place and 50 in another: plan on 50.
export const IG_POSTS_PER_DAY = 50;
export const HASHTAGS = '#memecoin #solana #pumpfun';
export const CAPTION_MAX = 2200;

/** Why the poster is off, or null when it is on. */
export function posterOff(cfg) {
  if (!cfg.autoPost) return 'AUTO_POST is not 1';
  if (!fbLogin(cfg) && !cfg.ig?.accessToken) return 'IG_ACCESS_TOKEN is required (or IG_USER_ID and IG_FB_ACCESS_TOKEN for Facebook Login)';
  if (!/^https:\/\//.test(cfg.publicUrl || '')) return 'PUBLIC_URL must be https (Instagram fetches the card from it)';
  if (!cfg.postsDir) return 'POSTS_DIR is not set';
  return null;
}

// The lore is quoted, never a tag: no @mentions and no extra hashtags from a fan's words.
const quotable = (s) => visibleOnly(s).replace(/[@#＠＃]+(?=\S)/g, '').replace(/\s+/g, ' ').trim();

/**
 * The caption. Only the coin's ticker, the creator's handle, the post's link and the lore Claude
 * passed go in; nothing else anyone typed. ≤ 2200 characters, 1 @mention (the creator), 3 hashtags.
 */
export function postCaption({ username, symbol, mint, lore, post_permalink }, publicUrl) {
  const host = String(publicUrl).replace(/^https?:\/\//, '');
  const build = (l) => `$${symbol} is live for @${username} 🚀\n\n`
    + `@${username} — this coin's creator fees are yours. Only you can claim them: ${host}/u/${username}\n\n`
    + (l ? `"${l}"\n\n` : '')
    + (post_permalink ? `Original post: ${post_permalink}\n` : '')
    + `Coin: pump.fun/coin/${mint}\n\n`
    + `Fan-made, not by @${username}. Not financial advice.\n${HASHTAGS}`;
  let l = lore ? quotable(lore) : '';
  let caption = build(l);
  while (caption.length > CAPTION_MAX && l) {
    l = l.slice(0, Math.max(0, l.length - (caption.length - CAPTION_MAX) - 1)).trimEnd();
    l = l ? `${l}…` : '';
    caption = build(l);
  }
  return caption;
}

export class GraphError extends Error {
  constructor(message, { dead = false } = {}) { super(message); this.dead = dead; }
}
class Skip extends Error {}

/**
 * Graph API calls: with the Instagram token on graph.instagram.com, or (both Facebook Login settings
 * set) the Facebook-Login token on graph.facebook.com. The token goes in the query (GET) or the form
 * body (POST), never in errors. `call.igId()` is the bot's account id for the paths.
 */
function graphClient(cfg, fetchImpl) {
  const viaFb = fbLogin(cfg);
  const base = viaFb ? `${graphBase(cfg)}/${cfg.fbGraphVersion || 'v23.0'}/` : igGraph(cfg.ig ?? {}, '');
  // Read at every call, never kept: the Instagram token is renewed while the server runs (src/igtoken.js).
  const token = () => (viaFb ? cfg.fbAccessToken : cfg.ig?.accessToken);
  async function call(method, path, params = {}) {
    const q = new URLSearchParams({ ...params, access_token: token() });
    const what = `${method} ${path.replace(/^\d{6,}\//, '')}`;
    let r;
    try {
      r = method === 'GET'
        ? await fetchImpl(`${base}${path}?${q}`, { signal: AbortSignal.timeout(30_000) })
        : await fetchImpl(`${base}${path}`, {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: q.toString(),
          signal: AbortSignal.timeout(30_000),
        });
    } catch (e) {
      throw new GraphError(`${what}: ${e.message}`);
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j?.error) throw new GraphError(`${what}: ${r.status} ${j?.error ? describeError(j) : ''}`.trim());
    return j;
  }
  call.via = viaFb ? 'Facebook Login (graph.facebook.com)' : 'Instagram Login (graph.instagram.com)';
  call.igId = async () => {
    if (viaFb) return String(cfg.igUserId);
    try { return (await igAccount(cfg.ig, fetchImpl)).userId; } catch (e) { throw new GraphError(`the bot's IG_ID is unknown: ${e.message}`); }
  };
  return call;
}

/**
 * deps: { db, cfg, fetchImpl, now, sleep, log, pollMs, maxPolls, render, review }
 * review({username, name, symbol, image}) → {nameOk, pictureOk} | null checks website launches.
 * Returns { enabled, off, keepSource, enqueue, settled, tick, start, stop, kick }.
 */
export function createPoster({
  db, cfg, fetchImpl = fetch, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = console, pollMs = 3000, maxPolls = 20, render = coinCard, review = reviewCoin,
}) {
  const call = graphClient(cfg, fetchImpl);
  const dailyCap = () => Math.min(cfg.postMaxPerDay, IG_POSTS_PER_DAY);
  const off = () => posterOff(cfg);
  const enabled = () => !off();
  const cardPath = (mint) => join(cfg.postsDir, `${mint}.jpg`);
  const srcDir = () => join(cfg.postsDir, 'src');
  const kvGet = (k) => db.prepare('select value from kv where key = ?').get(k)?.value ?? null;
  const kvSet = (k, v) => db.prepare('insert into kv (key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(k, String(v));
  const job = (mint) => db.prepare('select * from post_job where mint = ?').get(mint);
  const rm = (p) => { try { unlinkSync(p); } catch { /* gone already */ } };

  /**
   * Web launches: keep the picture from /api/launch/prepare (shrunk, as a JPEG) until
   * /api/launch/confirm draws the card. A picture sharp cannot read is not kept: the card then
   * shows the default coin.
   */
  async function keepSource(mint, image) {
    if (!enabled() || !MINT_RE.test(mint) || !image?.buf?.length || !sniffImage(image.buf)) return false;
    let jpeg;
    try {
      jpeg = await sharp(Buffer.from(image.buf), READ).rotate()
        .resize(SOURCE_SIDE, SOURCE_SIDE, { fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer();
    } catch {
      return false;
    }
    mkdirSync(srcDir(), { recursive: true });
    writeFileSync(join(srcDir(), `${mint}.jpg`), jpeg);
    return true;
  }

  function findSource(mint) {
    const path = join(srcDir(), `${mint}.jpg`);
    return existsSync(path) ? { buf: readFileSync(path), type: 'image/jpeg', path } : null;
  }

  async function writeCard(token, image) {
    mkdirSync(cfg.postsDir, { recursive: true });
    const jpeg = await render({ image, symbol: token.symbol, name: token.name, username: token.username, publicUrl: cfg.publicUrl });
    const path = cardPath(token.mint);
    writeFileSync(`${path}.tmp`, jpeg);
    renameSync(`${path}.tmp`, path); // never a half-written card at the public address
  }

  /**
   * Why this coin will not be posted, or null. A creator who opted out; or one we already posted
   * about within POST_CREATOR_GAP_DAYS, or who has another coin waiting to be posted.
   */
  function refusal(token, t) {
    if (isBlocked(db, token.username)) return 'creator opted out';
    const days = cfg.postCreatorGapDays ?? 30;
    if (!(days > 0)) return null;
    const other = db.prepare(
      `select j.status from post_job j join token k using (mint)
        where k.username = ? and j.mint != ?
          and (j.status in ('queued', 'posting') or (j.status = 'posted' and j.posted_at > ?))
        limit 1`
    ).get(token.username, token.mint, t - days * DAY);
    if (!other) return null;
    return other.status === 'posted'
      ? `@${token.username} was posted about in the last ${days} days`
      : `another coin for @${token.username} is waiting to be posted`;
  }

  /** Record that a coin will not be posted, and why (a skipped job, so it is never queued later). */
  function skip(mint, why) {
    const t = now();
    db.prepare(
      `insert into post_job (mint, status, attempts, last_error, created_at, next_attempt_at) values (?, 'skipped', 0, ?, ?, ?)
       on conflict(mint) do nothing`
    ).run(mint, why, t, t);
    log.log(`poster: not posting ${mint}: ${why}`);
    return false;
  }

  /**
   * Draw the card and queue the post for a coin that just went live. `image` is its picture
   * (comment launches: the creator's post); website launches use the picture kept at prepare, and
   * are checked by Claude first. Resolves to true when a post was queued.
   */
  async function enqueueNow(mint, image = null) {
    if (!enabled()) return false;
    const token = db.prepare(`select * from token where mint = ? and status = 'live'`).get(mint);
    if (!token || isBlocked(db, token.username)) return false;
    if (job(mint)) return false; // one job per coin
    const early = refusal(token, now());
    const src = image ? null : findSource(mint);
    if (early) { if (src) rm(src.path); return skip(mint, early); }

    let picture = image ?? src;
    let note = null;
    if (token.source !== 'comment' && cfg.postWebLaunches === false) {
      if (src) rm(src.path);
      return skip(mint, 'website launches are not posted (POST_WEB_LAUNCHES=0)');
    }
    if (token.source !== 'comment') {
      const verdict = await Promise.resolve()
        .then(() => review({ username: token.username, name: token.name, symbol: token.symbol, image: picture }))
        .catch((e) => { log.error('poster: review failed', mint, e.message); return null; });
      if (!verdict?.nameOk) {
        if (src) rm(src.path);
        return skip(mint, verdict ? 'the name or ticker did not pass the check' : 'not checked (Claude unavailable), so not posted');
      }
      if (picture && !verdict.pictureOk) {
        if (src) rm(src.path); // never drawn later either
        picture = null;
        note = 'the picture did not pass the check: the card shows the default coin';
        log.log(`poster: ${mint}: ${note}`);
      }
    }
    try {
      await writeCard(token, picture);
      if (src) rm(src.path);
    } catch (e) {
      log.error('poster: card failed', mint, e.message); // drawn again before posting
    }
    // Checked again: another coin for this creator may have been queued while this one was checked.
    const late = refusal(token, now());
    if (late) { rm(cardPath(mint)); return skip(mint, late); }
    const t = now();
    const r = db.prepare(
      `insert into post_job (mint, status, attempts, last_error, created_at, next_attempt_at) values (?, 'queued', 0, ?, ?, ?)
       on conflict(mint) do nothing`
    ).run(mint, note, t, t);
    if (r.changes) kick();
    return r.changes === 1;
  }

  // Enqueues still running (a website launch waits for Claude): stop() and the tests wait for them.
  const inflight = new Set();
  function enqueue(mint, image = null) {
    const p = enqueueNow(mint, image);
    inflight.add(p);
    p.catch(() => {}).finally(() => inflight.delete(p));
    return p;
  }
  async function settled() {
    while (inflight.size) await Promise.allSettled([...inflight]);
  }

  async function quota() {
    const j = await call('GET', `${await call.igId()}/content_publishing_limit`, { fields: 'quota_usage,config' });
    const d = Array.isArray(j.data) ? (j.data[0] ?? {}) : j;
    const total = d.config?.quota_total;
    return { usage: Number(d.quota_usage ?? 0), total: total == null ? null : Number(total) };
  }

  async function containerStatus(id) {
    const j = await call('GET', id, { fields: 'status_code,status' });
    return { code: String(j.status_code ?? ''), detail: j.status ? String(j.status) : '' };
  }

  async function waitReady(id) {
    for (let i = 0; i < maxPolls; i++) {
      const st = await containerStatus(id);
      if (st.code === 'FINISHED' || st.code === 'PUBLISHED') return st.code;
      if (st.code === 'ERROR' || st.code === 'EXPIRED') {
        throw new GraphError(`container ${st.code}${st.detail ? `: ${st.detail}` : ''}`, { dead: true });
      }
      await sleep(pollMs);
    }
    throw new GraphError(`container not ready after ${Math.round((maxPolls * pollMs) / 1000)}s`);
  }

  function markPosted(mint, mediaId, permalink, note = null) {
    db.prepare(
      `update post_job set status = 'posted', media_id = ?, permalink = ?, posted_at = ?, last_error = ? where mint = ?`
    ).run(mediaId, permalink, now(), note, mint);
  }

  /** The container was published before (the answer was lost, or we restarted): find the post, never publish again. */
  async function recover(mint) {
    const j = await call('GET', `${await call.igId()}/media`, { fields: 'id,caption,permalink', limit: '25' }).catch(() => ({}));
    const hit = (j.data ?? []).find((m) => String(m.caption ?? '').includes(`pump.fun/coin/${mint}`));
    markPosted(mint, hit?.id ? String(hit.id) : null, hit?.permalink ?? null, hit ? null : 'published earlier; not found on the feed');
    log.log(`poster: ${mint} was already published; recorded, not posted again`);
  }

  async function publish(j) {
    const token = db.prepare('select * from token where mint = ?').get(j.mint);
    if (!token) throw new Skip('coin not found');
    let containerId = j.container_id;
    if (containerId) {
      const st = await containerStatus(containerId);
      if (st.code === 'PUBLISHED') return recover(j.mint);
      if (st.code === 'ERROR' || st.code === 'EXPIRED') {
        containerId = null;
        db.prepare('update post_job set container_id = null where mint = ?').run(j.mint);
      }
    }
    if (isBlocked(db, token.username)) throw new Skip('creator opted out');
    if (!containerId) {
      if (!existsSync(cardPath(token.mint))) {
        const src = findSource(token.mint);
        await writeCard(token, src);
        if (src) rm(src.path);
      }
      const c = await call('POST', `${await call.igId()}/media`, {
        image_url: `${cfg.publicUrl}/posts/${token.mint}.jpg`,
        caption: postCaption(token, cfg.publicUrl),
      });
      if (!c.id) throw new GraphError('media: no container id');
      containerId = String(c.id);
      db.prepare('update post_job set container_id = ? where mint = ?').run(containerId, j.mint);
    }
    if (await waitReady(containerId) === 'PUBLISHED') return recover(j.mint);
    const p = await call('POST', `${await call.igId()}/media_publish`, { creation_id: containerId });
    const mediaId = p.id ? String(p.id) : null;
    markPosted(j.mint, mediaId, null); // first, before anything else can fail
    if (mediaId) {
      try {
        const { permalink } = await call('GET', mediaId, { fields: 'permalink' });
        if (permalink) db.prepare('update post_job set permalink = ? where mint = ?').run(String(permalink), j.mint);
      } catch (e) {
        log.error('poster: permalink', j.mint, e.message);
      }
    }
    log.log(`poster: posted ${token.symbol} for @${token.username} (${j.mint})`);
  }

  function failure(msg) {
    const n = Number(kvGet('poster.failures') ?? 0) + 1;
    if (n >= BREAKER_FAILURES) {
      kvSet('poster.failures', 0);
      kvSet('poster.paused_until', now() + BREAKER_PAUSE);
      log.error(`poster: ${n} failures in a row; posting paused for an hour. Last: ${msg}`);
    } else {
      kvSet('poster.failures', n);
      log.error(`poster: ${msg}`);
    }
  }

  let lastSourceSweep = 0;
  function sweep(t) {
    if (cfg.postMaxAgeH > 0) {
      db.prepare(`update post_job set status = 'skipped', last_error = ? where status = 'queued' and created_at < ?`)
        .run(`not posted within ${cfg.postMaxAgeH} h`, t - cfg.postMaxAgeH * 60 * 60_000);
    }
    db.prepare(
      `update post_job set status = 'skipped', last_error = 'creator opted out'
        where status = 'queued' and mint in (select t.mint from token t join creator_block b on b.username = t.username)`
    ).run();
    if (t - lastSourceSweep > 60 * 60_000) {
      lastSourceSweep = t;
      try {
        for (const f of readdirSync(srcDir())) {
          const p = join(srcDir(), f);
          if (t - statSync(p).mtimeMs > SOURCE_TTL) rm(p);
        }
      } catch { /* no folder yet */ }
    }
  }

  /** One pass: at most one post. Returns what happened, for logs and tests. */
  async function step() {
    if (!enabled()) return 'off';
    const t = now();
    sweep(t);
    if (Number(kvGet('poster.paused_until') ?? 0) > t) return 'paused';
    // A post interrupted by a restart comes first; it was already counted against the pacing.
    let j = db.prepare(`select * from post_job where status = 'posting' order by created_at, rowid limit 1`).get();
    if (!j) {
      const day = db.prepare(`select count(*) n from post_job where status = 'posted' and posted_at > ?`).get(t - DAY).n;
      if (day >= dailyCap()) return 'daily-cap';
      const last = db.prepare(`select max(posted_at) last from post_job where status = 'posted'`).get().last;
      if (last != null && t - last < cfg.postMinGapMin * 60_000) return 'gap';
      // Comment launches first: a burst of website launches must not push them back.
      j = db.prepare(
        `select j.* from post_job j join token k using (mint)
          where j.status = 'queued' and j.next_attempt_at <= ?
          order by case k.source when 'comment' then 0 else 1 end, j.created_at, j.rowid
          limit 1`
      ).get(t);
      if (!j) return 'idle';
    }
    let q;
    try { q = await quota(); } catch (e) { failure(`publishing limit: ${e.message}`); return 'error'; }
    if (q.total != null && q.usage >= q.total) {
      log.log(`poster: Instagram's publishing limit is used up (${q.usage}/${q.total}); trying again later`);
      return 'quota';
    }
    db.prepare(`update post_job set status = 'posting', attempts = attempts + 1 where mint = ?`).run(j.mint);
    j = job(j.mint);
    try {
      await publish(j);
      kvSet('poster.failures', 0);
      return 'posted';
    } catch (e) {
      if (e instanceof Skip) {
        db.prepare(`update post_job set status = 'skipped', last_error = ? where mint = ? and status = 'posting'`).run(e.message, j.mint);
        return 'skipped';
      }
      const final = j.attempts >= MAX_ATTEMPTS;
      db.prepare(
        `update post_job set status = ?, next_attempt_at = ?, last_error = ?,
                container_id = case when ? then null else container_id end
          where mint = ? and status = 'posting'`
      ).run(final ? 'failed' : 'queued', now() + BACKOFF[Math.min(j.attempts, BACKOFF.length) - 1],
        String(e.message).slice(0, 300), e.dead ? 1 : 0, j.mint);
      failure(`${j.mint}: ${e.message}`);
      return 'failed';
    }
  }

  let running = null;
  function tick() {
    if (!running) {
      running = step()
        .catch((e) => { log.error('poster: tick failed', e); return 'error'; })
        .finally(() => { running = null; });
    }
    return running;
  }

  let timer = null, soon = null;
  function kick(ms = 3000) {
    if (!timer) return;
    clearTimeout(soon);
    soon = setTimeout(tick, ms);
    soon.unref?.();
  }
  function start() {
    if (timer) return;
    const why = off();
    log.log(why ? `auto-poster off: ${why}` : `auto-poster on: at most ${dailyCap()} a day, ${cfg.postMinGapMin} min apart, via ${call.via}`);
    timer = setInterval(tick, TICK_MS);
    timer.unref?.();
    kick(5000);
  }
  function stop() {
    clearInterval(timer); clearTimeout(soon);
    timer = null; soon = null;
    return Promise.all([running, settled()]);
  }

  return { enabled, off, keepSource, enqueue, settled, tick, start, stop, kick };
}
