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

/** Instagram usernames, as the server reads them (src/handles.js). */
export const HANDLE_RE = /^(?!\.)(?!.*\.\.)(?!.*\.$)[a-z0-9._]{1,30}$/;

/** First path segments on instagram.com that are never a profile. A copy of src/handles.js
 *  NOT_PROFILES (test/site.test.js keeps the two the same). */
export const NOT_PROFILES = new Set([
  'explore', 'reels', 'reel', 'p', 'stories', 'direct', 'accounts', 'about', 'legal',
  'developer', 'web', 'emails', 'challenge', 'tv', 'privacy', 'session', 'oauth', 'api',
  'static', 'graphql', 'ar', 'lite', 'download', 'directory', 'topics', 'your_activity', 'threads',
]);

/** A lowercase username the server will accept (src/handles.js normalizeHandle). */
export const isHandle = (v) => HANDLE_RE.test(v) && !NOT_PROFILES.has(v);

/** Copy text: the clipboard API first, then a hidden textarea. Resolves true only if it copied. */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through to the textarea */ }
  const t = document.createElement('textarea');
  t.value = text;
  t.setAttribute('readonly', '');
  t.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
  document.body.append(t);
  t.select();
  t.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  t.remove();
  return ok;
}

/** Select an element's text, so a person can copy it by hand. */
export function selectText(el) {
  const r = document.createRange();
  r.selectNodeContents(el);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
}

/**
 * A Copy button: its label changes, a polite live region says what happened, and if neither
 * clipboard path works the text is selected and the person is told to press and hold.
 */
export function copyButton(btn, { text, status, source }) {
  const label = btn.querySelector('[data-copy-label]') || btn;
  const idle = label.textContent;
  let timer;
  btn.addEventListener('click', async () => {
    const ok = await copyText(typeof text === 'function' ? text() : text);
    clearTimeout(timer);
    btn.classList.toggle('copied', ok);
    if (ok) {
      label.textContent = 'Copied';
      if (status) status.textContent = 'Copied';
    } else {
      label.textContent = 'Press and hold to copy';
      if (source) selectText(source);
      if (status) status.textContent = 'Could not copy automatically. Press and hold the text to copy it.';
    }
    timer = setTimeout(() => {
      btn.classList.remove('copied');
      label.textContent = idle;
      if (status) status.textContent = '';
    }, ok ? 2200 : 6000);
  });
}

/** "See a creator's page" forms: instapaid.fun/u/<username>. Works without JS through /u?u=. */
export function wireLookup(form) {
  const input = form.querySelector('input');
  const err = form.querySelector('.lookup-err');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = input.value.trim()
      .replace(/^https?:\/\//i, '').replace(/^(www\.)?(instagram\.com|instapaid\.fun\/u)\//i, '')
      .replace(/^@/, '').replace(/[/?#].*$/, '').toLowerCase();
    if (!isHandle(v)) {
      input.setAttribute('aria-invalid', 'true');
      if (err) { err.hidden = false; err.textContent = 'Type an Instagram username, like baker.example'; }
      input.focus();
      return;
    }
    input.removeAttribute('aria-invalid');
    if (err) err.hidden = true;
    location.href = '/u/' + encodeURIComponent(v);
  });
}
