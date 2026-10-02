import { createRequire } from 'node:module';
import {
  AddressLookupTableProgram, ComputeBudgetProgram, Keypair, PublicKey, SendTransactionError, SystemProgram, TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import BN from 'bn.js';
import bs58 from 'bs58';
import { createPublicKey, verify as verifyEd25519 } from 'node:crypto';
import { sealSecret, openSecret } from './crypto.js';

// The SDK's ESM build fails to import (@coral-xyz/anchor is CommonJS); its CJS build is fine.
const require = createRequire(import.meta.url);
const { PUMP_SDK, OnlinePumpSdk, getBuyTokenAmountFromSolAmount } = require('@pump-fun/pump-sdk');

export const LAMPORTS_PER_SOL = 1_000_000_000;
const MAX_DEV_BUY_SOL = 50;
const MAX_TX_BYTES = 1232; // Solana's packet limit for one transaction

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
 * ever collect the coin's creator fees — is the Instagram account's vault. `mint` is the coin's
 * address keypair (one from the stock that ends in "pump", src/mintpool.js); without it the coin
 * gets a random address.
 *
 * signMint (default true): the mint signs here, so the only other signer can sign and send this
 * exact message or nothing (the server paying for a comment launch). A website launch passes
 * false: Phantom asks to sign first, so the mint signs after, in cosignLaunch, which checks the
 * wallet changed nothing that matters. The keypair is then returned as mintKey, for the caller to
 * keep (sealed) until the wallet has signed.
 *
 * table: the launch lookup table (loadLaunchTable), or null. pump.fun's fixed accounts are then
 * one byte each instead of 32, which is what lets a launch with a first buy fit in one transaction.
 */
export async function buildLaunchTx(connection, {
  launcher, vault, name, symbol, uri, devBuySol, mint: mintKey, signMint = true, table = null,
}) {
  const online = new OnlinePumpSdk(connection);
  const mint = mintKey ?? Keypair.generate();
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
  }).compileToV0Message(table ? [table] : []);
  const tx = new VersionedTransaction(msg);
  // Its signature slots are already there, so this is the size that goes on the wire. Without the
  // lookup table a launch with a first buy is ~1,270 bytes, over Solana's limit: no wallet could
  // send it, so say so here.
  if (tx.serialize().length > MAX_TX_BYTES) {
    throw new Error(lamports > 0
      ? 'A launch with a first buy is too large for one Solana transaction right now. Set the first buy to 0 and buy on pump.fun after it launches.'
      : 'This launch is too large for one Solana transaction. Try a shorter name.');
  }
  if (signMint) tx.sign([mint]);
  return {
    mint: mint.publicKey.toBase58(), tx: Buffer.from(tx.serialize()).toString('base64'), lastValidBlockHeight,
    ...(signMint ? {} : { mintKey: mint }),
  };
}

/**
 * The addresses for the launch lookup table: every account a launch with a first buy uses whoever
 * launches it and whatever the coin (pump.fun's program, its global and fee accounts, the token
 * programs...), plus each of pump.fun's fee recipients, since a buy picks one of them. Worked out
 * from the SDK (three sample launches with random keys, read only), so it follows pump.fun's
 * current accounts. Anything a later launch uses that is not in the table just stays a full address.
 */
export async function launchTableAddresses(connection) {
  const online = new OnlinePumpSdk(connection);
  const [global, feeConfig] = await Promise.all([online.fetchGlobal(), online.fetchFeeConfig()]);
  const solAmount = new BN(LAMPORTS_PER_SOL / 10);
  const amount = getBuyTokenAmountFromSolAmount({
    global, feeConfig, mintSupply: null, bondingCurve: null, amount: solAmount, quoteMint: PublicKey.default,
  });
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const ixs = await PUMP_SDK.createV2AndBuyInstructions({
      global, mint: Keypair.generate().publicKey, name: 'Sample', symbol: 'SAMPLE', uri: 'https://example.com/x.json',
      creator: Keypair.generate().publicKey, user: Keypair.generate().publicKey, amount, solAmount, mayhemMode: false,
    });
    runs.push(new Set(ixs.flatMap((ix) => ix.keys.map((k) => k.pubkey.toBase58()))));
  }
  const shared = [...runs[0]].filter((k) => runs.every((r) => r.has(k)));
  const fees = [global.feeRecipient, ...(global.feeRecipients ?? [])].filter(Boolean).map((k) => k.toBase58());
  return [...new Set([...shared, ...fees])].map((k) => new PublicKey(k));
}

