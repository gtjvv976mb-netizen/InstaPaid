import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NOT_PROFILES as SERVER_NOT_PROFILES, normalizeHandle } from '../src/handles.js';
import { NOT_PROFILES, HANDLE_RE, isHandle } from '../public/common.js';
import { launchedReply } from '../src/comments.js';

test('the page reads usernames exactly as the server does', () => {
  assert.deepEqual([...NOT_PROFILES].sort(), [...SERVER_NOT_PROFILES].sort(), 'public/common.js NOT_PROFILES = src/handles.js');
  const serverRe = readFileSync(new URL('../src/handles.js', import.meta.url), 'utf8').match(/const RE = (\/.*\/);/)[1];
  assert.equal(String(HANDLE_RE), serverRe);
  for (const v of ['nat.geo', 'explore', 'reels', 'p', 'bad..name', '.x', 'x.', 'ok_name.1', 'x'.repeat(30), 'x'.repeat(31), '']) {
    assert.equal(isHandle(v), normalizeHandle(v) === v, v);
  }
});

test('the comment reply makes no hype: no rocket, no moon', () => {
  const m = launchedReply({ username: 'baker.example', name: 'First Loaf', symbol: 'LOAF', mint: 'M'.repeat(44), publicUrl: 'https://instapaid.fun' });
  assert.match(m, /^🎉 Done! First Loaf \(\$LOAF\) is now live on pump\.fun, made for @baker\.example\./);
  assert.doesNotMatch(m, /🚀|🌕|moon|profit|gains|pump it|100x/i);
  assert.match(m, /Not financial advice/);
});

test('the site loads nothing from another host', () => {
  for (const f of ['index.html', 'launch.html', 'claim.html', 'account.html', 'privacy.html', 'data-deletion.html', '404.html',
    'app.css', 'home.css', 'home.js', 'common.js', 'launch.js', 'claim.js', 'mascot.js']) {
    // A canonical link names the page's own address; the browser loads nothing from it.
    const s = readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8').replace(/<link rel="canonical" href="https:\/\/instapaid\.fun\/[^"]*">/g, '');
    // src=, href= on <link>/<script>, url(...) and import from '...': only same-site paths.
    for (const m of s.matchAll(/(?:<script[^>]*\ssrc|<link[^>]*\shref|<img[^>]*\ssrc)="([^"]+)"|url\(([^)]+)\)|from '([^']+)'/g)) {
      const u = (m[1] || m[2] || m[3]).replace(/^["']|["']$/g, '');
      assert.ok(u.startsWith('/') || u.startsWith('#') || u.startsWith('data:') || u.startsWith('../'), `${f} loads ${u}`);
    }
  }
});

test('the home page draws the folding phone without naming a phone brand', () => {
  for (const f of ['index.html', 'home.css', 'home.js']) {
    const s = readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8')
      .replace(/apple-touch-icon/g, '').replace(/-apple-system/g, '');
    assert.doesNotMatch(s, /iphone|apple/i, `${f} names the device's maker`);
  }
});
