import { CODE_RE } from './crypto.js';

// The Instagram API with Instagram Login. IG_GRAPH_BASE_URL points a staging server at a stand-in.
export const igBase = (cfg) => String(cfg?.graphBaseUrl || 'https://graph.instagram.com').replace(/\/+$/, '');
export const graph = (cfg, path) => `${igBase(cfg)}/${cfg.graphVersion || 'v23.0'}/${path}`;

/**
 * Every text DM to the bot in a webhook body, from someone other than the bot itself.
 * Shape: { object: 'instagram', entry: [{ messaging: [{ sender: {id}, recipient: {id}, message: {text, is_echo} }] }] }
 * Meta also delivers DMs as entry.changes[{field:'messages', value}] (its dashboard Test does,
 * and some Instagram Login subscriptions do), and may put {field, value} on the entry itself: all are read.
 */
export function textMessages(body) {
  const out = [];
  if (body?.object !== 'instagram') return out;
  for (const entry of body.entry ?? []) {
    const events = [
      ...(entry.messaging ?? []),
      ...(entry.changes ?? []).filter((c) => c?.field === 'messages').map((c) => c.value),
      ...(entry.field === 'messages' && entry.value ? [entry.value] : []),
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
  return Boolean(r?.ok);
}

// Meta's error message only (no tokens are ever in it), for the logs.
async function metaError(r) {
  const j = await r.json().catch(() => null);
  return describeError(j);
}

/** "(#10) Application does not have permission …" from a Graph error body; never a token. */
export function describeError(j) {
  const e = j?.error;
  if (!e) return 'no details';
  const code = e.code != null ? `(#${e.code}${e.error_subcode != null ? `/${e.error_subcode}` : ''}) ` : '';
  return `${code}${String(e.message ?? '').slice(0, 300)}`.trim() || 'no details';
}

/**
 * One Graph call that never throws: { ok, status, json, error }. `status` is the HTTP status, or
 * 'network' when no answer came. The token goes in the query (GET, DELETE) or the form body (POST)
 * and is never in `error`.
 */
export async function graphCall(fetchImpl, url, token, { method = 'GET', params = {} } = {}) {
  const q = new URLSearchParams({ ...params, access_token: token });
  let r;
  try {
    r = method === 'GET' || method === 'DELETE'
      ? await fetchImpl(`${url}?${q}`, { ...(method === 'DELETE' ? { method } : {}), signal: AbortSignal.timeout(30_000) })
      : await fetchImpl(url, {
        method, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: q.toString(),
        signal: AbortSignal.timeout(30_000),
      });
  } catch (e) {
    return { ok: false, status: 'network', json: null, error: String(e?.message ?? e).slice(0, 300) };
  }
  const json = await r.json().catch(() => null);
  const ok = r.ok && !json?.error;
  return { ok, status: r.status, json, error: ok ? null : describeError(json) };
}

// The bot's own account ({userId, username}), once per config object: GET /me?fields=user_id,username.
const accounts = new WeakMap();

/**
 * The bot's Instagram professional account id (IG_ID) and username, read from the Instagram token:
 * GET graph.instagram.com/<version>/me?fields=user_id,username. `user_id` is the id webhooks carry
 * as entry.id and the one /<IG_ID>/media, /mentions and /media_publish take. Asked once and kept;
 * a failed lookup is asked again next time. Throws when it cannot be read.
 */
export async function igAccount(cfg, fetchImpl = fetch) {
  if (cfg.userId) return { userId: String(cfg.userId), username: cfg.username ? String(cfg.username).toLowerCase() : null };
  if (!cfg.accessToken) throw new Error('IG_ACCESS_TOKEN is not set');
  let p = accounts.get(cfg);
  if (!p) {
    p = graphCall(fetchImpl, graph(cfg, 'me'), cfg.accessToken, { params: { fields: 'user_id,username' } }).then((r) => {
      const id = r.json?.user_id ?? null;
      if (!r.ok || !id) throw new Error(`GET /me → ${r.status}${r.ok ? ', no user_id' : ` ${r.error}`}`);
      return { userId: String(id), username: r.json.username ? String(r.json.username).toLowerCase() : null };
    });
    accounts.set(cfg, p);
    p.catch(() => { if (accounts.get(cfg) === p) accounts.delete(cfg); });
  }
  return p;
}

/**
 * Subscribe @instapaid.official to this app's webhook (POST /me/subscribed_apps) for `fields`
 * (messages; comments too when comment launches are on). Meta only delivers real events to apps
 * the account is subscribed to; the dashboard toggle does not always do this. Idempotent, so it
 * runs at every start. Never throws. `answer` is Meta's reply body (e.g. {"success":true}), for the log.
 */
export async function subscribeMessages(cfg, fetchImpl = fetch, fields = ['messages']) {
  if (!cfg.accessToken || cfg.accessToken.length < 20) return { ok: false, reason: 'no Instagram token yet' };
  try {
    const r = await fetchImpl(`${graph(cfg, 'me/subscribed_apps')}?subscribed_fields=${fields.join(',')}&access_token=${encodeURIComponent(cfg.accessToken)}`, { method: 'POST' });
    const text = (await r.text().catch(() => '')).slice(0, 300);
    if (r.ok) return { ok: true, answer: text };
    let j = null;
    try { j = JSON.parse(text); } catch { /* not JSON */ }
    return { ok: false, reason: `Instagram said ${r.status}: ${describeError(j)}` };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/**
 * The shape of one webhook entry, for the logs: its keys and field names, the keys of each event
 * and the length of any text. Never the text itself (a DM is private), never ids or tokens.
 */
export function describeEntry(entry) {
  if (!entry || typeof entry !== 'object') return `entry=${typeof entry}`;
  const keys = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? `{${Object.keys(o).sort().join(',')}}` : typeof o);
  const len = (v) => (typeof v?.text === 'string' ? ` text=${v.text.length} chars` : '')
    + (typeof v?.message?.text === 'string' ? ` text=${v.message.text.length} chars` : '');
  const value = (v) => `value=${keys(v)}${v?.from ? ` from=${keys(v.from)}` : ''}${v?.media ? ` media=${keys(v.media)}` : ''}`
    + `${v?.message ? ` message=${keys(v.message)}` : ''}${len(v)}`;
  const parts = [`entry=${keys(entry)}`];
  if (entry.field !== undefined || entry.value !== undefined) parts.push(`field=${entry.field} ${value(entry.value)}`);
  for (const ch of Array.isArray(entry.changes) ? entry.changes : []) parts.push(`changes[field=${ch?.field} ${value(ch?.value)}]`);
  for (const ev of Array.isArray(entry.messaging) ? entry.messaging : []) {
    parts.push(`messaging[${keys(ev)}${ev?.message ? ` message=${keys(ev.message)}` : ''}${len(ev)}]`);
  }
  return parts.join(' ');
}
