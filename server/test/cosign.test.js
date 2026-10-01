// Website launches in Phantom's signing order: the launcher's wallet signs first, then the server
// checks what came back and adds the coin address's signature (src/pump.js cosignLaunch).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import {
  AddressLookupTableAccount, ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction,
  TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import { start, fakeCreate, fakeLaunchTable, PUMP_PROGRAM, PUMP_GLOBAL } from './helpers.js';

const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const sigOk = (tx, key) => {
  const i = tx.message.staticAccountKeys.findIndex((k) => k.equals(key));
  const pub = createPublicKey({ key: Buffer.concat([SPKI, key.toBuffer()]), format: 'der', type: 'spki' });
  return i >= 0 && verify(null, Buffer.from(tx.message.serialize()), pub, Buffer.from(tx.signatures[i]));
};
const b64 = (tx) => Buffer.from(tx.serialize()).toString('base64');
const fromB64 = (s) => VersionedTransaction.deserialize(Buffer.from(s, 'base64'));

async function prepare(t, wallet, extra = {}) {
  const r = await t.post('/api/launch/prepare', {
    username: 'bob', name: 'Coin', symbol: 'COIN', launcher: wallet.publicKey.toBase58(),
    imageUrl: 'https://a.cdninstagram.com/p.jpg', ...extra,
  });
  assert.equal(r.status, 200, await r.clone().text());
  return r.json();
}
const submit = (t, mint, tx) => t.post('/api/launch/submit', { mint, tx: typeof tx === 'string' ? tx : b64(tx) });
/** What a wallet would return: the prepared message, possibly rebuilt with changes, signed by `signer`. */
function walletSigns(prepTx, signer, rebuild) {
  const tx = fromB64(prepTx);
  const out = rebuild ? rebuild(tx) : tx;
  out.sign([signer]);
  return out;
}
/** The prepared message's instructions, decompiled, so a test can change them like a wallet might. */
function instructionsOf(tx) {
  return TransactionMessage.decompile(tx.message).instructions;
}
function rebuilt(tx, instructions, payer) {
  return new VersionedTransaction(new TransactionMessage({
    payerKey: payer ?? tx.message.staticAccountKeys[0], recentBlockhash: tx.message.recentBlockhash, instructions,
  }).compileToV0Message());
}

test('the prepared launch is unsigned; the wallet signs first, the server adds the coin address and sends it', async () => {
  const t = await start();
  const wallet = Keypair.generate();
  try {
    const prep = await prepare(t, wallet);
    const unsigned = fromB64(prep.tx);
    assert.ok(unsigned.signatures.every((s) => s.every((b) => b === 0)), 'nobody has signed what the wallet is shown');
    assert.equal(unsigned.message.header.numRequiredSignatures, 2);

    const r = await submit(t, prep.mint, walletSigns(prep.tx, wallet));
    assert.equal(r.status, 200);
    assert.equal((await r.json()).signature, 'websig1');
    const sent = t.calls.sent[0];
    assert.ok(sigOk(sent, wallet.publicKey), "the wallet's signature");
    assert.ok(sigOk(sent, new PublicKey(prep.mint)), "the coin address's signature");

    const again = await submit(t, prep.mint, walletSigns(prep.tx, wallet));
    assert.equal(again.status, 410, 'the key is used once');
    assert.equal(t.db.prepare('select count(*) n from launch_pending').get().n, 0);
    const row = t.db.prepare('select status from token where mint = ?').get(prep.mint);
    assert.equal(row.status, 'prepared', 'still confirmed on chain as before');
  } finally { t.close(); }
});

