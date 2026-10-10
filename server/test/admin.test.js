// The owner's page /admin: Instagram Business Login for @instapaid.official only, and comment
// moderation (list, create, reply, hide / unhide, delete) with the owner's token, against a
// stand-in api.instagram.com + graph.instagram.com.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cfg as baseCfg, start, webhook, tick } from './helpers.js';
import { startStandIn, OWNER_TOKEN, OTHER_TOKEN } from './admin-standin.js';
import { SESSION_COOKIE, STATE_COOKIE } from '../src/admin.js';

const APP_ID = '1234567890123456';

async function setup({ appId = APP_ID } = {}) {
  const ig = await startStandIn();
  const t = await start({
    config: { ig: { ...baseCfg.ig, appId, graphBaseUrl: ig.base, oauthBaseUrl: ig.base } },
    fetchImpl: fetch,
  });
  return { t, ig, close: () => { t.close(); ig.close(); } };
}

const setCookies = (r) => Object.fromEntries(r.headers.getSetCookie().map((c) => {
  const [pair] = c.split(';');
  const i = pair.indexOf('=');
  return [pair.slice(0, i), { value: decodeURIComponent(pair.slice(i + 1)), raw: c }];
}));
const get = (t, p, cookie) => fetch(t.base + p, { redirect: 'manual', headers: cookie ? { cookie } : {} });

/** The whole sign-in: /admin/login, then Instagram's redirect back with `code`. */
async function signIn(t, code = 'good') {
  const login = await get(t, '/admin/login');
  const loc = new URL(login.headers.get('location'));
  const state = loc.searchParams.get('state');
  const stateCookie = setCookies(login)[STATE_COOKIE].value;
  const cb = await get(t, `/admin/callback?code=${code}&state=${encodeURIComponent(state)}`, `${STATE_COOKIE}=${encodeURIComponent(stateCookie)}`);
  const session = setCookies(cb)[SESSION_COOKIE];
  return { cb, session, cookie: session?.value ? `${SESSION_COOKIE}=${encodeURIComponent(session.value)}` : '' };
}

