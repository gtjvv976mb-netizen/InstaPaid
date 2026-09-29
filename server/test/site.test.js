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

test("the phone's description matches the upright open phone: post on top, the comments below it", () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const label = html.match(/<div class="phone duo" role="img" aria-label="([^"]*)"/)[1];
  // Open, it stands upright at every width (home.js pose: rz = 90), so nothing in it is "on the left" or "on the right".
  assert.doesNotMatch(label, /\b(on the )?(left|right)\b/i, 'the description still places the panes side by side');
  const top = label.indexOf('on top'), below = label.indexOf('Below it, the comments');
  assert.ok(top > 0 && below > top, 'the post is on top and the comments below it');
  // Each part is described in the half that draws it: the post in the swinging half, the fan's comment and the reply in the other.
  const post = label.indexOf('bakery post'), fan = label.indexOf("a fan's comment"), reply = label.indexOf("instapaid.official's reply");
  assert.ok(top < post && post < below && below < fan && fan < reply, 'post, then the comments: the fan, then the reply');
  const [postPane, commentPane] = [html.indexOf('scr scr-l'), html.indexOf('scr scr-r')];
  const fanInDom = html.indexOf('<div class="cmt s1">');
  assert.ok(postPane > 0 && commentPane > postPane && fanInDom > commentPane, "the fan's comment is drawn in the comments half");
  assert.match(html.slice(commentPane, fanInDom), /<span class="ab-title">Comments<\/span>/);
});
