// /admin: the owner's page, for @instapaid.official only. It signs in with Instagram Business Login
// (OAuth) and moderates comments on the bot's own posts with the OWNER's token from that sign-in:
// list posts and their comments, comment, reply, hide / unhide, delete. It also lists the latest
// comment-launch requests from the database. Meta's App Review for instagram_business_manage_comments
// asks for a screen recording of exactly this.
//
// Sign-in:  GET /admin/login    → www.instagram.com/oauth/authorize (state also in a signed cookie)
//           GET /admin/callback → POST api.instagram.com/oauth/access_token → GET graph /me
// Only the bot account may sign in (IG_BOT_USERNAME, or the id the server reads for the bot). The
// session cookie is signed with SESSION_SECRET, lasts 1 hour (the short-lived token's life) and
// holds the token sealed with VAULT_MASTER_KEY, never in clear. No token is ever logged.
import express from 'express';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openSecret, readToken, safeEqual, sealSecret, signToken } from './crypto.js';
import { graph, graphCall, igAccount, igBase } from './instagram.js';
import { allowedImageUrl, sniffImage } from './metadata.js';

export const SESSION_COOKIE = 'ip_admin';
export const STATE_COOKIE = 'ip_admin_state';
export const SESSION_TTL = 60 * 60_000;
const STATE_TTL = 10 * 60_000;
export const SCOPES = ['instagram_business_basic', 'instagram_business_manage_comments'];
const AUTHORIZE_URL = 'https://www.instagram.com/oauth/authorize';
const AAD = 'admin-session';
const ID_RE = /^\d{1,40}$/;
export const MAX_COMMENT = 300; // Instagram's own limit for a comment's text
const MEDIA_FIELDS = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,comments_count';
const COMMENT_FIELDS = 'id,text,username,timestamp,hidden,replies{id,text,username,timestamp,hidden}';

export const oauthBase = (cfg) => String(cfg.ig?.oauthBaseUrl || 'https://api.instagram.com').replace(/\/+$/, '');

/** Cookies from the request header, without a dependency. */
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function limiter(limit, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now(), w = hits.get(key);
    if (!w || w.reset < now) {
      hits.set(key, { n: 1, reset: now + windowMs });
      if (hits.size > 5000) hits.delete(hits.keys().next().value);
      return true;
    }
    return ++w.n <= limit;
  };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** A small page in the site's design: the not-configured card and every sign-in refusal. */
export function messagePage({ title, text, action = { href: '/admin', label: 'Back to the owner page' } }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} — InstaPaid</title>
<meta name="theme-color" content="#1a1114">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/app.css">
<link rel="stylesheet" href="/admin.css">
</head>
<body>
<header class="top">
  <div class="wrap top-bar">
    <a class="brand" href="/" aria-label="instapaid, home"><img src="/mark.svg" alt="" width="38" height="38"><span class="wordmark" aria-hidden="true"></span></a>
    <span class="pill">Owner</span>
  </div>
</header>
<main id="main" class="page">
  <div class="wrap page-narrow">
    <div class="card adm-msg">
      <h1>${esc(title)}</h1>
      <p class="sub">${esc(text)}</p>
      ${action ? `<a class="btn btn-primary" href="${esc(action.href)}">${esc(action.label)}</a>` : ''}
    </div>
  </div>
