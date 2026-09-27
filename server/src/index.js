import { Connection } from '@solana/web3.js';
import { config, assertConfig } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';
import * as pump from './pump.js';
import * as ig from './instagram.js';
import { uploadMetadata } from './metadata.js';
import * as comments from './comments.js';
import { nameCoin } from './lore.js';
import { createPoster } from './poster.js';

assertConfig(config);
const db = openDb(config.dbPath);
// @instapaid.official posts the coins that go live (AUTO_POST=1); off otherwise, and says why.
const poster = createPoster({ db, cfg: config, fetchImpl: fetch });
const app = createApp({
  db,
  cfg: config,
  connection: new Connection(config.rpcUrl, 'confirmed'),
  pump,
  ig,
  uploadMetadata,
  comments,
  nameCoin,
  poster,
  feePayer: pump.parseSecretKey(config.feePayerSecret),
  fetchImpl: fetch,
});
app.listen(config.port, () => {
  console.log(`instapaid on :${config.port} (${config.publicUrl})`);
  poster.start();
  ig.subscribeMessages(config.ig).then((r) => console.log(
    r.ok ? 'instagram: messages webhook subscribed for the bot account' : `instagram: messages webhook not subscribed (${r.reason})`));
});

// Comment launches that were sent but not confirmed (a lost confirmation, an RPC timeout): every two
// minutes, ask the chain what became of them. Landed ones go live (the fan is told, the post is
// queued); expired ones are dropped so the creator can have a coin again.
const settle = setInterval(() => app.locals.settlePending().catch((e) => console.error('settle failed', e)), 2 * 60_000);
settle.unref();

// On a deploy the host sends SIGTERM: let a post that is under way finish (up to 20 s) so it is
// recorded here rather than recovered after the restart.
process.once('SIGTERM', async () => {
  await Promise.race([poster.stop(), new Promise((r) => setTimeout(r, 20_000))]);
  process.exit(0);
});
