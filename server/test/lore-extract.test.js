// The fan's lore: the words after "@instapaid.official make a token" in their comment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commentLore, isLaunchRequest, instagramPermalink } from '../src/comments.js';

const bot = 'instapaid.official';
const lore = (text) => commentLore(text, bot);

test('no lore: just the command, in any of its forms', () => {
  for (const t of [
    '@instapaid.official make a token for this creator',
    '@instapaid.official make a token for the creator',
    '@instapaid.official make a token for this creator!',
    '@instapaid.official make a token',
    '@InstaPaid.Official LAUNCH A COIN',
    '@instapaid.official create a coin for @nat.geo',
    '@instapaid.official mint a token for this creator 🔥🔥',
    'make a token @instapaid.official',
    '@instapaid.official make a token for this creator: ...',
  ]) assert.equal(lore(t), null, t);
});

test('the text after the command is the lore, without "for this creator" and separators', () => {
  const cases = {
    '@instapaid.official make a token for this creator: king of sunsets': 'king of sunsets',
    '@instapaid.official make a token for the creator - king of sunsets': 'king of sunsets',
    '@instapaid.official make a token for this creator — the one who chased every sunset.': 'the one who chased every sunset.',
    '@instapaid.official make a token for @nat.geo lore: maps all the way down': 'lore: maps all the way down',
    '@instapaid.official make a token for @x lore': 'lore',
    '@instapaid.official make a coin, king of sunsets': 'king of sunsets',
    '@instapaid.official make a token. Baker of the best pandesal': 'Baker of the best pandesal',
    '@instapaid.official make a token for this creator:\n\n  king   of\n sunsets  ': 'king of sunsets',
    'Make A Token @instapaid.official for this creator: Loud and proud': 'Loud and proud',
    'make a token for this creator @instapaid.official: the bread king': 'the bread king',
    '@instapaid.official pls make a coin for this post: sunset chaser': 'sunset chaser',
  };
  for (const [text, want] of Object.entries(cases)) assert.equal(lore(text), want, text);
});

test('only the first command counts; later "coin" words stay in the lore', () => {
  assert.equal(lore('@instapaid.official make a coin for this creator: the coin of the realm'), 'the coin of the realm');
});

test('links are removed: http(s), www., bare domains, emails', () => {
  assert.equal(lore('@instapaid.official make a token for this creator: king https://evil.example/x?y=1 of sunsets'), 'king of sunsets');
  assert.equal(lore('@instapaid.official make a token: visit www.scam.example now'), 'visit now');
  assert.equal(lore('@instapaid.official make a token: follow x.com/abc and t.me/group, pump.fun too'), 'follow and too');
  assert.equal(lore('@instapaid.official make a token: write me at me@mail.example ok'), 'write me at ok');
  assert.equal(lore('@instapaid.official make a token HTTPS://X.COM/A'), null, 'only a link: no lore');
  assert.equal(lore('@instapaid.official make a token for this creator: https://x.com/abc www.y.example z.io'), null);
});

test('mentions: the bot is removed, other handles lose their @ (nobody gets tagged)', () => {
  assert.equal(lore('@instapaid.official make a token for this creator: @alice and @bob.smith are legends'), 'alice and bob.smith are legends');
  assert.equal(lore('@instapaid.official make a token @instapaid.official @instapaid.official'), null);
  assert.equal(lore('@instapaid.official. make a token: hi'), 'hi', 'the mention followed by a full stop');
  assert.doesNotMatch(lore('@instapaid.official make a token: thanks @instapaid.official for this') ?? '', /instapaid\.official|@/);
});

test('at most 400 characters; invisible characters removed', () => {
  const long = lore('@instapaid.official make a token for this creator: ' + 'word '.repeat(200));
  assert.ok(long.length <= 400, long.length);
  assert.ok(long.startsWith('word word'));
  assert.equal(lore('@instapaid.official make a token: ab​c ‮def⁦'), 'abc def');
  const emoji = lore('@instapaid.official make a token: ' + 'x'.repeat(399) + '😀');
  assert.ok(emoji.length <= 400);
  assert.doesNotMatch(emoji, /[\ud800-\udbff]$/, 'never half an emoji');
});

test('not a request, no lore', () => {
  assert.equal(lore('@instapaid.official love this'), null);
  assert.equal(lore(''), null);
  assert.equal(lore(undefined), null);
  assert.ok(!isLaunchRequest('make a token: hi', bot), 'must tag the bot');
});

test('permalinks: only https Instagram addresses', () => {
  assert.equal(instagramPermalink('https://www.instagram.com/p/DAbc123/'), 'https://www.instagram.com/p/DAbc123/');
  assert.equal(instagramPermalink('https://instagram.com/reel/XYZ/'), 'https://instagram.com/reel/XYZ/');
  for (const bad of [
    'http://www.instagram.com/p/x/', 'https://instagram.com.evil.example/p/x', 'https://evil.example/?https://www.instagram.com/p/x',
    'https://user:pw@www.instagram.com/p/x', 'https://www.instagram.com:8443/p/x', 'javascript:alert(1)', '', null, undefined, 42,
    'https://www.instagram.com/p/' + 'x'.repeat(400),
  ]) assert.equal(instagramPermalink(bad), null, String(bad));
});

test('payment-scam spellings are removed: wallet addresses, dodged dots, spelled-out domains, hxxp, stray @', () => {
  const cases = {
    '@instapaid.official make a token: official airdrop wallet 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU send 1 SOL': 'official airdrop wallet send 1 SOL',
    '@instapaid.official make a coin: send to 0x52908400098527886E0F7030069857D2E4169EE7 now': 'send to now',
    '@instapaid.official make a coin: visit scam-site dot com': 'visit',
    '@instapaid.official make a coin: visit scam-site dot com slash claim today': 'visit today',
    '@instapaid.official make a coin: go to x。com／abc now': 'go to now',
    '@instapaid.official make a coin: ｗｗｗ．evil．com': null,
    '@instapaid.official make a coin: hxxps://evil[.]com': null,
    '@instapaid.official make a coin: evil (dot) com and evil[dot]net': 'and',
    '@instapaid.official make a coin: evil.xn--p1ai/claim': null,
    '@instapaid.official make a coin: phantom​.app claim': 'claim',
    '@instapaid.official make a coin: DM @ scam_support on telegram': 'DM scam_support on telegram',
    '＠instapaid.official ｍａｋｅ ａ ｔｏｋｅｎ: ｆｕｌｌ ｗｉｄｔｈ ｌｏｒｅ': 'full width lore',
  };
  for (const [text, want] of Object.entries(cases)) assert.equal(lore(text), want, text);
  for (const text of Object.keys(cases)) {
    const l = lore(text) ?? '';
    assert.doesNotMatch(l, /@|[1-9A-HJ-NP-Za-km-z]{32,44}|\b(?:com|net)\b|https?|hxxp|www/i, text);
  }
  // ordinary words that look a little like the patterns stay
  assert.equal(lore('@instapaid.official make a coin: queen of the polka dot dress, dot to dot artist'), 'queen of the polka dot dress, dot to dot artist');
  assert.equal(lore('@instapaid.official make a coin: Supercalifragilisticexpialidocious forever'), 'Supercalifragilisticexpialidocious forever');
});
