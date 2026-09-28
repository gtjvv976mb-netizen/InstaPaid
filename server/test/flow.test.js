import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start, webhook, launcher, tick, cfg } from './helpers.js';

const launch = (t, username, extra = {}) => t.post('/api/launch/prepare', {
  username, name: 'Coin', symbol: 'coin', launcher: launcher(), imageUrl: 'https://a.cdninstagram.com/p.jpg', ...extra,
});

async function verify(t, igsid) {
  const v = await (await t.post('/api/verify/start', {})).json();
  assert.equal((await webhook(t, igsid, `my code ${v.code}`)).status, 200);
  await tick();
  return (await t.get('/api/verify/' + v.id)).json();
}

test('launch: validation, the vault is the creator, confirm only when on-chain', async () => {
  const t = await start();
  try {
    assert.equal((await launch(t, 'explore')).status, 400);
    assert.equal((await launch(t, 'alice', { symbol: 'TOO-LONG-TICKER' })).status, 400);
    assert.equal((await launch(t, 'alice', { launcher: 'nope' })).status, 400);
    assert.equal((await launch(t, 'alice', { imageUrl: 'https://evil.com/x.png' })).status, 400);
    assert.equal((await launch(t, 'alice', { devBuySol: 51 })).status, 400);

    const a = await (await launch(t, '@Alice')).json();
    const b = await (await launch(t, 'alice')).json();
    assert.equal(a.vault, b.vault, 'one vault per account');
    assert.equal(t.db.prepare('select count(*) n from account').get().n, 1);

    let acct = await (await t.get('/api/accounts/alice')).json();
    assert.equal(acct.tokens.length, 0, 'prepared coins are not listed');
    assert.equal((await t.post('/api/launch/confirm', { mint: 'unknown' })).status, 404);
    assert.equal((await t.post('/api/launch/confirm', { mint: a.mint, signature: 'x' })).status, 200);
    acct = await (await t.get('/api/accounts/alice')).json();
    assert.equal(acct.tokens.length, 1);
    assert.equal(acct.verified, false);
  } finally { t.close(); }
});

test('webhook: bad signatures are refused and change nothing', async () => {
  const t = await start({ usernames: { 111: 'alice' } });
  try {
    const v = await (await t.post('/api/verify/start', {})).json();
    assert.equal((await webhook(t, '111', v.code, 'wrong-secret')).status, 401);
    await tick();
    assert.equal((await (await t.get('/api/verify/' + v.id)).json()).status, 'pending');
    const g = await t.get('/webhooks/instagram?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=42');
    assert.equal(await g.text(), '42');
    assert.equal((await t.get('/webhooks/instagram?hub.mode=subscribe&hub.verify_token=no&hub.challenge=42')).status, 403);
  } finally { t.close(); }
});

test('claim: the account that DMs the code gets its own fees, and binds the vault', async () => {
  const t = await start({ usernames: { 111: 'alice', 222: 'bob' } });
  try {
    await launch(t, 'alice');
    const s = await verify(t, '111');
    assert.equal(s.status, 'verified');
    assert.equal(s.username, 'alice');
    assert.deepEqual(s.accounts.map((a) => a.username), ['alice']);
    assert.ok(t.calls.replies.some((r) => r.igsid === '111' && /Verified as @alice/.test(r.text)));
    // The DM names the claim page's button by its own words.
    const button = readFileSync(new URL('../public/claim.html', import.meta.url), 'utf8').match(/id="claim"[^>]*>(?:<svg.*?<\/svg>)?([^<]+)<\/button>/)[1];
    assert.equal(button, 'Send my fees');
    assert.ok(t.calls.replies.some((r) => r.igsid === '111' && r.text.includes(`tap ${button}`)));

    const dest = launcher();
    assert.equal((await t.post('/api/claim', { claimToken: s.claimToken, destination: 'bad' })).status, 400);
    const r = await (await t.post('/api/claim', { claimToken: s.claimToken, destination: dest })).json();
    assert.equal(r.results[0].lamports, '1500000000');
    assert.equal(t.calls.payOut[0].destination, dest);
    assert.equal(t.db.prepare(`select igsid from account where username='alice'`).get().igsid, '111');

    // bob verifies: nothing of alice's is his
    const b = await verify(t, '222');
    assert.deepEqual(b.accounts, []);
    assert.equal((await t.post('/api/claim', { claimToken: b.claimToken, destination: dest })).status, 404);
    assert.equal(t.calls.payOut.length, 1);
    assert.equal((await t.post('/api/claim', { claimToken: 'forged.token', destination: dest })).status, 401);
  } finally { t.close(); }
});

