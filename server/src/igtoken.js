// Keeps the Instagram token alive. An Instagram Login token (IG_ACCESS_TOKEN) lasts 60 days; when it
// runs out, DM claims, comment launches and the poster all stop. So the token in use is kept in the
// database (sealed under VAULT_MASTER_KEY), and once it is 7 days old it is renewed (a pasted token,
// whose real age nobody knows, is renewed once it has been here 24 hours, so Meta's expires_in gives
// its true end early):
//   GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=<token>
//   → { access_token, token_type, expires_in }   (the token must be at least 24 hours old)
// The new token is stored and put in cfg.ig.accessToken, which every caller (DMs, comment launches,
// the poster, the webhook subscription) reads at the moment of each call and never copies.
//
// At start: the stored token is used when it descends from the IG_ACCESS_TOKEN set now (a renewal of
// it); a different IG_ACCESS_TOKEN is a freshly pasted one, which is stored and wins.
// Checked at start and every 24 hours. A failed renewal keeps the current token; within 10 days of
// its end, every failed day logs a loud warning. When Meta refuses the token itself (OAuthException
// 190: expired, revoked, invalid), the warning comes at once, whatever the assumed end date says, and
// the stored end is set to now, so every daily check (and every start) warns again until a new token
// is pasted. No log line ever carries a token.
import { createHmac } from 'node:crypto';
import { sealSecret, openSecret } from './crypto.js';
import { igBase, graphCall } from './instagram.js';

const DAY = 24 * 60 * 60_000;
export const RENEW_AFTER = 7 * DAY;
export const WARN_WITHIN = 10 * DAY;
export const CHECK_EVERY = DAY;
// A pasted token's age is not something Meta tells us: it is taken as new (60 days) when first seen.
export const PASTED_LIFE = 60 * DAY;
const AAD = 'ig_token';

const day = (t) => new Date(t).toISOString().slice(0, 10);
const HOW = 'Generate a new token (Meta app → Instagram → API setup with Instagram login → Generate token) and '
  + 'paste it into IG_ACCESS_TOKEN.';
const STOPPED = 'DM claims, comment launches and the poster are stopped.';
// Meta's answer when the token itself is no good (expired, revoked, password changed, invalid): code 190.
// Any other refusal (busy, rate limited, a network error) says nothing about the token.
const tokenRefused = (a) => !a.ok && Number(a.json?.error?.code) === 190;
const daysLeft = (ms) => Math.max(0, Math.round(ms / DAY));

/**
 * deps: { db, cfg, fetchImpl, now, log }. cfg.vaultMasterKey seals the stored token; cfg.ig holds the
 * one in use. → { load, check, start, stop, current }
 */