test('the coin address key waits sealed, never in the clear', async () => {
  const t = await start();
  const wallet = Keypair.generate();
  try {
    const prep = await prepare(t, wallet);
    const row = t.db.prepare('select * from launch_pending where mint = ?').get(prep.mint);
    assert.equal(row.launcher, wallet.publicKey.toBase58());
    assert.ok(!/^\[/.test(row.secret) && Buffer.from(row.secret, 'base64').length === 12 + 16 + 64, 'AES-GCM: iv, tag, 64-byte key');
  } finally { t.close(); }
});

test('refused: not signed by the wallet, signed by another wallet, or paid by another wallet', async () => {
  const t = await start();
  const wallet = Keypair.generate();
  try {
    const prep = await prepare(t, wallet);
    const r1 = await submit(t, prep.mint, fromB64(prep.tx));
    assert.equal(r1.status, 400);
    assert.match((await r1.json()).error, /did not sign/);

    const other = Keypair.generate();
    const forged = fromB64(prep.tx);
    forged.signatures[0] = new Uint8Array(64).fill(7);
    const r2 = await submit(t, prep.mint, forged);
    assert.equal(r2.status, 400, 'a signature that does not verify');
    assert.match((await r2.json()).error, /did not sign/);

    const r3 = await submit(t, prep.mint, walletSigns(prep.tx, other, (tx) => rebuilt(tx, instructionsOf(tx).map((ix) => ix.programId.equals(PUMP_PROGRAM)
      ? fakeCreate({ launcher: other.publicKey, mint: prep.mint, vault: prep.vault, name: 'Coin' }) : ix), other.publicKey)));
    assert.equal(r3.status, 400);
    assert.match((await r3.json()).error, /paid by the wallet that prepared it/);
    assert.equal(t.calls.sent.length, 0);
  } finally { t.close(); }
});

test('refused: the creator swapped for another address, or the create changed or dropped', async () => {
  const t = await start();
  const wallet = Keypair.generate();
  try {
    const prep = await prepare(t, wallet);
    const thief = Keypair.generate().publicKey;
    for (const change of [
      (ixs) => ixs.map((ix) => (ix.programId.equals(PUMP_PROGRAM) ? fakeCreate({ launcher: wallet.publicKey, mint: prep.mint, vault: thief, name: 'Coin' }) : ix)),
      (ixs) => ixs.map((ix) => (ix.programId.equals(PUMP_PROGRAM) ? fakeCreate({ launcher: wallet.publicKey, mint: prep.mint, vault: prep.vault, name: 'Other' }) : ix)),
    ]) {
      const tx = walletSigns(prep.tx, wallet, (x) => rebuilt(x, change(instructionsOf(x))));
      const r = await submit(t, prep.mint, tx);
      assert.equal(r.status, 400);
      assert.match((await r.json()).error, /wallet changed the launch|uses the coin address/);
    }
    // Without the create the coin address is not a signer at all.
    const dropped = walletSigns(prep.tx, wallet, (x) => rebuilt(x, instructionsOf(x).filter((ix) => !ix.programId.equals(PUMP_PROGRAM))));
    const r = await submit(t, prep.mint, dropped);
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /changed who signs/);
    assert.equal(t.calls.sent.length, 0);
  } finally { t.close(); }
});

test('allowed: the wallet adds its own checks and changes the priority fee; refused if an addition touches the coin address', async () => {
  const t = await start();
  const wallet = Keypair.generate();
  try {
    const prep = await prepare(t, wallet);
    const guard = new TransactionInstruction({ // stands in for Phantom's Lighthouse assertions
      programId: new PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95'),
      keys: [{ pubkey: wallet.publicKey, isSigner: false, isWritable: false }], data: Buffer.from([1, 2, 3]),
    });
    const ok = walletSigns(prep.tx, wallet, (x) => {
      const ixs = instructionsOf(x).filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId));
      return rebuilt(x, [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }), ...ixs, guard]);
    });
    const r = await submit(t, prep.mint, ok);
    assert.equal(r.status, 200, await r.clone().text());
    assert.ok(sigOk(t.calls.sent[0], new PublicKey(prep.mint)));

    const prep2 = await prepare(t, wallet);
    const grab = walletSigns(prep2.tx, wallet, (x) => rebuilt(x, [...instructionsOf(x),
      SystemProgram.transfer({ fromPubkey: new PublicKey(prep2.mint), toPubkey: wallet.publicKey, lamports: 1 })]));
    const r2 = await submit(t, prep2.mint, grab);
    assert.equal(r2.status, 400);
    assert.match((await r2.json()).error, /uses the coin address/);

    const prep3 = await prepare(t, wallet);
    const extraSigner = Keypair.generate();
    const tx3 = fromB64(prep3.tx);
    const more = rebuilt(tx3, [...instructionsOf(tx3), new TransactionInstruction({
      programId: guard.programId, keys: [{ pubkey: extraSigner.publicKey, isSigner: true, isWritable: false }], data: Buffer.alloc(0),
    })]);
    more.sign([wallet, extraSigner]);
    const r3 = await submit(t, prep3.mint, more);
    assert.equal(r3.status, 400);
    assert.match((await r3.json()).error, /changed who signs/);
    assert.equal(t.calls.sent.length, 1);
  } finally { t.close(); }
});

test('refused: a message with lookup tables, which cannot be checked', async () => {
  const t = await start();
  const wallet = Keypair.generate();
  try {
    const prep = await prepare(t, wallet);
    const x = fromB64(prep.tx);
    const table = new AddressLookupTableAccount({
      key: Keypair.generate().publicKey,
      state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: [new PublicKey(prep.vault)] },
    });
    const msg = new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: x.message.recentBlockhash, instructions: instructionsOf(x) })
      .compileToV0Message([table]);
    const tx = new VersionedTransaction(msg);
    tx.sign([wallet]);
    const r = await submit(t, prep.mint, tx);
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /cannot be checked/);
  } finally { t.close(); }
});

