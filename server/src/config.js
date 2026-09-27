import { readFileSync, existsSync } from 'node:fs';

// Load .env without a dependency; real environment variables win.
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const env = (k, d = '') => process.env[k] ?? d;

export const config = {
  port: Number(env('PORT', '8787')),
  publicUrl: env('PUBLIC_URL', 'http://localhost:8787').replace(/\/$/, ''),
  rpcUrl: env('RPC_URL', 'https://api.mainnet-beta.solana.com'),
  feePayerSecret: env('FEE_PAYER_SECRET'),
  vaultMasterKey: env('VAULT_MASTER_KEY'),
  sessionSecret: env('SESSION_SECRET'),
  platformFeeBps: Number(env('PLATFORM_FEE_BPS', '0')),
  treasury: env('TREASURY_ADDRESS'),
  ig: {
    botUsername: env('IG_BOT_USERNAME', 'instapaid.verify'),
    accessToken: env('IG_ACCESS_TOKEN'),
    appSecret: env('IG_APP_SECRET'),
    verifyToken: env('IG_WEBHOOK_VERIFY_TOKEN'),
    graphVersion: env('IG_GRAPH_VERSION', 'v23.0'),
  },
  // Comment launches ("@bot make a token for this creator"): the Instagram API with Facebook Login.
  igUserId: env('IG_USER_ID'),
  fbAccessToken: env('IG_FB_ACCESS_TOKEN'),
  fbGraphVersion: env('FB_GRAPH_VERSION', 'v23.0'),
  maxServerLaunchesPerDay: Number(env('MAX_SERVER_LAUNCHES_PER_DAY', '20')),
  minFeePayerSol: Number(env('MIN_FEE_PAYER_SOL', '0.1')),
  ipfsUploadUrl: env('IPFS_UPLOAD_URL', 'https://pump.fun/api/ipfs'),
  dbPath: env('DB_PATH', './instapaid.db'),
};

/** Refuse to start with settings that would lose or leak funds. */
export function assertConfig(c = config) {
  const problems = [];
  if (!/^[0-9a-f]{64}$/i.test(c.vaultMasterKey)) problems.push('VAULT_MASTER_KEY must be 64 hex characters');
  if (!/^[0-9a-f]{64}$/i.test(c.sessionSecret)) problems.push('SESSION_SECRET must be 64 hex characters');
  if (!c.feePayerSecret) problems.push('FEE_PAYER_SECRET is required (it pays claim network fees)');
  if (!(c.platformFeeBps >= 0 && c.platformFeeBps <= 5000)) problems.push('PLATFORM_FEE_BPS must be 0..5000');
  if (c.platformFeeBps > 0 && !c.treasury) problems.push('TREASURY_ADDRESS is required when PLATFORM_FEE_BPS > 0');
  if (!c.ig.appSecret) problems.push('IG_APP_SECRET is required (webhook signatures)');
  if (!c.ig.accessToken) problems.push('IG_ACCESS_TOKEN is required (reading who sent a code)');
  if (!c.ig.verifyToken) problems.push('IG_WEBHOOK_VERIFY_TOKEN is required');
  if (c.igUserId && !c.fbAccessToken) problems.push('IG_FB_ACCESS_TOKEN is required when IG_USER_ID is set (comment launches)');
  if (problems.length) throw new Error('Unsafe configuration:\n - ' + problems.join('\n - '));
}
