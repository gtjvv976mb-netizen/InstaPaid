import { Connection } from '@solana/web3.js';
import { config, assertConfig, configNotes } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';
import * as pump from './pump.js';
import * as ig from './instagram.js';
import { uploadMetadata } from './metadata.js';
import * as comments from './comments.js';
import { nameCoin } from './lore.js';
import { createPoster } from './poster.js';
import { createTokenKeeper } from './igtoken.js';

assertConfig(config);
for (const note of configNotes(config)) console.warn(`config: ${note}`);
const db = openDb(config.dbPath);
// The Instagram token in use: IG_ACCESS_TOKEN, or the renewal of it stored here (60-day tokens are
// renewed from day 7). Loaded before anything reads config.ig.accessToken.
const igToken = createTokenKeeper({ db, cfg: config, fetchImpl: fetch });
igToken.load();
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
  igToken.start();
  announceInstagram().catch((e) => console.error('instagram: start-up check failed', e));
});

// Who the Instagram token is (the bot's IG_ID, used by comment launches and the poster), whether
// comment launches are on, and the account's webhook subscription (messages; comments too when
// comment launches are on). Log lines only: the server runs either way.
async function announceInstagram() {
  try {
    const me = await ig.igAccount(config.ig);
    console.log(`instagram: @${me.username ?? '?'} id ${me.userId}`);
    if (me.username && me.username !== config.ig.botUsername.toLowerCase()) {
      console.warn(`instagram: the token is @${me.username}, but IG_BOT_USERNAME is ${config.ig.botUsername}: comments must name @${config.ig.botUsername}`);
    }
  } catch (e) {
    console.error(`instagram: could not read the bot account from IG_ACCESS_TOKEN (${e.message})`);
  }
  const off = comments.commentLaunchesOff(config);
  console.log(off ? `comment launches off: ${off}`
    : `comment launches on, via ${config.ig.accessToken ? 'Instagram Login' : 'Facebook Login'}${comments.fbLogin(config) && config.ig.accessToken ? ' (Facebook Login as the fallback)' : ''}`);
  const fields = off ? ['messages'] : ['messages', 'comments'];
  const r = await ig.subscribeMessages(config.ig, fetch, fields);
  console.log(r.ok ? `instagram: webhook subscribed (${fields.join(',')}): ${r.answer || 'no answer body'}`
    : `instagram: webhook not subscribed (${fields.join(',')}): ${r.reason}`);
}

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