export function createTokenKeeper({ db, cfg, fetchImpl = fetch, now = Date.now, log = console }) {
  const key = cfg.vaultMasterKey;
  const ig = cfg.ig ?? {};
  const usable = /^[0-9a-f]{64}$/i.test(key || '');
  const envHash = (t) => createHmac('sha256', Buffer.from(key, 'hex')).update(`ig-env:${t}`).digest('hex');
  let timer = null, running = null;
  // Anything that goes in a log line has every token we know of taken out first.
  const known = new Set();
  const clean = (s) => { let out = String(s ?? ''); for (const t of known) if (t) out = out.split(t).join('[token]'); return out; };

  const row = () => db.prepare('select * from ig_token where id = 1').get();
  const open = (r) => {
    try { return Buffer.from(openSecret(r.token, key, AAD)).toString(); } catch { return null; }
  };
  const save = (token, { envHashValue, source, refreshedAt, expiresAt }) => db.prepare(
    `insert into ig_token (id, token, env_hash, source, refreshed_at, expires_at) values (1, ?, ?, ?, ?, ?)
     on conflict(id) do update set token = excluded.token, env_hash = excluded.env_hash, source = excluded.source,
       refreshed_at = excluded.refreshed_at, expires_at = excluded.expires_at`,
  ).run(sealSecret(token, key, AAD), envHashValue, source, refreshedAt, expiresAt);

  /** At start, before anything uses the token: the stored one or the pasted one, whichever is newer. Never throws. */
  function load() {
    if (!usable) { log.warn('instagram token: not kept or renewed (VAULT_MASTER_KEY is not set)'); return; }
    try {
      const pasted = ig.accessToken || '';
      known.add(pasted);
      const r = row();
      const stored = r ? open(r) : null;
      known.add(stored);
      if (r && !stored) log.error('instagram token: the stored token could not be opened (VAULT_MASTER_KEY changed?); using IG_ACCESS_TOKEN');
      if (stored && (!pasted || r.env_hash === envHash(pasted))) {
        ig.accessToken = stored;
        if (r.expires_at <= now()) {
          log.error(`instagram token: WARNING — THE TOKEN IN USE EXPIRED OR WAS REFUSED BY META ON ${day(r.expires_at)}. `
            + `${STOPPED} ${HOW}`);
          return;
        }
        log.log(r.source === 'renewed'
          ? `instagram token: using the one renewed on ${day(r.refreshed_at)}, valid ~${daysLeft(r.expires_at - now())} days`
          : `instagram token: IG_ACCESS_TOKEN, stored ${day(r.refreshed_at)}; renewed automatically after 24 hours`);
        return;
      }
      if (!pasted) return;
      const t = now();
      save(pasted, { envHashValue: envHash(pasted), source: 'env', refreshedAt: t, expiresAt: t + PASTED_LIFE });
      log.log(`instagram token: ${r ? 'a new IG_ACCESS_TOKEN replaces the stored one' : 'IG_ACCESS_TOKEN stored'}; renewed automatically after 24 hours`);
    } catch (e) {
      log.error(`instagram token: could not read or store it (${clean(e?.message)}); using IG_ACCESS_TOKEN`);
    }
  }

  async function renew() {
    const r = row();
    if (!r) return 'none';
    const token = open(r);
    if (!token) return 'none';
    known.add(token);
    const t = now();
    const age = t - r.refreshed_at;
    const left = r.expires_at - t;
    // Due at 7 days. Sooner, once Meta allows it (24 h): a pasted token (its real age and end are
    // unknown; the first renewal tells them), or when the end is near (a short expires_in, or dead).
    if (age < RENEW_AFTER && !(age >= DAY && (r.source === 'env' || left <= WARN_WITHIN))) return 'fresh';
    const a = await graphCall(fetchImpl, `${igBase(ig)}/refresh_access_token`, token, { params: { grant_type: 'ig_refresh_token' } });
    const next = a.ok ? a.json?.access_token : null;
    const life = Number(a.json?.expires_in);
    if (typeof next === 'string' && next.length >= 20 && Number.isFinite(life) && life > 0) {
      known.add(next);
      const at = now();
      save(next, { envHashValue: r.env_hash, source: 'renewed', refreshedAt: at, expiresAt: at + life * 1000 });
      ig.accessToken = next;
      log.log(`instagram token: renewed, valid ~${daysLeft(life * 1000)} days`);
      return 'renewed';
    }
    const why = a.ok ? 'no access_token or expires_in in the answer' : `${a.status} ${a.error}`;
    if (tokenRefused(a)) {
      // The token is dead, whatever end date was assumed for it. Mark it so: every check from now on
      // (daily, and at each start) warns until a new token is pasted.
      if (r.expires_at > t) db.prepare('update ig_token set expires_at = ? where id = 1').run(t);
      log.error(`instagram token: WARNING — META REFUSED THE TOKEN IN USE (${clean(why)}): it has expired or been revoked `
        + `and cannot be renewed. ${STOPPED} ${HOW}`);
      return 'failed';
    }
    log.error(`instagram token: renewal failed → ${clean(why)}; the current token stays in use`);
    if (left <= WARN_WITHIN) {
      log.error(left <= 0
        ? `instagram token: WARNING — IT EXPIRED ON ${day(r.expires_at)} and could not be renewed. ${STOPPED} ${HOW}`
        : `instagram token: WARNING — IT EXPIRES IN ~${daysLeft(left)} DAYS (${day(r.expires_at)}) and could not be renewed. `
          + 'Generate a new token (Meta app → Instagram → API setup with Instagram login → Generate token) and paste it into '
          + 'IG_ACCESS_TOKEN, or DM claims, comment launches and the poster stop that day.');
    }
    return 'failed';
  }

  /** One renewal check: 'renewed' | 'failed' | 'fresh' | 'none'. Never throws; one at a time. */
  function check() {
    if (!usable) return Promise.resolve('none');
    running ??= renew()
      .catch((e) => { log.error(`instagram token: renewal check failed (${clean(e?.message)})`); return 'failed'; })
      .finally(() => { running = null; });
    return running;
  }

  return {
    load,
    check,
    /** Check now and every 24 hours. */
    start() {
      check();
      if (!timer) { timer = setInterval(check, CHECK_EVERY); timer.unref?.(); }
    },
    stop() { clearInterval(timer); timer = null; },
    /** { source, refreshedAt, expiresAt } of the stored token, for tests and the start-up log; never the token. */
    current() {
      const r = usable ? row() : null;
      return r ? { source: r.source, refreshedAt: r.refreshed_at, expiresAt: r.expires_at } : null;
    },
  };
}
