import { $, api, note, sol, wallet } from '/common.js';

const q = new URLSearchParams(location.search);
const msg = $('#msg');
let picUrl = q.get('pic') || '';

function setUser(u) {
  u = u.replace(/^@/, '').trim().toLowerCase();
  $('#username').value = u;
  $('#at').textContent = u ? '@' + u : '@…';
  if (!$('#name').dataset.touched) $('#name').value = u ? `${u}` : '';
  if (!$('#symbol').dataset.touched) $('#symbol').value = u.replace(/[^a-z0-9]/g, '').slice(0, 10).toUpperCase();
  // The preview's status pill says what /u/<name> says, once the server has answered for this name.
  const pill = $('#pv-status');
  pill.hidden = true;
  if (u) api('/api/accounts/' + encodeURIComponent(u)).then((a) => {
    if ($('#username').value !== u) return; // the name changed while this was on its way
    $('#waiting').textContent = a.tokens.length
      ? `${a.tokens.length} coin${a.tokens.length > 1 ? 's' : ''} already · ${sol(a.pendingLamports)} SOL waiting${a.verified ? ' · verified' : ''}`
      : 'No coins yet — this will be the first.';
    pill.className = `status ${a.verified ? 'claimed' : 'open'}`;
    pill.textContent = a.verified ? 'Claimed' : 'Not claimed yet';
    pill.hidden = false;
  }).catch(() => { if ($('#username').value === u) $('#waiting').textContent = ''; });
}
// The extension passes the profile picture's CDN address. It shows once it has loaded; if it is
// missing or expired it stays hidden and is forgotten, so the form asks for an image instead.
if (picUrl) {
  const pic = $('#pic');
  pic.addEventListener('load', () => { pic.hidden = false; }, { once: true });
  pic.addEventListener('error', () => { picUrl = ''; pic.hidden = true; pic.removeAttribute('src'); }, { once: true });
  pic.src = picUrl;
}
for (const id of ['name', 'symbol']) $('#' + id).addEventListener('input', (e) => { e.target.dataset.touched = '1'; });
$('#username').addEventListener('change', (e) => setUser(e.target.value));
setUser(q.get('u') || '');

const readFile = (file) => new Promise((ok, bad) => {
  const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = bad; r.readAsDataURL(file);
});

$('#f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const w = wallet();
  if (!w) return note(msg, 'err', 'Install a Solana wallet such as Phantom or Solflare, then reload this page.');
  const go = $('#go');
  go.disabled = true;
  try {
    note(msg, 'warn', 'Connecting your wallet…');
    const { publicKey } = await w.connect();
    const file = $('#image').files[0];
    if (!file && !picUrl) throw new Error('Choose an image for the coin.');

    note(msg, 'warn', 'Preparing the coin…');
    const prep = await api('/api/launch/prepare', {
      username: $('#username').value, name: $('#name').value, symbol: $('#symbol').value,
      description: $('#description').value, devBuySol: Number($('#buy').value || 0),
      launcher: publicKey.toString(),
      ...(file ? { imageBase64: await readFile(file) } : { imageUrl: picUrl }),
    });

    note(msg, 'warn', 'Approve the launch in your wallet.');
    const tx = solanaWeb3.VersionedTransaction.deserialize(Uint8Array.from(atob(prep.tx), (c) => c.charCodeAt(0)));
    const { signature } = await w.signAndSendTransaction(tx);

    note(msg, 'warn', 'Sent. Waiting for Solana to confirm…');
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        await api('/api/launch/confirm', { mint: prep.mint, signature });
        msg.className = 'note ok';
        msg.innerHTML = '';
        msg.append('Live on pump.fun. ');
        const a = Object.assign(document.createElement('a'), { href: `https://pump.fun/coin/${prep.mint}`, target: '_blank', rel: 'noopener', textContent: 'Open the coin' });
        msg.append(a, ' · ');
        msg.append(Object.assign(document.createElement('a'), { href: `/u/${$('#username').value}`, textContent: 'See the account page' }));
        return;
      } catch (err) { if (err.status !== 409) throw err; }
    }
    throw new Error('Solana has not confirmed it yet. Check your wallet; if it went through, the coin appears on the account page shortly.');
  } catch (err) {
    note(msg, 'err', err.message || String(err));
  } finally {
    go.disabled = false;
  }
});
