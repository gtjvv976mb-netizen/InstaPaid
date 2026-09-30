import { fork } from 'node:child_process';
import { Keypair } from '@solana/web3.js';
import { sealSecret, openSecret } from './crypto.js';

/** Coin addresses end in this, like the coins launched on pump.fun itself. */
export const MINT_SUFFIX = 'pump';

const aad = (pubkey) => `mint:${pubkey}`;
const RESTART_MS = 60_000;

const forkGrinder = (suffix) => fork(new URL('./mint-grinder.js', import.meta.url), [suffix], { stdio: 'inherit' });

/**
 * A stock of coin addresses (mint keypairs) that end in MINT_SUFFIX, found in the background
 * (src/mint-grinder.js, ~20 minutes each on half a CPU) and kept sealed in the database, so a
 * launch never waits for one. take() hands out each address once and deletes it in the same
 * statement: an address is never offered twice, even when its launch is abandoned. When the stock
 * is empty a launch gets a random address, exactly as before.
 *
 * size: how many to keep ready (MINT_POOL_SIZE; 0 = off). grinder(suffix): starts the search and
 * returns a child process (a stand-in in tests).
 */
export function createMintPool({ db, masterKey, size, suffix = MINT_SUFFIX, grinder = forkGrinder, log = console, now = Date.now }) {
  let child = null;
  let running = false;
  let restart = null;

  const count = () => db.prepare('select count(*) as n from mint_key').get().n;

  /** Stores a found key after checking it: only a well-formed key whose address has the suffix. */
  function add(seed) {
    let kp;
    try { kp = Keypair.fromSeed(Uint8Array.from(seed)); } catch { return false; }
    const pubkey = kp.publicKey.toBase58();
    if (!pubkey.endsWith(suffix)) return false;
    db.prepare('insert into mint_key (pubkey, secret, created_at) values (?, ?, ?) on conflict(pubkey) do nothing')
      .run(pubkey, sealSecret(kp.secretKey, masterKey, aad(pubkey)), now());
    return true;
  }

  /** The oldest address in stock, removed from it; null when there is none (use a random one). */
  function take() {
    const row = db.prepare(
      'delete from mint_key where pubkey = (select pubkey from mint_key order by created_at, pubkey limit 1) returning pubkey, secret'
    ).get();
    refill();
    if (!row) return null;
    try {
      const kp = Keypair.fromSecretKey(openSecret(row.secret, masterKey, aad(row.pubkey)));
      if (kp.publicKey.toBase58() === row.pubkey) return kp;
    } catch { /* sealed under another key: skip it */ }
    log.error(`mint pool: stored address ${row.pubkey} could not be opened; using a random one`);
    return null;
  }

  function refill() {
    if (!running || child || count() >= size) return;
    child = grinder(suffix);
    child.on('message', (m) => {
      if (!add(m?.seed ?? [])) return log.error('mint pool: the search sent a key without the suffix');
      const n = count();
      log.log(`mint pool: ${n}/${size} addresses ending in "${suffix}" ready`);
      if (n >= size) child?.kill();
    });
    child.on('exit', () => {
      child = null;
      // Stopped because the stock is full, or it crashed: look again in a minute.
      if (running) { clearTimeout(restart); restart = setTimeout(refill, RESTART_MS); restart.unref?.(); }
    });
    child.on('error', (e) => log.error('mint pool: search failed to start', e.message));
  }

  return {
    take,
    add,
    count,
    start() {
      if (!(size > 0)) return;
      running = true;
      log.log(`mint pool: ${count()}/${size} addresses ending in "${suffix}" ready`);
      refill();
    },
    stop() {
      running = false;
      clearTimeout(restart);
      child?.kill();
    },
    get searching() { return !!child; },
  };
}
