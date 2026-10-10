import express from 'express';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { Keypair, PublicKey } from '@solana/web3.js';
import { normalizeHandle } from './handles.js';
import { metaSignatureOk, newCode, readToken, signToken, safeEqual, sealSecret, openSecret } from './crypto.js';
import { claimableAccounts, bindAccount } from './identity.js';
import { codeMessages, textMessages, describeEntry } from './instagram.js';
import {
  mentionEvents, isLaunchRequest, launchedReply, existingReply, blockedReply, pendingReply, commentLore, instagramPermalink, welcomeDm,
  commentLaunchesOff, skipMention, commentPayloads, unreadReply,
} from './comments.js';
import { instagramProfile, loadImage, tokenDescription, botDescription } from './metadata.js';
import { isBlocked } from './blocks.js';
import { LAUNCH_TABLE_KV } from './db.js';
import { createPoster, MINT_FILE_RE } from './poster.js';
import { createCoinImages } from './coinimages.js';
import { adminRouter } from './admin.js';
import { bestPost } from './scout.js';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const VERIFY_TTL = 15 * 60_000;
const CLAIM_TTL = 30 * 60_000;
// A prepared website launch waits this long for the wallet's signature; its blockhash lives ~90 s.
const PENDING_TTL = 3 * 60_000;
// A post that shares no picture gets the InstaPaid coin: public/coin-default.png, drawn by
// scripts/make-default-coin.js (npm run default-coin). It becomes the coin's picture on IPFS for good.
const DEFAULT_IMAGE = () => ({ buf: readFileSync(join(here, '..', 'public', 'coin-default.png')), type: 'image/png' });

const isPubkey = (s) => { try { return PublicKey.isOnCurve(new PublicKey(s).toBytes()); } catch { return false; } };

/** Small fixed-window limiter, per key. Enough for one instance; use Redis behind several. */
function limiter(limit, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now(), w = hits.get(key);
    if (!w || w.reset < now) { hits.set(key, { n: 1, reset: now + windowMs }); return true; }
    return ++w.n <= limit;
  };
}

/**
 * deps: { db, cfg, connection,
 *         pump: {getOrCreateAccount, vaultKeypair, buildLaunchTx, cosignLaunch, sendLaunch, confirmLaunch, pendingFees, payOut, launchPaidByServer,
 *                launchStatus, balanceOf},
 *         ig: {usernameOf, reply}, comments: {readMention, replyToMention}, nameCoin,
 *         uploadMetadata, feePayer, fetchImpl, poster? (src/poster.js; made here when not given),
 *         mintPool? (src/mintpool.js: addresses ending in "pump"; without it, random addresses) }
 */
