import { $, api, note, sol, wallet } from '/common.js';

let claimToken = null;

$('#begin').addEventListener('click', async () => {
  try {
    const v = await api('/api/verify/start', {});
    $('#start').hidden = true;
    $('#dm').hidden = false;
    $('#code').textContent = v.code;
    $('#bot').textContent = '@' + v.botUsername;
    $('#bot').href = `https://ig.me/m/${v.botUsername}`;
    poll(v.id);
  } catch (e) { note($('#msg0'), 'err', e.message); }
});

$('#copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('#code').textContent).catch(() => {});
  $('#copy').textContent = 'Copied';
});

async function poll(id) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    let s;
    try { s = await api('/api/verify/' + encodeURIComponent(id)); } catch { continue; }
    if (s.status === 'expired') return note($('#wait'), 'err', 'The code expired. Reload the page for a new one.');
    if (s.status === 'verified') return showPay(s);
  }
}

function showPay(s) {
  claimToken = s.claimToken;
  $('#dm').hidden = true;
  $('#pay').hidden = false;
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
  const w = wallet();
  if (w?.isConnected && w.publicKey) $('#dest').value = w.publicKey.toString();
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
