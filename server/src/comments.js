// "@instapaid.official make a token ..." under any public post → the bot launches a coin for the
// post's owner, named from the post, and replies with the coin and the claim link.
//
// Two ways in, one Meta app can have only one of them:
// - Instagram Login (the default; the bot is a Business or Creator account, no Facebook Page): the
//   webhook's "comments" field carries both comments on the bot's own posts and @mentions of the bot
//   in comments elsewhere, as {field:'comments', value:{id, text, from:{id, username}, media:{id,
//   media_product_type}}} on the entry itself (or inside entry.changes[]). Nothing says which of the
//   two a comment is, so a comment counts as a request when its text names the bot and has the command.
//   The post is read and the reply sent with the Instagram token on graph.instagram.com.
// - Facebook Login (only when IG_USER_ID and IG_FB_ACCESS_TOKEN are both set): a `mentions` change
//   ({comment_id, media_id}) inside entry.changes[], read and answered on graph.facebook.com.
// Neither is sent for private accounts or Stories.
import { stripAddresses, stripUrls, visibleOnly } from './lore.js';
import { graph as igGraph, graphCall, igAccount } from './instagram.js';

// Lazy, so "make a coin for this creator: a coin of sunsets" ends the command at the first "coin".
export const LAUNCH_RE = /\b(make|launch|create|mint)\b[^\n]{0,40}?\b(token|coin)\b/i;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The bot's username, with or without the "@", not inside another handle, word or e-mail address.
const botRe = (botUsername, flags = 'i') => new RegExp(`(?<![\\w.@])@?${escapeRe(botUsername)}(?!\\w|\\.\\w)`, flags);
const SEPARATORS = /^[\s:\-–—,.;!|]+/;
const WHO = /^for\s+(?:(?:this|the)\s+(?:creator|account|post|page)\b|@[\w.]+)/i;
export const MAX_LORE = 400;

/** The Facebook Login alternative is configured (both its settings). */
export const fbLogin = (cfg) => !!(cfg.igUserId && cfg.fbAccessToken);

/** Why comment launches are off, or null when they are on. */
export function commentLaunchesOff(cfg) {
  if (cfg.commentLaunches === false) return 'COMMENT_LAUNCHES is 0';
  if (!cfg.ig?.accessToken && !fbLogin(cfg)) return 'IG_ACCESS_TOKEN is not set';
  return null;
}

/**
 * The comment events in a webhook body, in every shape Meta uses:
 *   entry.field/value with field "comments" (Instagram Login, as documented),
 *   entry.changes[] with field "comments" (Instagram Login, as the dashboard's Test sends it),
 *   entry.changes[] with field "mentions" (Facebook Login: {comment_id, media_id}, no text).
 * The comment id may come as value.id or value.comment_id, the post's id as value.media.id or
 * value.media_id. A "comments" or "mentions" change without both is left out, and `onDrop(why)` is
 * told (one line in the log), so a change in what Meta sends shows up instead of going silent.
 * → [{ field, commentId, mediaId, text?, fromId?, fromUsername?, productType?, botId? }]
 */
