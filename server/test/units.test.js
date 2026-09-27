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
