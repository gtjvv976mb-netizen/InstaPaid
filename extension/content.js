// Adds "Launch a coin" to Instagram profile pages. Instagram is a single-page app, so this
// watches the URL and the header, and redraws when either changes.
(() => {
  const NOT_PROFILES = new Set(['explore', 'reels', 'reel', 'p', 'stories', 'direct', 'accounts', 'about',
    'legal', 'developer', 'web', 'emails', 'challenge', 'tv', 'privacy', 'session', 'oauth', 'api', 'static',
    'graphql', 'ar', 'lite', 'download', 'directory', 'topics', 'your_activity', 'threads']);
  const RE = /^(?!\.)(?!.*\.\.)(?!.*\.$)[a-z0-9._]{1,30}$/;

  function profileHandle() {
    const seg = location.pathname.split('/').filter(Boolean);
    if (!seg.length || seg.length > 2) return null;
    if (seg.length === 2 && !['tagged', 'reels', 'saved'].includes(seg[1])) return null;
    const h = seg[0].toLowerCase();
    return RE.test(h) && !NOT_PROFILES.has(h) ? h : null;
  }

  function profilePicture() {
    const img = document.querySelector('header img');
    return img?.src && img.src.startsWith('https://') ? img.src : '';
  }

  const sol = (l) => (Number(BigInt(l || '0')) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 3 });

  let shownFor = null;

  function draw() {
    const handle = profileHandle();
    const header = document.querySelector('main header');
    const existing = document.getElementById('instapaid-bar');
    if (!handle || !header) { if (!handle) existing?.remove(); shownFor = null; return; }
    if (shownFor === handle && existing && header.contains(existing)) return;
    existing?.remove();
    shownFor = handle;

    const bar = document.createElement('div');
    bar.id = 'instapaid-bar';
    const launch = document.createElement('button');
    launch.type = 'button';
    launch.className = 'instapaid-btn';
    launch.textContent = 'Launch a coin';
    launch.addEventListener('click', () => {
      const q = new URLSearchParams({ u: handle });
      const pic = profilePicture();
      if (pic) q.set('pic', pic);
      chrome.runtime.sendMessage({ type: 'open', path: `/launch?${q}` });
    });
    const info = document.createElement('button');
    info.type = 'button';
    info.className = 'instapaid-info';
    info.textContent = '…';
    info.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'open', path: `/u/${handle}` }));
    bar.append(launch, info);
    header.append(bar);

    chrome.runtime.sendMessage({ type: 'account', username: handle }, (r) => {
      if (shownFor !== handle) return;
      if (!r?.ok) { info.textContent = 'InstaPaid offline'; return; }
      const n = r.data.tokens.length;
      info.textContent = n
        ? `${n} coin${n > 1 ? 's' : ''} · ${sol(r.data.pendingLamports)} SOL for @${handle}${r.data.verified ? ' ✓' : ''}`
        : 'No coins yet';
    });
  }

  let t;
  new MutationObserver(() => { clearTimeout(t); t = setTimeout(draw, 250); })
    .observe(document.body, { childList: true, subtree: true });
  draw();
})();
