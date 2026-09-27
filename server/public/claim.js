import { $, api, note, sol, wallet, copyButton } from '/common.js';

let claimToken = null;
let feeBps = null; // unknown until /api/config answers; the pay card waits for it

const loadConfig = () => api('/api/config').then((c) => {
  feeBps = Number(c.platformFeeBps) || 0;
  for (const el of document.querySelectorAll('[data-bot]')) el.textContent = '@' + c.botUsername;
});
loadConfig().catch(() => {});

/** The step indicator at the top: 1 get a code, 2 DM it, 3 choose a wallet. */
function step(n) {
  [...$('#progress').children].forEach((li, i) => {
    li.classList.toggle('on', i === n - 1);
    li.classList.toggle('done', i < n - 1);
    if (i === n - 1) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
  });
}

$('#begin').addEventListener('click', async () => {
  try {
    const v = await api('/api/verify/start', {});
    $('#start').hidden = true;
    $('#dm').hidden = false;
    $('#code').textContent = v.code;
    $('#bot').textContent = '@' + v.botUsername;
    $('#bot').href = `https://ig.me/m/${v.botUsername}`;
    $('#open-dm').href = $('#bot').href;
    $('#open-dm').hidden = false;
    step(2);
    $('#dm').querySelector('h2').setAttribute('tabindex', '-1');
    $('#dm').querySelector('h2').focus();
    poll(v.id);
  } catch (e) { note($('#msg0'), 'err', e.message); }
});

// Big and easy to copy: the clipboard, then a textarea, then "press and hold" with the code selected.
copyButton($('#copy'), { text: () => $('#code').textContent.trim(), status: $('#copy-status'), source: $('#code') });

async function poll(id) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    let s;
    try { s = await api('/api/verify/' + encodeURIComponent(id)); } catch { continue; }
    if (s.status === 'expired') return note($('#wait'), 'err', 'The code expired. Reload the page for a new one.');
    if (s.status === 'verified') return showPay(s);
  }
}

async function showPay(s) {
  claimToken = s.claimToken;
  $('#dm').hidden = true;
  $('#pay').hidden = false;
  step(3);
  $('#me').textContent = '@' + s.username;
  const ul = $('#accts');
  ul.replaceChildren();
  if (!s.accounts.length) {
    ul.append(Object.assign(document.createElement('li'), { textContent: 'No coins have been launched for this account yet.' }));
    $('#claim').disabled = true;
  }
  for (const a of s.accounts) {
    const li = document.createElement('li');
    li.append(Object.assign(document.createElement('span'), { textContent: '@' + a.username }));
    li.append(Object.assign(document.createElement('b'), { textContent: sol(a.pendingLamports) + ' SOL' }));
    ul.append(li);
  }
  // Any platform share is shown before anything is sent.
  const share = $('#share');
  share.hidden = false;
  for (let i = 0; feeBps === null && i < 3; i++) await loadConfig().catch(() => new Promise((r) => setTimeout(r, 1500)));
  if (feeBps === null) {
    share.textContent = 'We could not check the platform share. Reload the page before sending.';
    $('#claim').disabled = true;
    return;
  }
  share.textContent = feeBps > 0
    ? `InstaPaid keeps a ${(feeBps / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}% platform share of what is sent. You receive the rest.`
    : 'No platform share: the whole balance is sent to your wallet.';
  const w = wallet();
  if (w?.isConnected && w.publicKey) $('#dest').value = w.publicKey.toString();
  $('#pay').querySelector('h2').setAttribute('tabindex', '-1');
  $('#pay').querySelector('h2').focus();
}

$('#claim').addEventListener('click', async () => {
  const btn = $('#claim');
  btn.disabled = true;
  note($('#msg'), 'warn', 'Collecting and sending… this takes up to a minute.');
  try {
    const r = await api('/api/claim', { claimToken, destination: $('#dest').value.trim() });
    const lines = r.results.map((x) => x.error ? `@${x.username}: ${x.error}` : `@${x.username}: ${sol(x.lamports)} SOL sent`);
    note($('#msg'), r.results.some((x) => x.error) ? 'warn' : 'ok', lines.join('\n'));
    $('#msg').style.whiteSpace = 'pre-line';
  } catch (e) {
    note($('#msg'), 'err', e.message);
  } finally {
    btn.disabled = false;
  }
});
