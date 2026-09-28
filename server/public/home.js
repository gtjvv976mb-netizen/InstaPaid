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

// ---- The phone in 3D: drag it, flick it, turn it with the arrow keys. CSS 3D, so the thread stays live
//      HTML. Only transforms and opacity change, in one requestAnimationFrame loop that sleeps when the phone
//      is off-screen, the tab is hidden, or nothing is moving. Motion is always on: nothing here reads
//      Reduce Motion. ----
const scene = $('[data-p3]');
if (scene) phone3d(scene);

function phone3d(scene) {
  const rig = scene.querySelector('[data-p3-rig]');
  const body = scene.querySelector('[data-p3-body]');
  const back = scene.querySelector('.p3-back');
  const glare = scene.querySelector('[data-p3-glare]');
  const sheen = scene.querySelector('[data-p3-sheen]');
  const floor = scene.querySelector('.p3-floor');
  const glow = scene.querySelector('.p3-glow');
  const compact = matchMedia('(max-width: 980px)');
  const hover = matchMedia('(hover: hover) and (pointer: fine)');
  const RAD = Math.PI / 180;
  const cssPx = (name) => parseFloat(getComputedStyle(scene).getPropertyValue(name)) || 0;
  const D = cssPx('--d') || 28, R = cssPx('--r') || 46, FACETS = 10;

  // The rim: four straight walls and FACETS facets per rounded corner, each standing on the outline with its
  // outward normal at angle phi (0 = right, 90 = down). Keys are thin plates just proud of the side walls.
  const pieces = [];
  const px = (v) => `${+v.toFixed(2)}px`;
  const piece = (cls, box, transform, phi) => {
    const el = document.createElement('i');
    el.className = `p3-rim ${cls}`;
    for (const k in box) el.style[k] = typeof box[k] === 'number' ? px(box[k]) : box[k];
    el.style.transform = transform;
    body.append(el);
    pieces.push({ el, c: Math.cos(phi * RAD), s: Math.sin(phi * RAD), dk: -1, gl: -1 });
  };
  // Every piece overlaps its neighbours a little (the walls run 1.2px into the corners, each facet is 1.6px wider
  // than its chord), so no seam of the background shows between them once they are turned and antialiased.
  const E = 1.2;
  piece('p3-h', { left: R - E, right: R - E, top: -D / 2, height: D }, 'rotateX(90deg)', 270);
  piece('p3-h', { left: R - E, right: R - E, bottom: -D / 2, height: D }, 'rotateX(-90deg)', 90);
  piece('p3-v', { top: R - E, bottom: R - E, left: -D / 2, width: D }, 'rotateY(-90deg)', 180);
  piece('p3-v', { top: R - E, bottom: R - E, right: -D / 2, width: D }, 'rotateY(90deg)', 0);
  const arc = 90 / FACETS, chord = 2 * R * Math.sin((arc / 2) * RAD) + 1.6, rr = R * Math.cos((arc / 2) * RAD);
  for (const [from, h, v] of [[180, 'left', 'top'], [270, 'right', 'top'], [0, 'right', 'bottom'], [90, 'left', 'bottom']]) {
    for (let i = 0; i < FACETS; i++) {
      const phi = from + (i + 0.5) * arc, ox = rr * Math.cos(phi * RAD), oy = rr * Math.sin(phi * RAD);
      piece('p3-h', {
        [h]: h === 'left' ? R + ox - chord / 2 : R - ox - chord / 2,
        [v]: v === 'top' ? R + oy - D / 2 : R - oy - D / 2,
        width: chord, height: D,
      }, `rotateZ(${(phi + 90).toFixed(2)}deg) rotateX(90deg)`, phi);
    }
  }
  const kw = D * 0.5, out = 2.5;
  piece('p3-v p3-key', { top: 150, height: 74, right: -out - kw / 2, width: kw }, 'rotateY(90deg)', 0); // side key
  piece('p3-v p3-key', { top: 126, height: 46, left: -out - kw / 2, width: kw }, 'rotateY(-90deg)', 180); // volume up
  piece('p3-v p3-key', { top: 182, height: 46, left: -out - kw / 2, width: kw }, 'rotateY(-90deg)', 180); // volume down

  // Light: a key light from the upper left in front, a cool rim light from the right; the viewer looks down -z.
  const norm = (x, y, z) => { const l = Math.hypot(x, y, z); return [x / l, y / l, z / l]; };
  const L1 = norm(-0.55, -0.7, 0.6), L2 = norm(0.9, -0.1, 0.25);
  const H1 = norm(L1[0], L1[1], L1[2] + 1), H2 = norm(L2[0], L2[1], L2[2] + 1);
  const dot = (a, x, y, z) => a[0] * x + a[1] * y + a[2] * z;

  // ---- State. Angles in degrees: y turns about the vertical axis (+ = the face turns right), x about the
  //      horizontal one (+ = the face tips up). ----
  let restY = 0, restX = 0, limY = 40, limX = 22, idleScale = 1;
  const pose = () => {
    const small = compact.matches;
    restY = small ? -10 : -24; restX = small ? 4 : 7;
    limY = small ? 34 : 40; limX = small ? 15 : 22; idleScale = small ? 0.6 : 1;
  };
  pose();
  let ry = 0, rx = 0, vy = 0, vx = 0;       // the body's own angle and speed (deg, deg/s)
  let mode = 'spring';                      // 'drag' | 'coast' | 'spin' | 'spring' | 'rest'; starts by turning into its pose
  let keyY = 0, keyX = 0;                   // held by the arrow keys while focused
  let hovY = 0, hovX = 0, hovTY = 0, hovTX = 0; // lean toward the mouse
  let idleAmp = 0, liftAmp = 0, modeT = 0; // idle sway and idle lift (eased apart, so a grab never jumps)
  let spinTo = null, spinFrom = 0, spinV = 0, spinK = 0; // a flick's landing angle (null: none), start, speed, slowing rate
  let drag = null, lastTap = null, visible = false, raf = 0, last = 0, mouse = null;

  const reduced = () => false; // motion is always on
  const soft = (v, lim) => lim * Math.tanh(v / lim);          // a clamp that eases into its limit
  const unsoft = (v, lim) => lim * Math.atanh(Math.max(-0.995, Math.min(0.995, v / lim)));
  const wrap = (a, around) => a - 360 * Math.round((a - around) / 360); // the same angle, nearest `around`
  const targetY = () => restY + keyY, targetX = () => restX + keyX;
  const used = () => scene.classList.add('p3-used');
  // The idle float, only with a mouse on a screen under 2.5x. A turned layer that never stops moving is kept
  // rasterised at a low scale, which on a 3x phone softens the thread's words; once still it is drawn sharp again.
  // So a phone holds still at rest, and the loop sleeps.
  const floats = () => !reduced() && hover.matches && devicePixelRatio < 2.5;
  if (reduced()) { ry = restY; rx = restX; mode = 'rest'; }

  // ---- Physics ----
  function step(dt) {
    if (mode === 'coast') {
      // Inertia after a release, with soft walls at the limits; then the spring takes it home.
      modeT += dt;
      ry += vy * dt; rx += vx * dt;
      const f = Math.exp(-5.5 * dt); vy *= f; vx *= f;
      if (Math.abs(ry) > limY) vy -= (ry - Math.sign(ry) * limY) * 260 * dt;
      if (Math.abs(rx) > limX) vx -= (rx - Math.sign(rx) * limX) * 260 * dt;
      if (modeT > 0.55 || (Math.abs(vy) < 18 && Math.abs(vx) < 18)) { mode = 'spring'; modeT = 0; }
    } else if (mode === 'spin') {
      // A flick: free turns that slow down to land exactly on the front again (solved, not stepped, so a
      // slow frame never overshoots): ry = from + v/k (1 - e^-kt), and v/k is the distance to the landing.
      modeT += dt;
      const e = Math.exp(-spinK * modeT);
      ry = spinFrom + (spinV / spinK) * (1 - e); vy = spinV * e;
      spring1('x', targetX(), dt);
      if (Math.abs(vy) < 14) {
        // Hand over to the spring on the same angle, less the whole turns: from here on it is an ordinary pose.
        ry -= 360 * Math.round((spinTo - targetY()) / 360); spinTo = null; mode = 'spring'; modeT = 0;
      }
    } else if (mode === 'spring') {
      const ty = targetY();
      spring1('y', ty, dt); spring1('x', targetX(), dt);
      if (Math.abs(ty - ry) < 0.03 && Math.abs(vy) < 0.3 && Math.abs(targetX() - rx) < 0.03 && Math.abs(vx) < 0.3) {
        ry = ty; rx = targetX(); vy = vx = 0; mode = 'rest';
      }
    }
    // Hover lean (read here, before this frame writes anything) and idle float ease in and out.
    if (mouse) {
      const r = scene.getBoundingClientRect();
      const px = Math.max(-1, Math.min(1, (mouse.x - (r.left + r.width / 2)) / (r.width / 2 + 160)));
      const py = Math.max(-1, Math.min(1, (mouse.y - (r.top + r.height / 2)) / (r.height / 2 + 120)));
      hovTY = px * 9; hovTX = -py * 6; mouse = null;
    }
    const calm = !drag && mode !== 'spin' && !reduced();
    const kH = 1 - Math.exp(-(calm ? 5 : 9) * dt);
    hovY += ((calm ? hovTY : 0) - hovY) * kH; hovX += ((calm ? hovTX : 0) - hovX) * kH;
    const idleOn = calm && mode === 'rest' && !keyY && !keyX && floats();
    const kI = 1 - Math.exp(-(idleOn ? 0.9 : 6) * dt);
    idleAmp += ((idleOn ? 1 : 0) - idleAmp) * kI;
    liftAmp += ((idleOn ? 1 : 0) - liftAmp) * kI;
  }
  function spring1(axis, to, dt) {
    const k = 46, c = 2 * 0.6 * Math.sqrt(k); // a little overshoot, then still
    if (axis === 'y') { vy += (k * (to - ry) - c * vy) * dt; ry += vy * dt; }
    else { vx += (k * (to - rx) - c * vx) * dt; rx += vx * dt; }
  }

  // ---- Drawing: one transform for the rig, opacity and transforms for the light. ----
  let drawn = '';
  function render(t) {
    const s = t / 1000, a = idleAmp * idleScale;
    const Y = ry + hovY + a * 3.4 * Math.sin(s * 0.55);
    const X = rx + hovX + a * 1.8 * Math.sin(s * 0.8 + 1.3);
    const lift = liftAmp * idleScale * 7 * (0.5 + 0.5 * Math.sin(s * 1.05));
    const key = `${Y.toFixed(2)} ${X.toFixed(2)} ${lift.toFixed(2)}`;
    if (key === drawn) return;
    drawn = key;
    rig.style.transform = `translate3d(0, ${(-lift).toFixed(2)}px, 0) rotateX(${X.toFixed(2)}deg) rotateY(${Y.toFixed(2)}deg)`;

    const cy = Math.cos(Y * RAD), sy = Math.sin(Y * RAD), cx = Math.cos(X * RAD), sx = Math.sin(X * RAD);
    for (const p of pieces) {
      // The piece's outward normal (c, s, 0) turned by rotateY then rotateX.
      const nx = p.c * cy, ny = p.s * cx + p.c * sy * sx, nz = p.s * sx - p.c * sy * cx;
      if (nz < -0.05) continue; // facing away: hidden by backface-visibility
      const lum = 0.2 + 0.7 * Math.max(0, dot(L1, nx, ny, nz)) + 0.42 * Math.max(0, dot(L2, nx, ny, nz));
      const dk = Math.min(0.72, Math.max(0, 0.82 - lum));
      const gl = Math.min(0.95, 0.95 * Math.max(0, dot(H1, nx, ny, nz)) ** 28 + 0.55 * Math.max(0, dot(H2, nx, ny, nz)) ** 18);
      if (Math.abs(dk - p.dk) > 0.004) { p.el.style.setProperty('--dk', dk.toFixed(3)); p.dk = dk; }
      if (Math.abs(gl - p.gl) > 0.004) { p.el.style.setProperty('--gl', gl.toFixed(3)); p.gl = gl; }
    }
    // The back, when it shows: shade by its normal (0, 0, -1), and slide its sheen.
    const bz = -cy * cx;
    if (bz > -0.05) {
      back.style.setProperty('--dk', Math.max(0, 0.5 - 0.6 * Math.max(0, dot(L1, -sy, cy * sx, bz))).toFixed(3));
      sheen.style.transform = `translate3d(${(wrap(Y - 180, 0) * 0.9).toFixed(1)}%, 0, 0)`;
    }
    // The glare on the glass slides against the turn. It is off at the resting pose, where people read the
    // thread, and brightens only as the phone is turned away from it (by a hand, the keys or a flick: the idle
    // float and the hover lean never light it).
    const off = Math.hypot(wrap(ry - restY, 0), rx - restX);
    const tilt = Math.min(1, Math.max(0, (off - 5) / 30));
    glare.style.transform = `translate3d(${(-wrap(Y, 0) * 1.5 - 20).toFixed(1)}%, ${(X * 0.8).toFixed(1)}%, 0)`;
    glare.style.opacity = (cy > 0 ? 0.8 * tilt : 0).toFixed(3);
    // Shadows stay flat: they narrow as the phone turns edge-on and soften as it lifts.
    const w = Math.abs(cy) + (D / 330) * Math.abs(sy);
    floor.style.transform = `translate3d(${(-wrap(Y, 0) * 0.5).toFixed(1)}px, ${(X * 0.4).toFixed(1)}px, 0) scale(${(0.3 + 0.7 * w).toFixed(3)}, ${(1 - lift * 0.02).toFixed(3)})`;
    floor.style.opacity = (0.95 - lift * 0.045).toFixed(3);
    glow.style.transform = `translate3d(${(wrap(Y, 0) * -0.35).toFixed(1)}px, ${(lift * 0.5 - X * 0.6).toFixed(1)}px, 0) scale(${(0.25 + 0.75 * w).toFixed(3)}, 1)`;
  }

  // ---- The loop ----
  const busy = () => drag?.live || mode !== 'rest' || mouse || Math.abs(hovY - hovTY) > 0.01 || Math.abs(hovX - hovTX) > 0.01 ||
    Math.abs(hovY) > 0.01 || Math.abs(hovX) > 0.01 || idleAmp > 0.001 || liftAmp > 0.001 || (floats() && !drag && !keyY && !keyX);
  function frame(t) {
    raf = 0;
    // Real time, in steps of at most 1/120 s, so a slow device runs the same motion at fewer frames.
    const dt = Math.min(0.2, Math.max(0, (t - last) / 1000)); last = t;
    const n = Math.max(1, Math.ceil(dt * 120));
    for (let i = 0; i < n; i++) step(dt / n);
    render(t);
    if (visible && !document.hidden && busy()) raf = requestAnimationFrame(frame); // at rest and still: sleep
  }
  const wake = () => {
    if (raf || !visible || document.hidden) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  };
  const sleep = () => { if (raf) cancelAnimationFrame(raf); raf = 0; };

  // ---- Pointer: drag turns it (captured once past a small threshold, so a tap is still a click); on touch only
  //      a sideways drag does, so swiping up and down still scrolls the page. From the press on, the pointer is
  //      followed at the window until it ends, wherever it goes, so no press is ever left half-open. ----
  const GAIN_Y = 0.36, GAIN_X = 0.26, SLOP = 6;
  let presses = [false, false]; // whether each of the last two presses was a drag (then a dblclick is not a reset)
  const follow = (on) => {
    const f = (on ? window.addEventListener : window.removeEventListener).bind(window);
    f('pointermove', move, true); f('pointerup', up, true); f('pointercancel', cancel, true);
  };
  scene.addEventListener('pointerdown', (e) => {
    if (drag && drag.id === e.pointerId) release(e, true); // the same pointer pressing again: its last press ended unseen
    if (drag || (e.pointerType !== 'touch' && e.button !== 0)) return; // one pointer at a time: a second finger is ignored
    drag = { id: e.pointerId, type: e.pointerType, x0: e.clientX, y0: e.clientY, live: false, samples: [] };
    follow(true);
  });
  function move(e) {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.type !== 'touch' && !(e.buttons & 1)) { release(e, true); return; } // the button came up out of our sight
    let dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    if (!drag.live) {
      if (Math.hypot(dx, dy) < SLOP) return;
      if (drag.type === 'touch' && Math.abs(dy) > Math.abs(dx)) { release(e, true); return; } // a scroll: the page's
      // Take it from where it is shown, hover lean and float included, so nothing jumps.
      const a = idleAmp * idleScale, s = performance.now() / 1000;
      const shownY = wrap(ry + hovY + a * 3.4 * Math.sin(s * 0.55), 0), shownX = rx + hovX + a * 1.8 * Math.sin(s * 0.8 + 1.3);
      hovY = hovX = hovTY = hovTX = 0; idleAmp = 0; keyY = keyX = 0; spinTo = null; mouse = null;
      drag.free = Math.abs(shownY) > limY * 0.98;           // grabbed mid-spin: no soft clamp this time
      drag.baseY = drag.free ? shownY : unsoft(shownY, limY);
      drag.baseX = unsoft(Math.max(-limX, Math.min(limX, shownX)), limX);
      drag.x0 = e.clientX; drag.y0 = e.clientY; dx = dy = 0;
      drag.live = true; mode = 'drag'; ry = shownY; rx = shownX; vy = vx = 0;
      try { scene.setPointerCapture(e.pointerId); } catch { /* the pointer is gone */ }
      scene.classList.add('p3-grab');
      used();
      wake();
    }
    const rawY = drag.baseY + dx * GAIN_Y, rawX = drag.baseX - dy * GAIN_X;
    ry = drag.free ? rawY : soft(rawY, limY);
    rx = soft(rawX, limX);
    const now = e.timeStamp || performance.now();
    drag.samples.push([now, rawY, ry, rx]);
    while (drag.samples.length > 2 && now - drag.samples[0][0] > 90) drag.samples.shift();
  }
  const up = (e) => release(e, false), cancel = (e) => release(e, true);
  function release(e, cancelled) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    follow(false);
    presses = [presses[1], d.live];
    scene.classList.remove('p3-grab');
    if (!d.live) { // a tap or click: two quick taps reset it (a mouse has dblclick)
      if (!cancelled && d.type === 'touch') {
        const now = performance.now();
        if (lastTap && now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) { reset(); lastTap = null; }
        else lastTap = { t: now, x: e.clientX, y: e.clientY };
      }
      return;
    }
    // It was a drag: the click that may follow is not a click on whatever is under the pointer.
    const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
    scene.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => scene.removeEventListener('click', swallow, { capture: true }), 0);

    if (reduced()) { ry = targetY(); rx = targetX(); vy = vx = 0; mode = 'rest'; render(performance.now()); return; }
    // Speed over the last ~90 ms, if the pointer was still moving at release.
    const sm = d.samples, a = sm[0], b = sm[sm.length - 1], now = e.timeStamp || performance.now();
    let rawV = 0;
    if (a && b && b[0] > a[0] && now - b[0] < 70) {
      const span = (b[0] - a[0]) / 1000;
      rawV = (b[1] - a[1]) / span; vy = (b[2] - a[2]) / span; vx = (b[3] - a[3]) / span;
    } else vy = vx = 0;
    if (!cancelled && Math.abs(rawV) > 640) {
      // A flick: one or two whole turns, landing on the front.
      const dir = Math.sign(rawV), speed = Math.min(1800, Math.abs(rawV));
      const turns = speed > 1300 ? 2 : 1;
      const from = ry;
      let to = restY + 360 * Math.round((from - restY) / 360) + dir * 360 * turns;
      if ((to - from) * dir < 300) to += dir * 360;
      spinTo = to; spinFrom = from; spinV = dir * speed; spinK = speed / Math.abs(to - from); vy = spinV;
      mode = 'spin';
    } else if (Math.abs(ry) > limY + 10) {
      // Let go while turned away (grabbed mid-spin): ease back to the nearest front, the same way a flick lands.
      const to = restY + 360 * Math.round((ry - restY) / 360);
      spinTo = to; spinFrom = ry; spinK = 3; spinV = (to - ry) * spinK;
      mode = 'spin';
    } else {
      mode = 'coast';
    }
    modeT = 0;
    wake();
  }
  // Capture moving to the scene (touch starts captured to the element under the finger) is not a release.
  scene.addEventListener('lostpointercapture', (e) => { if (e.target === scene && drag?.live && e.pointerId === drag.id) release(e, true); });
  scene.addEventListener('dragstart', (e) => e.preventDefault());
  scene.addEventListener('dblclick', (e) => {
    e.preventDefault();
    if (presses[0] || presses[1]) return; // two quick drags (or a drag and a click) are not a double-click
    reset();
  });

  // Hover: lean a little toward the mouse, anywhere over the stage.
  const stage = scene.closest('[data-stage]') || scene;
  function lean(e) {
    if (e.pointerType !== 'mouse' || !hover.matches || reduced() || drag) return;
    mouse = { x: e.clientX, y: e.clientY }; // turned into a lean at the next frame, so moves never force layout
    wake();
  }
  stage.addEventListener('pointermove', lean);
  stage.addEventListener('pointerleave', () => { mouse = null; hovTY = hovTX = 0; wake(); });

  // ---- Keys: arrows turn it (Shift for fine steps), Home turns it back; it springs home on blur. ----
  const STEP = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 0.5], ArrowDown: [0, -0.5] };
  scene.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || !(Object.hasOwn(STEP, e.key) || e.key === 'Home')) return;
    e.preventDefault();
    if (drag?.live) return; // a hand is on it: the keys wait until it lets go
    used();
    if (e.key === 'Home') { reset(); return; }
    const big = e.shiftKey ? 4 : 12, [sy, sx] = STEP[e.key];
    keyY = Math.max(-limY - restY, Math.min(limY - restY, keyY + sy * big));
    keyX = Math.max(-limX - restX, Math.min(limX - restX, keyX + sx * big));
    settle();
  });
  scene.addEventListener('blur', () => { if (keyY || keyX) { keyY = keyX = 0; settle(); } });

  // Turn to the current target (rest plus keys) from wherever it is, whatever it was doing.
  function settle() {
    if (drag?.live) return; // a hand is on it: letting go brings it to the new pose
    ry = wrap(ry, targetY()); spinTo = null; // drop any whole turns a flick was making: the short way to the target
    if (reduced()) { ry = targetY(); rx = targetX(); vy = vx = 0; mode = 'rest'; render(performance.now()); return; }
    if (Math.abs(targetY() - ry) > 60) { // far round: ease home like a landing flick rather than whip back on the spring
      spinTo = targetY(); spinFrom = ry; spinK = 3; spinV = (spinTo - ry) * spinK; mode = 'spin';
    } else mode = 'spring';
    modeT = 0;
    wake();
  }
  function reset() {
    keyY = keyX = 0;
    used();
    settle(); // the short way round
  }

  // ---- Sleep off-screen and in hidden tabs; follow the layout and Reduce Motion as they change. ----
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([e]) => { visible = e.isIntersecting; visible ? wake() : sleep(); }, { rootMargin: '80px 0px' }).observe(scene);
  } else { visible = true; wake(); }
  document.addEventListener('visibilitychange', () => (document.hidden ? sleep() : wake()));
  compact.addEventListener?.('change', () => { pose(); settle(); });

  scene.classList.add('p3-live');
  render(performance.now());
}

// ---- The film behind the hero: decorative. It plays only while on screen (and always: motion is never
//      switched off here). ----
const loop = $('[data-loop]');
if (loop) {
  let onScreen = false;
  const sync = () => {
    if (!onScreen) { if (!loop.paused) loop.pause(); return; }
    if (loop.paused) loop.play().catch(() => { /* no autoplay or no codec: the poster stays */ });
  };
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; sync(); }, { threshold: 0.05 }).observe(loop);
  } else { onScreen = true; sync(); }
}

// ---- Scroll reveal: each [data-reveal] rises once as it comes into view. ----
if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  for (const el of document.querySelectorAll('[data-reveal]')) io.observe(el);
} else {
  for (const el of document.querySelectorAll('[data-reveal]')) el.classList.add('in');
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