export function mentionEvents(body, onDrop = () => {}) {
  const out = [];
  if (body?.object !== 'instagram') return out;
  const idOf = (x) => (x != null && x !== '' && (typeof x === 'string' || typeof x === 'number') ? String(x) : null);
  for (const entry of body.entry ?? []) {
    const botId = entry?.id != null ? String(entry.id) : null;
    const changes = [...(entry?.field ? [{ field: entry.field, value: entry.value }] : []), ...(entry?.changes ?? [])];
    for (const ch of changes) {
      if (ch?.field !== 'mentions' && ch?.field !== 'comments') continue;
      const v = ch.value ?? {};
      const commentId = ch.field === 'comments' ? idOf(v.id) ?? idOf(v.comment_id) : idOf(v.comment_id);
      const mediaId = ch.field === 'comments' ? idOf(v.media?.id) ?? idOf(v.media_id) : idOf(v.media_id) ?? idOf(v.media?.id);
      if (!commentId || !mediaId) {
        const keys = v && typeof v === 'object' ? Object.keys(v).sort().join(',') : typeof v;
        onDrop(`a "${ch.field}" event with no ${commentId ? 'post id' : mediaId ? 'comment id' : 'comment id or post id'} (value={${keys}})`);
        continue;
      }
      if (ch.field === 'mentions') {
        out.push({ field: 'mentions', commentId, mediaId, botId });
      } else {
        out.push({
          field: 'comments', commentId, mediaId, botId,
          text: typeof v.text === 'string' ? v.text : undefined,
          fromId: v.from?.id != null ? String(v.from.id) : null,
          fromUsername: v.from?.username ? String(v.from.username).toLowerCase() : null,
          productType: v.media?.media_product_type ? String(v.media.media_product_type) : null,
        });
      }
    }
  }
  return out;
}

/**
 * Why a comment event is not worth reading, or null. `botIds` are the ids the bot is known by.
 * Only what the webhook itself says: the bot's own comment (its replies come back as comments), a
 * Story, or a comment whose text is there and is not a request.
 */
export function skipMention(ev, botUsername, botIds = []) {
  const ids = new Set([ev.botId, ...botIds].filter(Boolean).map(String));
  if ((ev.fromId && ids.has(ev.fromId)) || (ev.fromUsername && String(ev.fromUsername).toLowerCase() === botUsername.toLowerCase())) return 'our own comment';
  if (ev.productType && /story/i.test(ev.productType)) return 'a Story';
  if (typeof ev.text === 'string' && !isLaunchRequest(ev.text, botUsername)) return 'not a launch request';
  return null;
}

/** The comment names the bot (with or without the "@", any case) and has the command. */
export function isLaunchRequest(text, botUsername) {
  const t = visibleOnly(text).normalize('NFKC');
  return botRe(botUsername).test(t) && LAUNCH_RE.test(t);
}

/**
 * The fan's lore: what they wrote after the command, e.g.
 *   "@instapaid.official make a token for this creator: king of sunsets" → "king of sunsets".
 * NFKC-normalised first (full-width letters and dots become plain ones), then without the bot's
 * name (with or without its "@"), a leading "for this creator" / "for @handle", separators, links in any spelling
 * (http(s), "hxxp", www., bare and spelled-out domains, dodged dots, emails) and wallet addresses.
 * No "@" survives, so neither the coin nor our post tags someone the fan picked. Whitespace
 * collapsed, at most 400 characters. null when nothing with a letter or digit is left. Still
 * unmoderated: Claude judges it before it is used.
 */
export function commentLore(text, botUsername) {
  let t = visibleOnly(text).normalize('NFKC').replace(botRe(botUsername, 'gi'), ' ');
  const m = LAUNCH_RE.exec(t);
  if (!m) return null;
  t = t.slice(m.index + m[0].length).replace(SEPARATORS, '').replace(WHO, '').replace(SEPARATORS, '');
  t = stripAddresses(stripUrls(t)).replace(/@+/g, '').replace(/\s+/g, ' ').trim().replace(SEPARATORS, '');
  t = t.replace(/[\s:\-–—,;|]+$/, '');
  if (t.length > MAX_LORE) t = t.slice(0, MAX_LORE).replace(/[\ud800-\udbff]$/, '').trimEnd();
  return /[\p{L}\p{N}]/u.test(t) ? t : null;
}

/** The post's link, only when it is an https://(www.)instagram.com address. */
export function instagramPermalink(u) {
  if (typeof u !== 'string' || u.length > 300) return null;
  try {
    const url = new URL(u);
    const ok = url.protocol === 'https:' && (url.hostname === 'www.instagram.com' || url.hostname === 'instagram.com')
      && !url.username && !url.password && !url.port;
    return ok ? url.href : null;
  } catch { return null; }
}

