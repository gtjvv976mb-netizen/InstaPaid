// "@instapaid make a token for this creator" under any public post → the bot launches a coin
// for the post's owner and replies with the coin, its links and its lore.
//
// Meta sends a `mentions` change ({comment_id, media_id}) when a comment on media we don't own
// @mentions our professional account. It is not sent for private accounts or Stories.

const LAUNCH_RE = /\b(make|launch|create|mint)\b[^\n]{0,40}\b(token|coin)\b/i;

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

const fb = (cfg, path) => `https://graph.facebook.com/${cfg.fbGraphVersion}/${path}`;

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

export function launchedReply({ username, name, symbol, mint, lore, publicUrl }) {
  return [
    `$${symbol} is live for @${username} 🚀`,
    '',
    lore,
    '',
    `Coin: pump.fun/coin/${mint}`,
    `Creator fees go to @${username}. Only they can claim: ${publicUrl.replace(/^https?:\/\//, '')}/u/${username}`,
    `Fan-made, not by @${username}.`,
  ].join('\n');
}

export function existingReply({ username, name, symbol, mint, publicUrl }) {
  return [
    `@${username} already has a coin: $${symbol} (${name}).`,
    `Coin: pump.fun/coin/${mint}`,
    `Creator fees go to @${username}: ${publicUrl.replace(/^https?:\/\//, '')}/u/${username}`,
  ].join('\n');
}