export function createApp(deps) {
  const { db, cfg, connection, pump, ig, uploadMetadata, feePayer } = deps;
  const scout = deps.scout ?? null; // src/scout.js: the launcher bot's shortlist
  const poster = deps.poster ?? createPoster({ db, cfg, fetchImpl: deps.fetchImpl });
  // Each coin's picture on the site: kept at launch, or recovered once from its metadata.
  const coinImages = deps.coinImages ?? createCoinImages({
    dir: cfg.coinsDir, db, fetchImpl: deps.fetchImpl,
    readUri: (mint) => (pump.metadataUri ? pump.metadataUri(connection, mint) : null),
  });
  const keepPicture = (mint, image) => coinImages.save(mint, image)
    .catch((e) => console.error('coin picture not kept', mint, e.message));
  // A coin's address: the next one from the stock ending in "pump", or a random one when it is empty.
  const nextMint = () => deps.mintPool?.take() ?? undefined;
  // The launch lookup table: npm run lookup-table makes it and keeps its address in kv. Without it a
  // website launch with a first buy is too large for one transaction (buildLaunchTx says so).
  // Loaded once and again every 10 minutes; a table that fails to load or was closed is not used.
  let table = { address: null, account: null, at: 0 };
  const launchTable = async () => {
    const address = db.prepare('select value from kv where key = ?').get(LAUNCH_TABLE_KV)?.value ?? null;
    if (!address || !pump.loadLaunchTable) return null;
    if (table.address === address && Date.now() - table.at < 10 * 60_000) return table.account;
    try {
      const account = await pump.loadLaunchTable(connection, address);
      table = { address, account: account?.isActive() ? account : null, at: Date.now() };
    } catch (e) {
      console.error('launch lookup table not loaded', e.message);
      if (table.address !== address) table = { address, account: null, at: 0 };
    }
    return table.account;
  };

  const kvGet = (k) => db.prepare('select value from kv where key = ?').get(k)?.value ?? null;
  const kvSet = (k, v) => db.prepare(
    'insert into kv (key, value) values (?, ?) on conflict(key) do update set value = excluded.value'
  ).run(k, String(v));

  const app = express();
  app.set('trust proxy', process.env.TRUST_PROXY === '1');
  app.disable('x-powered-by');

  const launchLimit = limiter(20, 60 * 60_000);
  const submitLimit = limiter(60, 60 * 60_000);
  const verifyLimit = limiter(20, 60 * 60_000);
  const claimLocks = new Set();

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    // Never framed (clickjacking on the claim and launch pages), no camera, microphone or location.
    res.set('X-Frame-Options', 'DENY');
    res.set('Content-Security-Policy', "frame-ancestors 'none'");
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    // Only over HTTPS (behind the host's proxy that needs TRUST_PROXY=1): a plain-HTTP answer must not pin it.
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });

  // Meta signs the exact bytes, so this route reads the raw body before any JSON parser.
  app.get('/webhooks/instagram', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && safeEqual(req.query['hub.verify_token'] ?? '', cfg.ig.verifyToken)) {
      return res.type('text').send(String(req.query['hub.challenge'] ?? ''));
    }
    res.sendStatus(403);
  });
  app.post('/webhooks/instagram', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    // Signed with the Instagram app secret or, when set, the Meta app's own secret: the two
    // products of one Meta app (Instagram Login, Facebook Login) can sign with either.
    const sig = req.get('x-hub-signature-256');
    if (![cfg.ig.appSecret, cfg.metaAppSecret].some((secret) => secret && metaSignatureOk(req.body, sig, secret))) {
      // Shape only, never the body: a wrong secret in Render is the usual cause.
      // Which secrets are set (never their values), so a missing one is plain in the Logs.
      const set = [cfg.ig.appSecret && 'IG_APP_SECRET', cfg.metaAppSecret && 'META_APP_SECRET'].filter(Boolean).join(' and ') || 'no secret';
      console.warn(`webhook: rejected, signature ${sig ? `does not match ${set} (the only one${set.includes(' and ') ? 's' : ''} set)` : 'header missing'}`);
      return res.sendStatus(401);
    }
    res.sendStatus(200); // answer Meta at once; work after
    let body;
    try { body = JSON.parse(req.body.toString('utf8')); } catch { console.warn('webhook: body is not JSON'); return; }
    const codes = codeMessages(body);
    const entries = Array.isArray(body?.entry) ? body.entry : [];
    const messaging = entries.reduce((n, e) => n + (e.messaging?.length ?? 0), 0);
    const fields = [...new Set(entries.flatMap((e) => (e.changes ?? []).map((c) => c.field)))];
    const entryFields = [...new Set(entries.map((e) => e?.field).filter(Boolean))];
    console.log(`webhook: object=${body?.object} entries=${entries.length} messaging=${messaging} changes=[${fields.join(',')}]`
      + `${entryFields.length ? ` fields=[${entryFields.join(',')}]` : ''} codes=${codes.length}`);
    // The raw shape of each entry (keys, field names, text lengths; never a text or a token), so the
    // first live test shows exactly what Meta sends.
    entries.slice(0, 20).forEach((e, i) => console.log(`webhook: entry ${i + 1}/${entries.length} ${describeEntry(e)}`));
    for (const { igsid, code } of codes) {
      try { await verifyCode(igsid, code); } catch (e) { console.error('verify failed', e.message); }
    }
    // A DM with no code: someone asking what this is. Answer once per hour per sender.
    for (const { igsid } of textMessages(body).filter((m) => !m.code)) {
      try { await welcome(igsid); } catch (e) { console.error('welcome failed', e.message); }
    }
    // Every comment event as Meta sent it, the latest kept for /admin (the owner's eyes only; the
    // log lines keep to its shape): what the first real @mention looks like, or that none came.
    const payloads = commentPayloads(body);
    if (payloads.length) rememberCommentEvents(payloads);
    const events = mentionEvents(body, (why) => console.log(`mention: comment event ignored: ${why}`));
    const off = events.length ? commentLaunchesOff(cfg) : null;
    if (off) console.log(`mention: ${events.length} comment event${events.length === 1 ? '' : 's'} not handled: comment launches are off (${off})`);
    else {
      for (const ev of events) {
        // The bot's own comments (its replies come back), Stories, and comments that do not ask.
        const why = skipMention(ev, cfg.ig.botUsername, [cfg.ig.userId, cfg.igUserId]);
        if (why) { console.log(`mention: comment ${ev.commentId} (${ev.field}) ignored: ${why}`); continue; }
        enqueue(() => handleMention(ev));
      }
    }
  });

  /** kv mention.events counts the comment events received; kv mention.last_event is the latest, for /admin. */
  function rememberCommentEvents(payloads) {
    const last = payloads.at(-1);
    const n = Number(kvGet('mention.events') ?? 0) + payloads.length;
    kvSet('mention.events', n);
    kvSet('mention.last_event', JSON.stringify({
      at: Date.now(), entryId: last.entryId, time: last.time, field: last.field,
      payload: JSON.stringify(last.value, null, 2).slice(0, 4000),
    }));
  }

  // Comment launches run one at a time: two comments for the same creator must not make two
  // coins, and the daily budget is counted before each launch.
  let queue = Promise.resolve();
  const enqueue = (job) => {
    queue = queue.then(job).catch((e) => console.error('mention failed', e));
    return queue;
  };
  app.locals.drain = () => queue;

  /**
   * /admin's "Try again" on a failed comment request (after the owner fixed what stopped it: the
   * fee payer, the Facebook Login fallback, …): the same request, from what the webhook said.
   * → { queued, done } | { error }
   */
  app.locals.retryMention = (commentId) => {
    const row = db.prepare('select * from comment_request where comment_id = ?').get(String(commentId));
    if (!row) return { error: 'No such request.' };
    if (row.status !== 'failed') return { error: 'Only a failed request can be tried again.' };
    const off = commentLaunchesOff(cfg);
    if (off) return { error: `Comment launches are off (${off}).` };
    const ev = {
      field: row.field ?? 'comments', commentId: row.comment_id, mediaId: row.media_id,
      text: row.text ?? undefined, fromUsername: row.from_username ?? null,
    };
    console.log(`mention: comment ${row.comment_id} tried again from /admin`);
    return { queued: true, done: enqueue(() => handleMention(ev, { retry: true })) };
  };

  /**
   * A coin the server pays for, for `username`, named and pictured from one of their posts: a fan's
   * comment asked (handleMention) or the launcher bot chose them (autoLaunch, origin 'bot').
   * Returns { launched, photo } | { pending, mint } (sent, confirmation lost) | { failed, error }.
   */
  async function launchPaid({ username, imageUrl, caption, permalink, lore = null, origin = null, description = '' }) {
    let sent = null, image, photo = false;
    try {
      // Everything about the coin comes from the post: its picture, its caption (for the name and
      // ticker), its link (the coin's website). A fan adds at most a lore, and only if Claude passes it.
      // A carousel or a post with no picture gets the default coin image.
      const postImage = imageUrl ? await loadImage({ imageUrl }, deps.fetchImpl).catch(() => null) : null;
      image = postImage ?? DEFAULT_IMAGE();
      photo = !!postImage; // the reply says the coin wears the post's photo only when it does
      const coin = await deps.nameCoin({ username, caption, image: postImage ?? undefined, lore });
      const acct = pump.getOrCreateAccount(db, username, cfg.vaultMasterKey);
      const uri = await uploadMetadata(cfg, {
        name: coin.name, symbol: coin.symbol, username, image,
        description: coin.lore ?? description,
        website: permalink ?? instagramProfile(username),
      }, deps.fetchImpl);
      const { mint, signature } = await pump.launchPaidByServer(connection, {
        feePayer, vault: acct.vault_pubkey, name: coin.name, symbol: coin.symbol, uri, mint: nextMint(),
        // Recorded before it is sent: a send whose confirmation is lost may still land, and this row
        // is what stops a second launch for the creator and counts against the day's budget.
        onSigned: (x) => {
          db.prepare(
            `insert into token (mint, username, name, symbol, launcher, lore, source, origin, post_permalink, status, signature, last_valid_height, created_at)
             values (?, ?, ?, ?, ?, ?, 'comment', ?, ?, 'prepared', ?, ?, ?)`
          ).run(x.mint, username, coin.name, coin.symbol, feePayer.publicKey.toBase58(), coin.lore ?? null, origin, permalink,
            x.signature, x.lastValidBlockHeight ?? null, Date.now());
          sent = x;
          keepPicture(x.mint, image);
        },
      });
      db.prepare(`update token set status = 'live', signature = ? where mint = ?`).run(signature, mint);
      return { launched: { mint, image, symbol: coin.symbol, name: coin.name, lore: coin.lore ?? null }, photo };
    } catch (e) {
      console.error(`${origin === 'bot' ? 'bot' : 'comment'} launch failed`, e);
      // Sent, but its confirmation was lost: find out before telling anyone to try again.
      const outcome = sent && e?.sent ? await settleLaunch(currentRow(sent.mint), { announce: false }) : 'failed';
      if (outcome === 'live') {
        const row = currentRow(sent.mint);
        return { launched: { mint: row.mint, image, symbol: row.symbol, name: row.name, lore: row.lore }, photo };
      }
      if (outcome === 'pending') {
        await poster.keepSource(sent.mint, image).catch(() => false); // for the post, if it lands
        return { pending: true, mint: sent.mint };
      }
      if (sent) dropLaunch(sent.mint);
      return { failed: true, error: e?.message ?? String(e) };
    }
  }

  /**
   * One comment that asked for a coin. `retry`: the owner asked from /admin to try a failed request
   * again (its row goes back to 'working'; the fan is not told a second time that the post is unreadable).
   */
  async function handleMention(ev, { retry = false } = {}) {
    const { commentId, mediaId } = ev;
    if (retry) {
      const again = db.prepare(
        `update comment_request set status = 'working', note = null where comment_id = ? and status = 'failed'`
      ).run(commentId);
      if (!again.changes) return;
    } else {
      const fresh = db.prepare(
        `insert into comment_request (comment_id, media_id, field, text, from_username, status, created_at)
         values (?, ?, ?, ?, ?, 'working', ?) on conflict(comment_id) do nothing`
      ).run(commentId, mediaId, ev.field ?? null, typeof ev.text === 'string' ? ev.text.slice(0, 2200) : null, ev.fromUsername ?? null, Date.now());
      if (!fresh.changes) return; // a retry of a comment we already handled
    }
    const done = (status, extra = {}) => db.prepare(
      `update comment_request set status = ?, username = ?, mint = ?, note = ? where comment_id = ?`
    ).run(status, extra.username ?? null, extra.mint ?? null, extra.note ?? null, commentId);
    const reply = (message) => deps.comments.replyToMention(cfg, { commentId, mediaId }, message, deps.fetchImpl);

    // A comment on one of our own posts (the poster's) is not a request; nothing to read.
    if (db.prepare('select 1 from post_job where media_id = ?').get(mediaId)) return done('skipped', { note: 'our own post' });

    let mention;
    // No launch when the post cannot be read: readMention logs each attempt. A fan whose comment
    // (as the webhook carried it) asked for a coin is told once, so the request does not vanish.
    try { mention = await deps.comments.readMention(cfg, ev, deps.fetchImpl); }
    catch (e) {
      const asked = typeof ev.text === 'string' && isLaunchRequest(ev.text, cfg.ig.botUsername);
      if (retry || !asked || e.message !== 'could not read the post') return done('failed', { note: e.message });
      const told = await reply(unreadReply({ publicUrl: cfg.publicUrl })).catch(() => false);
      return done('failed', { note: told ? `${e.message}; the fan was told` : e.message });
    }
    if (!isLaunchRequest(mention.text, cfg.ig.botUsername)) return done('skipped', { note: 'not a launch request' });

    const username = normalizeHandle(mention.media.username ?? '');
    if (!username) return done('skipped', { note: 'post owner unknown' });
    if (username === cfg.ig.botUsername.toLowerCase()) return done('skipped', { username, note: 'our own post' });

    // A creator who opted out: launch nothing, and say so once for that creator (not once per post),
    // without an @, so a troll commenting on every post cannot make us notify them again and again.
    if (isBlocked(db, username)) {
      const told = db.prepare(
        `select 1 from comment_request
          where username = ? and note = 'creator opted out' and comment_id != ?
            and created_at >= (select created_at from creator_block where username = ?)
          limit 1`
      ).get(username, commentId, username);
      if (!told) await reply(blockedReply(username)).catch((e) => console.error('reply failed', e));
      return done('skipped', { username, note: 'creator opted out' });
    }

    // One comment-launched coin per creator; later requests point at it. A launch that was sent
    // but is not known to have landed yet counts too: it is looked at again first.
    let existing = currentCoin(username);
    if (existing?.status === 'prepared') {
      const outcome = await settleLaunch(existing);
      if (outcome === 'pending') {
        await reply(pendingReply({ username, publicUrl: cfg.publicUrl })).catch((e) => console.error('reply failed', e));
        return done('existing', { username, mint: existing.mint, note: 'launch still unconfirmed' });
      }
      existing = currentCoin(username);
    }
    if (existing) {
      await reply(existingReply({ username, ...existing, publicUrl: cfg.publicUrl }));
      return done('existing', { username, mint: existing.mint });
    }

    // No coin the fan would never hear about: the reply needs the bot's IG_ID (Instagram Login).
    const noReply = await deps.comments.replyBlocked(cfg, deps.fetchImpl);
    if (noReply) {
      console.error(`mention: comment ${commentId} not launched: no reply could be sent (${noReply})`);
      return done('failed', { username, note: 'bot IG_ID unknown' });
    }

    // Pending launches count against the budget too (their rows are there).
    const today = db.prepare(
      `select count(*) n from token where source = 'comment' and created_at > ?`
    ).get(Date.now() - 24 * 60 * 60_000).n;
    const funds = await pump.balanceOf(connection, feePayer.publicKey).catch(() => 0n);
    if (today >= cfg.maxServerLaunchesPerDay || funds < BigInt(Math.round(cfg.minFeePayerSol * 1e9))) {
      await reply(`Launches are paused for now. Try again later, or launch it yourself at ${cfg.publicUrl.replace(/^https?:\/\//, '')}/launch`);
      return done('failed', { username, note: today >= cfg.maxServerLaunchesPerDay ? 'daily budget' : 'fee payer low' });
    }

    const permalink = instagramPermalink(mention.media.permalink);
    const m = mention.media;
    const out = await launchPaid({
      username, permalink, caption: m.caption, lore: commentLore(mention.text, cfg.ig.botUsername),
      imageUrl: m.media_type === 'VIDEO' ? m.thumbnail_url : (m.media_url || m.thumbnail_url),
    });
    if (out.pending) {
      await reply(pendingReply({ username, publicUrl: cfg.publicUrl })).catch(() => {});
      return done('launched', { username, mint: out.mint, note: UNCONFIRMED });
    }
    if (out.failed) {
      await reply('That one didn\'t go through. Try again in a few minutes.').catch(() => {});
      return done('failed', { username, note: String(out.error).slice(0, 300) });
    }
    const { launched, photo } = out;
    // The coin is live: queue @instapaid.official's post about it (when the poster is on and the
    // creator may be posted about), then tell the fan under their comment; the reply promises the
    // post only when one was queued.
    done('launched', { username, mint: launched.mint });
    const queued = await poster.enqueue(launched.mint, launched.image).catch((e) => { console.error('post enqueue failed', e); return false; });
    await reply(launchedReply({
      username, name: launched.name, symbol: launched.symbol, mint: launched.mint, lore: launched.lore,
      postPermalink: permalink, photo, posted: queued === true, publicUrl: cfg.publicUrl,
    }))
      .catch((e) => console.error('reply failed', e));
  }

  /**
   * The launcher bot: one coin, paid by the server, for the next creator on the owner's watchlist,
   * else the most trending creator on the scout's shortlist. Runs only while the owner has it on in /admin (kv scout.launch = 1, off by default),
   * in the same queue as comment launches, and stops at: SCOUT_MAX_LAUNCHES_PER_DAY bot coins a day,
   * the server's own daily budget (shared with comments), and a fee payer below
   * SCOUT_MIN_FEE_PAYER_SOL (kept above the comment floor, so fans' launches are never starved).
   * Skips anyone who opted out or already has a coin, and reads the profile again first: still
   * public, still trending, a fresh picture link. Its coins and posts say the bot made them.
   */
  const botOn = () => kvGet('scout.launch') === '1';
  app.locals.botLaunching = botOn;
  app.locals.setBotLaunching = (on) => kvSet('scout.launch', on ? '1' : '0');
  app.locals.botLimits = async () => {
    const since = Date.now() - 24 * 60 * 60_000;
    const bot = db.prepare(`select count(*) n from token where origin = 'bot' and created_at > ?`).get(since).n;
    const server = db.prepare(`select count(*) n from token where source = 'comment' and created_at > ?`).get(since).n;
    const funds = await pump.balanceOf(connection, feePayer.publicKey).catch(() => null);
    return {
      botToday: bot, botCap: cfg.scout?.maxPerDay ?? 0, serverToday: server, serverCap: cfg.maxServerLaunchesPerDay,
      feePayerSol: funds == null ? null : Number(funds) / 1e9,
      floorSol: Math.max(cfg.scout?.minSol ?? 0, cfg.minFeePayerSol), minScore: cfg.scout?.minScore ?? 0,
    };
  };
  app.locals.autoLaunch = () => enqueue(async () => {
    if (!scout || !botOn()) return { outcome: 'off' };
    const lim = await app.locals.botLimits();
    if (lim.botToday >= lim.botCap) return { outcome: 'daily cap' };
    if (lim.serverToday >= lim.serverCap) return { outcome: 'server budget' };
    if (lim.feePayerSol == null || lim.feePayerSol < lim.floorSol) return { outcome: 'fee payer low' };
    // The owner's watchlist first: picked by hand, so no score is needed. The coin is named and
    // pictured from the post the owner linked (or the creator's most engaged one) when the profile
    // can be read; when it cannot, only a creator the owner linked a post for is launched, with the
    // default picture and that post as its link (an unreadable name alone could be a typo).
    for (const w of scout.watched({ limit: 5 })) {
      if (isBlocked(db, w.username) || currentCoin(w.username)) continue;
      db.prepare('update bot_watch set attempts = attempts + 1 where username = ?').run(w.username);
      const note = (n) => db.prepare('update bot_watch set note = ? where username = ?').run(String(n).slice(0, 200), w.username);
      let p = null;
      try {
        p = await scout.readProfile(w.username);
      } catch (e) {
        if (e.missing) { note(`no such account (${e.message})`); continue; }
        if (!w.post_url) { note(`profile not readable (${e.message}); add a link to one of their posts to launch anyway`); continue; }
        console.log(`bot: @${w.username}'s profile not readable (${e.message}); launching from the post the owner linked`);
      }
      if (p?.isPrivate) { note('private account'); continue; }
      const post = p ? bestPost(p, w.post_url) : null;
      const out = await launchPaid({
        username: w.username, imageUrl: post?.imageUrl, caption: post?.caption, origin: 'bot',
        permalink: post ? `https://www.instagram.com/p/${encodeURIComponent(post.shortcode)}/` : w.post_url,
        description: botDescription(w.username, cfg.publicUrl, { trending: false }),
      });
      if (out.failed) {
        note(out.error);
        console.error(`bot: @${w.username} (watchlist) not launched: ${out.error}`);
        return { outcome: 'failed', username: w.username, error: out.error };
      }
      const mint = out.pending ? out.mint : out.launched.mint;
      db.prepare('update bot_watch set launched_mint = ?, launched_at = ?, note = null where username = ?').run(mint, Date.now(), w.username);
      if (out.launched) await poster.enqueue(mint, out.launched.image).catch((e) => console.error('post enqueue failed', e));
      console.log(`bot: launched $${out.launched?.symbol ?? '?'} for @${w.username} (watchlist, ${p ? `profile via ${p.via}` : 'no profile read'})${out.pending ? ', not confirmed yet' : ''}`);
      return { outcome: out.pending ? 'pending' : 'launched', username: w.username, mint, from: 'watchlist' };
    }
    for (const c of scout.candidates({ limit: 5 })) {
      if (c.score < lim.minScore) break;
      if (isBlocked(db, c.username) || currentCoin(c.username)) continue;
      const fresh = await scout.refresh(c.username);
      if (fresh.outcome === 'slowed') return { outcome: 'instagram asked to slow down' };
      const row = db.prepare('select * from scout_profile where username = ?').get(c.username);
      if (row.status !== 'ok' || row.score < lim.minScore || !row.top_shortcode) continue;
      db.prepare('update scout_profile set attempts = attempts + 1 where username = ?').run(c.username);
      const username = row.username;
      const out = await launchPaid({
        username, imageUrl: row.top_image, caption: row.top_caption, origin: 'bot',
        permalink: `https://www.instagram.com/p/${encodeURIComponent(row.top_shortcode)}/`,
        description: botDescription(username, cfg.publicUrl),
      });
      if (out.failed) {
        db.prepare('update scout_profile set note = ? where username = ?').run(String(out.error).slice(0, 200), username);
        console.error(`bot: @${username} not launched: ${out.error}`);
        return { outcome: 'failed', username, error: out.error };
      }
      const mint = out.pending ? out.mint : out.launched.mint;
      db.prepare('update scout_profile set launched_mint = ?, launched_at = ?, note = null where username = ?').run(mint, Date.now(), username);
      if (out.launched) await poster.enqueue(mint, out.launched.image).catch((e) => console.error('post enqueue failed', e));
      console.log(`bot: launched $${out.launched?.symbol ?? '?'} for @${username} (score ${row.score})${out.pending ? ', not confirmed yet' : ''}`);
      return { outcome: out.pending ? 'pending' : 'launched', username, mint };
    }
    return { outcome: 'no candidate' };
  });

  const UNCONFIRMED = 'sent, not confirmed yet';
  const currentRow = (mint) => db.prepare('select * from token where mint = ?').get(mint);
  /** The creator's coin: a live one first, else a comment launch still waiting for confirmation. */
  const currentCoin = (username) => db.prepare(
    `select * from token where username = ? and (status = 'live' or (source = 'comment' and status = 'prepared'))
      order by status = 'live' desc, created_at limit 1`
  ).get(username);
  const dropLaunch = (mint) => db.prepare(
    `delete from token where mint = ? and source = 'comment' and status = 'prepared'
       and not exists (select 1 from post_job where post_job.mint = token.mint)`
  ).run(mint);

  /**
   * Ask the chain what became of a comment launch that was sent but not confirmed: 'live' (marked
   * live and, with `announce`, the fan told and the post queued), 'failed' (the row goes, so the
   * creator can have a coin again) or 'pending' (left as it is).
   */
  async function settleLaunch(t, { announce = true } = {}) {
    if (!t || t.status !== 'prepared' || t.source !== 'comment') return t ? 'live' : 'failed';
    const acct = db.prepare('select vault_pubkey from account where username = ?').get(t.username);
    const outcome = await pump.launchStatus(connection, {
      mint: t.mint, vault: acct?.vault_pubkey, signature: t.signature, lastValidBlockHeight: t.last_valid_height,
    }).catch(() => 'pending');
    if (outcome === 'failed') dropLaunch(t.mint);
    if (outcome !== 'live') return outcome;
    const r = db.prepare(`update token set status = 'live' where mint = ? and status = 'prepared'`).run(t.mint);
    if (r.changes && announce) {
      // The fan who asked was told it was on its way; now tell them it is live.
      const asked = db.prepare(`select comment_id, media_id from comment_request where mint = ? and note = ?`).get(t.mint, UNCONFIRMED);
      // Queued first, so the reply promises a post only when there will be one. Which picture the
      // coin wears is not recorded, so this reply does not claim the post's photo.
      const queued = await poster.enqueue(t.mint).catch((e) => { console.error('post enqueue failed', e); return false; });
      if (asked) {
        db.prepare(`update comment_request set note = null where comment_id = ?`).run(asked.comment_id);
        await deps.comments.replyToMention(cfg, { commentId: asked.comment_id, mediaId: asked.media_id },
          launchedReply({
            username: t.username, name: t.name, symbol: t.symbol, mint: t.mint, lore: t.lore,
            postPermalink: t.post_permalink, posted: queued === true, publicUrl: cfg.publicUrl,
          }), deps.fetchImpl)
          .catch((e) => console.error('reply failed', e));
      }
    }
    return 'live';
  }

  /** Every comment launch still waiting for confirmation, looked at again (index.js runs this every few minutes). */
  app.locals.settlePending = () => enqueue(async () => {
    const rows = db.prepare(`select * from token where source = 'comment' and status = 'prepared' order by created_at`).all();
    const out = {};
    for (const t of rows) out[t.mint] = await settleLaunch(t);
    return out;
  });

  const welcomed = new Map(); // igsid → when we last answered a code-less DM
  async function welcome(igsid) {
    const last = welcomed.get(igsid) ?? 0;
    if (Date.now() - last < 60 * 60_000) return;
    welcomed.set(igsid, Date.now());
    if (welcomed.size > 5000) welcomed.delete(welcomed.keys().next().value);
    const username = await ig.usernameOf(cfg.ig, igsid).catch(() => null);
    const accounts = username ? claimableAccounts(db, { igsid, username }) : [];
    const coins = [];
    for (const a of accounts) {
      const pending = await pump.pendingFees(connection, a.vault_pubkey).catch(() => 0n);
      for (const t of db.prepare(`select name, symbol from token where username = ? and status = 'live'`).all(a.username)) {
        coins.push({ name: t.name, symbol: t.symbol, pendingLamports: coins.length ? 0n : pending });
      }
    }
    const sent = await ig.reply(cfg.ig, igsid, welcomeDm({ username, coins, publicUrl: cfg.publicUrl }));
    if (sent === false) { welcomed.delete(igsid); return; } // not sent: the next DM may try again
    console.log(`welcome: dm answered (${coins.length} coin${coins.length === 1 ? '' : 's'})`);
  }

  async function verifyCode(igsid, code) {
    const v = db.prepare(`select * from verification where code = ? and status = 'pending'`).get(code);
    if (!v) { console.log('verify: code not found or already used'); return; }
    if (v.expires_at < Date.now()) {
      console.log('verify: code expired');
      db.prepare(`update verification set status = 'expired' where id = ?`).run(v.id);
      return ig.reply(cfg.ig, igsid, '⏰ That code has expired (they last 15 minutes). Open the claim page again for a fresh one and DM it to me: it takes seconds.');
    }
    const username = await ig.usernameOf(cfg.ig, igsid);
    const r = db.prepare(
      `update verification set status = 'verified', igsid = ?, username = ? where id = ? and status = 'pending'`
    ).run(igsid, username, v.id);
    if (r.changes) {
      console.log(`verify: verified @${username}`);
      await ig.reply(cfg.ig, igsid, `✅ Verified as @${username}! Head back to the claim page, paste the Solana wallet you want the fees in, and tap Send my fees. We never ask for a password or seed phrase.`);
    }
  }

  // For the host's health check: the process is up and the database answers.
  app.get('/healthz', (req, res) => {
    try {
      db.prepare('select 1').get();
      res.set('Cache-Control', 'no-store').json({ ok: true });
    } catch {
      res.status(503).set('Cache-Control', 'no-store').json({ ok: false });
    }
  });

  // The poster's cards. Instagram fetches them from here when it makes the post, so they are public;
  // only <mint>.jpg names, straight from POSTS_DIR.
  app.get('/posts/:file', (req, res) => {
    const file = req.params.file;
    if (!cfg.postsDir || !MINT_FILE_RE.test(file)) return res.sendStatus(404);
    res.sendFile(file, {
      root: cfg.postsDir, dotfiles: 'deny', headers: { 'Cache-Control': 'public, max-age=86400' },
    }, (err) => { if (err && !res.headersSent) res.sendStatus(404); });
  });

  app.get('/coins/:file', async (req, res) => {
    const m = String(req.params.file).match(/^([1-9A-HJ-NP-Za-km-z]{32,44})\.webp$/);
    const file = m && await coinImages.get(m[1]).catch(() => null);
    if (!file) return res.set('Cache-Control', 'public, max-age=300').sendStatus(404);
    res.sendFile(file, { dotfiles: 'deny', headers: { 'Cache-Control': 'public, max-age=86400' } },
      (err) => { if (err && !res.headersSent) res.sendStatus(404); });
  });

  app.use('/api', express.json({ limit: '6mb' }));
  app.use('/api/accounts', (req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); next(); });

  // platformFeeBps lets the claim page show any platform share before anything is sent.
  app.get('/api/config', (req, res) => res.json({
    botUsername: cfg.ig.botUsername, publicUrl: cfg.publicUrl, platformFeeBps: cfg.platformFeeBps || 0,
  }));

  // Public: the newest live coins, for the home page's "Recently launched" strip. No prices;
  // `claimed` says whether the creator has verified and bound their vault (what /u/<name> shows).
  app.get('/api/recent', (req, res) => {
    const rows = db.prepare(
      `select t.mint, t.username, t.name, t.symbol, t.lore, t.post_permalink, t.created_at, t.origin, a.igsid is not null as claimed
         from token t join account a using (username)
        where t.status = 'live'
        order by t.created_at desc, t.rowid desc
        limit 12`
    ).all();
    res.set('Cache-Control', 'public, max-age=15');
    res.json({ tokens: rows.map((r) => ({ ...r, claimed: !!r.claimed })) });
  });

  // Public: what an Instagram account has waiting. The extension shows this on profiles.
  app.get('/api/accounts/:username', async (req, res) => {
    const username = normalizeHandle(req.params.username);
    if (!username) return res.status(400).json({ error: 'Not an Instagram username.' });
    const acct = db.prepare('select * from account where username = ?').get(username);
    if (!acct) return res.json({ username, tokens: [], pendingLamports: '0', verified: false });
    const tokens = db.prepare(
      `select mint, name, symbol, lore, source, origin, post_permalink, created_at from token where username = ? and status = 'live' order by created_at desc`
    ).all(username);
    const pending = await pump.pendingFees(connection, acct.vault_pubkey).catch(() => 0n);
    res.json({
      username, vault: acct.vault_pubkey, tokens, pendingLamports: pending.toString(), verified: !!acct.igsid,
    });
  });

  app.post('/api/launch/prepare', async (req, res) => {
    if (!launchLimit(req.ip)) return res.status(429).json({ error: 'Too many launches from here. Try again in an hour.' });
    const { username: u, name, symbol, description, imageUrl, imageBase64, devBuySol, launcher } = req.body ?? {};
    const username = normalizeHandle(u);
    const cleanName = String(name ?? '').trim();
    const cleanSymbol = String(symbol ?? '').trim().toUpperCase();
    if (!username) return res.status(400).json({ error: 'Enter a real Instagram username.' });
    if (isBlocked(db, username)) return res.status(403).json({ error: `@${username} has asked not to have coins made for them.` });
    if (!cleanName || cleanName.length > 32) return res.status(400).json({ error: 'Name is 1–32 characters.' });
    if (!/^[A-Z0-9]{1,10}$/.test(cleanSymbol)) return res.status(400).json({ error: 'Ticker is 1–10 letters or digits.' });
    if (!isPubkey(launcher)) return res.status(400).json({ error: 'Connect a Solana wallet first.' });
    const buy = Number(devBuySol ?? 0);
    if (!(buy >= 0 && buy <= 50)) return res.status(400).json({ error: 'First buy is 0–50 SOL.' });

    try {
      const image = await loadImage({ imageUrl, imageBase64 }, deps.fetchImpl);
      const acct = pump.getOrCreateAccount(db, username, cfg.vaultMasterKey);
      const uri = await uploadMetadata(cfg, {
        name: cleanName, symbol: cleanSymbol, username, image,
        description: tokenDescription(username, description, cfg.publicUrl),
      }, deps.fetchImpl);
      // Unsigned: the launcher's wallet signs first (Phantom's order), then /api/launch/submit adds
      // the coin address's signature. Its key waits here, sealed, for as long as the blockhash lives.
      // The launch never carries the first buy: that is its own transaction once the coin is live
      // (/api/launch/buy), so each leaves Phantom room for its safety checks.
      const built = await pump.buildLaunchTx(connection, {
        launcher, vault: acct.vault_pubkey, name: cleanName, symbol: cleanSymbol, uri, devBuySol: 0, mint: nextMint(),
        signMint: false, table: await launchTable(),
      });
      const now = Date.now();
      db.prepare('delete from launch_pending where expires_at < ?').run(now);
      db.prepare('insert into launch_pending (mint, secret, tx, launcher, expires_at) values (?, ?, ?, ?, ?)')
        .run(built.mint, sealSecret(built.mintKey.secretKey, cfg.vaultMasterKey, `launch:${built.mint}`), built.tx, launcher, now + PENDING_TTL);
      db.prepare(
        `insert into token (mint, username, name, symbol, launcher, status, created_at) values (?, ?, ?, ?, ?, 'prepared', ?)`
      ).run(built.mint, username, cleanName, cleanSymbol, launcher, now);
      // Kept for the poster's card, drawn when the launch is confirmed.
      await poster.keepSource(built.mint, image).catch((e) => console.error('keep picture failed', e.message));
      await keepPicture(built.mint, image);
      res.json({ mint: built.mint, tx: built.tx, vault: acct.vault_pubkey });
    } catch (e) {
      console.error('prepare failed', e);
      res.status(400).json({ error: e.message || 'Could not prepare the launch.' });
    }
  });

  // The launcher's wallet signed the prepared launch: check it, add the coin address's signature
  // (pump.cosignLaunch says what is refused), and send it. The key is used once, then deleted.
  app.post('/api/launch/submit', async (req, res) => {
    if (!submitLimit(req.ip)) return res.status(429).json({ error: 'Too many tries from here. Try again in an hour.' });
    const { mint, tx } = req.body ?? {};
    const p = typeof mint === 'string' && db.prepare('select * from launch_pending where mint = ?').get(mint);
    if (!p || p.expires_at < Date.now()) return res.status(410).json({ error: 'This launch expired before it was signed. Press Launch again.' });
    if (typeof tx !== 'string' || tx.length > 4000) return res.status(400).json({ error: 'That is not a signed launch.' });
    let signed;
    try {
      const key = Keypair.fromSecretKey(openSecret(p.secret, cfg.vaultMasterKey, `launch:${mint}`));
      signed = pump.cosignLaunch({ prepared: p.tx, signed: tx, mint: key, launcher: p.launcher, tables: [await launchTable()] });
    } catch (e) {
      if (e?.refused) return res.status(400).json({ error: e.message });
      console.error('cosign failed', mint, e);
      return res.status(500).json({ error: 'Could not add the coin address signature. Press Launch again.' });
    }
    try {
      const signature = await pump.sendLaunch(connection, signed);
      db.prepare('delete from launch_pending where mint = ?').run(mint);
      res.json({ signature });
    } catch (e) {
      console.error('launch send failed', mint, e.message);
      res.status(400).json({ error: `Solana did not accept the launch: ${String(e.message || e).split('\n')[0]}` });
    }
  });

  // The launcher's first buy, once their coin is live: a transaction only their wallet signs, which
  // the page hands to the wallet to sign and send. Only for the wallet that launched the coin here.
  app.post('/api/launch/buy', async (req, res) => {
    if (!submitLimit(req.ip)) return res.status(429).json({ error: 'Too many tries from here. Try again in an hour.' });
    const { mint, launcher, solAmount } = req.body ?? {};
    const sol = Number(solAmount);
    if (!(sol > 0 && sol <= 50)) return res.status(400).json({ error: 'First buy is 0–50 SOL.' });
    const t = typeof mint === 'string' && db.prepare(`select status, launcher from token where mint = ? and source = 'web'`).get(mint);
    if (!t) return res.status(404).json({ error: 'Unknown launch.' });
    if (!isPubkey(launcher) || t.launcher !== launcher) return res.status(403).json({ error: 'Only the wallet that launched this coin can make its first buy here.' });
    if (t.status !== 'live') return res.status(409).json({ error: 'The coin is not live yet.' });
    try {
      const built = await pump.buildBuyTx(connection, { buyer: launcher, mint, solAmount: sol, table: await launchTable() });
      res.json({ tx: built.tx });
    } catch (e) {
      console.error('first buy failed', mint, e.message);
      res.status(400).json({ error: 'Could not prepare the first buy. Buy on pump.fun instead.' });
    }
  });

  app.post('/api/launch/confirm', async (req, res) => {
    const { mint, signature } = req.body ?? {};
    const t = typeof mint === 'string'
      && db.prepare(`select t.*, a.vault_pubkey from token t join account a using (username) where mint = ? and t.source = 'web'`).get(mint);
    if (!t) return res.status(404).json({ error: 'Unknown launch.' });
    if (t.status === 'live') return res.json({ ok: true, username: t.username });
    const ok = await pump.confirmLaunch(connection, mint, t.vault_pubkey);
    if (!ok) return res.status(409).json({ error: 'Not on-chain yet. Try again in a few seconds.' });
    const r = db.prepare(`update token set status = 'live', signature = ? where mint = ? and status = 'prepared'`)
      .run(typeof signature === 'string' ? signature.slice(0, 100) : null, mint);
    res.json({ ok: true, username: t.username });
    // After the answer: a website launch is checked by Claude before its post is queued.
    if (r.changes) poster.enqueue(mint).catch((e) => console.error('post enqueue failed', e));
  });

  app.post('/api/verify/start', (req, res) => {
    if (!verifyLimit(req.ip)) return res.status(429).json({ error: 'Too many tries. Wait an hour.' });
    const id = randomBytes(24).toString('base64url');
    const code = newCode();
    const now = Date.now();
    db.prepare(`insert into verification (id, code, status, created_at, expires_at) values (?, ?, 'pending', ?, ?)`)
      .run(id, code, now, now + VERIFY_TTL);
    res.json({ id, code, botUsername: cfg.ig.botUsername, expiresAt: now + VERIFY_TTL });
  });

  app.get('/api/verify/:id', async (req, res) => {
    const v = db.prepare('select * from verification where id = ?').get(req.params.id);
    if (!v) return res.status(404).json({ error: 'Unknown verification.' });
    if (v.status === 'pending' && v.expires_at < Date.now()) return res.json({ status: 'expired' });
    if (v.status !== 'verified') return res.json({ status: v.status });
    // One verification is good for a claim window, not forever: stop issuing tokens after it.
    const exp = v.expires_at + CLAIM_TTL;
    if (exp < Date.now()) return res.json({ status: 'expired' });
    const accounts = claimableAccounts(db, v);
    const withFees = await Promise.all(accounts.map(async (a) => ({
      username: a.username,
      pendingLamports: (await pump.pendingFees(connection, a.vault_pubkey).catch(() => 0n)).toString(),
    })));
    const claimToken = signToken({ igsid: v.igsid, username: v.username, exp }, cfg.sessionSecret);
    res.json({ status: 'verified', username: v.username, accounts: withFees, claimToken });
  });

  app.post('/api/claim', async (req, res) => {
    const who = readToken(req.body?.claimToken, cfg.sessionSecret);
    if (!who) return res.status(401).json({ error: 'Your verification ran out. Verify again.' });
    const destination = req.body?.destination;
    if (!isPubkey(destination)) return res.status(400).json({ error: 'Enter a Solana wallet address.' });

    const results = [];
    for (const acct of claimableAccounts(db, who)) {
      if (claimLocks.has(acct.username)) { results.push({ username: acct.username, error: 'A claim is already running.' }); continue; }
      claimLocks.add(acct.username);
      try {
        if (!bindAccount(db, acct.username, who.igsid)) { results.push({ username: acct.username, error: 'Held by another account.' }); continue; }
        const vault = pump.vaultKeypair(acct, cfg.vaultMasterKey);
        const out = await pump.payOut(connection, {
          vault, feePayer, destination, platformFeeBps: cfg.platformFeeBps, treasury: cfg.treasury,
        });
        if (out.lamports > 0n || out.collectSig) {
          db.prepare(
            `insert into claim (username, igsid, destination, lamports, platform_fee, collect_sig, transfer_sig, created_at)
             values (?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(acct.username, who.igsid, destination, Number(out.lamports), Number(out.platformFee), out.collectSig, out.transferSig, Date.now());
        }
        results.push(out.tooSmall
          ? { username: acct.username, error: 'Under 0.001 SOL so far. Claim again when more has built up.' }
          : { username: acct.username, lamports: out.lamports.toString(), signature: out.transferSig });
      } catch (e) {
        console.error('claim failed', acct.username, e);
        results.push({ username: acct.username, error: 'The payout did not go through. Nothing was lost; try again.' });
      } finally {
        claimLocks.delete(acct.username);
      }
    }
    if (!results.length) return res.status(404).json({ error: `No tokens have been launched for @${who.username} yet.` });
    res.json({ results });
  });

  // Pages
  const pub = join(here, '..', 'public');
  const noCacheHtml = (res, file) => { if (file.endsWith('.html')) res.set('Cache-Control', 'no-cache'); };
  const notFound = (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found.' });
    res.status(404).set('Cache-Control', 'no-cache').sendFile(join(pub, '404.html'));
  };
  // A real page with a trailing slash (/launch/, /u/name/) → the page (301). Only known pages, so
  // "//other.site/" can never become a redirect to another host.
  const pages = new Set(readdirSync(pub).filter((f) => f.endsWith('.html') && f !== '404.html' && f !== 'index.html' && f !== 'account.html')
    .map((f) => '/' + f.slice(0, -5)));
  app.use((req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || req.path === '/' || !req.path.endsWith('/')) return next();
    const bare = req.path.replace(/\/+$/, '');
    if (!pages.has(bare) && !/^\/u\/[^/]+$/.test(bare)) return next();
    const q = req.originalUrl.indexOf('?');
    res.redirect(301, bare + (q >= 0 ? req.originalUrl.slice(q) : ''));
  });
  app.get(['/404', '/404.html'], notFound);
  // The owner's page (src/admin.js): before the static files, so /admin is always the checked route.
  app.get('/admin.html', (req, res) => res.redirect(301, '/admin'));
  app.use(adminRouter({ db, cfg, fetchImpl: deps.fetchImpl ?? fetch, pub, locals: app.locals, bot: scout ? { scout, locals: app.locals } : null }));

  const web3Iife = require.resolve('@solana/web3.js/lib/index.iife.min.js');
  app.get('/vendor/web3.js', (req, res) => res.sendFile(web3Iife, { maxAge: '1d' }));
  // Media and vendor files keep their names when they change: a day for media; the 3D engine is
  // asked for with ?v=<its hash> (mascot.js), so it can be kept for 30 days. HTML is always revalidated.
  app.use('/media', express.static(join(pub, 'media'), { maxAge: '1d', fallthrough: true }));
  app.use('/vendor', express.static(join(pub, 'vendor'), { maxAge: '30d', fallthrough: true }));
  app.use(express.static(pub, { extensions: ['html'], setHeaders: noCacheHtml }));
  app.get('/u/:username', (req, res) => res.set('Cache-Control', 'no-cache').sendFile(join(pub, 'account.html')));
  // The "See a creator's page" form without JavaScript: /u?u=name → /u/name.
  app.get('/u', (req, res) => {
    const u = normalizeHandle(String(req.query.u ?? ''));
    res.redirect(302, u ? `/u/${encodeURIComponent(u)}` : '/#creators');
  });
  app.use(notFound);

  return app;
}
