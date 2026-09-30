import { $, api, note, sol, wallet, isHandle, NOT_PROFILES } from '/common.js';

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

/**
 * What is wrong with the form, as { field, text }, or null. Checked before the wallet is asked to
 * connect, with the same rules the server applies, so nobody approves a connection for a launch
 * that cannot go through.
 */
function problem() {
  const u = $('#username').value.replace(/^@/, '').trim().toLowerCase();
  if (u !== $('#username').value || $('#at').textContent !== (u ? '@' + u : '@…')) setUser(u);
  if (!u) return { field: 'username', text: 'Enter the Instagram username of the account the coin is for.' };
  if (NOT_PROFILES.has(u)) return { field: 'username', text: `instagram.com/${u} is a page of Instagram's own, not an account. Enter the creator's username.` };
  if (!isHandle(u)) return { field: 'username', text: `@${u} can't be an Instagram username: use up to 30 letters, numbers, dots and underscores, with no dot at the start or end and no two dots in a row.` };
  const name = $('#name').value.trim();
  if (!name) return { field: 'name', text: 'Give the coin a name.' };
  if (name.length > 32) return { field: 'name', text: 'The coin name is at most 32 characters.' };
  if (!/^[A-Z0-9]{1,10}$/.test($('#symbol').value.trim().toUpperCase())) return { field: 'symbol', text: 'The ticker is 1 to 10 letters or digits, like LOAF.' };
  if (!$('#image').files[0] && !picUrl) return { field: 'image', text: 'Choose an image for the coin.' };
  const buy = Number($('#buy').value || 0);
  if (!(buy >= 0 && buy <= 50)) return { field: 'buy', text: 'Your first buy is between 0 and 50 SOL.' };
  return null;
}
const FIELDS = ['username', 'name', 'symbol', 'image', 'buy'];
for (const id of FIELDS) $('#' + id).addEventListener('input', (e) => e.target.setCustomValidity(''));

$('#f').addEventListener('submit', async (e) => {
  e.preventDefault();
  // The page fills some fields itself (the name and ticker from the username), which fires no
  // input event, so an old message could stay on a field that is now right: clear them all first.
  for (const id of FIELDS) $('#' + id).setCustomValidity('');
  const bad = problem();
  if (bad) {
    const field = $('#' + bad.field);
    field.setCustomValidity(bad.text);
    field.reportValidity();
    field.focus();
    return note(msg, 'err', bad.text);
  }
  const w = wallet();
  if (!w) return note(msg, 'err', 'Install a Solana wallet such as Phantom or Solflare, then reload this page.');
  const go = $('#go');
  go.disabled = true;
  try {
    note(msg, 'warn', 'Connecting your wallet…');
    const { publicKey } = await w.connect();
    const file = $('#image').files[0];

    note(msg, 'warn', 'Preparing the coin…');
    const prep = await api('/api/launch/prepare', {
      username: $('#username').value, name: $('#name').value, symbol: $('#symbol').value,
      description: $('#description').value, devBuySol: Number($('#buy').value || 0),
      launcher: publicKey.toString(),
      ...(file ? { imageBase64: await readFile(file) } : { imageUrl: picUrl }),
    });

    // The wallet signs first, as Phantom asks; the server then adds the coin address's signature
    // (after checking the wallet changed nothing that matters) and sends it.
    note(msg, 'warn', 'Approve the launch in your wallet.');
    const tx = solanaWeb3.VersionedTransaction.deserialize(Uint8Array.from(atob(prep.tx), (c) => c.charCodeAt(0)));
    const walletSigned = await w.signTransaction(tx);
    let bin = '';
    for (const b of walletSigned.serialize()) bin += String.fromCharCode(b);
    note(msg, 'warn', 'Sending the launch…');
    const { signature } = await api('/api/launch/submit', { mint: prep.mint, tx: btoa(bin) });

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
