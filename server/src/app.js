import express from 'express';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { PublicKey } from '@solana/web3.js';
import { normalizeHandle } from './handles.js';
import { metaSignatureOk, newCode, readToken, signToken, safeEqual } from './crypto.js';
import { claimableAccounts, bindAccount } from './identity.js';
import { codeMessages, textMessages, describeEntry } from './instagram.js';
import {
  mentionEvents, isLaunchRequest, launchedReply, existingReply, blockedReply, pendingReply, commentLore, instagramPermalink, welcomeDm,
  commentLaunchesOff, skipMention,
} from './comments.js';
import { loadImage, tokenDescription } from './metadata.js';
import { isBlocked } from './blocks.js';
import { createPoster, MINT_FILE_RE } from './poster.js';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const VERIFY_TTL = 15 * 60_000;
const CLAIM_TTL = 30 * 60_000;
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
 *         pump: {getOrCreateAccount, vaultKeypair, buildLaunchTx, confirmLaunch, pendingFees, payOut, launchPaidByServer,
 *                launchStatus, balanceOf},
 *         ig: {usernameOf, reply}, comments: {readMention, replyToMention}, nameCoin,
 *         uploadMetadata, feePayer, fetchImpl, poster? (src/poster.js; made here when not given) }
 */
export function createApp(deps) {
  const { db, cfg, connection, pump, ig, uploadMetadata, feePayer } = deps;
  const poster = deps.poster ?? createPoster({ db, cfg, fetchImpl: deps.fetchImpl });

  const app = express();
  app.set('trust proxy', process.env.TRUST_PROXY === '1');
  app.disable('x-powered-by');

  const launchLimit = limiter(20, 60 * 60_000);
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
      console.warn(`webhook: rejected, signature ${sig ? 'does not match IG_APP_SECRET or META_APP_SECRET' : 'header missing'}`);
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
    const events = mentionEvents(body);
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

  // Comment launches run one at a time: two comments for the same creator must not make two
  // coins, and the daily budget is counted before each launch.
  let queue = Promise.resolve();
  const enqueue = (job) => {
    queue = queue.then(job).catch((e) => console.error('mention failed', e));
    return queue;
  };
  app.locals.drain = () => queue;

  async function handleMention(ev) {
    const { commentId, mediaId } = ev;
    const fresh = db.prepare(
      `insert into comment_request (comment_id, media_id, status, created_at) values (?, ?, 'working', ?)
       on conflict(comment_id) do nothing`
    ).run(commentId, mediaId, Date.now());
    if (!fresh.changes) return; // a retry of a comment we already handled
    const done = (status, extra = {}) => db.prepare(
      `update comment_request set status = ?, username = ?, mint = ?, note = ? where comment_id = ?`
    ).run(status, extra.username ?? null, extra.mint ?? null, extra.note ?? null, commentId);
    const reply = (message) => deps.comments.replyToMention(cfg, { commentId, mediaId }, message, deps.fetchImpl);

    // A comment on one of our own posts (the poster's) is not a request; nothing to read.
    if (db.prepare('select 1 from post_job where media_id = ?').get(mediaId)) return done('skipped', { note: 'our own post' });

    let mention;
    // No launch and no reply when the post cannot be read: readMention logs each attempt.
    try { mention = await deps.comments.readMention(cfg, ev, deps.fetchImpl); }
    catch (e) { return done('failed', { note: e.message }); }
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

    // Pending launches count against the budget too (their rows are there).
    const today = db.prepare(
      `select count(*) n from token where source = 'comment' and created_at > ?`
    ).get(Date.now() - 24 * 60 * 60_000).n;
    const funds = await pump.balanceOf(connection, feePayer.publicKey).catch(() => 0n);
    if (today >= cfg.maxServerLaunchesPerDay || funds < BigInt(Math.round(cfg.minFeePayerSol * 1e9))) {
      await reply(`Launches are paused for now. Try again later, or launch it yourself at ${cfg.publicUrl.replace(/^https?:\/\//, '')}/launch`);
      return done('failed', { username, note: today >= cfg.maxServerLaunchesPerDay ? 'daily budget' : 'fee payer low' });
    }

    let launched, sent = null, image, photo = false;
    const permalink = instagramPermalink(mention.media.permalink);
    try {
      // Everything about the coin comes from the post: its picture, its caption (for the name and
      // ticker), its link (the coin's website). The fan adds at most a lore, and only if Claude passes it.
      const m = mention.media;
      const imageUrl = m.media_type === 'VIDEO' ? m.thumbnail_url : (m.media_url || m.thumbnail_url);
      // A carousel or a post Meta sends no picture for gets the default coin image.
      const postImage = imageUrl ? await loadImage({ imageUrl }, deps.fetchImpl).catch(() => null) : null;
      image = postImage ?? DEFAULT_IMAGE();
      photo = !!postImage; // the reply says the coin wears the post's photo only when it does
      const coin = await deps.nameCoin({
        username, caption: m.caption, image: postImage ?? undefined, lore: commentLore(mention.text, cfg.ig.botUsername),
      });
      const acct = pump.getOrCreateAccount(db, username, cfg.vaultMasterKey);
      const uri = await uploadMetadata(cfg, {
        name: coin.name, symbol: coin.symbol, username, image,
        description: coin.lore ?? '',
        website: permalink ?? `${cfg.publicUrl}/u/${username}`,
      }, deps.fetchImpl);
      const { mint, signature } = await pump.launchPaidByServer(connection, {
        feePayer, vault: acct.vault_pubkey, name: coin.name, symbol: coin.symbol, uri,
        // Recorded before it is sent: a send whose confirmation is lost may still land, and this row
        // is what stops a second launch for the creator and counts against the day's budget.
        onSigned: (s) => {
          db.prepare(
            `insert into token (mint, username, name, symbol, launcher, lore, source, post_permalink, status, signature, last_valid_height, created_at)
             values (?, ?, ?, ?, ?, ?, 'comment', ?, 'prepared', ?, ?, ?)`
          ).run(s.mint, username, coin.name, coin.symbol, feePayer.publicKey.toBase58(), coin.lore ?? null, permalink,
            s.signature, s.lastValidBlockHeight ?? null, Date.now());
          sent = s;
        },
      });
      db.prepare(`update token set status = 'live', signature = ? where mint = ?`).run(signature, mint);
      launched = { mint, image, symbol: coin.symbol, name: coin.name, lore: coin.lore ?? null };
    } catch (e) {
      console.error('comment launch failed', e);
      // Sent, but its confirmation was lost: find out before telling anyone to try again.
      const outcome = sent && e?.sent ? await settleLaunch(currentRow(sent.mint), { announce: false }) : 'failed';
      if (outcome === 'live') {
        const row = currentRow(sent.mint);
        launched = { mint: row.mint, image, symbol: row.symbol, name: row.name, lore: row.lore };
      } else if (outcome === 'pending') {
        await poster.keepSource(sent.mint, image).catch(() => false); // for the post, if it lands
        await reply(pendingReply({ username, publicUrl: cfg.publicUrl })).catch(() => {});
        return done('launched', { username, mint: sent.mint, note: UNCONFIRMED });
      } else {
        if (sent) dropLaunch(sent.mint);
        await reply('That one didn\'t go through. Try again in a few minutes.').catch(() => {});
        return done('failed', { username, note: String(e.message).slice(0, 300) });
      }
    }
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
    console.log(`welcome: dm answered (${coins.length} coin${coins.length === 1 ? '' : 's'})`);
    await ig.reply(cfg.ig, igsid, welcomeDm({ username, coins, publicUrl: cfg.publicUrl }));
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
      `select t.mint, t.username, t.name, t.symbol, t.lore, t.post_permalink, t.created_at, a.igsid is not null as claimed
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
      `select mint, name, symbol, lore, source, post_permalink, created_at from token where username = ? and status = 'live' order by created_at desc`
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
      const built = await pump.buildLaunchTx(connection, {
        launcher, vault: acct.vault_pubkey, name: cleanName, symbol: cleanSymbol, uri, devBuySol: buy,
      });
      db.prepare(
        `insert into token (mint, username, name, symbol, launcher, status, created_at) values (?, ?, ?, ?, ?, 'prepared', ?)`
      ).run(built.mint, username, cleanName, cleanSymbol, launcher, Date.now());
      // Kept for the poster's card, drawn when the launch is confirmed.
      await poster.keepSource(built.mint, image).catch((e) => console.error('keep picture failed', e.message));
      res.json({ mint: built.mint, tx: built.tx, vault: acct.vault_pubkey });
    } catch (e) {
      console.error('prepare failed', e);
      res.status(400).json({ error: e.message || 'Could not prepare the launch.' });
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