</main>
</body>
</html>`;
}

/**
 * deps: { db, cfg, fetchImpl, pub (the public folder), log, bot? ({ scout, locals }: the launcher bot) }.
 * Returns an express Router mounted at the site's root (its paths all start with /admin).
 */
export function adminRouter({ db, cfg, fetchImpl = fetch, pub, log = console, bot = null }) {
  const r = express.Router();
  const loginLimit = limiter(20, 10 * 60_000);
  const writeLimit = limiter(60, 10 * 60_000);
  const readLimit = limiter(300, 10 * 60_000);
  const configured = () => !!cfg.ig?.appId;
  const redirectUri = () => `${cfg.publicUrl}/admin/callback`;
  const secureCookie = (req) => req.secure || String(cfg.publicUrl).startsWith('https:');
  const cookieOpts = (req, maxAge, path = '/admin') => ({ httpOnly: true, secure: secureCookie(req), sameSite: 'lax', path, maxAge });
  const adminHtml = () => readFileSync(join(pub, 'admin.html'), 'utf8');

  // Never indexed, never cached, whatever the page.
  r.use('/admin', (req, res, next) => {
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('Cache-Control', 'no-store');
    next();
  });

  const page = (res, status, opts) => res.status(status).type('html').send(messagePage(opts));
  const notConfigured = (res) => page(res, 503, {
    title: 'Owner page not configured',
    text: 'Instagram sign-in is not set up on this server yet. Set IG_APP_ID (Meta app → Instagram → API setup with Instagram login) and restart.',
    action: { href: '/', label: 'Home' },
  });

  r.get('/admin', (req, res) => {
    if (!configured()) return notConfigured(res);
    res.type('html').send(adminHtml());
  });

  r.get('/admin/login', (req, res) => {
    if (!configured()) return notConfigured(res);
    if (!loginLimit(req.ip)) return page(res, 429, { title: 'Too many tries', text: 'Wait a few minutes and try again.' });
    const state = randomBytes(24).toString('base64url');
    res.cookie(STATE_COOKIE, signToken({ s: state, exp: Date.now() + STATE_TTL }, cfg.sessionSecret), cookieOpts(req, STATE_TTL));
    const q = new URLSearchParams({
      client_id: cfg.ig.appId, redirect_uri: redirectUri(), response_type: 'code', scope: SCOPES.join(','), state,
    });
    res.redirect(302, `${AUTHORIZE_URL}?${q}`);
  });

  r.get('/admin/callback', async (req, res) => {
    if (!configured()) return notConfigured(res);
    if (!loginLimit(req.ip)) return page(res, 429, { title: 'Too many tries', text: 'Wait a few minutes and try again.' });
    const saved = readToken(cookies(req)[STATE_COOKIE], cfg.sessionSecret);
    res.clearCookie(STATE_COOKIE, { path: '/admin' });
    const state = String(req.query.state ?? '');
    const again = { href: '/admin/login', label: 'Log in again' };
    if (!saved?.s || !state || !safeEqual(saved.s, state)) {
      log.warn('admin: sign-in refused: the state does not match');
      return page(res, 400, { title: 'Sign-in expired', text: 'That sign-in link ran out or was opened in another browser. Start again.', action: again });
    }
    if (req.query.error || !req.query.code) {
      log.log(`admin: sign-in not completed: ${String(req.query.error_reason || req.query.error || 'no code').slice(0, 80)}`);
      return page(res, 400, { title: 'Sign-in cancelled', text: 'Instagram did not complete the sign-in. Nothing was saved.', action: again });
    }
    // The code for a short-lived Instagram User token (one hour).
    const body = new URLSearchParams({
      client_id: cfg.ig.appId, client_secret: cfg.ig.appSecret, grant_type: 'authorization_code',
      redirect_uri: redirectUri(), code: String(req.query.code).replace(/#_$/, ''),
    });
    let tok = null;
    try {
      const x = await fetchImpl(`${oauthBase(cfg)}/oauth/access_token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(),
        signal: AbortSignal.timeout(30_000),
      });
      const j = await x.json().catch(() => null);
      const d = Array.isArray(j?.data) ? j.data[0] : j; // both shapes Meta has documented
      if (x.ok && d?.access_token) tok = String(d.access_token);
      else log.warn(`admin: code exchange refused ${x.status}: ${String(j?.error_message ?? j?.error?.message ?? 'no details').slice(0, 300)}`);
    } catch (e) {
      log.warn(`admin: code exchange failed: ${String(e?.message ?? e).slice(0, 200)}`);
    }
    if (!tok) return page(res, 502, { title: 'Sign-in failed', text: 'Instagram did not hand over the sign-in. Nothing was saved. Try again.', action: again });

    const me = await graphCall(fetchImpl, graph(cfg.ig, 'me'), tok, { params: { fields: 'user_id,username' } });
    if (!me.ok || !me.json?.user_id) {
      log.warn(`admin: could not read who signed in: ${me.status} ${me.error ?? 'no user_id'}`);
      return page(res, 502, { title: 'Sign-in failed', text: 'Instagram did not say who signed in. Nothing was saved. Try again.', action: again });
    }
    const userId = String(me.json.user_id);
    const username = String(me.json.username ?? '').toLowerCase();
    const bot = String(cfg.ig.botUsername).toLowerCase();
    let isBot = username === bot;
    if (!isBot) {
      const known = await igAccount(cfg.ig, fetchImpl).catch(() => null);
      isBot = !!known?.userId && known.userId === userId;
    }
    if (!isBot) {
      log.warn(`admin: sign-in refused: @${username || '?'} is not @${bot}`);
      return page(res, 403, {
        title: `This page is only for @${cfg.ig.botUsername}`,
        text: `You signed in as @${username || 'another account'}. Nothing was saved. To use this page, log in to Instagram as @${cfg.ig.botUsername}.`,
        action: again,
      });
    }
    const exp = Date.now() + SESSION_TTL;
    const session = signToken({
      u: username || bot, id: userId, csrf: randomBytes(24).toString('base64url'),
      t: sealSecret(tok, cfg.vaultMasterKey, `${AAD}:${userId}:${exp}`), exp,
    }, cfg.sessionSecret);
    res.cookie(SESSION_COOKIE, session, cookieOpts(req, SESSION_TTL));
    log.log(`admin: @${username || bot} signed in`);
    res.redirect(302, '/admin');
  });

  // The session, or null. The token is opened only here, per request.
  function sessionOf(req) {
    const s = readToken(cookies(req)[SESSION_COOKIE], cfg.sessionSecret);
    if (!s?.t || !s.id) return null;
    try {
      return { ...s, token: Buffer.from(openSecret(s.t, cfg.vaultMasterKey, `${AAD}:${s.id}:${s.exp}`)).toString('utf8') };
    } catch { return null; }
  }

  r.use('/admin/api', express.json({ limit: '16kb' }));
  // Who is signed in; the page asks this first. Answers without a session too.
  r.get('/admin/api/session', (req, res) => {
    const s = configured() ? sessionOf(req) : null;
    res.json(s ? { configured: true, signedIn: true, username: s.u, csrf: s.csrf, expiresAt: s.exp }
      : { configured: configured(), signedIn: false, botUsername: cfg.ig.botUsername });
  });

  // Every other API: a session; and for anything that changes something, the CSRF token in X-CSRF.
  r.use('/admin/api', (req, res, next) => {
    if (!configured()) return res.status(503).json({ error: 'The owner page is not configured.' });
    const s = sessionOf(req);
    if (!s) return res.status(401).json({ error: 'Signed out. Log in with Instagram again.' });
    const writes = req.method !== 'GET' && req.method !== 'HEAD';
    if (writes && !safeEqual(String(req.get('x-csrf') ?? ''), s.csrf)) return res.status(403).json({ error: 'This page is out of date. Reload it.' });
    if (!(writes ? writeLimit : readLimit)(req.ip)) return res.status(429).json({ error: 'Too many requests. Wait a few minutes.' });
    req.admin = s;
    next();
  });

  // One Graph call with the owner's token; Meta's error is logged (never a token) and passed on.
  async function call(res, what, path, opts) {
    const a = await graphCall(fetchImpl, graph(cfg.ig, path), res.req.admin.token, opts);
    if (!a.ok) {
      log.warn(`admin: ${what} → ${a.status} ${a.error}`);
      res.status(a.status === 401 || a.json?.error?.code === 190 ? 401 : 502)
        .json({ error: `Instagram said: ${a.error || 'no details'}` });
      return null;
    }
    return a.json ?? {};
  }
  const idOk = (res, id) => {
    if (ID_RE.test(String(id))) return true;
    res.status(400).json({ error: 'Not an Instagram id.' });
    return false;
  };
  const messageOf = (req, res) => {
    const m = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!m) { res.status(400).json({ error: 'Write something first.' }); return null; }
    if (m.length > MAX_COMMENT) { res.status(400).json({ error: `At most ${MAX_COMMENT} characters.` }); return null; }
    return m;
  };

  r.get('/admin/api/media', async (req, res) => {
    const j = await call(res, 'list posts', 'me/media', { params: { fields: MEDIA_FIELDS, limit: '12' } });
    if (!j) return;
    res.json({
      media: (j.data ?? []).map((m) => ({
        id: String(m.id), caption: m.caption ?? '', mediaType: m.media_type ?? null, permalink: m.permalink ?? null,
        timestamp: m.timestamp ?? null, commentsCount: m.comments_count ?? 0,
        hasPicture: !!(m.media_url || m.thumbnail_url),
      })),
    });
  });

  // The post's picture through this server, so the page loads nothing from another host.
  r.get('/admin/api/media/:id/picture', async (req, res) => {
    if (!idOk(res, req.params.id)) return;
    const j = await call(res, 'read a post', encodeURIComponent(req.params.id), { params: { fields: 'media_type,media_url,thumbnail_url' } });
    if (!j) return;
    const u = j.media_type === 'VIDEO' ? (j.thumbnail_url || j.media_url) : (j.media_url || j.thumbnail_url);
    const standIn = u && String(u).startsWith(`${igBase(cfg.ig)}/`) && igBase(cfg.ig) !== 'https://graph.instagram.com';
    if (!u || !(allowedImageUrl(u) || standIn)) return res.sendStatus(404);
    try {
      const x = await fetchImpl(u, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
      const buf = Buffer.from(await x.arrayBuffer());
      const type = x.ok && buf.length <= 8 * 1024 * 1024 ? sniffImage(buf) : null;
      if (!type) return res.sendStatus(404);
      res.set('Cache-Control', 'private, max-age=600').type(type).send(buf);
    } catch { res.sendStatus(404); }
  });

  r.get('/admin/api/media/:id/comments', async (req, res) => {
    if (!idOk(res, req.params.id)) return;
    const j = await call(res, 'list comments', `${encodeURIComponent(req.params.id)}/comments`, { params: { fields: COMMENT_FIELDS, limit: '50' } });
    if (!j) return;
    const one = (c) => ({
      id: String(c.id), text: c.text ?? '', username: c.username ?? null, timestamp: c.timestamp ?? null, hidden: !!c.hidden,
    });
    res.json({ comments: (j.data ?? []).map((c) => ({ ...one(c), replies: (c.replies?.data ?? []).map(one) })) });
  });

  // CREATE: a comment on the bot's own post.
  r.post('/admin/api/media/:id/comments', async (req, res) => {
    if (!idOk(res, req.params.id)) return;
    const message = messageOf(req, res);
    if (message == null) return;
    const j = await call(res, 'comment', `${encodeURIComponent(req.params.id)}/comments`, { method: 'POST', params: { message } });
    if (!j) return;
    log.log(`admin: commented on post ${req.params.id}`);
    res.json({ ok: true, id: j.id ? String(j.id) : null });
  });

  // UPDATE (Instagram has no comment edit): a reply under a comment…
  r.post('/admin/api/comments/:id/replies', async (req, res) => {
    if (!idOk(res, req.params.id)) return;
    const message = messageOf(req, res);
    if (message == null) return;
    const j = await call(res, 'reply', `${encodeURIComponent(req.params.id)}/replies`, { method: 'POST', params: { message } });
    if (!j) return;
    log.log(`admin: replied to comment ${req.params.id}`);
    res.json({ ok: true, id: j.id ? String(j.id) : null });
  });

  // …or hiding / unhiding it.
  r.post('/admin/api/comments/:id/hide', async (req, res) => {
    if (!idOk(res, req.params.id)) return;
    if (typeof req.body?.hide !== 'boolean') return res.status(400).json({ error: 'Say hide: true or false.' });
    const hide = req.body.hide;
    const j = await call(res, hide ? 'hide' : 'unhide', encodeURIComponent(req.params.id), { method: 'POST', params: { hide: String(hide) } });
    if (!j) return;
    log.log(`admin: ${hide ? 'hid' : 'unhid'} comment ${req.params.id}`);
    res.json({ ok: true, hidden: hide });
  });

  // DELETE.
  r.delete('/admin/api/comments/:id', async (req, res) => {
    if (!idOk(res, req.params.id)) return;
    const j = await call(res, 'delete', encodeURIComponent(req.params.id), { method: 'DELETE' });
    if (!j) return;
    log.log(`admin: deleted comment ${req.params.id}`);
    res.json({ ok: true });
  });

  // The latest comment-launch requests, read-only. Usernames are the public post owners'.
  r.get('/admin/api/requests', (req, res) => {
    const rows = db.prepare(
      `select c.created_at, c.status, c.note, c.username, c.mint, t.symbol
         from comment_request c left join token t on t.mint = c.mint
        order by c.created_at desc, c.rowid desc limit 25`
    ).all();
    res.json({ requests: rows });
  });

  // The launcher bot: its two switches (Scouting, Auto-launch; both start off), its limits, the
  // shortlist and what it launched. Only the signed-in @instapaid.official reaches these.
  const botState = async () => ({
    ...bot.scout.status(),
    launching: bot.locals.botLaunching(),
    limits: await bot.locals.botLimits(),
    shortlist: bot.scout.candidates({ limit: 15 }).map((c) => ({
      username: c.username, followers: c.followers, score: c.score, recentPosts: c.recent_posts, checkedAt: c.checked_at,
    })),
    launched: db.prepare(
      `select s.username, s.score, s.launched_at, t.symbol, t.mint, t.status from scout_profile s
         left join token t on t.mint = s.launched_mint
        where s.launched_mint is not null order by s.launched_at desc limit 15`
    ).all(),
  });
  r.get('/admin/api/bot', async (req, res) => {
    if (!bot) return res.status(503).json({ error: 'The launcher bot is not set up on this server.' });
    res.json(await botState());
  });
  r.post('/admin/api/bot', async (req, res) => {
    if (!bot) return res.status(503).json({ error: 'The launcher bot is not set up on this server.' });
    const { scouting, launching, seeds } = req.body ?? {};
    if (typeof scouting === 'boolean') {
      bot.scout.setCrawling(scouting);
      log.log(`admin: @${req.admin.u} turned scouting ${scouting ? 'on' : 'off'}`);
    }
    if (typeof launching === 'boolean') {
      bot.locals.setBotLaunching(launching);
      log.log(`admin: @${req.admin.u} turned auto-launch ${launching ? 'on' : 'off'}`);
    }
    let added = 0;
    if (typeof seeds === 'string' && seeds.trim()) {
      if (seeds.length > 4000) return res.status(400).json({ error: 'At most 4000 characters of usernames.' });
      added = bot.scout.addSeeds(seeds.split(/[\s,]+/).filter(Boolean).slice(0, 200));
    }
    res.json({ ...(await botState()), added });
  });

  r.post('/admin/api/logout', (req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: '/admin' });
    log.log(`admin: @${req.admin.u} signed out`);
    res.json({ ok: true });
  });

  return r;
}
