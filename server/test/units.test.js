import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { sealSecret, openSecret, signToken, readToken, newCode, CODE_RE, metaSignatureOk } from '../src/crypto.js';
import { normalizeHandle } from '../src/handles.js';
import { codeMessages } from '../src/instagram.js';
import { allowedImageUrl, tokenDescription } from '../src/metadata.js';

const key = randomBytes(32).toString('hex');

test('vault keys open only with their own account and the master key', () => {
  const secret = randomBytes(64);
  const sealed = sealSecret(secret, key, 'vault:alice');
  assert.deepEqual(Buffer.from(openSecret(sealed, key, 'vault:alice')), secret);
  assert.throws(() => openSecret(sealed, key, 'vault:mallory'));
  assert.throws(() => openSecret(sealed, randomBytes(32).toString('hex'), 'vault:alice'));
});

test('signed tokens: tampering and expiry are refused', () => {
  const t = signToken({ igsid: '1', username: 'a', exp: Date.now() + 1000 }, key);
  assert.equal(readToken(t, key).igsid, '1');
  const [b, m] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ igsid: '2', username: 'a', exp: Date.now() + 1000 })).toString('base64url');
  assert.equal(readToken(`${forged}.${m}`, key), null);
  assert.equal(readToken(signToken({ exp: Date.now() - 1 }, key), key), null);
  assert.equal(readToken('junk', key), null);
});

test('codes match the pattern the webhook looks for', () => {
  for (let i = 0; i < 200; i++) assert.match(newCode(), CODE_RE);
});

test('usernames', () => {
  assert.equal(normalizeHandle('@Nat.Geo'), 'nat.geo');
  assert.equal(normalizeHandle('explore'), null);
  assert.equal(normalizeHandle('.bad'), null);
  assert.equal(normalizeHandle('a..b'), null);
  assert.equal(normalizeHandle('x'.repeat(31)), null);
  assert.equal(normalizeHandle('ok_name.1'), 'ok_name.1');
});

test('webhook parsing skips echoes and finds the code in any case', () => {
  const body = { object: 'instagram', entry: [{ messaging: [
    { sender: { id: '9' }, message: { text: 'here: ip-ABCDEFGH thanks' } },
    { sender: { id: 'bot' }, message: { text: 'IP-ABCDEFGH', is_echo: true } },
    { sender: { id: '8' }, message: { text: 'hello' } },
  ] }] };
  assert.deepEqual(codeMessages(body), [{ igsid: '9', code: 'IP-ABCDEFGH' }]);
  assert.deepEqual(codeMessages({ object: 'page', entry: [] }), []);
  // The same DM in the changes[] shape (Meta's dashboard Test, some Instagram Login subscriptions).
  const changes = { object: 'instagram', entry: [{ id: 'bot', changes: [
    { field: 'messages', value: { sender: { id: '7' }, recipient: { id: 'bot' }, message: { mid: 'm1', text: 'IP-ABCDEFGH' } } },
    { field: 'messages', value: { sender: { id: 'bot' }, recipient: { id: '7' }, message: { mid: 'm2', text: 'IP-ABCDEFGH' } } },
    { field: 'messages', value: { sender: { id: '8' }, message: { mid: 'm3', text: 'random text' } } },
    { field: 'mentions', value: { comment_id: '1', media_id: '2' } },
  ] }] };
  assert.deepEqual(codeMessages(changes), [{ igsid: '7', code: 'IP-ABCDEFGH' }]);
});

test('Meta signature', () => {
  const raw = Buffer.from('{"a":1}');
  assert.equal(metaSignatureOk(raw, 'sha256=00', 's'), false);
  assert.equal(metaSignatureOk(raw, undefined, 's'), false);
});

test('images only from Instagram CDNs; every coin carries the disclaimer', () => {
  assert.ok(allowedImageUrl('https://scontent-lax3-1.cdninstagram.com/v/t51/x.jpg'));
  assert.ok(!allowedImageUrl('http://scontent.cdninstagram.com/x.jpg'));
  assert.ok(!allowedImageUrl('https://169.254.169.254/latest'));
  assert.ok(!allowedImageUrl('https://evil.com/?.cdninstagram.com'));
  const d = tokenDescription('alice', 'gm', 'https://x');
  assert.match(d, /claimable only by that account/);
  assert.match(d, /not by @alice/);
});

test('subscribeMessages: posts to me/subscribed_apps, skips placeholder tokens, never throws', async () => {
  const { subscribeMessages } = await import('../src/instagram.js');
  const cfg = { graphVersion: 'v23.0', accessToken: 'IGAA' + 'x'.repeat(40) };
  let seen;
  const ok = await subscribeMessages(cfg, async (url, init) => { seen = { url, init }; return new Response('{"success":true}', { status: 200 }); });
  assert.equal(ok.ok, true);
  assert.match(seen.url, /\/v23\.0\/me\/subscribed_apps\?subscribed_fields=messages&access_token=IGAA/);
  assert.equal(seen.init.method, 'POST');
  assert.equal((await subscribeMessages({ ...cfg, accessToken: 'x' }, async () => { throw new Error('should not call'); })).ok, false);
  const bad = await subscribeMessages(cfg, async () => new Response('{"error":{"message":"Invalid OAuth access token"}}', { status: 400 }));
  assert.match(bad.reason, /400: Invalid OAuth access token/);
  assert.equal((await subscribeMessages(cfg, async () => { throw new Error('offline'); })).reason, 'offline');
});

test('welcomeDm: official, tells a creator with coins what is waiting and how to claim; a stranger what this is', async () => {
  const { welcomeDm } = await import('../src/comments.js');
  const withCoins = welcomeDm({ username: 'nat.geo', publicUrl: 'https://instapaid.fun', coins: [
    { name: 'Golden Hour', symbol: 'GEO', pendingLamports: 1_500_000_000n },
    { name: 'Sunset', symbol: 'SUN', pendingLamports: 0n },
  ] });
  for (const must of ['Hello @nat.geo, this is InstaPaid.', '• Golden Hour ($GEO)', '• Sunset ($SUN)', 'Waiting for you right now: 1.5 SOL',
    'instapaid.fun/claim', 'Get my code', 'never asks for your password, seed phrase or private key', 'instapaid.fun/u/nat.geo']) {
    assert.ok(withCoins.includes(must), must);
  }
  assert.ok(withCoins.length <= 1000, `${withCoins.length} chars (Instagram DM limit)`);
  assert.doesNotMatch(withCoins, /🚀|moon|profit/i);

  const none = welcomeDm({ username: 'someone', publicUrl: 'https://instapaid.fun', coins: [] });
  assert.match(none, /No coin has been launched for @someone yet/);
  assert.match(none, /make a token for this creator/);
  assert.ok(none.length <= 1000);
  assert.match(welcomeDm({ username: null, coins: [], publicUrl: 'https://instapaid.fun' }), /Hello you, this is InstaPaid/);

  const many = welcomeDm({ username: 'x', publicUrl: 'https://instapaid.fun', coins: Array.from({ length: 5 }, (_, i) => ({ name: 'N' + i, symbol: 'S' + i, pendingLamports: 0n })) });
  assert.match(many, /• and 2 more/);
});
