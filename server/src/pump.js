import { createRequire } from 'node:module';
import {
  ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import BN from 'bn.js';
import bs58 from 'bs58';
import { sealSecret, openSecret } from './crypto.js';

// The SDK's ESM build fails to import (@coral-xyz/anchor is CommonJS); its CJS build is fine.
const require = createRequire(import.meta.url);
const { PUMP_SDK, OnlinePumpSdk, getBuyTokenAmountFromSolAmount } = require('@pump-fun/pump-sdk');

export const LAMPORTS_PER_SOL = 1_000_000_000;
const MAX_DEV_BUY_SOL = 50;

export function parseSecretKey(s) {
  s = s.trim();
  return Keypair.fromSecretKey(s.startsWith('[') ? Uint8Array.from(JSON.parse(s)) : bs58.decode(s));
}

const vaultAad = (username) => `vault:${username}`;

/** The vault for an Instagram username, made on first launch. */
export function getOrCreateAccount(db, username, masterKey) {
  const row = db.prepare('select * from account where username = ?').get(username);
  if (row) return row;
  const kp = Keypair.generate();
  db.prepare(
    `insert into account (username, vault_pubkey, vault_secret, created_at) values (?, ?, ?, ?)
     on conflict(username) do nothing`
  ).run(username, kp.publicKey.toBase58(), sealSecret(kp.secretKey, masterKey, vaultAad(username)), Date.now());
  return db.prepare('select * from account where username = ?').get(username);
}

export function vaultKeypair(account, masterKey) {
  return Keypair.fromSecretKey(openSecret(account.vault_secret, masterKey, vaultAad(account.username)));
}

/**
 * Build the launch transaction. The launcher's wallet pays and signs; the creator — who alone can
 * ever collect the coin's creator fees — is the Instagram account's vault. The mint keypair signs
 * here, so the launcher can sign and send this exact message or nothing: changing the creator
 * would break the mint's signature.
 */
export async function buildLaunchTx(connection, { launcher, vault, name, symbol, uri, devBuySol }) {
  const online = new OnlinePumpSdk(connection);
  const mint = Keypair.generate();
  const user = new PublicKey(launcher);
  const creator = new PublicKey(vault);

  let ixs;
  const lamports = Math.round(Number(devBuySol || 0) * LAMPORTS_PER_SOL);
  if (!(lamports >= 0 && lamports <= MAX_DEV_BUY_SOL * LAMPORTS_PER_SOL)) throw new Error('bad dev buy');
  if (lamports > 0) {
    const [global, feeConfig] = await Promise.all([online.fetchGlobal(), online.fetchFeeConfig()]);
    const solAmount = new BN(lamports);
    const amount = getBuyTokenAmountFromSolAmount({
      global, feeConfig, mintSupply: null, bondingCurve: null, amount: solAmount,
      quoteMint: PublicKey.default,
    });
    ixs = await PUMP_SDK.createV2AndBuyInstructions({
      global, mint: mint.publicKey, name, symbol, uri, creator, user, amount, solAmount, mayhemMode: false,
    });
  } else {
    ixs = [await PUMP_SDK.createV2Instruction({
      mint: mint.publicKey, name, symbol, uri, creator, user, mayhemMode: false,
    })];
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({
    payerKey: user,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 350_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }),
      ...ixs,
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([mint]);
  return { mint: mint.publicKey.toBase58(), tx: Buffer.from(tx.serialize()).toString('base64'), lastValidBlockHeight };
}

/** True once the coin exists on-chain with this vault as its creator. */
export async function confirmLaunch(connection, mint, vault) {
  const online = new OnlinePumpSdk(connection);
  try {
    const curve = await online.fetchBondingCurve(new PublicKey(mint));
    return curve.creator.toBase58() === vault;
  } catch {
    return false; // not created (yet)
  }
}

/** Lamports waiting in the vault's pump + PumpSwap creator vaults, plus anything already in the vault wallet. */
export async function pendingFees(connection, vault) {
  const online = new OnlinePumpSdk(connection);
  const pk = new PublicKey(vault);
  const [waiting, held] = await Promise.all([
    online.getCreatorVaultBalanceBothPrograms(pk).then((b) => BigInt(b.toString())).catch(() => 0n),
    connection.getBalance(pk, 'confirmed').then(BigInt),
  ]);
  return waiting + held;
}

export function compileSigned(ixs, payer, signers, blockhash) {
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: ixs })
    .compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign(signers);
  return tx;
}

async function sendAndConfirm(connection, ixs, payer, signers) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = compileSigned(ixs, payer, signers, blockhash);
  const sig = await connection.sendTransaction(tx, { maxRetries: 3 });
  const res = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  if (res.value.err) throw new Error(`transaction ${sig} failed: ${JSON.stringify(res.value.err)}`);
  return sig;
}

/**
 * Pay out one vault: collect its creator fees into the vault wallet, then send the whole
 * balance on (less the platform cut). The server's fee payer pays both network fees, so the
 * vault wallet is emptied exactly and never needs to hold rent.
 */
export async function payOut(connection, { vault, feePayer, destination, platformFeeBps, treasury }) {
  const online = new OnlinePumpSdk(connection);
  let collectSig = null;
  const [waiting, held, rentMin] = await Promise.all([
    online.getCreatorVaultBalanceBothPrograms(vault.publicKey).then((b) => BigInt(b.toString())).catch(() => 0n),
    connection.getBalance(vault.publicKey, 'confirmed').then(BigInt),
    connection.getMinimumBalanceForRentExemption(0).then(BigInt),
  ]);
  // An empty wallet can only be opened with at least rent's worth; below that, wait for more fees.
  if (held === 0n && waiting < rentMin) return { collectSig, transferSig: null, lamports: 0n, platformFee: 0n, tooSmall: waiting > 0n };
  if (waiting > 0n) {
    // Collecting is permissionless on pump.fun: the fees can only go to the creator's own
    // wallet (the vault), so the vault does not sign here — only moving them out needs its key.
    const ixs = await online.collectCoinCreatorFeeInstructions(vault.publicKey, feePayer.publicKey);
    collectSig = await sendAndConfirm(connection, ixs, feePayer, [feePayer]);
  }

  const balance = BigInt(await connection.getBalance(vault.publicKey, 'confirmed'));
  if (balance === 0n) return { collectSig, transferSig: null, lamports: 0n, platformFee: 0n };

  const platformFee = (balance * BigInt(platformFeeBps)) / 10_000n;
  const ixs = [SystemProgram.transfer({
    fromPubkey: vault.publicKey, toPubkey: new PublicKey(destination), lamports: balance - platformFee,
  })];
  if (platformFee > 0n) {
    ixs.push(SystemProgram.transfer({ fromPubkey: vault.publicKey, toPubkey: new PublicKey(treasury), lamports: platformFee }));
  }
  const transferSig = await sendAndConfirm(connection, ixs, feePayer, [feePayer, vault]);
  return { collectSig, transferSig, lamports: balance - platformFee, platformFee };
}