test('a renamed account keeps its fees; whoever takes the old handle gets none', async () => {
  const t = await start({ usernames: { 111: 'alice' } });
  try {
    await launch(t, 'alice');
    const s1 = await verify(t, '111');
    await t.post('/api/claim', { claimToken: s1.claimToken, destination: launcher() });

    // alice renames to alice.new; a stranger (333) registers "alice"
    t.usernames[111] = 'alice.new';
    t.usernames[333] = 'alice';
    await launch(t, 'alice'); // more coins for the old handle still accrue to the bound vault

    const owner = await verify(t, '111');
    assert.deepEqual(owner.accounts.map((a) => a.username), ['alice']);
    const squatter = await verify(t, '333');
    assert.deepEqual(squatter.accounts, []);
    assert.equal((await t.post('/api/claim', { claimToken: squatter.claimToken, destination: launcher() })).status, 404);
  } finally { t.close(); }
});

test('codes are single-use and expire', async () => {
  const t = await start({ usernames: { 111: 'alice', 222: 'bob' } });
  try {
    const v = await (await t.post('/api/verify/start', {})).json();
    await webhook(t, '111', v.code);
    await tick();
    await webhook(t, '222', v.code); // replaying the code from another account changes nothing
    await tick();
    assert.equal((await (await t.get('/api/verify/' + v.id)).json()).username, 'alice');

    const w = await (await t.post('/api/verify/start', {})).json();
    t.db.prepare('update verification set expires_at = 0 where id = ?').run(w.id);
    await webhook(t, '111', w.code);
    await tick();
    assert.equal((await (await t.get('/api/verify/' + w.id)).json()).status, 'expired');
    assert.ok(t.calls.replies.some((r) => /expired/.test(r.text)));
  } finally { t.close(); }
});

test('claim tokens stop being issued after the claim window', async () => {
  const t = await start({ usernames: { 111: 'alice' } });
  try {
    await launch(t, 'alice');
    const v = await (await t.post('/api/verify/start', {})).json();
    await webhook(t, '111', v.code);
    await tick();
    t.db.prepare('update verification set expires_at = ? where id = ?').run(Date.now() - 31 * 60_000, v.id);
    assert.equal((await (await t.get('/api/verify/' + v.id)).json()).status, 'expired');
  } finally { t.close(); }
});

test('a DM without a code gets one official answer an hour: what is waiting and how to claim', async () => {
  const t = await start({ usernames: { 111: 'alice', 222: 'bob' } });
  try {
    const a = await (await launch(t, 'alice')).json();
    assert.equal((await t.post('/api/launch/confirm', { mint: a.mint, signature: 'x' })).status, 200);
    assert.equal((await webhook(t, '111', 'hi, what is this?')).status, 200);
    await tick();
    const dm = t.calls.replies.find((r) => r.igsid === '111');
    assert.ok(dm, 'answered');
    assert.match(dm.text, /^Hello @alice, this is InstaPaid\./);
    assert.match(dm.text, /Waiting for you right now: 1\.5 SOL/);
    assert.match(dm.text, /instapaid\.test\/claim/);
    await webhook(t, '111', 'hello again');
    await tick();
    assert.equal(t.calls.replies.filter((r) => r.igsid === '111').length, 1, 'not answered twice within the hour');

    await webhook(t, '222', 'what?');
    await tick();
    const bob = t.calls.replies.find((r) => r.igsid === '222');
    assert.match(bob.text, /No coin has been launched for @bob yet/);
  } finally { t.close(); }
});
