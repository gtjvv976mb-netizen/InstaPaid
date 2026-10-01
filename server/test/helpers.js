import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressLookupTableAccount, ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { openDb, LAUNCH_TABLE_KV } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createPoster } from '../src/poster.js';
import { createScout } from '../src/scout.js';
import { getOrCreateAccount, vaultKeypair, cosignLaunch } from '../src/pump.js';

export const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
/** pump.fun's Global account: the same in every launch, so it is what the launch lookup table holds. */
export const PUMP_GLOBAL = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');

/** A launch lookup table as loadLaunchTable returns it, holding `addresses` (default: pump.fun's Global). */
export function fakeLaunchTable(addresses = [PUMP_GLOBAL], key = Keypair.generate().publicKey) {
  return new AddressLookupTableAccount({
    key,
    state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses },
  });
}
const BLOCKHASH = '11111111111111111111111111111111';

/** The fake launch's create instruction: the coin address signs, the vault is the creator. */
export function fakeCreate({ launcher, mint, vault, name = 'Coin' }) {
  return new TransactionInstruction({
    programId: PUMP_PROGRAM,
    keys: [
      { pubkey: new PublicKey(mint), isSigner: true, isWritable: true },
      { pubkey: new PublicKey(vault), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(launcher), isSigner: true, isWritable: true },
      { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(`create:${name}`),
  });
}

/** An unsigned launch as buildLaunchTx makes it: compute budget first, then the create. */
export function fakeLaunchTx({ launcher, mint, vault, name, extra = [], budget = 200_000, table = null }) {
  const msg = new TransactionMessage({
    payerKey: new PublicKey(launcher), recentBlockhash: BLOCKHASH,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 350_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: budget }),
      fakeCreate({ launcher, mint, vault, name }),
      ...extra,
    ],
  }).compileToV0Message(table ? [table] : []);
  return new VersionedTransaction(msg);
}

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
  scout: { intervalS: 60, seeds: [], minFollowers: 1000, maxFollowers: 0, maxPerDay: 2, minSol: 0.5, minScore: 100, everyMin: 60 },
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
 * dmSent: what the fake ig.reply resolves to (false = Instagram refused the DM).
 * launchTable: what the fake loadLaunchTable finds on chain (fakeLaunchTable()), for the address in
 * kv launch.lookupTable; null (default) means no table.
 */
export async function start({
  usernames = {}, mentions = {}, feePayerLamports = 10n ** 9n, launchFails = false,
  config = {}, graph, naming = {}, review = { nameOk: true, pictureOk: true }, now,
  comments: commentsImpl, fetchImpl: fetchOverride, dmSent, mintPool, scoutFetch, launchTable = null,
} = {}) {
  const db = openDb(':memory:');
  if (launchTable) db.prepare('insert into kv (key, value) values (?, ?)').run(LAUNCH_TABLE_KV, launchTable.key.toBase58());
  const postsDir = mkdtempSync(join(tmpdir(), 'instapaid-posts-'));
  const coinsDir = mkdtempSync(join(tmpdir(), 'instapaid-coins-'));
  const c = { ...cfg, postsDir, coinsDir, ...config };
  const calls = { payOut: [], replies: [], mentionReplies: [], serverLaunches: [], lore: [], uploads: [], reviews: [], statusChecks: [], mints: [], sent: [], tables: [], tableLoads: [] };
  const chain = { outcome: 'pending', launchFails };
  const live = new Set();
  const pump = {
    getOrCreateAccount, vaultKeypair,
    // A real v0 transaction shaped like a launch: the launcher pays, and one "create" instruction to
    // pump.fun's program takes the coin address (signer), the vault and the launcher, with the name
    // in its data. So the real cosignLaunch checks it exactly as it checks a mainnet launch.
    async buildLaunchTx(conn, { launcher, vault, name, mint: mintKey, signMint = true, table = null }) {
      calls.mints.push(mintKey);
      calls.tables.push(table);
      const kp = mintKey ?? Keypair.generate();
      const mint = kp.publicKey.toBase58();
      live.add(`${mint}:${vault}`);
      const tx = fakeLaunchTx({ launcher, mint: kp.publicKey, vault, name, table });
      if (signMint) tx.sign([kp]);
      return { mint, tx: Buffer.from(tx.serialize()).toString('base64'), ...(signMint ? {} : { mintKey: kp }) };
    },
    cosignLaunch,
    async loadLaunchTable(conn, address) {
      calls.tableLoads.push(address);
      return launchTable && launchTable.key.toBase58() === address ? launchTable : null;
    },
    async sendLaunch(conn, tx) {
      if (chain.sendFails) throw new Error(chain.sendFails);
      calls.sent.push(tx);
      return `websig${calls.sent.length}`;
    },
    async confirmLaunch(conn, mint, vault) { return live.has(`${mint}:${vault}`); },
    async pendingFees() { return 1_500_000_000n; },
    async launchPaidByServer(conn, args) {
      if (chain.launchFails === true) throw new Error('rpc down');
      calls.serverLaunches.push(args);
      calls.mints.push(args.mint);
      const sent = { mint: (args.mint ?? Keypair.generate()).publicKey.toBase58(), signature: `sig${calls.serverLaunches.length}`, lastValidBlockHeight: 1000 };
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
    // dmSent: what ig.reply resolves to (a value, or a function of the reply's number); undefined by default.
    async reply(c, igsid, text) { calls.replies.push({ igsid, text }); return typeof dmSent === 'function' ? dmSent(calls.replies.length) : dmSent; },
  };
  const fetchImpl = fetchOverride ?? (async () => new Response(POST_PNG, { headers: { 'content-type': 'image/png' } }));
  const comments = commentsImpl ?? {
    async readMention(c, { commentId }) {
      if (!mentions[commentId]) throw new Error('not found');
      return mentions[commentId];
    },
    async replyToMention(c, ids, message) { calls.mentionReplies.push({ ...ids, message }); return true; },
    async replyBlocked() { return null; },
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
  // The launcher bot's scout, with a stand-in for instagram.com (scoutFetch) when a test gives one.
  const scout = scoutFetch ? createScout({ db, cfg: c, fetchImpl: scoutFetch, log: quiet, now: now ?? Date.now }) : undefined;
  const app = createApp({
    db, cfg: c, connection: null, pump, ig, comments, nameCoin, fetchImpl, feePayer: Keypair.generate(), poster, mintPool, scout,
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
    scout, bot: app.locals,
    close: () => { server.close(); rmSync(postsDir, { recursive: true, force: true }); rmSync(coinsDir, { recursive: true, force: true }); },
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
