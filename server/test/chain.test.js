// Builds a real launch transaction against mainnet (read-only: fetches pump.fun's Global and
// fee config, never sends). Skipped when RPC is unreachable. CHAIN_TEST=0 skips it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { buildLaunchTx } from '../src/pump.js';

const rpc = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const conn = new Connection(rpc, 'confirmed');
const reachable = process.env.CHAIN_TEST !== '0' && await conn.getSlot().then(() => true, () => false);

test('launch tx: launcher pays, vault is the creator, mint has signed', { skip: !reachable && 'no RPC' }, async () => {
  const launcher = Keypair.generate().publicKey;
  const vault = Keypair.generate().publicKey;
  for (const devBuySol of [0, 0.1]) {
    const out = await buildLaunchTx(conn, {
      launcher: launcher.toBase58(), vault: vault.toBase58(), name: 'Test', symbol: 'TEST',
      uri: 'https://ipfs.io/ipfs/x', devBuySol,
    });
    const tx = VersionedTransaction.deserialize(Buffer.from(out.tx, 'base64'));
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    assert.equal(keys[0], launcher.toBase58(), 'fee payer is the launcher');
    assert.equal(tx.message.header.numRequiredSignatures, 2, 'launcher + mint');
    const mintIdx = keys.indexOf(out.mint);
    assert.ok(mintIdx > 0 && mintIdx < 2);
    assert.ok(tx.signatures[mintIdx].some((b) => b !== 0), 'mint signed');
    assert.ok(tx.signatures[0].every((b) => b === 0), 'launcher has not signed yet');
    // create_v2 carries the creator pubkey in its data; the vault must be there, the launcher not.
    const pump = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
    const create = tx.message.compiledInstructions.find((ix) => keys[ix.programIdIndex] === pump);
    const data = Buffer.from(create.data);
    assert.ok(data.includes(vault.toBuffer()), 'vault is the creator');
    assert.ok(!data.includes(launcher.toBuffer()), 'launcher is not the creator');
    // Tamper: the mint's signature no longer verifies if anyone changes the message.
    const { default: nacl } = await import('tweetnacl');
    const msg = tx.message.serialize();
    assert.ok(nacl.sign.detached.verify(msg, tx.signatures[mintIdx], tx.message.staticAccountKeys[mintIdx].toBytes()));
    msg[msg.length - 1] ^= 1;
    assert.ok(!nacl.sign.detached.verify(msg, tx.signatures[mintIdx], tx.message.staticAccountKeys[mintIdx].toBytes()));
  }
});

test('claim txs sign with exactly the keys the instructions need', { skip: !reachable && 'no RPC' }, async () => {
  const { createRequire } = await import('node:module');
  const { SystemProgram } = await import('@solana/web3.js');
  const { compileSigned } = await import('../src/pump.js');
  const { OnlinePumpSdk } = createRequire(import.meta.url)('@pump-fun/pump-sdk');
  const vault = Keypair.generate(), feePayer = Keypair.generate();
  const { blockhash } = await conn.getLatestBlockhash();
  const collect = await new OnlinePumpSdk(conn).collectCoinCreatorFeeInstructions(vault.publicKey, feePayer.publicKey);
  assert.throws(() => compileSigned(collect, feePayer, [feePayer, vault], blockhash), /non signer|unknown signer/i);
  const c = compileSigned(collect, feePayer, [feePayer], blockhash);
  assert.equal(c.message.header.numRequiredSignatures, 1);
  const move = [SystemProgram.transfer({ fromPubkey: vault.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })];
  const t = compileSigned(move, feePayer, [feePayer, vault], blockhash);
  assert.equal(t.message.header.numRequiredSignatures, 2);
});

test('server-paid launch: the fee payer pays and signs, the vault is still the creator', { skip: !reachable && 'no RPC' }, async () => {
  const feePayer = Keypair.generate();
  const vault = Keypair.generate().publicKey;
  const out = await buildLaunchTx(conn, {
    launcher: feePayer.publicKey.toBase58(), vault: vault.toBase58(), name: 'T', symbol: 'T', uri: 'https://x', devBuySol: 0,
  });
  const tx = VersionedTransaction.deserialize(Buffer.from(out.tx, 'base64'));
  tx.sign([feePayer]);
  const { default: nacl } = await import('tweetnacl');
  const msg = tx.message.serialize();
  tx.message.staticAccountKeys.slice(0, 2).forEach((k, i) =>
    assert.ok(nacl.sign.detached.verify(msg, tx.signatures[i], k.toBytes()), `signature ${i} valid`));
  assert.equal(tx.message.staticAccountKeys[0].toBase58(), feePayer.publicKey.toBase58());
});
