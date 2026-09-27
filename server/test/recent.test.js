import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start, webhook, launcher, tick } from './helpers.js';

const launch = (t, username, extra = {}) => t.post('/api/launch/prepare', {
  username, name: 'Coin', symbol: 'coin', launcher: launcher(), imageUrl: 'https://a.cdninstagram.com/p.jpg', ...extra,
});
const recent = async (t) => {
  const r = await t.get('/api/recent');
  assert.equal(r.status, 200);
  return (await r.json()).tokens;
};

test('recent: live coins only, newest first, public fields only, at most 12', async () => {
  const t = await start({ usernames: { 111: 'alice' } });
  try {
    assert.deepEqual(await recent(t), [], 'nothing launched yet');

    const a = await (await launch(t, 'alice', { name: 'Alice Coin', symbol: 'ali' })).json();
    assert.deepEqual(await recent(t), [], 'a prepared launch is not listed');

    await t.post('/api/launch/confirm', { mint: a.mint, signature: 'sig-a' });
    let list = await recent(t);
    assert.equal(list.length, 1);
    assert.deepEqual(Object.keys(list[0]).sort(), ['claimed', 'created_at', 'lore', 'mint', 'name', 'post_permalink', 'symbol', 'username']);
    assert.equal(list[0].post_permalink, null, 'a web launch has no post');
    assert.equal(list[0].mint, a.mint);
    assert.equal(list[0].username, 'alice');
    assert.equal(list[0].name, 'Alice Coin');
    assert.equal(list[0].symbol, 'ALI');
    assert.equal(list[0].claimed, false);
    assert.equal(typeof list[0].created_at, 'number');

    // 13 more, each a millisecond apart: the newest 12 come back, newest first.
    const mints = [];
    for (let i = 0; i < 13; i++) {
      await tick(2);
      const p = await (await launch(t, `bob${i}`)).json();
      await t.post('/api/launch/confirm', { mint: p.mint, signature: 's' });
      mints.push(p.mint);
    }
    list = await recent(t);
    assert.equal(list.length, 12);
    assert.deepEqual(list.map((x) => x.mint), mints.slice(1).reverse());
    for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].created_at >= list[i].created_at);
  } finally { t.close(); }
});

test('recent: shows a claim once the creator has claimed, and never a price', async () => {
  const t = await start({ usernames: { 111: 'alice' } });
  try {
    const a = await (await launch(t, 'alice')).json();
    await t.post('/api/launch/confirm', { mint: a.mint, signature: 'sig-a' });
    assert.equal((await recent(t))[0].claimed, false);

    const v = await (await t.post('/api/verify/start', {})).json();
    await webhook(t, '111', v.code);
    await tick();
    const s = await (await t.get('/api/verify/' + v.id)).json();
    await t.post('/api/claim', { claimToken: s.claimToken, destination: launcher() });

    const [coin] = await recent(t);
    assert.equal(coin.claimed, true);
    for (const k of ['price', 'marketCap', 'launcher', 'vault', 'signature']) assert.ok(!(k in coin), `${k} is not exposed`);
  } finally { t.close(); }
});

test('config says whether a platform share applies, so the claim page can show it first', async () => {
  const t = await start();
  try {
    const c = await (await t.get('/api/config')).json();
    assert.equal(c.botUsername, 'instapaid.official');
    assert.equal(c.platformFeeBps, 0);
  } finally { t.close(); }
});