test('expired or unknown launches, junk, and a send Solana refuses', async () => {
  const t = await start();
  const wallet = Keypair.generate();
  try {
    assert.equal((await submit(t, Keypair.generate().publicKey.toBase58(), 'AAAA')).status, 410);
    const prep = await prepare(t, wallet);
    assert.equal((await submit(t, prep.mint, 'not base64 at all!!')).status, 400);
    assert.equal((await submit(t, prep.mint, 'A'.repeat(5000))).status, 400);

    t.chain.sendFails = 'Blockhash not found';
    const r = await submit(t, prep.mint, walletSigns(prep.tx, wallet));
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /Solana did not accept the launch: Blockhash not found/);
    t.chain.sendFails = null;

    t.db.prepare('update launch_pending set expires_at = 0 where mint = ?').run(prep.mint);
    const late = await submit(t, prep.mint, walletSigns(prep.tx, wallet));
    assert.equal(late.status, 410);
    assert.match((await late.json()).error, /expired/);
    await prepare(t, wallet);
    assert.equal(t.db.prepare('select count(*) n from launch_pending where mint = ?').get(prep.mint).n, 0, 'expired rows are swept');
  } finally { t.close(); }
});

// The launch lookup table (npm run lookup-table): what lets a launch with a first buy fit.
const decompiled = (tx, table) => TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: [table] }).instructions;
const withTable = (tx, instructions, table) => new VersionedTransaction(new TransactionMessage({
  payerKey: tx.message.staticAccountKeys[0], recentBlockhash: tx.message.recentBlockhash, instructions,
}).compileToV0Message([table]));

test('no table saved: launches are built without one, as before', async () => {
  const t = await start();
  const wallet = Keypair.generate();
  try {
    const prep = await prepare(t, wallet);
    assert.equal(t.calls.tables[0], null);
    assert.equal(t.calls.tableLoads.length, 0, 'nothing to load');
    assert.equal(fromB64(prep.tx).message.addressTableLookups.length, 0);
  } finally { t.close(); }
});

test('a saved table that is gone from the chain is not used', async () => {
  const t = await start({ launchTable: fakeLaunchTable() });
  const wallet = Keypair.generate();
  try {
    t.db.prepare(`update kv set value = ? where key = 'launch.lookupTable'`).run(Keypair.generate().publicKey.toBase58());
    const prep = await prepare(t, wallet);
    assert.equal(t.calls.tables[0], null);
    assert.equal(fromB64(prep.tx).message.addressTableLookups.length, 0);
  } finally { t.close(); }
});

test('with the table: the launch uses it, the wallet signs, the server checks it through the table and sends it', async () => {
  const table = fakeLaunchTable();
  const t = await start({ launchTable: table });
  const wallet = Keypair.generate();
  try {
    const prep = await prepare(t, wallet, { devBuySol: 0.1 });
    assert.equal(t.calls.tables[0], table);
    const lookups = fromB64(prep.tx).message.addressTableLookups;
    assert.equal(lookups.length, 1);
    assert.ok(lookups[0].accountKey.equals(table.key), "pump.fun's Global comes from the table");

    const r = await submit(t, prep.mint, walletSigns(prep.tx, wallet));
    assert.equal(r.status, 200, await r.clone().text());
    const sent = t.calls.sent[0];
    assert.ok(sigOk(sent, wallet.publicKey), "the wallet's signature");
    assert.ok(sigOk(sent, new PublicKey(prep.mint)), "the coin address's signature");
    assert.equal(t.calls.tableLoads.length, 1, 'loaded once, then kept');
  } finally { t.close(); }
});

test('with the table: a wallet may add its own checks, rebuilt through the same table', async () => {
  const table = fakeLaunchTable();
  const t = await start({ launchTable: table });
  const wallet = Keypair.generate();
  try {
    const prep = await prepare(t, wallet);
    const check = SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 });
    const r = await submit(t, prep.mint, walletSigns(prep.tx, wallet, (tx) => withTable(tx, [...decompiled(tx, table), check], table)));
    assert.equal(r.status, 200, await r.clone().text());
  } finally { t.close(); }
});

test('with the table: refused if the wallet swaps in another table, or points the create at another address in ours', async () => {
  const other = Keypair.generate().publicKey;
  const table = fakeLaunchTable([PUMP_GLOBAL, other]);
  const t = await start({ launchTable: table });
  const wallet = Keypair.generate();
  try {
    const prep = await prepare(t, wallet);
    const lookalike = fakeLaunchTable([PUMP_GLOBAL, other]);
    const r1 = await submit(t, prep.mint, walletSigns(prep.tx, wallet, (tx) => withTable(tx, decompiled(tx, table), lookalike)));
    assert.equal(r1.status, 400);
    assert.match((await r1.json()).error, /cannot be checked/);

    const swapped = (tx) => withTable(tx, decompiled(tx, table).map((ix) => (ix.programId.equals(PUMP_PROGRAM)
      ? { ...ix, keys: ix.keys.map((k) => (k.pubkey.equals(PUMP_GLOBAL) ? { ...k, pubkey: other } : k)) } : ix)), table);
    const r2 = await submit(t, prep.mint, walletSigns(prep.tx, wallet, swapped));
    assert.equal(r2.status, 400, 'the altered create no longer matches: it is an addition that uses the coin address');
    assert.match((await r2.json()).error, /uses the coin address/);
    assert.equal(t.calls.sent.length, 0);
  } finally { t.close(); }
});
