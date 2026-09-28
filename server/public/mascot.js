/* Pip, the InstaPaid axolotl. Drop `<div data-mascot data-size="lg|sm"></div>` anywhere and load this
 * file. Pip watches the pointer (eyes, head and gills follow it), blinks, breathes, waves on arrival,
 * jumps and says something when tapped or when Enter/Space is pressed on him. Nothing here is gated
 * by Reduce Motion: the owner wants the motion on for everyone. */
(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const LINES = [
    'Comment. Coin. Claim!',
    'Tag @instapaid.official under any post.',
    'The coin wears the post’s photo.',
    'Only the creator gets the fees.',
    'No wallet needed to start.',
    'I read the caption, then I name it.',
    'Fees wait in the vault until they claim.',
  ];

  const CSS = `
.pip{position:relative;display:block;width:100%;aspect-ratio:1/1;max-width:100%;cursor:pointer;-webkit-tap-highlight-color:transparent;outline:none;border-radius:50%}
.pip:focus-visible{box-shadow:0 0 0 3px rgba(255,122,89,.65)}
.pip svg{display:block;width:100%;height:100%;overflow:visible}
.pip [data-p]{transition:transform .28s cubic-bezier(.2,.9,.3,1.2)}
.pip .pip-root{animation:pip-bob 3.6s ease-in-out infinite;transform-origin:120px 230px}
.pip.is-jump .pip-root{animation:pip-jump .62s cubic-bezier(.3,1.4,.4,1) 1}
.pip .pip-gill{transform-origin:var(--ox) var(--oy);animation:pip-sway 2.8s ease-in-out infinite}
.pip .pip-gill:nth-child(2){animation-delay:-.6s}.pip .pip-gill:nth-child(3){animation-delay:-1.2s}
.pip .pip-gill.r{animation-name:pip-sway-r}
.pip .pip-lid{transform-box:fill-box;transform-origin:center;transform:scaleY(1);transition:transform .09s}
.pip.is-blink .pip-lid{transform:scaleY(.08)}
.pip .pip-mouth-open{opacity:0;transition:opacity .15s}.pip .pip-mouth{transition:opacity .15s}
.pip.is-open .pip-mouth-open{opacity:1}.pip.is-open .pip-mouth{opacity:0}
.pip .pip-coinarm{transform-origin:150px 176px;transition:transform .35s cubic-bezier(.2,.9,.3,1.3)}
.pip.is-jump .pip-coinarm,.pip.is-wave .pip-coinarm{transform:rotate(-38deg)}
.pip .pip-shadow{transform-origin:120px 238px;transition:transform .3s,opacity .3s}
.pip.is-jump .pip-shadow{transform:scale(.7);opacity:.35}
.pip .pip-spark{opacity:0;transform-box:fill-box;transform-origin:center}
.pip.is-jump .pip-spark{animation:pip-spark .7s ease-out 1}
.pip.is-jump .pip-spark:nth-child(2){animation-delay:.06s}.pip.is-jump .pip-spark:nth-child(3){animation-delay:.12s}.pip.is-jump .pip-spark:nth-child(4){animation-delay:.03s}.pip.is-jump .pip-spark:nth-child(5){animation-delay:.1s}
.pip-3d{position:absolute;z-index:1;inset:-12% -18% -6%;width:auto;height:auto;opacity:0;transition:opacity .6s;pointer-events:none;--poster-color:transparent;background:transparent}
.pip.has-3d .pip-3d{opacity:1;pointer-events:auto}
.pip.has-3d>svg{opacity:0;transition:opacity .4s}
.pip.has-3d .pip-3d{animation:pip-bob 3.6s ease-in-out infinite;transform-origin:50% 95%}
.pip.has-3d.is-jump .pip-3d{animation:pip-jump .62s cubic-bezier(.3,1.4,.4,1) 1}
.pip-say{position:absolute;z-index:3;left:50%;bottom:calc(100% - 4%);transform:translate(-50%,8px) scale(.9);opacity:0;pointer-events:none;background:#fff3ea;color:#2a1215;font:600 14px/1.3 Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:9px 13px;border-radius:14px;box-shadow:0 10px 30px -10px rgba(0,0,0,.5);white-space:nowrap;max-width:min(260px,80vw);white-space:normal;text-align:center;width:max-content;transition:transform .25s cubic-bezier(.2,.9,.3,1.3),opacity .2s}
.pip-say::after{content:"";position:absolute;left:50%;top:100%;margin-left:calc(-7px + var(--tail,0px));border:7px solid transparent;border-top-color:#fff3ea;border-bottom:0}
.pip.is-say .pip-say{opacity:1;transform:translate(-50%,-6px) scale(1)}
.pip.say-below .pip-say{bottom:auto;top:calc(100% - 2%);transform:translate(-50%,-8px) scale(.9)}
.pip.say-below .pip-say::after{top:auto;bottom:100%;border-top:0;border-bottom:7px solid #fff3ea}
.pip.say-below.is-say .pip-say{transform:translate(-50%,6px) scale(1)}
[data-size="sm"] .pip-say{font-size:12px;padding:7px 10px}
@keyframes pip-bob{0%,100%{transform:translateY(0) scale(1,1)}50%{transform:translateY(-6px) scale(1.01,.99)}}
@keyframes pip-jump{0%{transform:translateY(0) scale(1.06,.9)}35%{transform:translateY(-34px) scale(.96,1.06)}70%{transform:translateY(0) scale(1.08,.9)}100%{transform:translateY(0) scale(1,1)}}
@keyframes pip-sway{0%,100%{transform:rotate(-6deg)}50%{transform:rotate(7deg)}}
@keyframes pip-sway-r{0%,100%{transform:rotate(6deg)}50%{transform:rotate(-7deg)}}
@keyframes pip-spark{0%{opacity:0;transform:translate(0,0) scale(.4)}25%{opacity:1}100%{opacity:0;transform:translate(var(--dx),var(--dy)) scale(1.1)}}
`;

  const SVG = `
<svg viewBox="0 0 240 250" xmlns="${NS}" aria-hidden="true" focusable="false">
  <defs>
    <radialGradient id="pip-body" cx="45%" cy="35%" r="70%"><stop offset="0" stop-color="#ff9a7e"/><stop offset="1" stop-color="#f26a4f"/></radialGradient>
    <radialGradient id="pip-belly" cx="50%" cy="40%" r="60%"><stop offset="0" stop-color="#ffe0cc"/><stop offset="1" stop-color="#ffc2a3"/></radialGradient>
    <linearGradient id="pip-gillg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ff5c8a"/><stop offset="1" stop-color="#ff8fb0"/></linearGradient>
    <linearGradient id="pip-coin" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8d3a67"/><stop offset="1" stop-color="#5e2244"/></linearGradient>
  </defs>
  <ellipse class="pip-shadow" cx="120" cy="238" rx="58" ry="9" fill="#000" opacity=".28"/>
  <g class="pip-root">
    <g data-p="tail">
      <path d="M152 196 C 198 206, 222 176, 200 158 C 186 147, 170 158, 178 172 C 184 182, 198 178, 196 168" fill="none" stroke="#f26a4f" stroke-width="20" stroke-linecap="round"/>
      <path d="M154 194 C 198 202, 218 178, 200 162 C 188 152, 174 160, 180 171" fill="none" stroke="#ff9a7e" stroke-width="8" stroke-linecap="round" opacity=".7"/>
    </g>
    <g data-p="body">
      <ellipse cx="96" cy="226" rx="17" ry="9" fill="#e85f45"/>
      <ellipse cx="144" cy="226" rx="17" ry="9" fill="#e85f45"/>
      <ellipse cx="120" cy="178" rx="54" ry="50" fill="url(#pip-body)"/>
      <ellipse cx="120" cy="190" rx="33" ry="30" fill="url(#pip-belly)"/>
      <ellipse cx="70" cy="176" rx="12" ry="20" fill="#f26a4f" transform="rotate(28 70 176)"/>
      <g class="pip-coinarm">
        <ellipse cx="168" cy="182" rx="12" ry="22" fill="#f26a4f" transform="rotate(-50 168 182)"/>
        <g transform="translate(190 186)">
          <circle r="24" fill="url(#pip-coin)" stroke="#ffb3c8" stroke-width="3"/>
          <circle r="17" fill="none" stroke="#ffd7e2" stroke-width="1.5" opacity=".55"/>
          <text y="9" text-anchor="middle" font-family="Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" font-weight="800" font-size="27" fill="#fff3ea">@</text>
        </g>
      </g>
    </g>
    <g data-p="head">
      <g class="pip-gills">
        <path class="pip-gill" style="--ox:66px;--oy:96px" d="M70 92 C 56 82, 46 70, 44 56" fill="none" stroke="url(#pip-gillg)" stroke-width="11" stroke-linecap="round"/>
        <path class="pip-gill" style="--ox:60px;--oy:112px" d="M62 110 C 46 106, 34 98, 26 86" fill="none" stroke="url(#pip-gillg)" stroke-width="11" stroke-linecap="round"/>
        <path class="pip-gill" style="--ox:64px;--oy:128px" d="M66 128 C 52 132, 40 134, 30 148" fill="none" stroke="url(#pip-gillg)" stroke-width="11" stroke-linecap="round"/>
        <circle cx="44" cy="56" r="8" fill="#ff8fb0"/><circle cx="26" cy="86" r="8" fill="#ff8fb0"/><circle cx="30" cy="148" r="8" fill="#ff8fb0"/>
      </g>
      <g class="pip-gills">
        <path class="pip-gill r" style="--ox:174px;--oy:96px" d="M170 92 C 184 82, 194 70, 196 56" fill="none" stroke="url(#pip-gillg)" stroke-width="11" stroke-linecap="round"/>
        <path class="pip-gill r" style="--ox:180px;--oy:112px" d="M178 110 C 194 106, 206 98, 214 86" fill="none" stroke="url(#pip-gillg)" stroke-width="11" stroke-linecap="round"/>
        <path class="pip-gill r" style="--ox:176px;--oy:128px" d="M174 128 C 188 132, 200 134, 210 148" fill="none" stroke="url(#pip-gillg)" stroke-width="11" stroke-linecap="round"/>
        <circle cx="196" cy="56" r="8" fill="#ff8fb0"/><circle cx="214" cy="86" r="8" fill="#ff8fb0"/><circle cx="210" cy="148" r="8" fill="#ff8fb0"/>
      </g>
      <ellipse cx="120" cy="112" rx="64" ry="56" fill="url(#pip-body)"/>
      <ellipse cx="84" cy="132" rx="10" ry="6.5" fill="#ff5c8a" opacity=".5"/>
      <ellipse cx="156" cy="132" rx="10" ry="6.5" fill="#ff5c8a" opacity=".5"/>
      <g class="pip-eye" transform="translate(97 110)">
        <g class="pip-lid"><circle r="12" fill="#fff8f2"/><g data-pupil><circle r="8.5" fill="#3b1b23"/><circle cx="-3" cy="-3" r="3" fill="#fff"/></g></g>
      </g>
      <g class="pip-eye" transform="translate(143 110)">
        <g class="pip-lid"><circle r="12" fill="#fff8f2"/><g data-pupil><circle r="8.5" fill="#3b1b23"/><circle cx="-3" cy="-3" r="3" fill="#fff"/></g></g>
      </g>
      <path class="pip-mouth" d="M104 134 Q 120 150 136 134" fill="none" stroke="#5a2431" stroke-width="4" stroke-linecap="round"/>
      <g class="pip-mouth-open"><path d="M104 132 Q 120 160 136 132 Z" fill="#5a2431"/><ellipse cx="120" cy="147" rx="8" ry="5" fill="#ff8fa6"/></g>
    </g>
    <g class="pip-sparks" fill="#ffc29b">
      <circle class="pip-spark" style="--dx:-40px;--dy:-50px" cx="120" cy="120" r="4"/>
      <circle class="pip-spark" style="--dx:46px;--dy:-44px" cx="120" cy="120" r="3.5"/>
      <circle class="pip-spark" style="--dx:-56px;--dy:10px" cx="120" cy="120" r="3"/>
      <circle class="pip-spark" style="--dx:60px;--dy:6px" cx="120" cy="120" r="4"/>
      <circle class="pip-spark" style="--dx:4px;--dy:-70px" cx="120" cy="120" r="3"/>
    </g>
  </g>
</svg>`;

  function mount(slot) {
    const el = document.createElement('div');
    el.className = 'pip';
    el.tabIndex = 0;
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', 'Pip, the InstaPaid axolotl. Press Enter to make him jump.');
    el.innerHTML = SVG + '<div class="pip-say" aria-live="polite"></div>';
    slot.appendChild(el);

    const head = el.querySelector('[data-p="head"]');
    const body = el.querySelector('[data-p="body"]');
    const tail = el.querySelector('[data-p="tail"]');
    const pupils = el.querySelectorAll('[data-pupil]');
    const say = el.querySelector('.pip-say');

    // Where the pointer is, relative to Pip's eyes, in his own units (-1..1 each way).
    let tx = 0, ty = 0, cx = 0, cy = 0, lastX = 0, lastY = 0, vel = 0, near = false;
    const look = (px, py) => {
      const r = el.getBoundingClientRect();
      const ex = r.left + r.width * 0.5, ey = r.top + r.height * 0.44;
      const dx = px - ex, dy = py - ey;
      const reach = Math.max(r.width, 260) * 1.6;
      const d = Math.hypot(dx, dy) || 1;
      const k = Math.min(1, d / reach);
      tx = (dx / d) * k; ty = (dy / d) * k;
      near = d < r.width * 0.9;
      vel = Math.min(1, Math.hypot(px - lastX, py - lastY) / 40);
      lastX = px; lastY = py;
    };
    window.addEventListener('pointermove', (e) => look(e.clientX, e.clientY), { passive: true });
    window.addEventListener('touchmove', (e) => { const t = e.touches[0]; if (t) look(t.clientX, t.clientY); }, { passive: true });
    window.addEventListener('pointerleave', () => { tx = 0; ty = 0; near = false; });

    let idle = 0;
    const tick = (now) => {
      // Ease toward the pointer; drift a little on his own when nobody moves.
      idle += 0.012;
      const ax = tx + Math.sin(idle) * 0.08, ay = ty + Math.cos(idle * 0.7) * 0.05;
      cx += (ax - cx) * 0.12; cy += (ay - cy) * 0.12;
      vel *= 0.94;
      const px = cx * 4.2, py = cy * 3.6;
      pupils.forEach((p) => { p.setAttribute('transform', `translate(${px.toFixed(2)} ${py.toFixed(2)})`); });
      head.style.transform = `translate(${(cx * 7).toFixed(2)}px, ${(cy * 5).toFixed(2)}px) rotate(${(cx * 7).toFixed(2)}deg)`;
      head.style.transformOrigin = '120px 160px';
      body.style.transform = `translate(${(cx * 3).toFixed(2)}px, ${(cy * 1.5).toFixed(2)}px) rotate(${(cx * 2.5).toFixed(2)}deg)`;
      body.style.transformOrigin = '120px 226px';
      tail.style.transform = `rotate(${(-cx * 9 - vel * 12).toFixed(2)}deg)`;
      tail.style.transformOrigin = '152px 196px';
      el.classList.toggle('is-open', near || el.classList.contains('is-jump'));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    // Blinks: every 2.5–6 s, sometimes twice.
    const blink = () => {
      el.classList.add('is-blink');
      setTimeout(() => el.classList.remove('is-blink'), 110);
      if (Math.random() < 0.25) setTimeout(() => { el.classList.add('is-blink'); setTimeout(() => el.classList.remove('is-blink'), 110); }, 220);
      setTimeout(blink, 2500 + Math.random() * 3500);
    };
    setTimeout(blink, 1200);

    // A wave when he arrives on screen.
    const wave = () => { el.classList.add('is-wave'); setTimeout(() => el.classList.remove('is-wave'), 900); };
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) { setTimeout(wave, 500); io.disconnect(); } });
      io.observe(el);
    } else setTimeout(wave, 800);

    // Keep the bubble on screen: shift it sideways (the tail still points at Pip) and open it below
    // Pip when the sticky top bar leaves no room above. Measured from layout sizes, not the
    // transformed rect: the bubble is mid scale(.9) transition when this runs.
    const place = () => {
      say.style.marginLeft = '0px';
      say.style.setProperty('--tail', '0px');
      el.classList.remove('say-below');
      const pr = el.getBoundingClientRect();
      const vw = document.documentElement.clientWidth || window.innerWidth;
      const w = say.offsetWidth, h = say.offsetHeight, c = pr.left + pr.width / 2, pad = 8;
      let dx = 0;
      if (c - w / 2 < pad) dx = pad - (c - w / 2);
      else if (c + w / 2 > vw - pad) dx = vw - pad - (c + w / 2);
      say.style.marginLeft = `${dx.toFixed(1)}px`;
      const room = Math.max(0, w / 2 - 22); // the tail stays on the straight edge, clear of the corners
      say.style.setProperty('--tail', `${Math.max(-room, Math.min(room, -dx)).toFixed(1)}px`);
      const bar = document.querySelector('header.top');
      const barBottom = bar && getComputedStyle(bar).position !== 'static' ? Math.max(0, bar.getBoundingClientRect().bottom) : 0;
      const top = pr.top + pr.height * 0.04 - 6 - h;
      if (top < barBottom + pad) el.classList.add('say-below');
    };

    let line = Math.floor(Math.random() * LINES.length), sayT = 0;
    const jump = () => {
      if (el.classList.contains('is-jump')) return;
      el.classList.add('is-jump');
      setTimeout(() => el.classList.remove('is-jump'), 650);
      say.textContent = LINES[line++ % LINES.length];
      el.classList.add('is-say');
      place();
      clearTimeout(sayT);
      sayT = setTimeout(() => el.classList.remove('is-say'), 2600);
    };
    el.addEventListener('click', jump);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jump(); } });

    // The HD figure: a textured 3D model of Pip (media/pip.glb, made from the same drawing) shown
    // through <model-viewer> once it has loaded, in the big slot only. The SVG Pip stands in until
    // then and stays if WebGL, the library or the file is missing, so the page never waits on it.
    // Not on a data saver or a slow line: the engine and the model are 2.4 MB, and the SVG Pip is the same Pip.
    if (slot.dataset.size === 'lg' && !slot.hasAttribute('data-flat') && !lightLine() && hasWebGL()) mount3d(el, () => ({ cx, cy, near, vel }));
  }

  const easeOut = (t) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

  function lightLine() {
    const c = navigator.connection;
    return !!c && (c.saveData === true || /^(slow-2g|2g|3g)$/.test(c.effectiveType || ''));
  }

  function hasWebGL() {
    try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; }
  }

  function mount3d(el, state) {
    const src = document.currentScript?.dataset.model || '/media/pip.glb?v=bf81e36f';
    import('/vendor/model-viewer.min.js?v=283b0672').then(() => {
      const mv = document.createElement('model-viewer');
      mv.className = 'pip-3d';
      mv.setAttribute('src', src);
      mv.setAttribute('alt', '');
      mv.setAttribute('loading', 'eager');
      mv.setAttribute('autoplay', '');
      mv.setAttribute('disable-zoom', '');
      mv.setAttribute('disable-pan', '');
      mv.setAttribute('disable-tap', '');
      mv.setAttribute('interaction-prompt', 'none');
      mv.setAttribute('shadow-intensity', '1.2');
      mv.setAttribute('shadow-softness', '0.9');
      mv.setAttribute('exposure', '1.05');
      mv.setAttribute('camera-orbit', '0deg 82deg 105%');
      mv.setAttribute('camera-target', 'auto auto auto');
      mv.setAttribute('field-of-view', '28deg');
      mv.setAttribute('interpolation-decay', '120');
      mv.setAttribute('touch-action', 'pan-y');
      mv.setAttribute('aria-hidden', 'true');
      // Pip's own element takes the focus and the Enter key; the viewer is decoration, never a tab stop.
      mv.tabIndex = -1;
      const unfocus = () => mv.shadowRoot?.querySelectorAll('[tabindex]').forEach((n) => n.setAttribute('tabindex', '-1'));
      mv.innerHTML = '<div slot="progress-bar"></div>';
      let ok = false, spinUntil = 0, spinFrom = 0;
      el.addEventListener('click', () => { spinFrom = performance.now(); spinUntil = spinFrom + 720; });
      mv.addEventListener('load', () => {
        ok = true;
        unfocus();
        el.classList.add('has-3d');
        // Turn toward the pointer: yaw up to ±32°, pitch a little, and lean in when near.
        const turn = () => {
          if (!el.isConnected) return;
          const { cx, cy, near } = state();
          const now = performance.now();
          // A tap spins him round once, then he turns back to the pointer.
          const spin = now < spinUntil ? 360 * easeOut((now - spinFrom) / 720) : 0;
          const theta = (cx * 32 + spin).toFixed(1), phi = (82 - cy * 10).toFixed(1), r = near ? 98 : 105;
          mv.cameraOrbit = `${theta}deg ${phi}deg ${r}%`;
          requestAnimationFrame(turn);
        };
        requestAnimationFrame(turn);
      });
      mv.addEventListener('error', () => { if (!ok) mv.remove(); });
      el.insertBefore(mv, el.firstChild);
      unfocus();
      Promise.resolve(mv.updateComplete).then(unfocus, () => {});
    }).catch(() => { /* the SVG Pip stays */ });
  }

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  document.querySelectorAll('[data-mascot]').forEach(mount);
})();
