// Pip, 2D and free: an HD cartoon axolotl (drawn with Nano Banana Pro, animated with Kling on a green
// screen, keyed into sprite sheets: media/pip-*.webp) who lives on the whole page. He walks about,
// goes up to buttons and presses them (a squish and a sparkle only: he never follows a link or
// submits anything), waves at the pointer, looks around, jumps, dances and cheers, says things,
// can be tapped, and can be picked up and dropped anywhere. A × on hover sends him off for the
// visit. Nothing here stops the page working: only Pip himself takes the pointer.
//
// startPip2D(from) → Promise<boolean>: `from` is the slot he starts in (the drawn Pip's spot). It
// resolves once the sprites are in; false (and nothing changes) if they cannot load.

const SPRITES = '/media/pip-sprites.json?v=68b35fca';
const LINES = {
  hello: ['Hi! I’m Pip 👋', 'Welcome to InstaPaid!', 'Psst, over here!'],
  tap: ['Hehe, that tickles!', 'Comment. Coin. Claim!', 'Only the creator gets the fees.', 'Tag @instapaid.official under any post.', 'I name coins after the post!', 'Wheee!'],
  launch: ['This one launches a coin! 🚀', 'Pick a creator, name the coin, done!', 'Launch a coin for your favourite creator!'],
  claim: ['Creators claim their fees here 💰', 'One DM and the fees are yours!'],
  copy: ['Copy this and comment it on any post!', 'That’s the magic comment ✨'],
  other: ['Ooh, what does this do?', 'Boop!', 'Click click!'],
  drop: ['Whoa! Put me down! 😆', 'I can fly!', 'Wheee!'],
  bye: ['Bye for now! 👋'],
};
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const CSS = `
.pip2d{position:fixed;left:0;top:0;z-index:60;width:var(--pw);height:var(--ph);pointer-events:none;will-change:transform}
.pip2d-body{position:absolute;inset:0;pointer-events:auto;cursor:grab;touch-action:none;-webkit-tap-highlight-color:transparent;outline:none;border-radius:40%}
.pip2d-body:focus-visible{box-shadow:0 0 0 3px rgba(255,122,89,.7)}
.pip2d.is-held .pip2d-body{cursor:grabbing}
.pip2d-sprite{position:absolute;left:50%;bottom:0;background-repeat:no-repeat;transform-origin:50% 100%;image-rendering:auto;pointer-events:none;filter:drop-shadow(0 10px 12px rgba(0,0,0,.35))}
.pip2d-shadow{position:absolute;left:50%;bottom:-4px;width:58%;height:12px;margin-left:-29%;border-radius:50%;background:radial-gradient(closest-side,rgba(0,0,0,.35),transparent);pointer-events:none;transition:opacity .2s,transform .2s}
.pip2d.is-air .pip2d-shadow{opacity:.35;transform:scale(.6)}
.pip2d-say{position:absolute;left:50%;bottom:calc(100% + 4px);transform:translate(-50%,6px) scale(.9);opacity:0;pointer-events:none;background:#fff3ea;color:#2a1215;font:600 14px/1.3 Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:8px 12px;border-radius:14px;box-shadow:0 10px 30px -10px rgba(0,0,0,.5);width:max-content;max-width:min(240px,70vw);text-align:center;transition:transform .22s cubic-bezier(.2,.9,.3,1.3),opacity .18s}
.pip2d-say::after{content:"";position:absolute;left:50%;top:100%;margin-left:-7px;border:7px solid transparent;border-top-color:#fff3ea;border-bottom:0}
.pip2d.is-say .pip2d-say{opacity:1;transform:translate(-50%,0) scale(1)}
.pip2d-x{position:absolute;right:2px;top:6px;width:26px;height:26px;border-radius:50%;border:0;background:rgba(26,17,20,.85);color:#fff3ea;font:700 15px/26px system-ui,sans-serif;cursor:pointer;opacity:0;pointer-events:auto;transition:opacity .2s;padding:0}
.pip2d:hover .pip2d-x,.pip2d-x:focus-visible{opacity:1}
@media (hover:none){.pip2d-x{opacity:.8;width:24px;height:24px}}
.pip2d-pressed{transition:transform .12s ease,box-shadow .2s ease!important;transform:scale(.94)!important;box-shadow:0 0 0 4px rgba(255,122,89,.45),0 0 28px rgba(255,122,89,.55)!important}
.pip2d-spark{position:fixed;z-index:59;width:10px;height:10px;border-radius:50%;background:#ffd2b0;pointer-events:none;animation:pip2d-spark .6s ease-out forwards}
@keyframes pip2d-spark{0%{opacity:1;transform:translate(0,0) scale(1)}100%{opacity:0;transform:translate(var(--dx),var(--dy)) scale(.3)}}
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
    // He appears once he can stand, walk and wave; the other moves arrive in the background and
    // join in as they land. Every sheet is decoded first, so a move never starts on a blank frame.
    await Promise.all(['idle', 'walk', 'wave'].map(load));
  } catch { return false; }
  Object.keys(meta.clips).filter((n) => !ready.has(n)).reduce((p, n) => p.then(() => load(n)).catch(() => {}), Promise.resolve());
  try { if (sessionStorage.getItem('pip2d.away') === '1') return true; } catch { /* storage off: he stays */ }

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const small = matchMedia('(max-width: 640px)').matches;
  const PH = small ? 118 : 168; // on-screen height of a front-facing frame
  const front = meta.clips.idle;
  const PW = Math.round((front.w / front.h) * PH);

  const el = document.createElement('div');
  el.className = 'pip2d';
  el.style.setProperty('--pw', `${PW}px`);
  el.style.setProperty('--ph', `${PH}px`);
  el.innerHTML = `<div class="pip2d-shadow"></div><div class="pip2d-body" role="img" tabindex="0" aria-label="Pip, the InstaPaid axolotl. Press Enter to make him jump; drag him anywhere."><div class="pip2d-sprite"></div></div><div class="pip2d-say" aria-live="polite"></div><button class="pip2d-x" type="button" aria-label="Send Pip away for this visit">×</button>`;
  document.body.appendChild(el);
  const body = el.querySelector('.pip2d-body'), sprite = el.querySelector('.pip2d-sprite'), say = el.querySelector('.pip2d-say');

  // ---- Sprite player: one clip at a time, frame by frame, facing left or right.
  let clip = 'idle', frame = 0, frameT = 0, loop = true, onEnd = null, face = 1;
  const show = () => {
    const c = meta.clips[clip];
    // Same size in every clip: a sheet pixel is c.src/c.h source pixels, and PH shows front.src.
    const h = Math.round(PH * (c.src / front.src)), w = Math.round(h * (c.w / c.h));
    sprite.style.width = `${w}px`;
    sprite.style.height = `${h}px`;
    sprite.style.marginLeft = `${-w / 2}px`;
    sprite.style.backgroundImage = `url(/media/pip-${clip}.webp?v=${meta.v || 1})`;
    sprite.style.backgroundSize = `${w * c.cols}px auto`;
    sprite.style.backgroundPosition = `${-(frame % c.cols) * w}px ${-Math.floor(frame / c.cols) * h}px`;
    sprite.style.transform = `scaleX(${face})`;
  };
  const play = (name, { once = false } = {}) => new Promise((done) => {
    if (!ready.has(name)) name = once ? 'wave' : 'idle'; // not arrived yet: something he can do
    if (onEnd) { const f = onEnd; onEnd = null; f(); }
    clip = name; frame = 0; frameT = 0; loop = !once;
    onEnd = once ? done : null;
    if (!once) done();
    show();
  });

  // ---- Where he is (viewport px, bottom-centre of his feet), and moving him.
  const vw = () => document.documentElement.clientWidth, vh = () => window.innerHeight;
  const start = from?.getBoundingClientRect();
  let x = start && start.width ? start.left + start.width / 2 : vw() - PW;
  let y = start && start.height ? start.bottom : vh() - 12;
  if (y > vh() - 8 || y < PH + 40) y = vh() - 12;
  const place = () => { el.style.transform = `translate(${Math.round(x - PW / 2)}px, ${Math.round(y - PH)}px)`; };
  const floor = () => vh() - 10;
  const inView = () => { x = clamp(x, PW / 2 + 4, vw() - PW / 2 - 4); y = clamp(y, PH + 50, floor()); };

  let busy = false, held = false, stopped = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let sayT = 0;
  const talk = (text, ms = 2600) => {
    say.textContent = text;
    el.classList.add('is-say');
    // Keep the bubble on screen.
    requestAnimationFrame(() => {
      const r = say.getBoundingClientRect();
      const dx = r.left < 8 ? 8 - r.left : r.right > vw() - 8 ? vw() - 8 - r.right : 0;
      say.style.marginLeft = `${dx}px`;
    });
    clearTimeout(sayT);
    sayT = setTimeout(() => el.classList.remove('is-say'), ms);
  };

  // Walk to (tx, ty) at his own pace, the walk cycle facing the way he goes.
  const walkTo = async (tx, ty) => {
    tx = clamp(tx, PW / 2 + 4, vw() - PW / 2 - 4);
    ty = clamp(ty, PH + 50, floor());
    const dist = Math.hypot(tx - x, ty - y);
    if (dist < 8) return;
    face = tx >= x ? 1 : -1;
    await play('walk');
    const speed = small ? 120 : 170; // px per second
    const x0 = x, y0 = y, dur = dist / speed;
    const t0 = performance.now();
    while (!stopped && !held) {
      const u = Math.min(1, (performance.now() - t0) / 1000 / dur);
      x = x0 + (tx - x0) * u;
      y = y0 + (ty - y0) * u;
      place();
      if (u >= 1) break;
      await new Promise((r) => requestAnimationFrame(r));
    }
    face = 1;
    await play('idle');
  };

  // A hop in an arc to (tx, ty): arms up in the air, straight into idle on landing.
  const hopTo = async (tx, ty) => {
    const x0 = x, y0 = y, t0 = performance.now(), dur = 1000;
    face = tx >= x ? 1 : -1;
    play('cheer');
    el.classList.add('is-air');
    while (!stopped) {
      const u = Math.min(1, (performance.now() - t0) / dur);
      x = x0 + (tx - x0) * u;
      y = y0 + (ty - y0) * u - Math.sin(u * Math.PI) * 130;
      place();
      if (u >= 1) break;
      await new Promise((r) => requestAnimationFrame(r));
    }
    el.classList.remove('is-air');
    face = 1;
    play('idle');
  };

  const sparkle = (cx, cy) => {
    for (let i = 0; i < 10; i++) {
      const s = document.createElement('i');
      s.className = 'pip2d-spark';
      const a = (i / 10) * Math.PI * 2;
      s.style.left = `${cx}px`; s.style.top = `${cy}px`;
      s.style.setProperty('--dx', `${Math.cos(a) * rand(30, 60)}px`);
      s.style.setProperty('--dy', `${Math.sin(a) * rand(30, 60)}px`);
      document.body.appendChild(s);
      setTimeout(() => s.remove(), 700);
    }
  };

  // Buttons worth visiting: on screen (at least their top), below the header bar, not tiny.
  const buttons = () => [...document.querySelectorAll('a.btn, button.btn, button.copy, button.replay, .nav a, .foot-links a')]
    .filter((b) => {
      const r = b.getBoundingClientRect();
      return r.width > 30 && r.height > 18 && r.top > 64 && r.top < vh() - 30 && r.left > 0 && r.right < vw() && getComputedStyle(b).visibility !== 'hidden';
    });
  const lineFor = (b) => {
    const href = b.getAttribute('href') || '';
    if (href.includes('/launch')) return pick(LINES.launch);
    if (href.includes('/claim')) return pick(LINES.claim);
    if (b.matches('.copy, [data-copy]')) return pick(LINES.copy);
    return pick(LINES.other);
  };

  const recent = [];
  // Walk up to a button, stand beside it and press it: the button squishes and sparkles. Pip never
  // clicks it for real.
  const visitButton = async () => {
    const all = buttons();
    if (!all.length) return false;
    const fresh = all.filter((x) => !recent.includes(x)); // a button he has not just pressed, when there is one
    const b = pick(fresh.length ? fresh : all);
    recent.push(b); if (recent.length > 3) recent.shift();
    const r = b.getBoundingClientRect();
    const side = r.left - PW / 2 > 10 ? -1 : 1;
    const tx = side < 0 ? r.left - PW * 0.32 : r.right + PW * 0.32;
    await walkTo(tx, r.bottom + 6);
    if (stopped || held || !b.isConnected) return true;
    face = side < 0 ? 1 : -1; // turn toward the button
    const pressing = play('press', { once: true });
    await sleep(900);
    const rr = b.getBoundingClientRect();
    b.classList.add('pip2d-pressed');
    sparkle(rr.left + rr.width / 2, rr.top + rr.height / 2);
    talk(lineFor(b));
    await sleep(260);
    b.classList.remove('pip2d-pressed');
    await pressing;
    face = 1;
    return true;
  };

  // ---- What he does next, forever.
  const pointer = { x: -1, y: -1, t: 0 };
  window.addEventListener('pointermove', (e) => { pointer.x = e.clientX; pointer.y = e.clientY; pointer.t = performance.now(); }, { passive: true });
  let lastMove = '', bag = [], sinceButton = 0;
  const moves = {
    button: [6, visitButton],
    wander: [3, () => walkTo(rand(PW, vw() - PW), rand(Math.max(PH + 80, vh() * 0.35), floor()))],
    wave: [2, () => { talk(pick(LINES.hello)); return play('wave', { once: true }); }],
    look: [2, () => play('look', { once: true })],
    dance: [2, () => play('dance', { once: true })],
    cheer: [1.5, () => play('cheer', { once: true })],
    hop: [1.5, () => hopTo(clamp(x + rand(-260, 260), PW, vw() - PW), clamp(y + rand(-40, 40), PH + 80, floor()))],
    chase: [2, async () => {
      if (performance.now() - pointer.t > 4000 || pointer.x < 0) return;
      await walkTo(pointer.x + (pointer.x > x ? -PW * 0.7 : PW * 0.7), clamp(pointer.y + PH * 0.6, PH + 50, floor()));
      if (!stopped && !held) { talk(pick(LINES.hello)); await play('wave', { once: true }); }
    }],
    rest: [1, () => play('idle').then(() => sleep(rand(800, 1600)))],
  };
  const life = async () => {
    await sleep(500);
    talk(pick(LINES.hello), 3000);
    await play('wave', { once: true });
    // His best trick first: off to press a button.
    busy = true;
    try { await visitButton(); } catch { /* nothing to press */ }
    busy = false;
    lastMove = 'button';
    while (!stopped) {
      if (held || busy) { await sleep(200); continue; }
      // A shuffled bag: every move once, in a new order each round, never the same twice in a
      // row, and a button visit after every two moves.
      if (!bag.length) {
        bag = Object.keys(moves).filter((k) => k !== 'button').sort(() => Math.random() - 0.5);
        if (bag[0] === lastMove) bag.push(bag.shift());
      }
      const name = sinceButton >= 2 ? 'button' : bag.shift();
      sinceButton = name === 'button' ? 0 : sinceButton + 1;
      lastMove = name;
      busy = true;
      try { await moves[name][1](); } catch { /* a move that could not finish just ends */ }
      busy = false;
      if (!held) await play('idle');
      await sleep(rand(400, 1400));
    }
  };

  // ---- Tap: jump and say something. Drag: pick him up and drop him anywhere.
  let drag = null;
  body.addEventListener('pointerdown', (e) => {
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: x, oy: y, moved: false };
    body.setPointerCapture(e.pointerId);
  });
  body.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    if (!drag.moved) { drag.moved = true; held = true; el.classList.add('is-held', 'is-air'); play('cheer'); }
    x = drag.ox + dx; y = drag.oy + dy;
    place();
  });
  const release = async (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const moved = drag.moved;
    drag = null;
    if (!moved) { tapped(); return; }
    el.classList.remove('is-held');
    // Falls to where he was dropped (or the floor if dropped too high), then carries on.
    const land = clamp(y + 40, PH + 50, floor());
    const x0 = x;
    inView();
    talk(pick(LINES.drop), 1800);
    await hopTo(x0, land);
    el.classList.remove('is-air');
    held = false;
  };
  body.addEventListener('pointerup', release);
  body.addEventListener('pointercancel', release);
  // A tap plays over whatever he is doing (he keeps walking if he was); the next move carries on.
  const tapped = () => {
    if (clip === 'jump' && !loop) return;
    talk(pick(LINES.tap));
    play(pick(['jump', 'cheer', 'dance']), { once: true });
  };
  body.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tapped(); } });

  el.querySelector('.pip2d-x').addEventListener('click', async () => {
    stopped = true;
    talk(pick(LINES.bye), 1200);
    await play('wave', { once: true });
    el.style.transition = 'opacity .4s';
    el.style.opacity = '0';
    setTimeout(() => { el.remove(); style.remove(); }, 450);
    try { sessionStorage.setItem('pip2d.away', '1'); } catch { /* nothing to remember with */ }
  });

  window.addEventListener('resize', () => { inView(); place(); });

  // ---- The frame clock: advances whichever clip is playing.
  let last = performance.now();
  const tick = (now) => {
    if (!el.isConnected) return;
    requestAnimationFrame(tick);
    frameT += (now - last) / 1000;
    last = now;
    const c = meta.clips[clip];
    // The clips are 5 s; played a little brisker he feels alive rather than slow.
    const step = 1 / (meta.fps * (clip === 'walk' ? 1.2 : 1.5));
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
  };

  inView();
  place();
  show();
  if (from) from.style.visibility = 'hidden'; // the drawn Pip steps out of his slot
  requestAnimationFrame(tick);
  life();
  return true;
}
