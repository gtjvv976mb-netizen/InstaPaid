// Pip in 3D: the HD axolotl (media/pip.glb, a Meshy 7 model made with Higgsfield), rigged here in code.
// Auto-riggers expect human proportions and refuse Pip's big head, so the skeleton is placed by
// hand from the mesh's own landmarks and every vertex is weighted to it on load. Everything he does
// is procedural: he breathes, sways his tail, wiggles his gills, turns his head and his eyes to the
// pointer, blinks, bounces from foot to foot, and every few seconds does something on his own: a
// wave, a look around, a hop, a spin, a wiggle or a dance. Tapped, he jumps, spins and dances in
// turn; pointing at a "Launch a coin" button gets a happy wiggle.
//
// mountPip3D(el, state) → Promise<boolean>. `el` is the .pip element (its pip:jump, pip:wave and
// pip:excite events drive the actions); state() → {cx, cy, near, vel}, the pointer relative to Pip
// (-1..1, y down) as mascot.js already smooths it. Resolves false when anything is missing, so the
// drawn Pip stays.
import * as T from '/vendor/three-pip.js?v=75d23c54';

const MODEL = '/media/pip.glb?v=f0865d24';
const S = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const ease = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

// The skeleton, in the model's own space (front +z, up +y; he is 1.9 units tall, feet at -0.95).
// "N" is his right (the viewer's left, -x), "P" his left.
const BONES = {
  root: [[0, -0.95, 0]],
  hips: [[0, -0.55, 0], 'root'],
  spine: [[0, -0.2, 0.02], 'hips'],
  head: [[0, 0.04, 0.02], 'spine'],
  gillN: [[-0.5, 0.42, 0], 'head'],
  gillP: [[0.5, 0.42, 0], 'head'],
  armN: [[-0.34, -0.15, 0.06], 'spine'],
  armP: [[0.34, -0.15, 0.06], 'spine'],
  legN: [[-0.19, -0.66, 0.05], 'hips'],
  legP: [[0.19, -0.66, 0.05], 'hips'],
  tail: [[-0.12, -0.45, -0.28], 'hips'],
  tail2: [[-0.42, -0.3, -0.52], 'tail'],
};
const NAMES = Object.keys(BONES);
const TAIL_BASE = new T.Vector3(...BONES.tail[0]), TAIL_TIP = new T.Vector3(-0.7, -0.05, -0.64);
// Each arm hangs from the shoulder (|x| 0.33) to the hand (|x| 0.68), about 0.11 thick.
const ARM_FROM = [0.33, -0.16], ARM_TO = [0.68, -0.42];
function armDistance(ax, y) {
  const dx = ARM_TO[0] - ARM_FROM[0], dy = ARM_TO[1] - ARM_FROM[1];
  const u = Math.max(0, Math.min(1, ((ax - ARM_FROM[0]) * dx + (y - ARM_FROM[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(ax - (ARM_FROM[0] + u * dx), y - (ARM_FROM[1] + u * dy));
}

/** How much each bone moves a vertex at (x, y, z): the regions measured from the mesh's slices. */
function weigh(x, y, z) {
  const w = {};
  const put = (k, v) => { if (v > 1e-4) w[k] = (w[k] || 0) + v; };
  const head = S(-0.02, 0.14, y);
  const gill = S(0.5, 0.62, Math.abs(x)) * S(0.12, 0.24, y);
  put('head', head * (1 - gill));
  put(x < 0 ? 'gillN' : 'gillP', head * gill);
  let rest = 1 - head;
  const behind = S(-0.24, -0.36, z) * (1 - S(-0.02, 0.1, y));
  if (behind > 0) {
    const d = TAIL_TIP.clone().sub(TAIL_BASE);
    const u = new T.Vector3(x, y, z).sub(TAIL_BASE).dot(d) / d.lengthSq();
    const far = S(0.35, 0.7, u);
    put('tail', rest * behind * (1 - far));
    put('tail2', rest * behind * far);
    rest *= 1 - behind;
  }
  const arm = (1 - S(0.12, 0.17, armDistance(Math.abs(x), y))) * S(0.33, 0.39, Math.abs(x));
  put(x < 0 ? 'armN' : 'armP', rest * arm);
  rest *= 1 - arm;
  const leg = S(-0.56, -0.7, y);
  const n = S(0.05, -0.05, x);
  put('legN', rest * leg * n);
  put('legP', rest * leg * (1 - n));
  rest *= 1 - leg;
  const up = S(-0.5, -0.15, y);
  put('spine', rest * up);
  put('hips', rest * (1 - up));
  return w;
}

function skin(geometry) {
  const pos = geometry.attributes.position;
  const idx = new Uint16Array(pos.count * 4), wts = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) {
    const top = Object.entries(weigh(pos.getX(i), pos.getY(i), pos.getZ(i))).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = top.reduce((s, [, v]) => s + v, 0) || 1;
    top.forEach(([k, v], j) => { idx[i * 4 + j] = NAMES.indexOf(k); wts[i * 4 + j] = v / sum; });
  }
  geometry.setAttribute('skinIndex', new T.Uint16BufferAttribute(idx, 4));
  geometry.setAttribute('skinWeight', new T.Float32BufferAttribute(wts, 4));
}

// ---- The eyes: decals laid on the face, so the iris can look around while the shine stays put.
const EYES = [
  { p: [-0.309, 0.361, 0.48], n: [-0.45, 0.14, 0.88] },
  { p: [0.296, 0.359, 0.477], n: [0.43, 0.14, 0.89] },
];
const EYE_SIZE = [0.235, 0.255];

function canvasTexture(draw, size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new T.CanvasTexture(c);
  t.colorSpace = T.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
const ellipse = (g, s, rx, ry) => { g.beginPath(); g.ellipse(s / 2, s / 2, rx * s, ry * s, 0, 0, Math.PI * 2); };
const TEX = {
  white: (g, s) => {
    ellipse(g, s, 0.47, 0.47);
    const gr = g.createRadialGradient(s * 0.45, s * 0.4, s * 0.05, s / 2, s / 2, s * 0.5);
    gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.75, '#fbeef0'); gr.addColorStop(1, '#e9c9d2');
    g.fillStyle = gr; g.fill();
    g.lineWidth = s * 0.035; g.strokeStyle = '#3a0f2e'; g.stroke();
  },
  iris: (g, s) => {
    ellipse(g, s, 0.44, 0.44);
    const gr = g.createRadialGradient(s / 2, s * 0.56, s * 0.02, s / 2, s / 2, s * 0.44);
    gr.addColorStop(0, '#0d030b'); gr.addColorStop(0.42, '#1e0719'); gr.addColorStop(0.72, '#4b1a52'); gr.addColorStop(0.93, '#7a3a86'); gr.addColorStop(1, '#2a0a26');
    g.fillStyle = gr; g.fill();
    ellipse(g, s, 0.2, 0.2); g.fillStyle = 'rgba(5,0,4,.9)'; g.fill();
  },
  shine: (g, s) => {
    g.fillStyle = '#ffffff';
    g.beginPath(); g.arc(s * 0.64, s * 0.32, s * 0.1, 0, Math.PI * 2); g.fill();
    g.globalAlpha = 0.85; g.beginPath(); g.arc(s * 0.42, s * 0.62, s * 0.045, 0, Math.PI * 2); g.fill();
  },
  lid: (g, s) => {
    ellipse(g, s, 0.5, 0.5);
    const gr = g.createLinearGradient(0, 0, 0, s); // his own skin by the eyes (#fe8277), lit from above
    gr.addColorStop(0, '#ff9a8c'); gr.addColorStop(0.6, '#fe8277'); gr.addColorStop(1, '#f06f66');
    g.fillStyle = gr; g.fill();
    g.beginPath(); g.ellipse(s / 2, s * 0.56, s * 0.4, s * 0.1, 0, 0.1, Math.PI - 0.1); g.lineWidth = s * 0.04; g.strokeStyle = '#3a0f2e'; g.stroke();
  },
};

function decal(mesh, at, orientation, w, h, map, layer, roughness = 0.25) {
  const geo = new T.DecalGeometry(mesh, at, orientation, new T.Vector3(w, h, 0.3));
  const mat = new T.MeshStandardMaterial({
    map, transparent: true, depthWrite: false, roughness, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -2 - layer, polygonOffsetUnits: -4 - 4 * layer,
  });
  const m = new T.Mesh(geo, mat);
  m.renderOrder = 10 + layer;
  return m;
}

function buildEyes(mesh, headBone, headRest) {
  const tex = Object.fromEntries(Object.entries(TEX).map(([k, f]) => [k, canvasTexture(f)]));
  return EYES.map((e) => {
    const at = new T.Vector3(...e.p), n = new T.Vector3(...e.n).normalize();
    const o = new T.Object3D(); o.position.copy(at); o.lookAt(at.clone().add(n));
    const right = new T.Vector3(1, 0, 0).applyQuaternion(o.quaternion), up = new T.Vector3(0, 1, 0).applyQuaternion(o.quaternion);
    const group = new T.Group();
    group.position.copy(headRest).negate(); // decals are in model space; the head bone carries them
    const white = decal(mesh, at, o.rotation, EYE_SIZE[0], EYE_SIZE[1], tex.white, 0);
    const iris = decal(mesh, at, o.rotation, EYE_SIZE[0] * 0.8, EYE_SIZE[1] * 0.8, tex.iris, 1);
    const shine = decal(mesh, at, o.rotation, EYE_SIZE[0] * 0.8, EYE_SIZE[1] * 0.8, tex.shine, 2);
    const lid = decal(mesh, at, o.rotation, EYE_SIZE[0] * 1.16, EYE_SIZE[1] * 1.12, tex.lid, 3, 0.7);
    lid.visible = false;
    group.add(white, iris, shine, lid);
    headBone.add(group);
    return { iris, lid, right, up };
  });
}

// ---- Soft round shadow under his feet.
function shadow() {
  const t = canvasTexture((g, s) => {
    const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0, 'rgba(0,0,0,.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, s, s);
  }, 128);
  const m = new T.Mesh(new T.PlaneGeometry(1.5, 0.75), new T.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  m.position.y = -0.955;
  return m;
}

export async function mountPip3D(el, state) {
  const canvas = document.createElement('canvas');
  canvas.className = 'pip-3d';
  canvas.setAttribute('aria-hidden', 'true');
  let renderer;
  try {
    renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
  } catch { return false; }
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.setClearColor(0x000000, 0);

  const gltf = await new T.GLTFLoader().loadAsync(MODEL).catch(() => null);
  if (!gltf) { renderer.dispose(); return false; }
  let src = null;
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => { if (!src && o.isMesh) src = o; });
  if (!src) { renderer.dispose(); return false; }

  // The mesh in model space (a quantized file keeps a scale and offset on its node), then skinned.
  const geometry = src.geometry.clone().applyMatrix4(src.matrixWorld);
  skin(geometry);
  const bones = {};
  for (const name of NAMES) {
    const [p, parent] = BONES[name];
    const b = new T.Bone();
    b.name = name;
    const at = new T.Vector3(...p);
    if (parent) { at.sub(new T.Vector3(...BONES[parent][0])); bones[parent].add(b); }
    b.position.copy(at);
    bones[name] = b;
  }
  const body = new T.SkinnedMesh(geometry, src.material);
  body.add(bones.root);
  body.bind(new T.Skeleton(NAMES.map((n) => bones[n])));
  body.updateMatrixWorld(true);
  const eyes = buildEyes(body, bones.head, new T.Vector3(...BONES.head[0]));

  const scene = new T.Scene();
  scene.add(body, shadow());
  scene.add(new T.HemisphereLight(0xfff1e8, 0x3a1a26, 2.1));
  const key = new T.DirectionalLight(0xffffff, 2.4); key.position.set(1.6, 3, 4); scene.add(key);
  const rim = new T.DirectionalLight(0xffb3c8, 1.6); rim.position.set(-3, 2, -2.5); scene.add(rim);
  const camera = new T.PerspectiveCamera(26, 1, 0.1, 50);
  camera.position.set(0, 0.25, 5.6);
  camera.lookAt(0, -0.02, 0);

  const resize = () => {
    const w = canvas.clientWidth || el.clientWidth, h = canvas.clientHeight || el.clientHeight;
    if (!w || !h) return;
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  el.insertBefore(canvas, el.firstChild);
  resize();
  new ResizeObserver(resize).observe(canvas);

  // Actions: one at a time; a new tap cuts in.
  let action = null, taps = 0, nextBlink = 1.5, blinkUntil = 0;
  const start = (name, dur) => { action = { name, t0: clock, dur }; };
  el.addEventListener('pip:wave', () => start('wave', 1.8));
  el.addEventListener('pip:jump', () => { const n = taps++ % 3; if (n === 0) start('jump', 0.9); else if (n === 1) start('spin', 1.1); else start('dance', 3.2); });
  // A happy wiggle when a launch button is pointed at; not over another action, at most every 2.5 s.
  let lastExcite = -9;
  el.addEventListener('pip:excite', () => {
    if ((action && action.name !== 'look') || clock - lastExcite < 2.5) return;
    lastExcite = clock;
    start('wiggle', 1.3);
  });

  let visible = true;
  new IntersectionObserver((es) => { visible = es.some((e) => e.isIntersecting); }).observe(el);

  let clock = 0, last = performance.now(), idleFidget = 3, lastIdle = '';
  const frame = (now) => {
    if (!el.isConnected) { renderer.dispose(); return; }
    requestAnimationFrame(frame);
    const dt = Math.max(0, Math.min(0.05, (now - last) / 1000)); // a frame can start before the mount did
    last = now;
    if (!visible) return;
    clock += dt;
    const t = clock;
    const { cx = 0, cy = 0, vel = 0, near = false } = state();

    for (const b of Object.values(bones)) { b.rotation.set(0, 0, 0); b.scale.set(1, 1, 1); }
    bones.root.position.set(...BONES.root[0]);

    // Always, and big enough to see: breathing, a bouncy step from foot to foot, head bobbing to it,
    // arms swinging, tail wagging and gills fluttering; head and body turned to the pointer.
    const br = Math.sin(t * 2.4);
    bones.spine.scale.set(1 + br * 0.025, 1 + br * 0.04, 1 + br * 0.025);
    const step = Math.sin(t * 3.2);
    bones.root.position.y += Math.abs(step) * 0.045;
    bones.hips.rotation.z = step * 0.07;
    bones.spine.rotation.set(0, 0, -step * 0.05);
    bones.legN.rotation.x = Math.max(0, step) * -0.18;
    bones.legP.rotation.x = Math.max(0, -step) * -0.18;
    const yaw = cx * 0.55, pitch = cy * 0.34;
    bones.head.rotation.set(pitch + Math.sin(t * 6.4) * 0.05, yaw, -cx * 0.1 + step * 0.06);
    bones.spine.rotation.x += pitch * 0.2;
    bones.spine.rotation.y += yaw * 0.3;
    const gw = Math.sin(t * 4.2) * 0.16 + vel * 0.2 + (near ? Math.sin(t * 12) * 0.08 : 0);
    bones.gillN.rotation.z = -gw; bones.gillP.rotation.z = gw;
    bones.gillN.rotation.y = Math.sin(t * 2.3) * 0.1; bones.gillP.rotation.y = -Math.sin(t * 2.3) * 0.1;
    bones.tail.rotation.y = Math.sin(t * 3.2) * 0.45 - cx * 0.2 - vel * 0.3;
    bones.tail2.rotation.y = Math.sin(t * 3.2 - 1) * 0.55;
    bones.armN.rotation.z = -0.1 - Math.sin(t * 3.2) * 0.22;
    bones.armP.rotation.z = 0.1 - Math.sin(t * 3.2) * 0.22;
    bones.armN.rotation.x = Math.sin(t * 3.2) * 0.2;
    bones.armP.rotation.x = -Math.sin(t * 3.2) * 0.2;

    // On his own every few seconds, whether or not anyone is there: a wave, a look around, a hop,
    // a spin, a wiggle or a dance. Never the same one twice in a row.
    idleFidget -= dt;
    if (!action && idleFidget < 0) {
      const moves = [['wave', 1.8], ['look', 2.4], ['hop', 0.9], ['spin', 1.1], ['wiggle', 1.3], ['dance', 3.2]]
        .filter(([m]) => m !== lastIdle);
      const [m, d] = moves[Math.floor(Math.random() * moves.length)];
      lastIdle = m;
      start(m === 'hop' ? 'jump' : m, d);
      idleFidget = 2.5 + Math.random() * 2.5;
    }

    if (action) {
      const u = (t - action.t0) / action.dur;
      if (u >= 1) action = null;
      else if (action.name === 'wave') {
        const up = ease(u / 0.2) * (1 - ease((u - 0.8) / 0.2));
        bones.armP.rotation.z += up * 2.25;
        bones.armP.rotation.x += up * (Math.sin(t * 13) * 0.35);
        bones.head.rotation.z -= up * 0.12;
        bones.spine.rotation.z -= up * 0.05;
      } else if (action.name === 'jump') {
        const air = Math.max(0, Math.min(1, (u - 0.15) / 0.65));
        const h = 4 * air * (1 - air);
        const squash = u < 0.15 ? Math.sin((u / 0.15) * Math.PI) : u > 0.8 ? Math.sin(((u - 0.8) / 0.2) * Math.PI) : 0;
        bones.root.position.y += h * 0.42;
        bones.root.scale.set(1 + squash * 0.08, 1 - squash * 0.12 + h * 0.05, 1 + squash * 0.08);
        bones.armN.rotation.z -= h * 1.5; bones.armP.rotation.z += h * 1.5;
        bones.legN.rotation.x = -h * 0.35; bones.legP.rotation.x = -h * 0.35;
        bones.tail.rotation.x = h * 0.4;
        bones.gillN.rotation.z -= h * 0.25; bones.gillP.rotation.z += h * 0.25;
      } else if (action.name === 'dance') {
        const env = ease(u / 0.1) * (1 - ease((u - 0.9) / 0.1));
        const beat = t * Math.PI * 2 * 2;
        bones.hips.rotation.z = Math.sin(beat / 2) * 0.16 * env;
        bones.spine.rotation.z -= Math.sin(beat / 2) * 0.2 * env;
        bones.head.rotation.z += Math.sin(beat / 2 + 0.6) * 0.18 * env;
        bones.root.position.y += Math.abs(Math.sin(beat / 2)) * 0.07 * env;
        bones.armN.rotation.z -= (0.9 + Math.sin(beat) * 0.6) * env;
        bones.armP.rotation.z += (0.9 - Math.sin(beat) * 0.6) * env;
        bones.legN.rotation.z = Math.max(0, Math.sin(beat / 2)) * -0.2 * env;
        bones.legP.rotation.z = Math.max(0, -Math.sin(beat / 2)) * 0.2 * env;
        bones.tail.rotation.y += Math.sin(beat) * 0.3 * env;
      } else if (action.name === 'spin') {
        // A full turn on the spot with a little hop; the head keeps finding the pointer at the end.
        const turn = ease(u) * Math.PI * 2;
        bones.root.rotation.y = turn;
        const hop = Math.sin(Math.min(1, u / 0.8) * Math.PI);
        bones.root.position.y += hop * 0.12;
        bones.armN.rotation.z -= hop * 0.9; bones.armP.rotation.z += hop * 0.9;
        bones.head.rotation.y *= 1 - hop;
        bones.tail.rotation.y += hop * 0.5;
        bones.gillN.rotation.z -= hop * 0.3; bones.gillP.rotation.z += hop * 0.3;
      } else if (action.name === 'wiggle') {
        // Excited: a quick shimmy, arms flapping, gills flared, a bounce.
        const env = Math.sin(u * Math.PI);
        const f = Math.sin(t * 22);
        bones.hips.rotation.z = f * 0.12 * env;
        bones.spine.rotation.z -= f * 0.1 * env;
        bones.head.rotation.z += Math.sin(t * 22 + 1) * 0.1 * env;
        bones.root.position.y += Math.abs(Math.sin(t * 11)) * 0.05 * env;
        bones.armN.rotation.z -= (0.5 + f * 0.35) * env;
        bones.armP.rotation.z += (0.5 - f * 0.35) * env;
        bones.gillN.rotation.z -= 0.3 * env; bones.gillP.rotation.z += 0.3 * env;
        bones.tail.rotation.y += Math.sin(t * 16) * 0.5 * env;
      } else if (action.name === 'look') {
        // Looks one way, then the other, then back: curious.
        const env = Math.sin(u * Math.PI);
        bones.head.rotation.y += Math.sin(u * Math.PI * 2) * 0.7 * env;
        bones.head.rotation.z += env * 0.15;
        bones.spine.rotation.y += Math.sin(u * Math.PI * 2) * 0.2 * env;
      }
    }

    // The eyes: the iris leads the head toward the pointer; now and then a blink.
    const ox = Math.max(-1, Math.min(1, cx * 1.4)) * 0.024, oy = -Math.max(-1, Math.min(1, cy * 1.4)) * 0.022;
    for (const e of eyes) e.iris.position.copy(e.right).multiplyScalar(ox).addScaledVector(e.up, oy);
    nextBlink -= dt;
    if (nextBlink < 0) { blinkUntil = t + 0.12; nextBlink = 2.5 + Math.random() * 3.5; if (Math.random() < 0.25) nextBlink = 0.25; }
    const closed = t < blinkUntil || (!!action && action.name === 'jump' && (t - action.t0) / action.dur > 0.82);
    for (const e of eyes) e.lid.visible = closed;

    renderer.render(scene, camera);
  };
  requestAnimationFrame(frame);
  return true;
}