async function signedIn(t) {
  const { cookie } = await signIn(t);
  const s = await (await get(t, '/admin/api/session', cookie)).json();
  const call = (method, p, body, csrf = s.csrf) => fetch(t.base + p, {
    method, headers: { cookie, 'content-type': 'application/json', ...(csrf ? { 'x-csrf': csrf } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { cookie, csrf: s.csrf, session: s, call };
}

/** Everything the server logs while `fn` runs. */
async function logsOf(fn) {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(saved)) console[k] = (...a) => lines.push(a.map(String).join(' '));
  try { await fn(); } finally { Object.assign(console, saved); }
  return lines.join('\n');
}

test('/admin without IG_APP_ID: a short "not configured" card; login and the API refuse', async () => {
  const s = await setup({ appId: '' });
  try {
    const r = await get(s.t, '/admin');
    assert.equal(r.status, 503);
    const html = await r.text();
    assert.match(html, /Owner page not configured/);
    assert.match(html, /IG_APP_ID/);
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
    assert.equal((await get(s.t, '/admin/login')).status, 503);
    assert.deepEqual(await (await get(s.t, '/admin/api/session')).json(), { configured: false, signedIn: false, botUsername: 'instapaid.official' });
    assert.equal((await get(s.t, '/admin/api/media')).status, 503);
  } finally { s.close(); }
});

test('/admin is served before the static files, noindex, never cached; robots.txt disallows it', async () => {
  const s = await setup();
  try {
    const r = await get(s.t, '/admin');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    const html = await r.text();
    assert.match(html, /Log in with Instagram/);
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
    assert.equal((await get(s.t, '/admin.html')).headers.get('location'), '/admin');
    assert.equal((await get(s.t, '/admin/')).headers.get('location'), '/admin');
    assert.match(await (await get(s.t, '/robots.txt')).text(), /^Disallow: \/admin$/m);
    assert.equal((await get(s.t, '/admin/nope')).status, 404);
  } finally { s.close(); }
});

test('login redirects to Instagram with the app id, the redirect URI, both scopes and a state kept in a signed cookie', async () => {
  const s = await setup();
  try {
    const r = await get(s.t, '/admin/login');
    assert.equal(r.status, 302);
    const loc = new URL(r.headers.get('location'));
    assert.equal(loc.origin + loc.pathname, 'https://www.instagram.com/oauth/authorize');
    assert.equal(loc.searchParams.get('client_id'), APP_ID);
    assert.equal(loc.searchParams.get('redirect_uri'), 'https://instapaid.test/admin/callback');
    assert.equal(loc.searchParams.get('response_type'), 'code');
    assert.equal(loc.searchParams.get('scope'), 'instagram_business_basic,instagram_business_manage_comments');
    const state = loc.searchParams.get('state');
    assert.ok(state && state.length >= 32);
    const c = setCookies(r)[STATE_COOKIE];
    assert.ok(c, 'a state cookie');
    assert.match(c.raw, /HttpOnly/i);
    assert.match(c.raw, /SameSite=Lax/i);
    assert.match(c.raw, /Path=\/admin/);
    assert.match(c.raw, /Secure/, 'PUBLIC_URL is https');
    assert.ok(!c.value.includes(state) || c.value.split('.').length === 2, 'signed');
    // Two logins, two states.
    const again = new URL((await get(s.t, '/admin/login')).headers.get('location')).searchParams.get('state');
    assert.notEqual(again, state);
  } finally { s.close(); }
});

test('callback: a wrong or missing state is refused before any code exchange; a cancelled sign-in stores nothing', async () => {
  const s = await setup();
  try {
    const login = await get(s.t, '/admin/login');
    const cookie = `${STATE_COOKIE}=${encodeURIComponent(setCookies(login)[STATE_COOKIE].value)}`;
    for (const [q, c] of [['code=good&state=forged', cookie], ['code=good&state=x', ''], ['code=good', cookie]]) {
      const r = await get(s.t, `/admin/callback?${q}`, c);
      assert.equal(r.status, 400, q);
      assert.match(await r.text(), /Sign-in expired/);
      assert.equal(setCookies(r)[SESSION_COOKIE], undefined);
    }
    const state = new URL(login.headers.get('location')).searchParams.get('state');
    const denied = await get(s.t, `/admin/callback?error=access_denied&error_reason=user_denied&state=${state}`, cookie);
    assert.equal(denied.status, 400);
    assert.match(await denied.text(), /Sign-in cancelled/);
    assert.equal(s.ig.calls.filter((c) => c.path === '/oauth/access_token').length, 0, 'no code was exchanged');
  } finally { s.close(); }
});

test('callback: another Instagram account is refused, "only for @instapaid.official", and nothing is stored', async () => {
  const s = await setup();
  try {
    const { cb, session } = await signIn(s.t, 'other');
    assert.equal(cb.status, 403);
    const html = await cb.text();
    assert.match(html, /This page is only for @instapaid\.official/);
    assert.match(html, /@somebody\.else/);
    assert.equal(session, undefined, 'no session cookie');
    assert.ok(!html.includes(OTHER_TOKEN));
    // The exchange was sent as Instagram documents it.
    const x = s.ig.calls.find((c) => c.path === '/oauth/access_token');
    assert.deepEqual(x.params, {
      client_id: APP_ID, client_secret: 'app-secret', grant_type: 'authorization_code',
      redirect_uri: 'https://instapaid.test/admin/callback', code: 'other',
    });
    const s2 = await (await get(s.t, '/admin/api/session')).json();
    assert.equal(s2.signedIn, false);
  } finally { s.close(); }
});

test('callback: the bot account gets a 1-hour signed, httpOnly, Secure, SameSite=Lax session; the token only sealed', async () => {
  const s = await setup();
  try {
    let got;
    const logs = await logsOf(async () => { got = await signIn(s.t); });
    const { cb, session, cookie } = got;
    assert.equal(cb.status, 302);
    assert.equal(cb.headers.get('location'), '/admin');
    assert.match(session.raw, /HttpOnly/i);
    assert.match(session.raw, /Secure/);
    assert.match(session.raw, /SameSite=Lax/i);
    assert.match(session.raw, /Max-Age=3600/);
    // Neither the token nor any piece of it in the cookie, in clear or in its JSON body.
    const body = Buffer.from(session.value.split('.')[0], 'base64url').toString();
    for (const s2 of [session.raw, session.value, body]) {
      assert.ok(!s2.includes(OWNER_TOKEN) && !s2.includes('owner-token'), 'no token in clear');
    }
    assert.ok(!logs.includes(OWNER_TOKEN) && !logs.includes('owner-token'), 'no token in the logs');
    assert.match(logs, /admin: @instapaid\.official signed in/);
    const me = await (await get(s.t, '/admin/api/session', cookie)).json();
    assert.equal(me.signedIn, true);
    assert.equal(me.username, 'instapaid.official');
    assert.ok(me.csrf?.length >= 32);
    assert.ok(!JSON.stringify(me).includes(OWNER_TOKEN));
    // A forged or tampered cookie is no session.
    const [b, mac] = session.value.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(body), u: 'x' })).toString('base64url');
    for (const c of [`${forged}.${mac}`, `${b}.AAAA`]) {
      assert.equal((await get(s.t, '/admin/api/media', `${SESSION_COOKIE}=${c}`)).status, 401);
    }
  } finally { s.close(); }
});

