import { createHmac, randomBytes } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { getOrCreateAccount, vaultKeypair } from '../src/pump.js';

export const cfg = {
  publicUrl: 'https://instapaid.test',
  vaultMasterKey: randomBytes(32).toString('hex'),
  sessionSecret: randomBytes(32).toString('hex'),
  platformFeeBps: 0,
  treasury: '',
  ig: { botUsername: 'instapaid.verify', accessToken: 't', appSecret: 'app-secret', verifyToken: 'vt', graphVersion: 'v23.0' },
};

/** A server over an in-memory database, with the chain and Instagram faked. */
export async function start({ usernames = {} } = {}) {
  const db = openDb(':memory:');
  const calls = { payOut: [], replies: [] };
  const live = new Set();
  const pump = {
    getOrCreateAccount, vaultKeypair,
    async buildLaunchTx(conn, { vault }) {
      const mint = Keypair.generate().publicKey.toBase58();
      live.add(`${mint}:${vault}`);
      return { mint, tx: 'AAAA' };
    },
    async confirmLaunch(conn, mint, vault) { return live.has(`${mint}:${vault}`); },
    async pendingFees() { return 1_500_000_000n; },
    async payOut(conn, args) { calls.payOut.push(args); return { collectSig: 'c', transferSig: 's', lamports: 1_500_000_000n, platformFee: 0n }; },
  };
  const ig = {
    async usernameOf(c, igsid) { return usernames[igsid]; },
    async reply(c, igsid, text) { calls.replies.push({ igsid, text }); },
  };
  const fetchImpl = async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
  const app = createApp({
    db, cfg, connection: null, pump, ig, fetchImpl, feePayer: Keypair.generate(),
    uploadMetadata: async () => 'https://ipfs.test/meta.json',
  });
  const server = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { db, calls, base, post, get: (p) => fetch(base + p), close: () => server.close(), usernames };
}

export function webhook(t, igsid, text, secret = cfg.ig.appSecret) {
  const body = JSON.stringify({ object: 'instagram', entry: [{ messaging: [{ sender: { id: igsid }, recipient: { id: 'bot' }, message: { text } }] }] });
  const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  return fetch(t.base + '/webhooks/instagram', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body });
}

export const launcher = () => Keypair.generate().publicKey.toBase58();
export const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));
