// The site's pages as a browser and a crawler see them: security headers, caching, the 404 page,
// trailing slashes, favicon.ico, robots.txt and the sitemap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { start } from './helpers.js';

const noFollow = (t, p, headers = {}) => fetch(t.base + p, { redirect: 'manual', headers });

test('every response carries the security headers; HSTS only over HTTPS', async () => {
  const t = await start();
  try {
    for (const p of ['/', '/launch', '/api/config', '/nope', '/media/coin-400.webp']) {
      const r = await t.get(p);
      assert.equal(r.headers.get('x-frame-options'), 'DENY', p);
      assert.equal(r.headers.get('content-security-policy'), "frame-ancestors 'none'", p);
      assert.equal(r.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()', p);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff', p);
      assert.equal(r.headers.get('strict-transport-security'), null, `${p}: plain HTTP pins nothing`);
    }
  } finally { t.close(); }
  // Behind the host's HTTPS proxy (TRUST_PROXY=1): req.secure, so HSTS.
  process.env.TRUST_PROXY = '1';
  const s = await start();
  delete process.env.TRUST_PROXY;
  try {
    const r = await fetch(s.base + '/', { headers: { 'x-forwarded-proto': 'https' } });
    assert.equal(r.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
  } finally { s.close(); }
});

test('an unknown page answers 404 with the site\'s own page; an unknown API path a JSON 404', async () => {
  const t = await start();
  try {
    for (const p of ['/nope', '/launch/extra', '/u/a/b', '/404', '/404.html']) {
      const r = await t.get(p);
      assert.equal(r.status, 404, p);
      assert.match(r.headers.get('content-type'), /text\/html/, p);
      const html = await r.text();
      assert.match(html, /This page doesn.t exist/, p);
      for (const href of ['href="/"', 'href="/launch"', 'href="/claim"']) assert.ok(html.includes(href), `${p} links ${href}`);
      assert.doesNotMatch(html, /Cannot GET/);
    }
    const api = await t.get('/api/nope');
    assert.equal(api.status, 404);
    assert.deepEqual(await api.json(), { error: 'Not found.' });
  } finally { t.close(); }
});

test('a trailing slash on a real page redirects (301) to the page; never to another host', async () => {
  const t = await start();
  try {
    for (const [from, to] of [['/launch/', '/launch'], ['/claim/', '/claim'], ['/privacy/', '/privacy'],
      ['/data-deletion/', '/data-deletion'], ['/claim/?x=1', '/claim?x=1'], ['/u/nat.geo/', '/u/nat.geo']]) {
      const r = await noFollow(t, from);
      assert.equal(r.status, 301, from);
      assert.equal(r.headers.get('location'), to, from);
    }
    for (const p of ['//evil.example/', '/nope/', '/api/config/']) {
      const r = await noFollow(t, p);
      assert.notEqual(r.status, 301, p);
      assert.ok(!r.headers.get('location'), p);
    }
    assert.equal((await t.get('/launch')).status, 200);
  } finally { t.close(); }
});

test('caching: HTML revalidated, media a day, the versioned 3D engine 30 days', async () => {
  const t = await start();
  try {
    for (const p of ['/', '/launch', '/claim', '/privacy', '/u/nat.geo']) {
      assert.equal((await t.get(p)).headers.get('cache-control'), 'no-cache', p);
    }
    assert.equal((await t.get('/media/coin-400.webp')).headers.get('cache-control'), 'public, max-age=86400');
    assert.equal((await t.get('/media/pip.glb')).headers.get('cache-control'), 'public, max-age=86400');
    const engine = await t.get('/vendor/three-pip.js');
    assert.equal(engine.headers.get('cache-control'), 'public, max-age=2592000');
    // Kept 30 days (a day for media) under one name, so each file is asked for with its hash: a new
    // file is a new URL. mascot.js loads pip3d.js, which loads the engine and the model.
    const hash = (f) => createHash('sha256').update(readFileSync(new URL(`../public/${f}`, import.meta.url))).digest('hex').slice(0, 8);
    const read = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
    assert.ok(read('mascot.js').includes(`/pip3d.js?v=${hash('pip3d.js')}`), 'pip3d.js ?v= is its hash');
    assert.ok(read('pip3d.js').includes(`/vendor/three-pip.js?v=${hash('vendor/three-pip.js')}`), 'three-pip.js ?v= is its hash');
    assert.ok(read('pip3d.js').includes(`/media/pip.glb?v=${hash('media/pip.glb')}`), 'pip.glb ?v= is its hash');
  } finally { t.close(); }
});

test('favicon.ico (32 and 16), robots.txt and the sitemap; a canonical link on each page', async () => {
  const t = await start();
  try {
    const ico = Buffer.from(await (await t.get('/favicon.ico')).arrayBuffer());
    assert.equal(ico.readUInt16LE(2), 1, 'an icon');
    assert.deepEqual([0, 1].map((i) => ico[6 + 16 * i]), [32, 16]);
    const robots = await (await t.get('/robots.txt')).text();
    assert.match(robots, /^Disallow: \/api\/$/m);
    assert.match(robots, /^Disallow: \/webhooks\/$/m);
    assert.match(robots, /^Sitemap: https:\/\/instapaid\.fun\/sitemap\.xml$/m);
    const map = await (await t.get('/sitemap.xml')).text();
    const locs = [...map.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    assert.deepEqual(locs, ['/', '/launch', '/claim', '/terms', '/privacy', '/data-deletion'].map((p) => 'https://instapaid.fun' + p));
    for (const [p, canon] of [['/', '/'], ['/launch', '/launch'], ['/claim', '/claim'], ['/terms', '/terms'], ['/privacy', '/privacy'], ['/data-deletion', '/data-deletion']]) {
      const html = await (await t.get(p)).text();
      assert.ok(html.includes(`<link rel="canonical" href="https://instapaid.fun${canon}">`), p);
    }
  } finally { t.close(); }
});