test('the bot is known by its id too: a sign-in whose username differs but whose id is the bot\'s is let in', async () => {
  const s = await setup();
  try {
    s.t.cfg.ig.botUsername = 'instapaid.renamed'; // the handle changed; the server still reads the bot's id from IG_ACCESS_TOKEN
    const { cb, session } = await signIn(s.t);
    assert.equal(cb.status, 302);
    assert.ok(session?.value);
  } finally { s.close(); }
});

test('signed out: every API answers 401; with a session but no CSRF token, every change answers 403 and reaches nobody', async () => {
  const s = await setup();
  try {
    for (const [m, p] of [['GET', '/admin/api/media'], ['GET', '/admin/api/media/17900000000000001/comments'], ['GET', '/admin/api/requests'],
      ['POST', '/admin/api/media/17900000000000001/comments'], ['POST', '/admin/api/comments/17850000000000011/replies'],
      ['POST', '/admin/api/comments/17850000000000011/hide'], ['DELETE', '/admin/api/comments/17850000000000011'], ['POST', '/admin/api/logout']]) {
      const r = await fetch(s.t.base + p, { method: m, headers: { 'content-type': 'application/json' }, body: m === 'GET' ? undefined : '{"message":"x","hide":true}' });
      assert.equal(r.status, 401, `${m} ${p}`);
    }
    const a = await signedIn(s.t);
    const before = s.ig.calls.length;
    for (const csrf of [null, 'wrong']) {
      for (const [m, p, b] of [['POST', '/admin/api/media/17900000000000001/comments', { message: 'x' }],
        ['POST', '/admin/api/comments/17850000000000011/replies', { message: 'x' }],
        ['POST', '/admin/api/comments/17850000000000011/hide', { hide: true }], ['DELETE', '/admin/api/comments/17850000000000011'],
        ['POST', '/admin/api/logout']]) {
        const r = await a.call(m, p, b, csrf);
        assert.equal(r.status, 403, `${m} ${p} csrf=${csrf}`);
      }
    }
    assert.equal(s.ig.calls.length, before, 'nothing reached Instagram');
  } finally { s.close(); }
});

