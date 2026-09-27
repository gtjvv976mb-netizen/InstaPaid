import { createRequire } from 'node:module';
import {
  ComputeBudgetProgram, Keypair, PublicKey, SendTransactionError, SystemProgram, TransactionMessage, VersionedTransaction,
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

/**
 * A launch the server pays for (from a comment): the fee payer is the launcher, the vault is
 * still the creator. `onSigned({mint, signature, lastValidBlockHeight})` runs after the transaction
 * is signed and before it is sent, so the caller can record the launch first: a send whose
 * confirmation fails may still have landed. Returns once the coin is confirmed on-chain; throws
 * LaunchSent when it was sent but not confirmed (ask launchStatus what happened).
 */
export async function launchPaidByServer(connection, { feePayer, vault, name, symbol, uri, onSigned }) {
  const built = await buildLaunchTx(connection, {
    launcher: feePayer.publicKey.toBase58(), vault, name, symbol, uri, devBuySol: 0,
  });
  const tx = VersionedTransaction.deserialize(Buffer.from(built.tx, 'base64'));
  tx.sign([feePayer]); // adds the payer's signature beside the mint's
  const signature = bs58.encode(tx.signatures[0]); // the payer signs first: this is the transaction's id
  const sent = { mint: built.mint, signature, lastValidBlockHeight: built.lastValidBlockHeight };
  await onSigned?.(sent);
  try {
    await connection.sendTransaction(tx, { maxRetries: 3 });
  } catch (e) {
    // The RPC answered and turned it down (a failed simulation, an unknown blockhash): it was not
    // forwarded, so it cannot land. Anything else (a timeout, a dropped connection) may have gone out.
    if (e instanceof SendTransactionError && !/already been processed/i.test(e.message)) throw new Error(`launch refused: ${e.message.split('\n')[0]}`);
    throw new LaunchSent(sent, e);
  }
  let res;
  try {
    res = await connection.confirmTransaction(
      { signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight: built.lastValidBlockHeight }, 'confirmed');
  } catch (e) {
    throw new LaunchSent(sent, e);
  }
  if (res.value.err) throw new Error(`launch ${signature} failed: ${JSON.stringify(res.value.err)}`);
  return { mint: built.mint, signature };
}

/** A launch that was signed and handed to the network, whose outcome is not known yet. */
export class LaunchSent extends Error {
  constructor(sent, cause) {
    super(`launch ${sent.signature} not confirmed: ${cause?.message ?? cause}`);
    this.sent = sent;
  }
}

/**
 * What became of a launch that was sent: 'live' (the coin exists with this vault as creator, or the
 * transaction is confirmed), 'failed' (it failed on-chain, or its blockhash expired without it
 * landing, so it never will), or 'pending' (not known yet, or the RPC could not say).
 */
export async function launchStatus(connection, { mint, vault, signature, lastValidBlockHeight }) {
  if (await confirmLaunch(connection, mint, vault)) return 'live';
  try {
    const st = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value?.[0];
    if (st?.err) return 'failed';
    if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return 'live';
    if (st) return 'pending';
    if (lastValidBlockHeight != null && await connection.getBlockHeight('confirmed') > lastValidBlockHeight) {
      // Expired. One more look for a coin that landed at the last moment.
      return (await confirmLaunch(connection, mint, vault)) ? 'live' : 'failed';
    }
  } catch { /* the RPC could not say */ }
  return 'pending';
}

export async function balanceOf(connection, pubkey) {
  return BigInt(await connection.getBalance(pubkey, 'confirmed'));
}