// GRAPH_BASE_URL points a staging server at a stand-in Graph API; graph.facebook.com otherwise.
export const graphBase = (cfg) => String(cfg.graphBaseUrl || 'https://graph.facebook.com').replace(/\/+$/, '');
const fb = (cfg, path) => `${graphBase(cfg)}/${cfg.fbGraphVersion || 'v23.0'}/${path}`;

const MEDIA_FIELDS = 'id,media_type,media_url,thumbnail_url,permalink,caption,username';

/** One log line per attempt: what was asked, Meta's HTTP status and error. Never a token. */
function attemptLine(via, r, owner) {
  if (r.skipped) return `mention: read post via ${via} → skipped (${r.skipped})`;
  if (!r.ok) return `mention: read post via ${via} → ${r.status} ${r.error}`;
  return `mention: read post via ${via} → ${r.status}, ${owner ? `owner @${owner}` : 'no owner username'}`;
}

/**
 * The comment and the post it is on; the post's owner (its `username`) is who the coin is for.
 * Reading someone else's post is not documented for Instagram Login, so this tries, in order, with
 * the Instagram token on graph.instagram.com:
 *   1. GET /<IG_ID>?fields=mentioned_comment.comment_id(<comment>){…,media{…,username}}
 *   2. GET /<IG_ID>?fields=mentioned_media.media_id(<media>){…,username}
 *   3. GET /<media>?fields=…,username
 * then, only when IG_USER_ID and IG_FB_ACCESS_TOKEN are both set, (1) on graph.facebook.com.
 * The first answer with an owner username wins. One log line per attempt. Throws when none gives
 * one (and logs that it could not read the post).
 * → { text, media, via }  (text: the comment's, else the webhook's)
 */
export async function readMention(cfg, { commentId, mediaId, text }, fetchImpl = fetch, log = console) {
  const attempts = [];
  const ig = cfg.ig ?? {};
  if (ig.accessToken) {
    let me = null, why = null;
    try { me = await igAccount(ig, fetchImpl); } catch (e) { why = `the bot's IG_ID is unknown: ${e.message}`; }
    const onMe = (fields) => (me
      ? graphCall(fetchImpl, igGraph(ig, me.userId), ig.accessToken, { params: { fields } })
      : Promise.resolve({ skipped: why }));
    attempts.push(['mentioned_comment', () => onMe(`mentioned_comment.comment_id(${commentId}){id,text,timestamp,media{${MEDIA_FIELDS}}}`),
      (j) => ({ text: j?.mentioned_comment?.text, media: j?.mentioned_comment?.media })]);
    if (mediaId) {
      attempts.push(['mentioned_media', () => onMe(`mentioned_media.media_id(${mediaId}){${MEDIA_FIELDS}}`),
        (j) => ({ media: j?.mentioned_media })]);
      attempts.push(['media', () => graphCall(fetchImpl, igGraph(ig, encodeURIComponent(mediaId)), ig.accessToken, { params: { fields: MEDIA_FIELDS } }),
        (j) => ({ media: j })]);
    }
  }
  if (fbLogin(cfg)) {
    attempts.push(['Facebook Login mentioned_comment',
      () => graphCall(fetchImpl, fb(cfg, cfg.igUserId), cfg.fbAccessToken,
        { params: { fields: `mentioned_comment.comment_id(${commentId}){id,text,timestamp,media{${MEDIA_FIELDS}}}` } }),
      (j) => ({ text: j?.mentioned_comment?.text, media: j?.mentioned_comment?.media })]);
  }
  for (const [via, run, pick] of attempts) {
    const r = await run();
    const got = r.ok ? pick(r.json) : {};
    const owner = got.media?.username ? String(got.media.username) : null;
    log.log(attemptLine(via, r, owner));
    if (owner) return { text: String(got.text ?? text ?? ''), media: got.media, via };
  }
  log.warn('mention: could not read the post — see the lines above');
  throw new Error('could not read the post');
}

