import { CODE_RE } from './crypto.js';

const graph = (cfg, path) => `https://graph.instagram.com/${cfg.graphVersion}/${path}`;

/**
 * Every text DM to the bot in a webhook body, from someone other than the bot itself.
 * Shape: { object: 'instagram', entry: [{ messaging: [{ sender: {id}, recipient: {id}, message: {text, is_echo} }] }] }
 * Meta also delivers DMs as entry.changes[{field:'messages', value}] (its dashboard Test does,
 * and some Instagram Login subscriptions do): both are read.
 */
export function textMessages(body) {
  const out = [];
  if (body?.object !== 'instagram') return out;
  for (const entry of body.entry ?? []) {
    const events = [
      ...(entry.messaging ?? []),
      ...(entry.changes ?? []).filter((c) => c?.field === 'messages').map((c) => c.value),
    ];
    for (const ev of events) {
      const text = ev?.message?.text;
      if (!text || ev.message.is_echo || !ev.sender?.id) continue;
      if (entry.id && String(ev.sender.id) === String(entry.id)) continue; // the bot itself
      const m = text.toUpperCase().match(CODE_RE);
      out.push({ igsid: String(ev.sender.id), code: m ? m[0] : null });
    }
  }
  return out;
}

/** The DMs that carry a claim code. */
export function codeMessages(body) {
  return textMessages(body).filter((m) => m.code);
}

/** The sender's current username, from the User Profile API (allowed once they have messaged the bot). */
export async function usernameOf(cfg, igsid, fetchImpl = fetch) {
  const url = `${graph(cfg, encodeURIComponent(igsid))}?fields=username&access_token=${encodeURIComponent(cfg.accessToken)}`;
  const r = await fetchImpl(url);
  if (!r.ok) throw new Error(`instagram profile lookup ${r.status}: ${await metaError(r)}`);
  const j = await r.json();
  if (!j.username) throw new Error('instagram profile has no username');
  return String(j.username).toLowerCase();
}

export async function reply(cfg, igsid, text, fetchImpl = fetch) {
  const r = await fetchImpl(`${graph(cfg, 'me/messages')}?access_token=${encodeURIComponent(cfg.accessToken)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ recipient: { id: igsid }, message: { text } }),
  }).catch((e) => { console.warn('dm reply: request failed', e.message); return null; });
  if (r && !r.ok) console.warn(`dm reply: Instagram said ${r.status}: ${await metaError(r)}`);
}

// Meta's error message only (no tokens are ever in it), for the logs.
async function metaError(r) {
  const j = await r.json().catch(() => null);
  return String(j?.error?.message ?? '').slice(0, 300) || 'no details';
}

/**
 * Subscribe @instapaid.official's messages to this app's webhook (POST /me/subscribed_apps).
 * Meta only delivers real DMs to apps the account is subscribed to; the dashboard toggle does
 * not always do this. Idempotent, so it runs at every start. Never throws.
 */
export async function subscribeMessages(cfg, fetchImpl = fetch) {
  if (!cfg.accessToken || cfg.accessToken.length < 20) return { ok: false, reason: 'no Instagram token yet' };
  try {
    const r = await fetchImpl(`${graph(cfg, 'me/subscribed_apps')}?subscribed_fields=messages&access_token=${encodeURIComponent(cfg.accessToken)}`, { method: 'POST' });
    if (r.ok) return { ok: true };
    return { ok: false, reason: `Instagram said ${r.status}: ${await metaError(r)}` };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}
