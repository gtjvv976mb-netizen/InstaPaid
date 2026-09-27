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

/** The reply under the fan's comment. No lore: the coin and the claim link only. */
export function launchedReply({ username, symbol, mint, publicUrl }) {
  return [
    `$${symbol} is live for @${username}`,
    `Coin: pump.fun/coin/${mint}`,
    `@${username} can claim the creator fees: ${host(publicUrl)}/u/${username}`,
    `Fan-made, not by @${username}.`,
  ].join('\n');
}

/** When the launch was sent but Solana has not confirmed it yet. It is looked at again later. */
export function pendingReply({ username, publicUrl }) {
  return [
    `The coin for @${username} is sent and waiting for Solana to confirm it.`,
    `It will show at ${host(publicUrl)}/u/${username} once it does.`,
  ].join('\n');
}

// Named without an "@": the creator asked to be left alone, so the reply does not notify them.
export const blockedReply = (username) => `${username} has asked not to have coins made for them.`;

export function existingReply({ username, name, symbol, mint, publicUrl }) {
  return [
    `@${username} already has a coin: $${symbol} (${name}).`,
    `Coin: pump.fun/coin/${mint}`,
    `Creator fees go to @${username}: ${host(publicUrl)}/u/${username}`,
  ].join('\n');
}
