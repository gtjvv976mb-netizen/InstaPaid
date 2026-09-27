import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coinRequest, writeCoin } from '../src/lore.js';

const jpeg = { buf: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), type: 'image/jpeg' };

test('the post picture goes to Claude before the text', () => {
  const r = coinRequest({ username: 'nat.geo', caption: 'Sunrise', image: jpeg });
  const [img, txt] = r.messages[0].content;
  assert.equal(img.type, 'image');
  assert.equal(img.source.type, 'base64');
  assert.equal(img.source.media_type, 'image/jpeg');
  assert.equal(Buffer.from(img.source.data, 'base64').compare(jpeg.buf), 0);
  assert.equal(txt.type, 'text');
  assert.match(txt.text, /@nat\.geo/);
  assert.match(txt.text, /picture from their post/);
  assert.match(txt.text, /<caption>\nSunrise\n<\/caption>/);
  assert.match(r.system, /Never describe\s+anyone's body/);
});

test('no picture, an unsupported type, or an oversized one: text only', () => {
  for (const image of [undefined, { buf: Buffer.from('x'), type: 'image/svg+xml' }, { buf: Buffer.alloc(4 * 1024 * 1024 + 1), type: 'image/png' }]) {
    const c = coinRequest({ username: 'a', caption: '', image }).messages[0].content;
    assert.equal(c.length, 1);
    assert.equal(c[0].type, 'text');
    assert.doesNotMatch(c[0].text, /picture from their post/);
    assert.match(c[0].text, /\(no caption\)/);
  }
});

test('writeCoin sends the picture and cleans what comes back; falls back on refusal or error', async () => {
  let sent;
  const client = { beta: { messages: { parse: async (p) => { sent = p; return { stop_reason: 'end_turn', parsed_output: { name: 'Golden Hour', symbol: '$gold!', lore: 'A sunrise legend.' } }; } } } };
  const coin = await writeCoin({ username: 'nat.geo', caption: '', image: jpeg }, client);
  assert.equal(sent.messages[0].content[0].type, 'image');
  assert.deepEqual(coin, { name: 'Golden Hour', symbol: 'GOLD', lore: 'A sunrise legend.' });

  const refused = { beta: { messages: { parse: async () => ({ stop_reason: 'refusal', parsed_output: null }) } } };
  assert.equal((await writeCoin({ username: 'nat.geo', image: jpeg }, refused)).symbol, 'NATGEO');
  const broken = { beta: { messages: { parse: async () => { throw new Error('boom'); } } } };
  assert.equal((await writeCoin({ username: 'nat.geo' }, broken)).name, 'nat.geo');
});

test('through the real SDK: headers, body and structured-output parsing', async () => {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  let seen;
  const client = new Anthropic({
    apiKey: 'test-key',
    maxRetries: 0,
    fetch: async (url, init) => {
      seen = { url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) };
      return new Response(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: JSON.stringify({ name: 'Golden Hour', symbol: 'GOLD', lore: 'A sunrise legend.' }) }],
        usage: { input_tokens: 10, output_tokens: 10 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const coin = await writeCoin({ username: 'nat.geo', caption: 'Sunrise', image: jpeg }, client);
  assert.deepEqual(coin, { name: 'Golden Hour', symbol: 'GOLD', lore: 'A sunrise legend.' });
  assert.match(seen.url, /\/v1\/messages/);
  assert.match(seen.headers.get('anthropic-beta') || '', /server-side-fallback-2026-07-01/);
  assert.equal(seen.body.model, 'claude-opus-5');
  assert.equal(seen.body.fallbacks, 'default');
  assert.equal(seen.body.messages[0].content[0].type, 'image');
  assert.equal(seen.body.output_config.format.type, 'json_schema');
  assert.equal(seen.body.betas, undefined, 'betas travel as a header, not in the body');
});
