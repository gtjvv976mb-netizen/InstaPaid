import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

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
    botUsername: env('IG_BOT_USERNAME', 'instapaid.official'),
    accessToken: env('IG_ACCESS_TOKEN'),
    appSecret: env('IG_APP_SECRET'),
    verifyToken: env('IG_WEBHOOK_VERIFY_TOKEN'),
    graphVersion: env('IG_GRAPH_VERSION', 'v23.0'),
    // Only for staging: a stand-in for graph.instagram.com (DMs, comment launches, the poster).
    // An empty IG_GRAPH_BASE_URL= (as .env.example once had it) counts as unset.
    graphBaseUrl: (env('IG_GRAPH_BASE_URL').trim() || 'https://graph.instagram.com').replace(/\/+$/, ''),
  },
  // Comment launches ("@bot make a token for this creator") run on the Instagram token (Instagram
  // Login) whenever it is set; COMMENT_LAUNCHES=0 switches them off without removing it.
  commentLaunches: env('COMMENT_LAUNCHES', '1') !== '0',
  // Optional, legacy: the Instagram API with Facebook Login instead (a Facebook Page linked to the
  // bot). Used only when both are set.
  igUserId: env('IG_USER_ID'),
  fbAccessToken: env('IG_FB_ACCESS_TOKEN'),
  fbGraphVersion: env('FB_GRAPH_VERSION', 'v23.0'),
  // Only for staging: a stand-in for graph.facebook.com (the Facebook Login path).
  graphBaseUrl: (env('GRAPH_BASE_URL').trim() || 'https://graph.facebook.com').replace(/\/+$/, ''),
  // Optional: the Meta app's secret (App settings → Basic) when it differs from IG_APP_SECRET.
  // Webhooks signed with either are accepted.
  metaAppSecret: env('META_APP_SECRET'),
  maxServerLaunchesPerDay: Number(env('MAX_SERVER_LAUNCHES_PER_DAY', '20')),
  minFeePayerSol: Number(env('MIN_FEE_PAYER_SOL', '0.1')),
  ipfsUploadUrl: env('IPFS_UPLOAD_URL', 'https://pump.fun/api/ipfs'),
  dbPath: env('DB_PATH', './instapaid.db'),
  // The auto-poster: @instapaid.official posts the coins that go live (src/poster.js).
  autoPost: env('AUTO_POST') === '1',
  postMaxPerDay: Number(env('POST_MAX_PER_DAY', '25')),
  postMinGapMin: Number(env('POST_MIN_GAP_MIN', '20')),
  postMaxAgeH: Number(env('POST_MAX_AGE_H', '24')),
  // At most one post per creator in this many days (0 = no limit).
  postCreatorGapDays: Number(env('POST_CREATOR_GAP_DAYS', '30')),
  // Website and extension launches are posted after Claude checks them; 0 never posts them.
  postWebLaunches: env('POST_WEB_LAUNCHES', '1') !== '0',
};
// The cards the poster publishes, served at /posts/<mint>.jpg. Beside the database by default.
config.postsDir = env('POSTS_DIR') ? resolve(env('POSTS_DIR')) : join(dirname(resolve(config.dbPath)), 'posts');

// The Graph API gets our access tokens: https, or plain http only to this machine.
function graphBaseOk(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  } catch { return false; }
}

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
  // IG_USER_ID and IG_FB_ACCESS_TOKEN are optional (the Facebook Login path, used only when both
  // are set): comment launches and the poster run on IG_ACCESS_TOKEN.
  if (c.graphBaseUrl !== undefined && !graphBaseOk(c.graphBaseUrl)) {
    problems.push('GRAPH_BASE_URL must be an https address (or http on localhost); leave it unset for graph.facebook.com');
  }
  if (c.ig?.graphBaseUrl !== undefined && !graphBaseOk(c.ig.graphBaseUrl)) {
    problems.push('IG_GRAPH_BASE_URL must be an https address (or http on localhost); leave it unset for graph.instagram.com');
  }
  for (const k of ['postMaxPerDay', 'postMinGapMin', 'postMaxAgeH', 'postCreatorGapDays']) {
    if (c[k] !== undefined && !(Number.isFinite(c[k]) && c[k] >= 0)) problems.push(`${k.replace(/[A-Z]/g, (m) => '_' + m).toUpperCase()} must be a number ≥ 0`);
  }
  if (problems.length) throw new Error('Unsafe configuration:\n - ' + problems.join('\n - '));
}

/** Settings that are allowed but probably not meant, for the start-up log. */
export function configNotes(c = config) {
  const notes = [];
  if (!!c.igUserId !== !!c.fbAccessToken) {
    notes.push(`${c.igUserId ? 'IG_USER_ID' : 'IG_FB_ACCESS_TOKEN'} is set without ${c.igUserId ? 'IG_FB_ACCESS_TOKEN' : 'IG_USER_ID'}: `
      + 'the Facebook Login path is off, and Instagram Login (IG_ACCESS_TOKEN) is used');
  }
  return notes;
}