/** The launch lookup table's account, as launches use it; null if it does not exist (yet). */
export async function loadLaunchTable(connection, address) {
  return (await connection.getAddressLookupTable(new PublicKey(address), { commitment: 'confirmed' })).value;
}

/** The SOL a lookup table holding `count` addresses keeps as rent (56-byte header, 32 per address). */
export async function launchTableRent(connection, count) {
  return BigInt(await connection.getMinimumBalanceForRentExemption(56 + 32 * count));
}

/**
 * Creates the launch lookup table on mainnet, paid by and owned by `payer` (the server's fee
 * payer), and fills it with `addresses`. One transaction for up to 20 addresses, one more per
 * further 20. It costs the rent (launchTableRent, about 0.004 SOL) plus network fees. Returns the
 * table's address and the signatures. A table only works from the slot after it was last filled.
 */
export async function createLaunchTable(connection, { payer, addresses }) {
  const recentSlot = await connection.getSlot('finalized');
  const [create, table] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey, payer: payer.publicKey, recentSlot,
  });
  const chunks = [];
  for (let i = 0; i < addresses.length; i += 20) chunks.push(addresses.slice(i, i + 20));
  const extend = (chunk) => AddressLookupTableProgram.extendLookupTable({
    lookupTable: table, authority: payer.publicKey, payer: payer.publicKey, addresses: chunk,
  });
  const signatures = [await sendAndConfirm(connection, [create, ...(chunks.length ? [extend(chunks[0])] : [])], payer, [payer])];
  for (const chunk of chunks.slice(1)) signatures.push(await sendAndConfirm(connection, [extend(chunk)], payer, [payer]));
  return { table: table.toBase58(), signatures };
}

/**
 * A first buy on its own, for a coin that is already live: the buyer's wallet is the only signer,
 * so the page hands it to the wallet to sign and send itself (Phantom's preferred way, with room
 * for its safety checks). `solAmount` is in SOL; the price is the curve's now, and the buy fails
 * rather than pay more than `slippagePct` above it. Built with the launch lookup table when given.
 */
export async function buildBuyTx(connection, { buyer, mint, solAmount, table = null, slippagePct = 5 }) {
  const lamports = Math.round(Number(solAmount) * LAMPORTS_PER_SOL);
  if (!(lamports > 0 && lamports <= MAX_DEV_BUY_SOL * LAMPORTS_PER_SOL)) throw new Error('bad first buy');
  const { TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');
  const online = new OnlinePumpSdk(connection);
  const user = new PublicKey(buyer);
  const mintKey = new PublicKey(mint);
  const [global, feeConfig, state] = await Promise.all([
    online.fetchGlobal(), online.fetchFeeConfig(), online.fetchBuyState(mintKey, user, TOKEN_2022_PROGRAM_ID),
  ]);
  const solAmountBn = new BN(lamports);
  const amount = getBuyTokenAmountFromSolAmount({
    global, feeConfig, mintSupply: state.bondingCurve.tokenTotalSupply, bondingCurve: state.bondingCurve,
    amount: solAmountBn, quoteMint: state.quoteMint,
  });
  const ixs = await PUMP_SDK.buyInstructions({
    global, bondingCurveAccountInfo: state.bondingCurveAccountInfo, bondingCurve: state.bondingCurve,
    associatedUserAccountInfo: state.associatedUserAccountInfo, mint: mintKey, user, amount, solAmount: solAmountBn,
    slippage: slippagePct, tokenProgram: TOKEN_2022_PROGRAM_ID,
  });
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({
    payerKey: user,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }),
      ...ixs,
    ],
  }).compileToV0Message(table ? [table] : []);
  return { tx: Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64'), lastValidBlockHeight };
}

const COMPUTE_BUDGET = ComputeBudgetProgram.programId.toBase58();
// DER header of an Ed25519 public key; the 32 raw key bytes follow it.
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * A message's instructions with their accounts resolved: static keys, and keys loaded from lookup
 * tables, which must all be in `known` (address → AddressLookupTableAccount). Throws otherwise.
 */
