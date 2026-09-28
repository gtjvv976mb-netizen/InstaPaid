// "@instapaid.official make a token ..." under any public post → the bot launches a coin for the
// post's owner, named from the post, and replies with the coin and the claim link.
//
// Meta sends a `mentions` change ({comment_id, media_id}) when a comment on media we don't own
// @mentions our professional account. It is not sent for private accounts or Stories.
import { stripAddresses, stripUrls, visibleOnly } from './lore.js';

// Lazy, so "make a coin for this creator: a coin of sunsets" ends the command at the first "coin".
export const LAUNCH_RE = /\b(make|launch|create|mint)\b[^\n]{0,40}?\b(token|coin)\b/i;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SEPARATORS = /^[\s:\-–—,.;!|]+/;
const WHO = /^for\s+(?:(?:this|the)\s+(?:creator|account|post|page)\b|@[\w.]+)/i;
export const MAX_LORE = 400;

/** The mention events in a webhook body. */
export function mentionEvents(body) {
  const out = [];
  if (body?.object !== 'instagram') return out;
  for (const entry of body.entry ?? []) {
    for (const ch of entry.changes ?? []) {
      if (ch?.field === 'mentions' && ch.value?.comment_id && ch.value?.media_id) {
        out.push({ commentId: String(ch.value.comment_id), mediaId: String(ch.value.media_id) });
      }
    }
  }
  return out;
}

export function isLaunchRequest(text, botUsername) {
  const t = String(text || '');
  return t.toLowerCase().includes('@' + botUsername.toLowerCase()) && LAUNCH_RE.test(t);
}

/**
 * The fan's lore: what they wrote after the command, e.g.
 *   "@instapaid.official make a token for this creator: king of sunsets" → "king of sunsets".
 * NFKC-normalised first (full-width letters and dots become plain ones), then without the bot's
 * @mention, a leading "for this creator" / "for @handle", separators, links in any spelling
 * (http(s), "hxxp", www., bare and spelled-out domains, dodged dots, emails) and wallet addresses.
 * No "@" survives, so neither the coin nor our post tags someone the fan picked. Whitespace
 * collapsed, at most 400 characters. null when nothing with a letter or digit is left. Still
 * unmoderated: Claude judges it before it is used.
 */
export function commentLore(text, botUsername) {
  let t = visibleOnly(text).normalize('NFKC').replace(new RegExp(`@${escapeRe(botUsername)}(?!\\w|\\.\\w)`, 'gi'), ' ');
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

/** The comment and the post it is on. Asks for the post owner's username; Meta may not return it. */
export async function readMention(cfg, { commentId }, fetchImpl = fetch) {
  const fields = `mentioned_comment.comment_id(${commentId}){id,text,timestamp,media{id,media_type,media_url,thumbnail_url,permalink,caption,username}}`;
  const r = await fetchImpl(`${fb(cfg, cfg.igUserId)}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(cfg.fbAccessToken)}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`mentioned_comment ${r.status}: ${j?.error?.message ?? ''}`);
  const c = j.mentioned_comment;
  if (!c) throw new Error('mentioned_comment missing');
  return { text: c.text ?? '', media: c.media ?? {} };
}

export async function replyToMention(cfg, { commentId, mediaId }, message, fetchImpl = fetch) {
  const r = await fetchImpl(`${fb(cfg, `${cfg.igUserId}/mentions`)}?access_token=${encodeURIComponent(cfg.fbAccessToken)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ comment_id: commentId, media_id: mediaId, message: message.slice(0, 2200) }),
  });
  if (!r.ok) console.error('reply failed', r.status, await r.text().catch(() => ''));
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
