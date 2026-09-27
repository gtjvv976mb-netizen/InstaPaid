import { $, api, copyButton, wireLookup } from '/common.js';

const status = $('#copy-status');

// ---- The bot's username, from the server (#bot and #cmd, and every [data-bot]) ----
api('/api/config').then((c) => {
  const at = '@' + c.botUsername;
  $('#bot').textContent = at;
  for (const el of document.querySelectorAll('[data-bot]')) el.textContent = at;
  const cmd = $('#cmd');
  cmd.replaceChildren(Object.assign(document.createElement('b'), { textContent: at }), ' make a token for this creator');
}).catch(() => {});

// ---- Copy the command: label, spoken status, textarea fallback, "press and hold" if both fail ----
for (const btn of document.querySelectorAll('[data-copy]')) {
  const source = $(btn.dataset.copy);
  copyButton(btn, { text: () => source.textContent.trim(), status, source });
}

// ---- "See a creator's page" ----
for (const form of document.querySelectorAll('[data-lookup]')) wireLookup(form);

// ---- The reply thread: armed now, played when the stage is in view, replayable ----
const stage = $('[data-stage]');
const replay = () => { stage.classList.remove('play'); void stage.offsetWidth; stage.classList.add('play'); };
stage.classList.add('armed');
$('[data-replay]').addEventListener('click', replay);

// ---- Motion budget: pause animations that are off-screen; play the thread the first time it shows ----
if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      e.target.classList.toggle('paused', !e.isIntersecting);
      if (e.target === stage && e.isIntersecting && !stage.classList.contains('play')) stage.classList.add('play');
    }
  }, { rootMargin: '0px 0px -12% 0px' });
  for (const el of document.querySelectorAll('[data-motion]')) io.observe(el);
} else {
  stage.classList.add('play');
}

// ---- The loop in "How it works": decorative. It plays only while on screen, and never under
//      Reduce Motion (then the poster stays; the inline script by the video stops the autoplay). ----
const loop = $('[data-loop]');
if (loop) {
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  let onScreen = false;
  const sync = () => {
    if (still.matches || !onScreen) { if (!loop.paused) loop.pause(); return; }
    if (loop.paused) loop.play().catch(() => { /* no autoplay or no codec: the poster stays */ });
  };
  still.addEventListener?.('change', () => {
    if (still.matches) { loop.removeAttribute('autoplay'); loop.pause(); loop.load(); } // back to the poster
    sync();
  });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; sync(); }, { threshold: 0.05 }).observe(loop);
  } else { onScreen = true; sync(); }
}

// ---- Recently launched: live coins from /api/recent replace the examples ----
const list = $('#recent-list');
const more = $('#recent-more');
const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
const svgUse = (id) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  u.setAttribute('href', '/icons.svg#' + id);
  s.append(u);
  return s;
};
function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400 * 1.5) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
/** The Instagram post a coin was named from, only when it really is an instagram.com address. */
function postUrl(v) {
  try {
    const x = new URL(String(v || ''));
    return x.protocol === 'https:' && (x.hostname === 'www.instagram.com' || x.hostname === 'instagram.com') ? x.href : null;
  } catch { return null; }
}
function card(t, i) {
  const u = encodeURIComponent(t.username);
  const post = postUrl(t.post_permalink);
  const top = el('div', { className: 'cc-top' },
    el('span', { className: `coin-ava c${(i % 6) + 1}`, textContent: (t.symbol || t.name || '?').slice(0, 1).toUpperCase() }),
    el('span', { className: 'cc-name' }, el('b', { textContent: t.name }), el('span', { className: 'tick', textContent: '$' + t.symbol })));
  top.firstChild.setAttribute('aria-hidden', 'true');
  const pump = el('a', { className: 'cc-pump', href: `https://pump.fun/coin/${encodeURIComponent(t.mint)}`, target: '_blank', rel: 'noopener' },
    'pump.fun', svgUse('out'));
  pump.setAttribute('aria-label', `$${t.symbol} on pump.fun (opens in a new tab)`);
  const links = el('p', { className: 'cc-links' });
  if (post) {
    const a = el('a', { className: 'cc-pump', href: post, target: '_blank', rel: 'noopener' }, 'Original post', svgUse('out'));
    a.setAttribute('aria-label', `The Instagram post $${t.symbol} was named from (opens in a new tab)`);
    links.append(a);
  }
  links.append(pump);
  // Lore is optional and only ever a fan's own words; without it, say where the name came from.
  const about = t.lore
    ? el('p', { className: 'cc-lore' }, el('span', { className: 'cc-lore-k', textContent: 'Fan lore' }), el('span', { className: 'cc-lore-t', textContent: t.lore }))
    : post ? el('p', { className: 'cc-src' }, svgUse('post'), 'Named from the post') : null;
  return el('li', { className: 'coin-card' },
    top,
    el('p', { className: 'cc-for' }, 'for ', el('a', { className: 'cc-link', href: `/u/${u}`, textContent: '@' + t.username })),
    ...(about ? [about] : []),
    el('p', { className: 'cc-meta' },
      el('span', { className: `status ${t.claimed ? 'claimed' : 'open'}`, textContent: t.claimed ? 'Claimed' : 'Not claimed yet' }),
      el('span', { className: 'fan-made', textContent: 'Fan-made' })),
    el('p', { className: 'cc-when', textContent: 'Launched ' + ago(t.created_at) }),
    links);
}
api('/api/recent').then(({ tokens }) => {
  if (!Array.isArray(tokens) || !tokens.length) { $('#recent-empty').hidden = false; return; }
  list.replaceChildren(...tokens.map(card));
  delete list.dataset.examples;
  $('#recent-tag').hidden = true;
  if (tokens.length > 6) {
    more.hidden = false;
    more.textContent = `Show ${tokens.length - 6} more`;
    more.addEventListener('click', () => { list.classList.add('show-all'); more.hidden = true; list.children[6]?.querySelector('a')?.focus(); });
  }
}).catch(() => { /* keep the labelled examples */ });
