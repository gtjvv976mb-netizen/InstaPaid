#!/usr/bin/env node
// The launch lookup table: lets a website launch with a first buy fit in one Solana transaction.
//   npm run lookup-table                 what it would hold and cost, or how the saved one stands
//   npm run lookup-table -- --create     make it on mainnet (the fee payer pays about 0.005 SOL), save it
// Run it in Render → the service → Shell. The server picks the table up by itself, no restart.
// It changes no coin and moves no one's money: it only stores pump.fun's fixed addresses on chain.
import { Connection } from '@solana/web3.js';
import { config } from '../src/config.js';
import { openDb, LAUNCH_TABLE_KV } from '../src/db.js';
import {
  parseSecretKey, launchTableAddresses, launchTableRent, loadLaunchTable, createLaunchTable, balanceOf, LAMPORTS_PER_SOL,
} from '../src/pump.js';

const create = process.argv.includes('--create');
const sol = (l) => (Number(l) / LAMPORTS_PER_SOL).toFixed(4);
const db = openDb(config.dbPath);
try {
  const connection = new Connection(config.rpcUrl, 'confirmed');
  const payer = parseSecretKey(config.feePayerSecret);
  const want = await launchTableAddresses(connection);
  const saved = db.prepare('select value from kv where key = ?').get(LAUNCH_TABLE_KV)?.value ?? null;
  const current = saved ? await loadLaunchTable(connection, saved) : null;

  if (current?.isActive()) {
    const have = new Set(current.state.addresses.map((k) => k.toBase58()));
    const missing = want.filter((k) => !have.has(k.toBase58()));
    console.log(`The launch lookup table is ${saved}, with ${have.size} addresses. Launches with a first buy use it.`);
    console.log(missing.length
      ? `pump.fun now uses ${missing.length} address(es) it does not hold. Launches still work, a little larger.`
      : 'It holds every address pump.fun launches use today.');
    console.log(`https://solscan.io/account/${saved}`);
    if (create) console.log('Nothing made: it already exists.');
  } else {
    if (saved) console.log(`The saved table ${saved} is not on chain (closed?). A new one can be made.`);
    const rent = await launchTableRent(connection, want.length);
    const balance = await balanceOf(connection, payer.publicKey);
    console.log(`The table would hold ${want.length} pump.fun addresses. Rent: ${sol(rent)} SOL plus network fees,`);
    console.log(`paid by the fee payer ${payer.publicKey.toBase58()} (balance ${sol(balance)} SOL).`);
    if (!create) {
      console.log('Nothing sent. To make it: npm run lookup-table -- --create');
    } else if (balance < rent + 10_000_000n) {
      console.log('Not made: the fee payer needs at least 0.01 SOL more than the rent.');
      process.exitCode = 1;
    } else {
      const { table, signatures } = await createLaunchTable(connection, { payer, addresses: want });
      db.prepare('insert into kv (key, value) values (?, ?) on conflict(key) do update set value = excluded.value')
        .run(LAUNCH_TABLE_KV, table);
      console.log(`Made the launch lookup table ${table} and saved it. Launches with a first buy work from now on.`);
      for (const s of signatures) console.log(`https://solscan.io/tx/${s}`);
    }
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  db.close();
}