test('posts and comments are listed with the owner\'s token; the picture comes through this server', async () => {
  const s = await setup();
  try {
    const a = await signedIn(s.t);
    const { media } = await (await a.call('GET', '/admin/api/media')).json();
    assert.equal(media.length, 3);
    assert.deepEqual(Object.keys(media[0]).sort(), ['caption', 'commentsCount', 'hasPicture', 'id', 'mediaType', 'permalink', 'timestamp']);
    assert.equal(media[0].commentsCount, 3);
    const list = s.ig.calls.find((c) => c.path === '/v23.0/me/media');
    assert.equal(list.token, OWNER_TOKEN, 'the owner\'s token, not IG_ACCESS_TOKEN');
    assert.equal(list.params.fields, 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,comments_count');

    const { comments } = await (await a.call('GET', `/admin/api/media/${media[0].id}/comments`)).json();
    assert.equal(comments.length, 2);
    assert.equal(comments[0].username, 'croissant.fan');
    assert.equal(comments[0].replies[0].username, 'instapaid.official');
    const cl = s.ig.calls.find((c) => c.path === `/v23.0/${media[0].id}/comments`);
    assert.equal(cl.token, OWNER_TOKEN);
    assert.match(cl.params.fields, /^id,text,username,timestamp,hidden,replies\{id,text,username,timestamp/);

    const pic = await a.call('GET', `/admin/api/media/${media[0].id}/picture`);
    assert.equal(pic.status, 200);
    assert.equal(pic.headers.get('content-type'), 'image/png');
    for (const bad of ['../me', 'abc', '1;2']) {
      assert.notEqual((await a.call('GET', `/admin/api/media/${encodeURIComponent(bad)}/comments`)).status, 200, bad);
    }
  } finally { s.close(); }
});

test('create, reply, hide / unhide and delete each call the right Instagram endpoint with the owner\'s token', async () => {
  const s = await setup();
  try {
    const a = await signedIn(s.t);
    const logs = await logsOf(async () => {
      const post = '17900000000000001', cm = '17850000000000013';
      let r = await a.call('POST', `/admin/api/media/${post}/comments`, { message: '  Thanks for the love!  ' });
      assert.equal(r.status, 200);
      const created = (await r.json()).id;
      assert.ok(created);
      r = await a.call('POST', `/admin/api/comments/${cm}/replies`, { message: 'Please keep it friendly.' });
      assert.equal(r.status, 200);
      r = await a.call('POST', `/admin/api/comments/${cm}/hide`, { hide: true });
      assert.deepEqual(await r.json(), { ok: true, hidden: true });
      r = await a.call('POST', `/admin/api/comments/${cm}/hide`, { hide: false });
      assert.deepEqual(await r.json(), { ok: true, hidden: false });
      r = await a.call('DELETE', `/admin/api/comments/${created}`);
      assert.deepEqual(await r.json(), { ok: true });

      const writes = s.ig.calls.filter((c) => c.method !== 'GET' && c.path !== '/oauth/access_token').map(({ method, path, token, params }) => ({ method, path, token, params }));
      assert.deepEqual(writes, [
        { method: 'POST', path: `/v23.0/${post}/comments`, token: OWNER_TOKEN, params: { message: 'Thanks for the love!' } },
        { method: 'POST', path: `/v23.0/${cm}/replies`, token: OWNER_TOKEN, params: { message: 'Please keep it friendly.' } },
        { method: 'POST', path: `/v23.0/${cm}`, token: OWNER_TOKEN, params: { hide: 'true' } },
        { method: 'POST', path: `/v23.0/${cm}`, token: OWNER_TOKEN, params: { hide: 'false' } },
        { method: 'DELETE', path: `/v23.0/${created}`, token: OWNER_TOKEN, params: {} },
      ]);
      // The stand-in's state follows: the new comment is gone, the reply is there.
      const { comments } = await (await a.call('GET', `/admin/api/media/${post}/comments`)).json();
      assert.ok(!comments.some((c) => c.id === created));
      assert.equal(comments.find((c) => c.id === cm).replies[0].text, 'Please keep it friendly.');

      // What Instagram refuses comes back in its own words, and is logged without a token.
      r = await a.call('DELETE', '/admin/api/comments/17859999999999999');
      assert.equal(r.status, 502);
      assert.match((await r.json()).error, /Instagram said: \(#100\/33\) Unsupported request/);
      // Empty and over-long messages never leave the server.
      for (const message of ['', '   ', 'x'.repeat(301), 5]) {
        assert.equal((await a.call('POST', `/admin/api/media/${post}/comments`, { message })).status, 400);
      }
      assert.equal((await a.call('POST', `/admin/api/comments/${cm}/hide`, { hide: 'yes' })).status, 400);
    });
    assert.match(logs, /admin: delete → 400 \(#100\/33\) Unsupported request/);
    assert.match(logs, /admin: commented on post 17900000000000001/);
    assert.ok(!logs.includes(OWNER_TOKEN) && !logs.includes('SECRET'), 'no token in the logs');
  } finally { s.close(); }
});

test('the latest comment-launch requests are listed, a failed one can be tried again; log out clears the session cookie', async () => {
  const s = await setup();
  try {
    const now = Date.now();
    const ins = s.t.db.prepare('insert into comment_request (comment_id, media_id, username, status, note, created_at, text, from_username, field) values (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    ins.run('c1', 'm1', 'sunset.bakery', 'launched', null, now - 2000, '@instapaid.official make a coin', 'fan.one', 'comments');
    ins.run('c2', 'm2', 'trail.dog.club', 'failed', 'daily budget', now - 1000, null, null, 'mentions');
    const a = await signedIn(s.t);
    let j = await (await a.call('GET', '/admin/api/requests')).json();
    assert.deepEqual(j.requests.map((r) => [r.username, r.status, r.note]), [['trail.dog.club', 'failed', 'daily budget'], ['sunset.bakery', 'launched', null]]);
    assert.deepEqual(Object.keys(j.requests[0]).sort(), ['comment_id', 'created_at', 'field', 'from_username', 'mint', 'note', 'status', 'symbol', 'text', 'username']);
    assert.deepEqual([j.requests[1].from_username, j.requests[1].text], ['fan.one', '@instapaid.official make a coin']);
    assert.deepEqual(j.events, { count: 0, last: null }, 'no comment event from Meta yet');
    // Try again: only a failed one; it is queued and answered at once.
    assert.equal((await a.call('POST', '/admin/api/requests/c1/retry')).status, 409);
    assert.equal((await a.call('POST', '/admin/api/requests/c2/retry', null, 'wrong')).status, 403, 'needs the CSRF token');
    assert.equal((await a.call('POST', '/admin/api/requests/c2/retry')).status, 202);
    await s.t.drain();
    j = await (await a.call('GET', '/admin/api/requests')).json();
    assert.equal(j.requests[0].status, 'failed', 'tried again: the stand-in has no such comment, so it failed again');
    assert.equal(j.requests[0].note, 'not found');
    const out = await a.call('POST', '/admin/api/logout');
    assert.equal(out.status, 200);
    const c = setCookies(out)[SESSION_COOKIE];
    assert.equal(c.value, '');
    assert.match(c.raw, /Expires=Thu, 01 Jan 1970/);
  } finally { s.close(); }
});

test('a welcome DM Instagram refuses (ig.reply resolves false) is tried again on the next DM from the same sender', async () => {
  const sent = [false, true, true];
  const t = await start({ usernames: { u9: 'dm.person' }, dmSent: (n) => sent[n - 1] });
  try {
    await webhook(t, 'u9', 'hi, what is this?');
    await tick();
    assert.equal(t.calls.replies.length, 1, 'the first welcome was tried');
    await webhook(t, 'u9', 'hello?');
    await tick();
    assert.equal(t.calls.replies.length, 2, 'refused, so the next DM tries again');
    await webhook(t, 'u9', 'anyone?');
    await tick();
    assert.equal(t.calls.replies.length, 2, 'sent, so no second welcome within the hour');
    assert.ok(t.calls.replies.every((r) => r.igsid === 'u9'));
  } finally { t.close(); }
});
