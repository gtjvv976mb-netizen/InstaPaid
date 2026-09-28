import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createPoster } from '../src/poster.js';
import { getOrCreateAccount, vaultKeypair } from '../src/pump.js';

export const cfg = {
  publicUrl: 'https://instapaid.test',
  vaultMasterKey: randomBytes(32).toString('hex'),
  sessionSecret: randomBytes(32).toString('hex'),
  platformFeeBps: 0,
  treasury: '',
  igUserId: '17841400000000000',
  fbAccessToken: 'fb',
  fbGraphVersion: 'v23.0',
  maxServerLaunchesPerDay: 3,
  minFeePayerSol: 0.1,
  autoPost: false,
  postMaxPerDay: 25,
  postMinGapMin: 20,
  postMaxAgeH: 24,
  ig: { botUsername: 'instapaid.official', accessToken: 't', appSecret: 'app-secret', verifyToken: 'vt', graphVersion: 'v23.0' },
};

export const quiet = { log() {}, error() {}, warn() {} };

/** A real 4×4 teal PNG (#2a9d8f): what the fake Instagram CDN serves as a post's picture. */
export const POST_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElEQVQImWPQmtsPRwzEcQAlwhVhGsOfqAAAAABJRU5ErkJggg==', 'base64');
export const DEFAULT_COIN = readFileSync(new URL('../public/coin-default.png', import.meta.url));

/**
 * A server over an in-memory database, with the chain and Instagram faked.
 * config: overrides for cfg (e.g. {autoPost: true}); graph: a fake fetch for the poster's Graph calls;
 * naming: what the fake Claude says ({name, symbol, loreOk}); review: what it says about website
 * launches ({nameOk, pictureOk}, or null for "Claude unavailable").
 * launchFails: true (the RPC refuses before anything is sent), or 'lost' (sent, the confirmation
 * never comes) with chain.outcome ('live' | 'failed' | 'pending') for what launchStatus finds.
 * comments: the real src/comments.js (or another stand-in) instead of the fake readMention/replyToMention;
 * fetchImpl: the app's fetch (a stand-in Graph and CDN) instead of one that serves POST_PNG.
 */
export async function start({
  usernames = {}, mentions = {}, feePayerLamports = 10n ** 9n, launchFails = false,
  config = {}, graph, naming = {}, review = { nameOk: true, pictureOk: true }, now,
  comments: commentsImpl, fetchImpl: fetchOverride,
} = {}) {
  const db = openDb(':memory:');
  const postsDir = mkdtempSync(join(tmpdir(), 'instapaid-posts-'));
  const c = { ...cfg, postsDir, ...config };
  const calls = { payOut: [], replies: [], mentionReplies: [], serverLaunches: [], lore: [], uploads: [], reviews: [], statusChecks: [] };
  const chain = { outcome: 'pending', launchFails };
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
    async launchPaidByServer(conn, args) {
      if (chain.launchFails === true) throw new Error('rpc down');
      calls.serverLaunches.push(args);
      const sent = { mint: Keypair.generate().publicKey.toBase58(), signature: `sig${calls.serverLaunches.length}`, lastValidBlockHeight: 1000 };
      await args.onSigned?.(sent);
      if (chain.launchFails === 'refused') throw new Error('launch refused: simulation failed');
      if (chain.launchFails === 'lost') throw Object.assign(new Error('block height exceeded'), { sent });
      return { mint: sent.mint, signature: sent.signature };
    },
    async launchStatus(conn, args) { calls.statusChecks.push(args); return chain.outcome; },
    async balanceOf() { return feePayerLamports; },
    async payOut(conn, args) { calls.payOut.push(args); return { collectSig: 'c', transferSig: 's', lamports: 1_500_000_000n, platformFee: 0n }; },
  };
  const ig = {
    async usernameOf(c, igsid) { return usernames[igsid]; },
    async reply(c, igsid, text) { calls.replies.push({ igsid, text }); },
  };
  const fetchImpl = fetchOverride ?? (async () => new Response(POST_PNG, { headers: { 'content-type': 'image/png' } }));
  const comments = commentsImpl ?? {
    async readMention(c, { commentId }) {
      if (!mentions[commentId]) throw new Error('not found');
      return mentions[commentId];
    },
    async replyToMention(c, ids, message) { calls.mentionReplies.push({ ...ids, message }); return true; },
  };
  // Stands in for Claude: names the coin, and passes the fan's lore unless naming.loreOk is false.
  const nameCoin = async (args) => {
    calls.lore.push(args);
    return {
      name: naming.name ?? 'Geo Coin', symbol: naming.symbol ?? 'GEO',
      lore: args.lore && naming.loreOk !== false ? args.lore : null,
    };
  };
  const poster = createPoster({
    db, cfg: c, log: quiet, sleep: async () => {}, now: now ?? Date.now,
    fetchImpl: graph ?? (async () => { throw new Error('no Graph in this test'); }),
    review: async (args) => { calls.reviews.push(args); return typeof review === 'function' ? review(args) : review; },
  });
  const app = createApp({
    db, cfg: c, connection: null, pump, ig, comments, nameCoin, fetchImpl, feePayer: Keypair.generate(), poster,
    uploadMetadata: async (conf, args) => { calls.uploads.push(args); return 'https://ipfs.test/meta.json'; },
  });
  const server = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return {
    db, calls, base, post, get: (p) => fetch(base + p), usernames, mentions, drain: () => app.locals.drain(),
    poster, cfg: c, postsDir, chain, settlePending: () => app.locals.settlePending(),
    close: () => { server.close(); rmSync(postsDir, { recursive: true, force: true }); },
  };
}

export function webhook(t, igsid, text, secret = cfg.ig.appSecret) {
  const body = JSON.stringify({ object: 'instagram', entry: [{ messaging: [{ sender: { id: igsid }, recipient: { id: 'bot' }, message: { text } }] }] });
  const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  return fetch(t.base + '/webhooks/instagram', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body });
}

export const launcher = () => Keypair.generate().publicKey.toBase58();
export const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

export function mentionHook(t, commentId, mediaId = 'm1', secret = cfg.ig.appSecret) {
  const body = JSON.stringify({ object: 'instagram', entry: [{ id: cfg.igUserId, time: 1, changes: [{ field: 'mentions', value: { comment_id: commentId, media_id: mediaId } }] }] });
  const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  return fetch(t.base + '/webhooks/instagram', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body });
}

/** Any webhook body, signed as Meta signs it. */
export function signedHook(t, payload, secret = cfg.ig.appSecret) {
  const body = JSON.stringify(payload);
  const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  return fetch(t.base + '/webhooks/instagram', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body });
}
