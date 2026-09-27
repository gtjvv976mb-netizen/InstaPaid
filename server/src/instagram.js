import { CODE_RE } from './crypto.js';

const graph = (cfg, path) => `https://graph.instagram.com/${cfg.graphVersion}/${path}`;

/**
 * The messages in a webhook body that could carry a code: text from someone other than the bot.
 * Shape: { object: 'instagram', entry: [{ messaging: [{ sender: {id}, recipient: {id}, message: {text, is_echo} }] }] }
 */
export function codeMessages(body) {
  const out = [];
  if (body?.object !== 'instagram') return out;
  for (const entry of body.entry ?? []) {
    for (const ev of entry.messaging ?? []) {
      const text = ev?.message?.text;
      if (!text || ev.message.is_echo || !ev.sender?.id) continue;
      const m = text.toUpperCase().match(CODE_RE);
      if (m) out.push({ igsid: String(ev.sender.id), code: m[0] });
    }
  }
  return out;
}

/** The sender's current username, from the User Profile API (allowed once they have messaged the bot). */
export async function usernameOf(cfg, igsid, fetchImpl = fetch) {
  const url = `${graph(cfg, encodeURIComponent(igsid))}?fields=username&access_token=${encodeURIComponent(cfg.accessToken)}`;
  const r = await fetchImpl(url);
  if (!r.ok) throw new Error(`instagram profile lookup ${r.status}`);
  const j = await r.json();
  if (!j.username) throw new Error('instagram profile has no username');
  return String(j.username).toLowerCase();
}

export async function reply(cfg, igsid, text, fetchImpl = fetch) {
  await fetchImpl(`${graph(cfg, 'me/messages')}?access_token=${encodeURIComponent(cfg.accessToken)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ recipient: { id: igsid }, message: { text } }),
  }).catch(() => {});
}
