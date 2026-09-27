import { Connection } from '@solana/web3.js';
import { config, assertConfig } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';
import * as pump from './pump.js';
import * as ig from './instagram.js';
import { uploadMetadata } from './metadata.js';

assertConfig(config);
const app = createApp({
  db: openDb(config.dbPath),
  cfg: config,
  connection: new Connection(config.rpcUrl, 'confirmed'),
  pump,
  ig,
  uploadMetadata,
  feePayer: pump.parseSecretKey(config.feePayerSecret),
  fetchImpl: fetch,
});
app.listen(config.port, () => console.log(`instapaid on :${config.port} (${config.publicUrl})`));
