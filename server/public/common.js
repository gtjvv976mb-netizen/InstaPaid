export const $ = (s) => document.querySelector(s);
export const sol = (lamports) => (Number(BigInt(lamports || '0')) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 4 });

export async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `Request failed (${r.status})`), { status: r.status });
  return j;
}

export function note(el, kind, text) {
  el.className = `note ${kind}`;
  el.textContent = text;
  el.hidden = false;
}

export function wallet() {
  return window.phantom?.solana ?? window.solflare ?? window.solana ?? null;
}