function resolvedInstructions(message, known = new Map()) {
  const tables = message.addressTableLookups.map((l) => {
    const t = known.get(l.accountKey.toBase58());
    if (!t) throw new Error('unknown lookup table');
    return t;
  });
  const all = message.getAccountKeys({ addressLookupTableAccounts: tables });
  const key = (i) => {
    const k = all.get(i);
    if (!k) throw new Error('lookup index out of range');
    return k.toBase58();
  };
  return message.compiledInstructions.map((ix) => ({
    program: key(ix.programIdIndex),
    accounts: ix.accountKeyIndexes.map(key),
    data: Buffer.from(ix.data).toString('base64'),
  }));
}

/** Refused website launch: the sentence is for the launch page. */
export class CosignRefused extends Error {
  get refused() { return true; }
}

/** Sends a fully signed launch; the RPC's refusal comes back as the error. Returns the signature. */
export async function sendLaunch(connection, tx) {
  return connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
}

/**
 * A website launch the launcher's wallet signed first, as Phantom asks (its Lighthouse checks
 * flag a transaction someone else signed before it). Checks what came back against what was
 * prepared, then adds the coin address's signature. Refuses (CosignRefused) when:
 * - the message uses a lookup table other than ours (`tables`, nothing else to check it against),
 *   or is not the launcher's to pay;
 * - the launcher's signature is missing or does not verify;
 * - any signer other than the launcher and the coin address is needed;
 * - the prepared instructions — pump.fun's create with the vault as creator, and any first buy —
 *   are not all there, byte for byte and in order (compute-budget ones may be the wallet's own);
 * - an instruction the wallet added touches the coin address, the only thing our signature allows.
 * Returns the fully signed transaction.
 */
export function cosignLaunch({ prepared, signed, mint, launcher, tables = [] }) {
  let tx;
  try { tx = VersionedTransaction.deserialize(Buffer.from(String(signed), 'base64')); } catch {
    throw new CosignRefused('That is not a signed launch.');
  }
  const msg = tx.message;
  const known = new Map(tables.filter(Boolean).map((t) => [t.key.toBase58(), t]));
  const uncheckable = () => new CosignRefused('The wallet changed the launch in a way that cannot be checked.');
  if (msg.version !== 0) throw uncheckable();
  let got;
  try { got = resolvedInstructions(msg, known); } catch { throw uncheckable(); }
  const keys = msg.staticAccountKeys.map((k) => k.toBase58());
  const mintAddr = mint.publicKey.toBase58();
  if (keys[0] !== launcher) throw new CosignRefused('The launch must be paid by the wallet that prepared it.');
  const signers = keys.slice(0, msg.header.numRequiredSignatures);
  if (!signers.includes(mintAddr) || signers.some((k) => k !== launcher && k !== mintAddr)) {
    throw new CosignRefused('The wallet changed who signs the launch.');
  }
  const pub = createPublicKey({ key: Buffer.concat([ED25519_SPKI, new PublicKey(launcher).toBuffer()]), format: 'der', type: 'spki' });
  if (!verifyEd25519(null, Buffer.from(msg.serialize()), pub, Buffer.from(tx.signatures[0]))) {
    throw new CosignRefused('The wallet did not sign the launch.');
  }

  const want = resolvedInstructions(VersionedTransaction.deserialize(Buffer.from(prepared, 'base64')).message, known)
    .filter((ix) => ix.program !== COMPUTE_BUDGET);
  const same = (a, b) => a.program === b.program && a.data === b.data
    && a.accounts.length === b.accounts.length && a.accounts.every((k, i) => k === b.accounts[i]);
  let next = 0;
  for (const ix of got) {
    if (next < want.length && same(ix, want[next])) { next++; continue; }
    if (ix.program !== COMPUTE_BUDGET && (ix.program === mintAddr || ix.accounts.includes(mintAddr))) {
      throw new CosignRefused('The wallet added something that uses the coin address.');
    }
  }
  if (next !== want.length) throw new CosignRefused('The wallet changed the launch.');
  tx.sign([mint]);
  return tx;
}

/** The coin's metadata uri, from its Token-2022 metadata on chain (pump.fun's create_v2); null if none. */
export async function metadataUri(connection, mint) {
  const { getTokenMetadata, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');
  const md = await getTokenMetadata(connection, new PublicKey(mint), 'confirmed', TOKEN_2022_PROGRAM_ID);
  return md?.uri ?? null;
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
export async function launchPaidByServer(connection, { feePayer, vault, name, symbol, uri, mint, onSigned }) {
  const built = await buildLaunchTx(connection, {
    launcher: feePayer.publicKey.toBase58(), vault, name, symbol, uri, devBuySol: 0, mint,
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
