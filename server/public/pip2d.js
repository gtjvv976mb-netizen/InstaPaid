// Pip lives in the site: an HD 2D axolotl (drawn with Nano Banana Pro, animated with Kling on a green
// screen and keyed into sprite sheets, media/pip-*.webp) who stands on the page itself. The top edges
// of headings, cards, buttons and pictures are his ground: he walks along them and leaps from one to
// another, so he scrolls with the page like part of it. Every move is staged: he crouches before a
// leap, stretches in the air, squashes and kicks up dust on landing, and his shadow sits on whatever
// is under him. He hops onto buttons and stomps them (a dip, a glow, sparkles: never a real click),
// tells you what they do, waves, looks around, dances and cheers. Scroll away and he drops in from
// above onto something you can see. Tap him, drag him (he falls onto whatever is below when let go),
// or send him off for the visit with the ×. Only Pip himself takes the pointer.
//
// startPip2D(from) → Promise<boolean>: `from` is the drawn Pip's slot, where he first appears.

const SPRITES = '/media/pip-sprites.json?v=68b35fca';
const LINES = {
  hello: ['Hi! I’m Pip 👋', 'Welcome to InstaPaid!', 'Come explore with me!'],
  tap: ['Hehe, that tickles!', 'Comment. Coin. Claim!', 'Only the creator gets the fees.', 'Tag @instapaid.official under any post.', 'I name coins after the post!'],
  launch: ['This one launches a coin! 🚀', 'Pick a creator, name the coin, done!'],
  claim: ['Creators claim their fees here 💰', 'One DM and the fees are yours!'],
  copy: ['Copy this, comment it on any post!', 'That’s the magic comment ✨'],
  other: ['Ooh, what does this do?', 'Boop!'],
  drop: ['Whoa, put me down! 😆', 'Wheee!'],
  arrive: ['Found you!', 'Wait for me!', 'I’m here!', 'Hi again!'],
  bye: ['Bye for now! 👋'],
};
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const easeInOut = (u) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);
const frameWait = () => new Promise((r) => requestAnimationFrame(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Elements whose top edge can be ground. Measured when a move is chosen, so they are always current.
const GROUND = 'main h1, main h2, main h3, main .btn, main button.copy, main img, main video, main figure, main .card, main .coin-card, main article, main li, main pre, main blockquote, main .phone, main .step, main [class*="card"], main [class*="box"], main [class*="panel"], main details, main form, footer .foot-brand';

const CSS = `
.pip2d{position:absolute;left:0;top:0;z-index:15;width:var(--pw);height:var(--ph);pointer-events:none;will-change:transform;transition:opacity .4s}
.pip2d-body{position:absolute;inset:8% 14% 0;pointer-events:auto;cursor:grab;touch-action:none;-webkit-tap-highlight-color:transparent;outline:none;border-radius:40%}
.pip2d-body:focus-visible{box-shadow:0 0 0 3px rgba(255,122,89,.7)}
.pip2d.is-held .pip2d-body{cursor:grabbing}
.pip2d-squash{position:absolute;inset:0;transform-origin:50% 100%;will-change:transform}
.pip2d-sprite{position:absolute;left:50%;bottom:0;background-repeat:no-repeat;transform-origin:50% 100%;pointer-events:none;filter:drop-shadow(0 6px 10px rgba(0,0,0,.28))}
.pip2d-shadow{position:absolute;left:0;top:0;z-index:14;width:var(--sw);height:14px;border-radius:50%;background:radial-gradient(closest-side,rgba(0,0,0,.38),rgba(0,0,0,.12) 60%,transparent);pointer-events:none;will-change:transform,opacity}
.pip2d-say{position:absolute;left:50%;bottom:calc(100% + 2px);transform:translate(-50%,8px) scale(.85);opacity:0;pointer-events:none;background:#fff3ea;color:#2a1215;font:600 14px/1.35 Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:9px 13px;border-radius:16px;box-shadow:0 14px 34px -12px rgba(0,0,0,.55);width:max-content;max-width:min(230px,70vw);text-align:center;transition:transform .35s cubic-bezier(.2,1.2,.3,1),opacity .25s ease}
.pip2d-say::after{content:"";position:absolute;left:calc(50% - var(--nudge,0px));top:100%;margin-left:-7px;border:7px solid transparent;border-top-color:#fff3ea;border-bottom:0}
.pip2d.is-say .pip2d-say{opacity:1;transform:translate(-50%,0) scale(1)}
.pip2d-x{position:absolute;right:6%;top:4%;width:26px;height:26px;border-radius:50%;border:0;background:rgba(26,17,20,.85);color:#fff3ea;font:700 15px/26px system-ui,sans-serif;cursor:pointer;opacity:0;pointer-events:auto;transition:opacity .25s;padding:0}
.pip2d:hover .pip2d-x,.pip2d-x:focus-visible{opacity:1}
@media (hover:none){.pip2d-x{opacity:.75;width:24px;height:24px}}
.pip2d-stomped{transition:transform .08s ease-out,box-shadow .35s ease!important;transform:translateY(3px) scale(.97)!important;box-shadow:0 0 0 4px rgba(255,122,89,.45),0 0 34px rgba(255,122,89,.6)!important}
.pip2d-fx{position:absolute;z-index:16;pointer-events:none;border-radius:50%}
.pip2d-dust{width:14px;height:10px;background:rgba(255,236,226,.55);animation:pip2d-dust .55s ease-out forwards}
@keyframes pip2d-dust{0%{opacity:.9;transform:translate(0,0) scale(.5)}100%{opacity:0;transform:translate(var(--dx),-10px) scale(1.6)}}
.pip2d-spark{width:9px;height:9px;background:#ffd2b0;box-shadow:0 0 8px #ff9a7e;animation:pip2d-spark .7s cubic-bezier(.2,.8,.3,1) forwards}
@keyframes pip2d-spark{0%{opacity:1;transform:translate(0,0) scale(1)}100%{opacity:0;transform:translate(var(--dx),var(--dy)) scale(.2)}}
.pip2d-pop{width:10px;height:10px;border:3px solid #ffd2b0;background:transparent;animation:pip2d-pop .6s ease-out forwards}
@keyframes pip2d-pop{0%{opacity:1;transform:scale(1)}100%{opacity:0;transform:scale(12)}}
`;

export async function startPip2D(from) {
  let meta;
  const ready = new Set();
  const load = (n) => new Promise((ok, bad) => {
    const img = new Image();
    img.onload = () => { const done = () => { ready.add(n); ok(); }; (img.decode ? img.decode().then(done, done) : done()); };
    img.onerror = bad;
    img.src = `/media/pip-${n}.webp?v=${meta.v || 1}`;
  });
  try {
    meta = await (await fetch(SPRITES)).json();
    // He appears once he can stand, walk and wave; the other moves join as they arrive. Every sheet
    // is decoded first, so a move never starts on a blank frame.
    await Promise.all(['idle', 'walk', 'wave'].map(load));
  } catch { return false; }
  Object.keys(meta.clips).filter((n) => !ready.has(n)).reduce((p, n) => p.then(() => load(n)).catch(() => {}), Promise.resolve());
  try { if (sessionStorage.getItem('pip2d.away') === '1') return true; } catch { /* storage off: he stays */ }

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const small = matchMedia('(max-width: 640px)').matches;
  const PH = small ? 112 : 156;
  const front = meta.clips.idle;
  const PW = Math.round((front.w / front.h) * PH);

  const el = document.createElement('div');
  el.className = 'pip2d';
  el.style.setProperty('--pw', `${PW}px`);
  el.style.setProperty('--ph', `${PH}px`);
  el.innerHTML = `<div class="pip2d-squash"><div class="pip2d-sprite"></div></div><div class="pip2d-body" role="img" tabindex="0" aria-label="Pip, the InstaPaid axolotl, exploring the page. Press Enter to make him jump; drag him anywhere."></div><div class="pip2d-say" aria-live="polite"></div><button class="pip2d-x" type="button" aria-label="Send Pip away for this visit">×</button>`;
  const shadow = document.createElement('div');
  shadow.className = 'pip2d-shadow';
  shadow.style.setProperty('--sw', `${Math.round(PW * 0.62)}px`);
  document.body.append(shadow, el);
  const body = el.querySelector('.pip2d-body'), squash = el.querySelector('.pip2d-squash'), sprite = el.querySelector('.pip2d-sprite'), say = el.querySelector('.pip2d-say');

  // ---- Sprite player.
  let clip = 'idle', frame = 0, frameT = 0, loop = true, onEnd = null, face = 1, rate = 1.3;
  const show = () => {
    const c = meta.clips[clip];
    const h = Math.round(PH * (c.src / front.src)), w = Math.round(h * (c.w / c.h));
    sprite.style.width = `${w}px`;
    sprite.style.height = `${h}px`;
    sprite.style.marginLeft = `${-w / 2}px`;
    sprite.style.backgroundImage = `url(/media/pip-${clip}.webp?v=${meta.v || 1})`;
    sprite.style.backgroundSize = `${w * c.cols}px auto`;
    sprite.style.backgroundPosition = `${-(frame % c.cols) * w}px ${-Math.floor(frame / c.cols) * h}px`;
    sprite.style.transform = `scaleX(${face})`;
  };
  const play = (name, { once = false, speed = 1.3 } = {}) => new Promise((done) => {
    if (!ready.has(name)) name = once ? 'wave' : 'idle';
    if (onEnd) { const f = onEnd; onEnd = null; f(); }
    clip = name; frame = 0; frameT = 0; loop = !once; rate = speed;
    onEnd = once ? done : null;
    if (!once) done();
    show();
  });

  // Squash and stretch: a scale the frame clock springs back to 1.
  let sq = { x: 1, y: 1 };
  const squish = (sx, sy) => { sq = { x: sx, y: sy }; };

  // ---- Where he is: document coordinates of the bottom-centre of his feet.
  const docW = () => document.documentElement.clientWidth;
  let x = 0, y = 0, lift = 0, shadowY = 0; // lift: his height above the ground under him
  let ground = null, groundDX = 0; // the element he stands on, and his offset from its left edge
  const place = () => {
    el.style.transform = `translate(${Math.round(x - PW / 2)}px, ${Math.round(y - PH)}px)`;
    const k = clamp(1 - lift / 360, 0.35, 1);
    shadow.style.transform = `translate(${Math.round(x - PW * 0.31)}px, ${Math.round(shadowY - 7)}px) scale(${k.toFixed(3)})`;
    shadow.style.opacity = (0.25 + 0.75 * k).toFixed(3);
  };

  // ---- The ground: top edges of real elements, with room above them.
  const rectDoc = (e) => { const r = e.getBoundingClientRect(); return { l: r.left + scrollX, r: r.right + scrollX, t: r.top + scrollY, b: r.bottom + scrollY, w: r.width, h: r.height, vt: r.top }; };
  // Something he would bump into: words, a picture, a control. Plain layout boxes (a section, a
  // grid, a list) are open air to him, however much of the page they cover.
  const SOLID = 'img, video, svg, canvas, button, a, input, select, textarea, label, h1, h2, h3, h4, p, pre, code, blockquote, .btn, .card, [class*="card"]';
  const solid = (n) => {
    if (n.matches(SOLID)) return true;
    for (const c of n.childNodes) if (c.nodeType === 3 && c.textContent.trim()) return true;
    return false;
  };
  const openAbove = (e, r) => {
    // The element must be the thing actually showing at its top edge (not covered by something),
    // and just above that edge nothing solid may sit but what it lies in. His body may stand in
    // front of the words above: he is a character on the page, not in its flow.
    const was = el.style.visibility;
    el.style.visibility = 'hidden';
    try {
      const button = e.matches('.btn, button');
      for (const fx of [0.35, 0.5, 0.65]) {
        const px = r.l - scrollX + r.w * fx;
        const own = document.elementFromPoint(px, r.vt + Math.min(4, r.h / 2));
        if (!own || !(own === e || e.contains(own))) return false;
        if (button) continue;
        const py = r.vt - 6;
        if (py < 64) return false; // under the sticky header
        const hit = document.elementFromPoint(px, py);
        if (!hit || hit === e || hit.contains(e) || el.contains(hit)) continue;
        if (hit.closest('header') || solid(hit)) return false;
      }
      return true;
    } finally { el.style.visibility = was; }
  };
  const grounds = () => {
    const vh = innerHeight, out = [];
    for (const e of document.querySelectorAll(GROUND)) {
      const r = rectDoc(e);
      if (r.w < PW * 0.9 || r.h < 20) continue;
      if (r.vt < 60 + PH * 0.7 || r.vt > vh - 20) continue; // his head clear of the sticky header
      const cs = getComputedStyle(e);
      if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
      if (!openAbove(e, r)) continue;
      out.push({ e, r });
    }
    return out;
  };
  // When nothing in view qualifies: the top of any wide block in view (a section, the footer).
  const fallbackGrounds = () => {
    const vh = innerHeight, out = [];
    for (const e of document.querySelectorAll('main section, main > *, main .wrap, footer')) {
      const r = rectDoc(e);
      if (r.w < PW * 1.5 || r.vt < 60 + PH * 0.7 || r.vt > vh - 40) continue;
      out.push({ e, r });
    }
    return out;
  };
  const standOn = (e, px) => {
    ground = e;
    const r = rectDoc(e);
    groundDX = clamp(px - r.l, Math.min(PW * 0.35, r.w / 2), Math.max(r.w - PW * 0.35, r.w / 2));
  };
  // Follow the ground as the page shifts (images load, sections open): he stays on his element.
  let held = false, stopped = false, airborne = false;
  const stick = () => {
    if (!ground || held || airborne) return;
    if (!ground.isConnected) { ground = null; return; }
    const r = rectDoc(ground);
    if (r.w === 0) { ground = null; return; }
    x = r.l + groundDX; y = r.t; shadowY = y; lift = 0;
  };

  // ---- Speech: a bubble that types itself out, kept on screen.
  let sayT = 0, typeT = 0;
  const talk = (text, ms = 2600) => {
    clearInterval(typeT);
    say.textContent = '';
    el.classList.add('is-say');
    let i = 0;
    typeT = setInterval(() => { say.textContent = text.slice(0, ++i); if (i >= text.length) clearInterval(typeT); }, 22);
    requestAnimationFrame(() => {
      const r = el.getBoundingClientRect();
      const half = Math.min(230, docW() * 0.7) / 2;
      const c = r.left + r.width / 2;
      const dx = c - half < 8 ? 8 - (c - half) : c + half > docW() - 8 ? docW() - 8 - (c + half) : 0;
      say.style.marginLeft = `${dx}px`;
      say.style.setProperty('--nudge', `${dx}px`);
    });
    clearTimeout(sayT);
    sayT = setTimeout(() => el.classList.remove('is-say'), ms + text.length * 22);
  };

  // ---- Effects.
  const fx = (cls, px, py, vars = {}, ms = 700) => {
    const d = document.createElement('i');
    d.className = `pip2d-fx ${cls}`;
    d.style.left = `${px}px`; d.style.top = `${py}px`;
    for (const [k, v] of Object.entries(vars)) d.style.setProperty(k, v);
    document.body.appendChild(d);
    setTimeout(() => d.remove(), ms);
  };
  const dust = (px, py, n = 6) => { for (let i = 0; i < n; i++) fx('pip2d-dust', px - 7 + rand(-PW * 0.2, PW * 0.2), py - 8, { '--dx': `${(i % 2 ? 1 : -1) * rand(18, 46)}px` }, 600); };
  const sparkle = (px, py, n = 12) => {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rand(-0.2, 0.2);
      fx('pip2d-spark', px - 4, py - 4, { '--dx': `${Math.cos(a) * rand(34, 70)}px`, '--dy': `${Math.sin(a) * rand(34, 70)}px` });
    }
  };

  // ---- Moves. Each one is staged and returns when it is over.
  const alive = () => !stopped && !held;

  // Walk along the ground to px, easing in and out, the cycle facing the way he goes.
  const walkTo = async (px) => {
    if (!ground) return;
    const r = rectDoc(ground);
    const target = clamp(px - r.l, Math.min(PW * 0.35, r.w / 2), Math.max(r.w - PW * 0.35, r.w / 2));
    const d = target - groundDX;
    if (Math.abs(d) < 6) return;
    face = d > 0 ? 1 : -1;
    await play('walk', { speed: 1.15 });
    const dur = Math.abs(d) / (small ? 95 : 120) + 0.35;
    const g0 = groundDX, t0 = performance.now();
    while (alive() && ground) {
      const u = Math.min(1, (performance.now() - t0) / 1000 / dur);
      groundDX = g0 + d * easeInOut(u);
      if (u >= 1) break;
      await frameWait();
    }
    await play('idle');
  };

  // Leap in an arc to (tx, ty): anticipation, stretch on the way up, squash and dust on landing.
  const leapTo = async (tx, ty, onto) => {
    face = tx >= x ? 1 : -1;
    squish(1.14, 0.84);
    await sleep(170);
    if (!alive()) return;
    airborne = true;
    ground = null;
    play('cheer', { speed: 1.6 });
    const x0 = x, y0 = y, dist = Math.hypot(tx - x0, ty - y0);
    const top = Math.min(y0, ty) - Math.max(70, 70 + dist * 0.12);
    const dur = clamp(0.55 + dist / 1100, 0.6, 1.3) * 1000;
    const a = y0 - top, b = ty - top, k = Math.sqrt(a) / (Math.sqrt(a) + Math.sqrt(b));
    const t0 = performance.now();
    squish(0.9, 1.12);
    while (!stopped) {
      if (held) { airborne = false; return; }
      const u = Math.min(1, (performance.now() - t0) / dur);
      // A true arc under gravity: up from y0 to the top, down to ty.
      x = x0 + (tx - x0) * u;
      y = u < k ? top + a * Math.pow(1 - u / k, 2) : top + b * Math.pow((u - k) / (1 - k), 2);
      shadowY = y0 + (ty - y0) * u;
      lift = Math.max(0, shadowY - y);
      if (u >= 1) break;
      await frameWait();
    }
    airborne = false;
    x = tx; y = ty; shadowY = ty; lift = 0;
    if (onto) standOn(onto, tx);
    squish(1.2, 0.78);
    dust(x, y);
    play('idle');
    await sleep(260);
  };

  // Drop in from above the screen onto something in view (when he has been scrolled away).
  const dropIn = async () => {
    let list = grounds();
    if (!list.length) list = fallbackGrounds();
    if (!list.length) return false;
    const vcx = scrollX + docW() / 2;
    list.sort((p, q) => Math.abs((p.r.l + p.r.r) / 2 - vcx) - Math.abs((q.r.l + q.r.r) / 2 - vcx));
    const g = list[Math.floor(rand(0, Math.min(3, list.length)))];
    const tx = clamp(rand(g.r.l + PW * 0.4, g.r.r - PW * 0.4), g.r.l + 10, g.r.r - 10);
    const ty = g.r.t;
    airborne = true; ground = null;
    x = tx; y = scrollY - 10; shadowY = ty; lift = ty - y;
    play('cheer', { speed: 1.6 });
    squish(0.88, 1.16);
    const t0 = performance.now(), y0 = y, dur = clamp(Math.sqrt((ty - y0) / 900), 0.45, 1.1) * 1000;
    while (!stopped && !held) {
      const u = Math.min(1, (performance.now() - t0) / dur);
      y = y0 + (ty - y0) * u * u; // falling
      lift = ty - y;
      if (u >= 1) break;
      await frameWait();
    }
    airborne = false;
    y = ty; lift = 0;
    standOn(g.e, tx);
    squish(1.24, 0.74);
    dust(x, y, 9);
    await play('idle');
    talk(pick(LINES.arrive), 1800);
    await sleep(350);
    return true;
  };

  // Leap to another piece of ground in view: near ones mostly.
  const explore = async () => {
    const list = grounds().filter((g) => g.e !== ground);
    const scored = list.map((g) => ({ g, d: Math.hypot((g.r.l + g.r.r) / 2 - x, g.r.t - y) }))
      .filter((s) => s.d > PW * 0.8 && s.d < (small ? 520 : 780)).sort((p, q) => p.d - q.d);
    if (!scored.length) return false;
    const { g } = scored[Math.floor(rand(0, Math.min(4, scored.length)))];
    const tx = clamp(x, g.r.l + PW * 0.4, g.r.r - PW * 0.4);
    await leapTo(tx, g.r.t, g.e);
    return true;
  };

  const lineFor = (b) => {
    const href = b.getAttribute('href') || '';
    if (href.includes('/launch')) return pick(LINES.launch);
    if (href.includes('/claim')) return pick(LINES.claim);
    if (b.matches('.copy, [data-copy]')) return pick(LINES.copy);
    return pick(LINES.other);
  };
  // Hop onto a button and stomp it: it dips, glows and sparkles. Never a real click.
  const recent = [];
  const stompButton = async () => {
    const list = grounds().filter((g) => g.e.matches('.btn, button.copy') && !recent.includes(g.e));
    if (!list.length) return false;
    const dist = (g) => Math.hypot((g.r.l + g.r.r) / 2 - x, g.r.t - y);
    const g = list.sort((p, q) => dist(p) - dist(q))[0];
    recent.push(g.e); if (recent.length > 3) recent.shift();
    await leapTo((g.r.l + g.r.r) / 2, g.r.t, g.e);
    if (!alive()) return true;
    for (let i = 0; i < 2 && alive(); i++) {
      squish(1.08, 0.9);
      await sleep(120);
      const t0 = performance.now();
      airborne = true;
      while (alive()) {
        const u = Math.min(1, (performance.now() - t0) / 260);
        const r = rectDoc(g.e);
        y = r.t - Math.sin(u * Math.PI) * 26; shadowY = r.t; lift = r.t - y;
        if (u >= 1) break;
        await frameWait();
      }
      airborne = false;
      squish(1.18, 0.8);
      g.e.classList.add('pip2d-stomped');
      const r = rectDoc(g.e);
      sparkle((r.l + r.r) / 2, (r.t + r.b) / 2, i ? 8 : 14);
      if (i === 0) talk(lineFor(g.e), 2400);
      await sleep(180);
      g.e.classList.remove('pip2d-stomped');
      await sleep(160);
    }
    await play('cheer', { once: true, speed: 1.8 });
    return true;
  };

  const moves = {
    explore: () => explore(),
    explore2: () => explore(),
    stroll: async () => { if (!ground) return; const r = rectDoc(ground); await walkTo(rand(r.l + PW * 0.4, r.r - PW * 0.4)); },
    wave: () => { talk(pick(LINES.hello)); return play('wave', { once: true, speed: 1.4 }); },
    look: () => play('look', { once: true, speed: 1.4 }),
    dance: () => play('dance', { once: true, speed: 1.4 }),
    cheer: () => play('cheer', { once: true, speed: 1.5 }),
    rest: () => play('idle').then(() => sleep(rand(900, 1800))),
  };

  // ---- His life: an entrance, then a shuffled bag of moves with a button stomp every third.
  let bag = [], since = 0, last = '';
  const offScreen = () => { const r = el.getBoundingClientRect(); return r.bottom < 60 || r.top > innerHeight; };
  const life = async () => {
    // Entrance: out of his slot with a pop and a spring, a wave, then a leap onto the page.
    const s = from?.getBoundingClientRect();
    if (from) from.style.visibility = 'hidden';
    if (!s || !s.height || s.top < 0 || s.bottom > innerHeight) {
      // His slot is out of sight: he makes his entrance from the sky instead.
      el.style.opacity = '1';
      if (!(await dropIn())) { x = scrollX + docW() * 0.8; y = scrollY + innerHeight - 40; shadowY = y; }
      talk(pick(LINES.hello), 2600);
      await play('wave', { once: true, speed: 1.4 });
    } else await slotEntrance(s);
    return liveOn();
  };
  const slotEntrance = async (s) => {
    x = s && s.width ? s.left + scrollX + s.width / 2 : scrollX + docW() * 0.8;
    y = s && s.height ? s.bottom + scrollY - s.height * 0.08 : scrollY + innerHeight - 40;
    shadowY = y; lift = 0;
    fx('pip2d-pop', x - 5, y - PH / 2, {}, 600);
    sparkle(x, y - PH / 2, 10);
    squish(0.4, 0.4);
    el.style.opacity = '1';
    await sleep(40);
    squish(1.12, 1.12);
    await sleep(260);
    talk(pick(LINES.hello), 2600);
    await play('wave', { once: true, speed: 1.4 });
    if (!(await explore())) await dropIn();
  };
  const liveOn = async () => {
    while (!stopped) {
      if (held) { await sleep(200); continue; }
      if (!ground || offScreen()) {
        await sleep(900);
        if (!held && !stopped && (!ground || offScreen())) await dropIn();
        continue;
      }
      if (!bag.length) {
        bag = Object.keys(moves).sort(() => Math.random() - 0.5);
        if (bag[0] === last) bag.push(bag.shift());
      }
      const name = since >= 2 ? 'button' : bag.shift();
      since = name === 'button' ? 0 : since + 1;
      last = name;
      try {
        if (name === 'button') { if (!(await stompButton())) await explore(); } else await moves[name]();
      } catch { /* a move that could not finish just ends */ }
      if (!held && !stopped) await play('idle');
      await sleep(rand(500, 1300));
    }
  };

  // ---- Tap: jump and say something. Drag: pick him up; let go and he falls onto what is below.
  let drag = null;
  body.addEventListener('pointerdown', (e) => {
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: x, oy: y, moved: false };
    body.setPointerCapture(e.pointerId);
  });
  body.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    if (!drag.moved) { drag.moved = true; held = true; ground = null; el.classList.add('is-held'); play('cheer', { speed: 1.6 }); talk(pick(LINES.drop), 1600); }
    x = drag.ox + dx; y = drag.oy + dy; lift = 40; shadowY = y + 40;
  });
  const release = async (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const moved = drag.moved;
    drag = null;
    if (!moved) { tapped(); return; }
    el.classList.remove('is-held');
    // Fall onto the ground below the drop point; with none, the life loop drops him in somewhere.
    const below = grounds().filter((g) => g.r.l < x && g.r.r > x && g.r.t >= y - 10).sort((p, q) => p.r.t - q.r.t)[0];
    if (below) {
      airborne = true;
      held = false;
      const t0 = performance.now(), y0 = y, ty = below.r.t, dur = clamp(Math.sqrt(Math.max(1, ty - y0) / 900), 0.25, 0.9) * 1000;
      while (!stopped) {
        const u = Math.min(1, (performance.now() - t0) / dur);
        y = y0 + (ty - y0) * u * u; shadowY = ty; lift = ty - y;
        if (u >= 1) break;
        await frameWait();
      }
      airborne = false;
      standOn(below.e, x);
      squish(1.22, 0.76);
      dust(x, ty, 8);
      play('idle');
    } else {
      ground = null;
      held = false;
    }
  };
  body.addEventListener('pointerup', release);
  body.addEventListener('pointercancel', release);
  const tapped = () => {
    if (!loop) return;
    talk(pick(LINES.tap));
    squish(1.1, 0.9);
    play(pick(['jump', 'cheer', 'dance']), { once: true, speed: 1.5 });
  };
  body.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tapped(); } });

  el.querySelector('.pip2d-x').addEventListener('click', async () => {
    stopped = true;
    talk(pick(LINES.bye), 1000);
    await play('wave', { once: true, speed: 1.6 });
    el.style.opacity = '0';
    shadow.style.opacity = '0';
    setTimeout(() => { el.remove(); shadow.remove(); style.remove(); }, 550);
    try { sessionStorage.setItem('pip2d.away', '1'); } catch { /* nothing to remember with */ }
  });

  // ---- The frame clock: sprite frames, squash springing back, staying on his ground.
  let lastT = performance.now();
  const tick = (now) => {
    if (!el.isConnected) return;
    requestAnimationFrame(tick);
    const dt = Math.max(0, Math.min(0.05, (now - lastT) / 1000));
    lastT = now;
    frameT += dt;
    const c = meta.clips[clip];
    const step = 1 / (meta.fps * rate);
    let changed = false;
    while (frameT >= step) {
      frameT -= step;
      frame += 1;
      changed = true;
      if (frame >= c.frames) {
        if (loop) frame = 0;
        else { frame = c.frames - 1; if (onEnd) { const f = onEnd; onEnd = null; f(); } break; }
      }
    }
    if (changed) show();
    const k = 1 - Math.pow(0.0005, dt);
    sq.x += (1 - sq.x) * k; sq.y += (1 - sq.y) * k;
    squash.style.transform = `scale(${sq.x.toFixed(3)}, ${sq.y.toFixed(3)})`;
    stick();
    place();
  };

  if (window.PIP_DEBUG) window.__pip = { grounds, rectDoc, openAbove, GROUND };
  el.style.opacity = '0';
  show();
  place();
  requestAnimationFrame(tick);
  life();
  return true;
}