/**
 * Why no reply could be sent under a comment right now, or null when one can. Asked before a coin
 * is launched, so the fee payer never pays for a coin the fan would never hear about. On Instagram
 * Login the reply goes to /<IG_ID>/mentions, so the bot's IG_ID must be known: /me is asked (again,
 * once more after a miss, since a failed lookup is not kept). With the Facebook Login settings as
 * well, a refused Instagram reply falls back to graph.facebook.com, so nothing is asked.
 */
export async function replyBlocked(cfg, fetchImpl = fetch) {
  const ig = cfg.ig ?? {};
  if (!ig.accessToken || fbLogin(cfg)) return null;
  let last;
  for (let i = 0; i < 2; i++) {
    try { await igAccount(ig, fetchImpl); return null; } catch (e) { last = e; }
  }
  return `the bot's IG_ID is unknown: ${last.message}`;
}

/**
 * Reply under the comment. Instagram Login: POST graph.instagram.com/<v>/<IG_ID>/mentions
 * {comment_id, media_id, message}. When Instagram answers with an error and the Facebook Login
 * alternative is set up, the same on graph.facebook.com. Logs Meta's status and error; → true when posted.
 */
export async function replyToMention(cfg, { commentId, mediaId }, message, fetchImpl = fetch, log = console) {
  const params = { comment_id: commentId, media_id: mediaId, message: message.slice(0, 2200) };
  const ig = cfg.ig ?? {};
  if (ig.accessToken) {
    let r;
    try {
      const me = await igAccount(ig, fetchImpl);
      r = await graphCall(fetchImpl, igGraph(ig, `${me.userId}/mentions`), ig.accessToken, { method: 'POST', params });
    } catch (e) {
      r = { ok: false, status: 'skipped', error: `the bot's IG_ID is unknown: ${e.message}` };
    }
    if (r.ok) { log.log(`mention: replied via Instagram Login → ${r.status}`); return true; }
    log.error(`mention: reply via Instagram Login → ${r.status} ${r.error}`);
    // A request that got no answer may still have posted: never a second reply for it.
    if (r.status === 'network' || !fbLogin(cfg)) return false;
  }
  if (!fbLogin(cfg)) return false;
  const r = await graphCall(fetchImpl, fb(cfg, `${cfg.igUserId}/mentions`), cfg.fbAccessToken, { method: 'POST', params });
  if (r.ok) log.log(`mention: replied via Facebook Login → ${r.status}`);
  else log.error(`mention: reply via Facebook Login → ${r.status} ${r.error}`);
  return r.ok;
}

