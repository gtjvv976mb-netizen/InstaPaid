import express from 'express';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { PublicKey } from '@solana/web3.js';
import { normalizeHandle } from './handles.js';
import { metaSignatureOk, newCode, readToken, signToken, safeEqual } from './crypto.js';
import { claimableAccounts, bindAccount } from './identity.js';
import { codeMessages } from './instagram.js';
import { mentionEvents, isLaunchRequest, launchedReply, existingReply } from './comments.js';
import { loadImage, tokenDescription } from './metadata.js';

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
 *         pump: {getOrCreateAccount, vaultKeypair, buildLaunchTx, confirmLaunch, pendingFees, payOut, launchPaidByServer, balanceOf},
 *         ig: {usernameOf, reply}, comments: {readMention, replyToMention}, writeCoin,
 *         uploadMetadata, feePayer, fetchImpl }
 */
export function createApp(deps) {
  const { db, cfg, connection, pump, ig, uploadMetadata, feePayer } = deps;
  const app = express();
  app.set('trust proxy', process.env.TRUST_PROXY === '1');
  app.disable('x-powered-by');

  const launchLimit = limiter(20, 60 * 60_000);
  const verifyLimit = limiter(20, 60 * 60_000);
  const claimLocks = new Set();

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
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
    if (!metaSignatureOk(req.body, req.get('x-hub-signature-256'), cfg.ig.appSecret)) return res.sendStatus(401);
    res.sendStatus(200); // answer Meta at once; work after
    let body;
    try { body = JSON.parse(req.body.toString('utf8')); } catch { return; }
    for (const { igsid, code } of codeMessages(body)) {
      try { await verifyCode(igsid, code); } catch (e) { console.error('verify failed', e.message); }
    }
    if (cfg.igUserId) {
      for (const ev of mentionEvents(body)) enqueue(() => handleMention(ev));
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

  async function handleMention({ commentId, mediaId }) {
    const fresh = db.prepare(
      `insert into comment_request (comment_id, media_id, status, created_at) values (?, ?, 'working', ?)
       on conflict(comment_id) do nothing`
    ).run(commentId, mediaId, Date.now());
    if (!fresh.changes) return; // a retry of a comment we already handled
    const done = (status, extra = {}) => db.prepare(
      `update comment_request set status = ?, username = ?, mint = ?, note = ? where comment_id = ?`
    ).run(status, extra.username ?? null, extra.mint ?? null, extra.note ?? null, commentId);
    const reply = (message) => deps.comments.replyToMention(cfg, { commentId, mediaId }, message, deps.fetchImpl);

    let mention;
    try { mention = await deps.comments.readMention(cfg, { commentId }, deps.fetchImpl); }
    catch (e) { return done('failed', { note: e.message }); }
    if (!isLaunchRequest(mention.text, cfg.ig.botUsername)) return done('skipped', { note: 'not a launch request' });

    const username = normalizeHandle(mention.media.username ?? '');
    if (!username) return done('skipped', { note: 'post owner unknown' });
    if (username === cfg.ig.botUsername.toLowerCase()) return done('skipped', { username, note: 'our own post' });

    // One comment-launched coin per creator; later requests point at it.
    const existing = db.prepare(
      `select * from token where username = ? and status = 'live' order by created_at limit 1`
    ).get(username);
    if (existing) {
      await reply(existingReply({ username, ...existing, publicUrl: cfg.publicUrl }));
      return done('existing', { username, mint: existing.mint });
    }

    const today = db.prepare(
      `select count(*) n from token where source = 'comment' and created_at > ?`
    ).get(Date.now() - 24 * 60 * 60_000).n;
    const funds = await pump.balanceOf(connection, feePayer.publicKey).catch(() => 0n);
    if (today >= cfg.maxServerLaunchesPerDay || funds < BigInt(Math.round(cfg.minFeePayerSol * 1e9))) {
      await reply(`Launches are paused for now. Try again later, or launch it yourself at ${cfg.publicUrl.replace(/^https?:\/\//, '')}/launch`);
      return done('failed', { username, note: today >= cfg.maxServerLaunchesPerDay ? 'daily budget' : 'fee payer low' });
    }

    try {
      const m = mention.media;
      const imageUrl = m.media_type === 'VIDEO' ? m.thumbnail_url : (m.media_url || m.thumbnail_url);
      // A carousel or a post Meta sends no picture for gets the default coin image.
      const image = imageUrl
        ? await loadImage({ imageUrl }, deps.fetchImpl).catch(() => DEFAULT_IMAGE())
        : DEFAULT_IMAGE();
      const coin = await deps.writeCoin({ username, caption: m.caption });
      const acct = pump.getOrCreateAccount(db, username, cfg.vaultMasterKey);
      const uri = await uploadMetadata(cfg, {
        name: coin.name, symbol: coin.symbol, username, image,
        description: tokenDescription(username, coin.lore, cfg.publicUrl),
      }, deps.fetchImpl);
      const { mint, signature } = await pump.launchPaidByServer(connection, {
        feePayer, vault: acct.vault_pubkey, name: coin.name, symbol: coin.symbol, uri,
      });
      db.prepare(
        `insert into token (mint, username, name, symbol, launcher, lore, source, status, signature, created_at)
         values (?, ?, ?, ?, ?, ?, 'comment', 'live', ?, ?)`
      ).run(mint, username, coin.name, coin.symbol, feePayer.publicKey.toBase58(), coin.lore, signature, Date.now());
      await reply(launchedReply({ username, ...coin, mint, publicUrl: cfg.publicUrl }));
      done('launched', { username, mint });
    } catch (e) {
      console.error('comment launch failed', e);
      await reply('That one didn\'t go through. Try again in a few minutes.');
      done('failed', { username, note: String(e.message).slice(0, 300) });
    }
  }

  async function verifyCode(igsid, code) {
    const v = db.prepare(`select * from verification where code = ? and status = 'pending'`).get(code);
    if (!v) return;
    if (v.expires_at < Date.now()) {
      db.prepare(`update verification set status = 'expired' where id = ?`).run(v.id);
      return ig.reply(cfg.ig, igsid, 'That code has expired. Start again on the claim page for a new one.');
    }
    const username = await ig.usernameOf(cfg.ig, igsid);
    const r = db.prepare(
      `update verification set status = 'verified', igsid = ?, username = ? where id = ? and status = 'pending'`
    ).run(igsid, username, v.id);
    if (r.changes) await ig.reply(cfg.ig, igsid, `Verified as @${username}. Go back to the claim page to collect your fees.`);
  }

  app.use('/api', express.json({ limit: '6mb' }));
  app.use('/api/accounts', (req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); next(); });

  app.get('/api/config', (req, res) => res.json({ botUsername: cfg.ig.botUsername, publicUrl: cfg.publicUrl }));

  // Public: what an Instagram account has waiting. The extension shows this on profiles.
  app.get('/api/accounts/:username', async (req, res) => {
    const username = normalizeHandle(req.params.username);
    if (!username) return res.status(400).json({ error: 'Not an Instagram username.' });
    const acct = db.prepare('select * from account where username = ?').get(username);
    if (!acct) return res.json({ username, tokens: [], pendingLamports: '0', verified: false });
    const tokens = db.prepare(
      `select mint, name, symbol, lore, source, created_at from token where username = ? and status = 'live' order by created_at desc`
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
      res.json({ mint: built.mint, tx: built.tx, vault: acct.vault_pubkey });
    } catch (e) {
      console.error('prepare failed', e);
      res.status(400).json({ error: e.message || 'Could not prepare the launch.' });
    }
  });

  app.post('/api/launch/confirm', async (req, res) => {
    const { mint, signature } = req.body ?? {};
    const t = typeof mint === 'string' && db.prepare('select t.*, a.vault_pubkey from token t join account a using (username) where mint = ?').get(mint);
    if (!t) return res.status(404).json({ error: 'Unknown launch.' });
    if (t.status === 'live') return res.json({ ok: true, username: t.username });
    const ok = await pump.confirmLaunch(connection, mint, t.vault_pubkey);
    if (!ok) return res.status(409).json({ error: 'Not on-chain yet. Try again in a few seconds.' });
    db.prepare(`update token set status = 'live', signature = ? where mint = ?`).run(typeof signature === 'string' ? signature.slice(0, 100) : null, mint);
    res.json({ ok: true, username: t.username });
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
  const web3Iife = require.resolve('@solana/web3.js/lib/index.iife.min.js');
  app.get('/vendor/web3.js', (req, res) => res.sendFile(web3Iife));
  app.use(express.static(join(here, '..', 'public'), { extensions: ['html'] }));
  app.get('/u/:username', (req, res) => res.sendFile(join(here, '..', 'public', 'account.html')));

  return app;
}