const host = (publicUrl) => publicUrl.replace(/^https?:\/\//, '');

/**
 * The reply under the comment once the coin is live. Lively but honest: no price talk, no "moon",
 * no rocket, and it always says the coin is fan-made. It names the coin, its ticker, its address,
 * the pump.fun page, where the creator claims, whether the coin wears the post's photo (`photo`: only
 * when it does, not when the default coin image stood in), and (`posted`: only when a post was queued)
 * that we will post it.
 * Instagram caps a comment at 2200 characters and makes no link clickable, so links are plain.
 */
export function launchedReply({ username, name, symbol, mint, lore, postPermalink, photo, posted, publicUrl }) {
  const site = host(publicUrl);
  const lines = [
    `🎉 Done! ${name ? `${name} ($${symbol})` : `$${symbol}`} is now live on pump.fun, made for @${username}.`,
    '',
    `🪙 Coin: ${name || symbol}`,
    `🔤 Ticker: $${symbol}`,
    `📍 Address: ${mint}`,
    `🔗 Trade it: pump.fun/coin/${mint}`,
    photo ? `📸 Named after this post, and it wears the post's photo.` : `📸 Named after this post.`,
  ];
  if (lore) lines.push(`📝 Lore: “${lore}”`);
  lines.push(
    '',
    `💰 @${username}, the creator fees from every trade are YOURS. Only you can claim them:`,
    `👉 ${site}/u/${username}`,
    `Prove it's you with one DM to @instapaid.official, pick any Solana wallet, and the fees are sent. No password, no seed phrase, ever.`,
  );
  if (posted) lines.push('', `📣 We'll post it on our feed and tag @${username}.`);
  lines.push(
    '',
    `ℹ️ Fan-made by the person who commented, not by @${username}. Meme coins are speculative and can go to zero. Not financial advice.`,
    `❓ How it works: ${site}`,
  );
  return lines.join('\n');
}

/** When the launch was sent but Solana has not confirmed it yet. It is looked at again later. */
export function pendingReply({ username, publicUrl }) {
  return [
    `⏳ The coin for @${username} is sent and Solana is confirming it now. Hang tight!`,
    `I'll reply here with the coin, its address and the claim link as soon as it lands. It will also show at ${host(publicUrl)}/u/${username}.`,
  ].join('\n');
}

// Named without an "@": the creator asked to be left alone, so the reply does not notify them.
export const blockedReply = (username) => `${username} has asked not to have coins made for them.`;

export function existingReply({ username, name, symbol, mint, publicUrl }) {
  const site = host(publicUrl);
  return [
    `@${username} already has a coin: ${name} ($${symbol}). One per creator, so it's all yours to trade 🙌`,
    `📍 Address: ${mint}`,
    `🔗 Trade it: pump.fun/coin/${mint}`,
    `💰 Creator fees go to @${username}, who claims them at ${site}/u/${username}`,
    `ℹ️ Fan-made, not by @${username}. Not financial advice.`,
  ].join('\n');
}

/**
 * The DM answer to a message that carries no claim code: someone who saw a mention and wrote
 * to ask what this is. Official in tone, and it tells them exactly what to do next.
 * `coins` is what the sender's account may claim: [{ symbol, name, pendingLamports }].
 * Meta caps a DM at 1000 characters.
 */
export function welcomeDm({ username, coins, publicUrl }) {
  const site = host(publicUrl);
  const sol = (l) => (Number(BigInt(l || 0)) / 1e9).toLocaleString('en-US', { maximumFractionDigits: 4 });
  const you = username ? `@${username}` : 'you';
  if (coins?.length) {
    const total = coins.reduce((n, c) => n + BigInt(c.pendingLamports || 0), 0n);
    const list = coins.slice(0, 3).map((c) => `• ${c.name} ($${c.symbol})`).join('\n');
    return [
      `Hello ${you}, this is InstaPaid.`,
      '',
      `A fan launched a coin for your account on pump.fun. Its creator fees belong to you, and only you can claim them.`,
      '',
      list + (coins.length > 3 ? `\n• and ${coins.length - 3} more` : ''),
      `Waiting for you right now: ${sol(total)} SOL`,
      '',
      'To claim:',
      `1. Open ${site}/claim`,
      '2. Tap "Get my code" and send that code to this account in a message.',
      '3. Enter any Solana wallet, and the fees are sent to it.',
      '',
      'InstaPaid never asks for your password, seed phrase or private key, and never asks you to pay. Anyone who does is not us.',
      `Details: ${site}/u/${username}`,
    ].join('\n');
  }
  return [
    `Hello ${you}, this is InstaPaid.`,
    '',
    'Fans can launch a coin for an Instagram creator on pump.fun by commenting "@instapaid.official make a token for this creator" under a public post. The coin\'s creator fees belong to that creator, and only they can claim them.',
    '',
    `No coin has been launched for ${you} yet. If one is, this account will mention you in a post, and you can claim its fees at ${site}/claim.`,
    '',
    'InstaPaid never asks for your password, seed phrase or private key, and never asks you to pay.',
    `More: ${site}`,
  ].join('\n');
}
