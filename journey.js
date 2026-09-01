import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/* <dlt-journey> — the scroll-scrubbed Woxsen → Miyapur journey.
   Scroll is the only motor: nothing moves on its own. The element publishes
   --journey-t / --journey-handoff on <html> and fires 'journeybeat' so the DOM
   layer (stop cards, hand-off line) stays plain HTML. */

const INK = '#1A1D22', PAPER = '#F7F5F0', GREEN = '#0E4B34';
const SHELL = '#F2EFE8', RIBBON = '#151B20';

const WOXSEN = 40, MIYAPUR = 118;

const BEATS = [
  [0.000, 0.215, 'depart'],
  [0.215, 0.435, 'woxsen'],
  [0.435, 0.700, 'transit'],
  [0.700, 0.885, 'miyapur'],
  [0.885, 1.001, 'handoff'],
];

const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const WHEEL_NOTCHES = 62;      // wheel clicks to travel the whole journey

/* ---------------------------------------------------------------------------
   One continuous path, not a chain of eased moves.

   Everything scroll-driven is sampled from C1 cubic Hermite splines, so the
   camera and the coach carry non-zero velocity THROUGH each keyframe instead
   of decelerating to a stop and re-accelerating at every one of them. That
   stalling is what makes scrubbed cameras feel like a slideshow.
   --------------------------------------------------------------------------- */

function hermite(x0, x1, y0, y1, m0, m1, x) {
  const h = x1 - x0, s = h === 0 ? 0 : (x - x0) / h, s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * y0 + (s3 - 2 * s2 + s) * h * m0
       + (-2 * s3 + 3 * s2) * y1 + (s3 - s2) * h * m1;
}
function findSpan(xs, x) {
  let i = 0;
  while (i < xs.length - 2 && x > xs[i + 1]) i++;
  return i;
}

/* Finite-difference tangents: C1 and never stalls. For channels that are not
   monotonic (lateral offset swings either side of the road) this is what keeps
   the camera sweeping through a key rather than pausing on it. */
const TENSION = 0.78; // trims Hermite overshoot without flattening the path
function fdTangents(xs, ys) {
  const n = xs.length, m = new Array(n);
  const sec = i => (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
  m[0] = sec(0) * TENSION;
  m[n - 1] = sec(n - 2) * TENSION;
  for (let i = 1; i < n - 1; i++) m[i] = (sec(i - 1) + sec(i)) / 2 * TENSION;
  return m;
}
function makeSpline(xs, ys) {
  const m = fdTangents(xs, ys);
  return x => {
    if (x <= xs[0]) return ys[0] + (x - xs[0]) * m[0];
    if (x >= xs[xs.length - 1]) {
      const n = xs.length - 1;
      return ys[n] + (x - xs[n]) * m[n];
    }
    const i = findSpan(xs, x);
    return hermite(xs[i], xs[i + 1], ys[i], ys[i + 1], m[i], m[i + 1], x);
  };
}

/* ---------------------------------------------------------------------------
   SPEED PROFILE, integrated — not a distance curve with knots.

   Authoring distance at keyframes means the coach's ACCELERATION steps at every
   one of them, and a step in acceleration is exactly what a jerk is. So the
   speed itself is authored as one smooth analytic function and integrated once
   at load: three cruise levels (approach, highway, city) crossfaded by
   smoothsteps, with a soft Gaussian dip over each stop. Continuous everywhere,
   so there is no scroll position at which the coach can lurch.

   The three levels are solved so the coach is at Woxsen (40 m) at t = 0.28 and
   Miyapur (118 m) at t = 0.74 exactly — the stop cards key off those.
   --------------------------------------------------------------------------- */
const smoothstep = (a, b, t) => { const x = clamp01((t - a) / (b - a)); return x * x * (3 - 2 * x); };
const SP_LEVEL = [67.9, 197.7, 97.1];        // m per unit t: approach / highway / city
const spDip = t => 1
  - 0.34 * Math.exp(-4.5 * Math.pow((t - 0.300) / 0.130, 2))   // Woxsen gate
  - 0.34 * Math.exp(-4.5 * Math.pow((t - 0.755) / 0.120, 2));  // under the viaduct
function speedAt(t) {
  const a = 1 - smoothstep(0.10, 0.46, t), c = smoothstep(0.58, 0.92, t);
  return spDip(t) * (SP_LEVEL[0] * a + SP_LEVEL[1] * (1 - a - c) + SP_LEVEL[2] * c);
}
const TRACK_N = 6000, TRACK_CUM = new Float64Array(TRACK_N + 1);
for (let i = 1; i <= TRACK_N; i++) {
  const t = i / TRACK_N;
  TRACK_CUM[i] = TRACK_CUM[i - 1] + (speedAt(t - 1 / TRACK_N) + speedAt(t)) / (2 * TRACK_N);
}
const trackAt = t => {
  const x = clamp01(t) * TRACK_N, i = Math.min(TRACK_N - 1, Math.floor(x));
  return 18 + TRACK_CUM[i] + (TRACK_CUM[i + 1] - TRACK_CUM[i]) * (x - i);
};

const LANE = -2.25;            // the coach's lateral offset in its lane
const COACH_H = 3.0, COACH_L = 11.0, COACH_W = 2.8, AIM_H = 1.65;

/* ---------------------------------------------------------------------------
   ONE camera rig, not a chain of shots.

   Every camera channel is a C1 spline over t, so the frame evolves continuously
   for the whole journey: no shot index, no blend windows, nothing to cut. The
   camera holds a three-quarter rear position throughout — it drifts across the
   road and climbs, but never crosses the coach's nose, which is what produced
   the 180-degree whips.

     azim   degrees around the coach, 180 = directly behind
     elev   degrees above the coach's plane
     frame  the coach's target height as a fraction of viewport height
     fov    lens; distance is derived from frame + fov, so scale stays authored
     ax/ay  where the coach sits in frame (NDC), so stop cards can own the rest
   --------------------------------------------------------------------------- */
const RIG_T     = [0.00, 0.14, 0.28, 0.42, 0.58, 0.74, 0.87, 1.00];
const RIG_AZIM  = [ 146,  149,  140,  148,  158,  150,  155,  165];
const RIG_ELEV  = [   7,    8,   10,   12,   20,   13,   16,   26];
const RIG_FRAME = [0.35, 0.36, 0.38, 0.36, 0.30, 0.34, 0.32, 0.28];
const RIG_FOV   = [  46,   44,   42,   41,   36,   40,   39,   36];
const RIG_AX    = [0.12, 0.14,-0.22,-0.20, 0.02,-0.18,-0.10, 0.00];
const RIG_AY    = [0.06, 0.05, 0.05, 0.06, 0.10, 0.06, 0.09, 0.13];
const RIG = {
  azim:  makeSpline(RIG_T, RIG_AZIM),
  elev:  makeSpline(RIG_T, RIG_ELEV),
  frame: makeSpline(RIG_T, RIG_FRAME),
  fov:   makeSpline(RIG_T, RIG_FOV),
  ax:    makeSpline(RIG_T, RIG_AX),
  ay:    makeSpline(RIG_T, RIG_AY),
};
const DEG = Math.PI / 180;

/* the sign face, drawn once into a canvas — letters set as letters, not blocks */
function signTexture() {
  const W = 1024, H = 218, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#8E8A7C'; g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(110,106,94,.55)';
  for (let i = 1; i < 7; i++) g.fillRect(Math.round(i * W / 7) - 1, 0, 2, H);
  g.fillStyle = '#1B1E18';
  g.textBaseline = 'middle';
  g.font = '700 88px Archivo, "Helvetica Neue", sans-serif';
  g.fillText('WOXSEN', 232, 68);
  g.fillStyle = '#2C5439';
  g.beginPath(); g.arc(140, 78, 50, 0, 6.2832); g.fill();
  g.fillStyle = '#1B1E18';
  g.font = '500 42px Archivo, "Helvetica Neue", sans-serif';
  g.letterSpacing = '9px';
  g.fillText('UNIVERSITY', 234, 132);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* Stop-marker faces. The two endpoints have to be legible as PLACES, not as
   abstract green bars — a passenger reads the name before they read the shape. */
function markerTexture(title, sub, opts = {}) {
  const W = 1024, H = 600, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const dark = !!opts.dark;
  g.fillStyle = dark ? '#151B20' : '#EDEAE1'; g.fillRect(0, 0, W, H);
  g.fillStyle = dark ? 'rgba(247,245,240,.10)' : 'rgba(14,16,20,.07)';
  g.fillRect(0, 0, W, 26); g.fillRect(0, H - 26, W, 26);
  g.fillStyle = '#1E7A52'; g.fillRect(74, 118, 150, 12);
  g.textBaseline = 'alphabetic';
  g.fillStyle = dark ? '#F7F5F0' : '#161A18';
  g.font = '700 132px Archivo, "Helvetica Neue", sans-serif';
  g.fillText(title, 74, 300);
  g.fillStyle = dark ? '#9FA79C' : '#5B6058';
  g.font = '500 52px Archivo, "Helvetica Neue", sans-serif';
  g.letterSpacing = '10px';
  g.fillText(sub, 78, 400);
  g.fillStyle = dark ? '#5FAE86' : '#0E4B34';
  g.font = '700 46px Archivo, "Helvetica Neue", sans-serif';
  g.letterSpacing = '4px';
  g.fillText('DLT', 78, 500);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
function beatAt(t) {
  for (const [a, b, name] of BEATS) if (t >= a && t < b) return name;
  return 'handoff';
}

class DLTJourney extends HTMLElement {
  connectedCallback() {
    if (this._booted) return;
    this._booted = true;
    this.style.display = 'block';
    this.style.position = 'absolute';
    this.style.inset = '0';

    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100%;height:100%;pointer-events:none';
    /* the journey is decorative: every fact it shows is also in the DOM cards,
       so screen readers should walk past it rather than read a blank canvas */
    canvas.setAttribute('aria-hidden', 'true');
    this.setAttribute('aria-hidden', 'true');
    this.appendChild(canvas);
    this._canvas = canvas;

    this._t = -1;
    this._beat = '';
    this._visible = true;
    this._dirty = true;

    try {
      this._initScene();
    } catch (err) {
      /* no WebGL, or a driver that refuses the context: say so once and let the
         page fall back to the static route. Booking must never wait on 3D. */
      console.warn('DLT journey: 3D unavailable, static fallback', err);
      this.dispatchEvent(new CustomEvent('journeyfailed', { bubbles: true, composed: true }));
      return;
    }
    /* Readiness is announced from the first PAINTED frame in _tick — dispatching
       during connectedCallback can fire before the host has the element in the
       document, and waiting for the coach GLB made a slow network look like a
       failure. The coach arrives in its own event. */
    /* The coach is the heaviest asset on the site, so it is not on the critical
       path: the road draws first and the model is fetched once the browser is
       idle (or on the first scroll intent, whichever comes first). */
    const loadSoon = () => {
      if (this._coachRequested) return;
      this._coachRequested = true;
      this._loadCoach();
    };
    if ('requestIdleCallback' in window) requestIdleCallback(loadSoon, { timeout: 1200 });
    else setTimeout(loadSoon, 300);
    addEventListener('scroll', loadSoon, { once: true, passive: true });

    this._onScroll = () => {
      this._dirty = true;
      /* Scroll is the motor, so it drives a frame itself rather than waiting for
         the next animation frame. Where the browser throttles rAF (background
         tabs, some embedded views) the journey still tracks the scrollbar. */
      this._frame();
    };
    addEventListener('scroll', this._onScroll, { passive: true });

    /* Chrome animates every wheel notch over ~120 ms of its own, which reads as
       the coach coasting after the wheel stops. While the journey owns the
       viewport we move the page ourselves, instantly: one notch, one step, no
       animation to trail. At either edge we do nothing, so the user scrolls out
       of the section natively. */
    this._onWheel = (e) => {
      if (e.ctrlKey) return;
      const host = this.closest('[data-journey-scroll]') || this.parentElement;
      const r = host.getBoundingClientRect();
      const span = r.height - innerHeight;
      if (span <= 0) return;
      const top = scrollY + r.top;
      const here = scrollY - top;
      if (here < -1 || here > span + 1) return;                 // outside the pin
      const notch = span / WHEEL_NOTCHES;
      const dy = Math.abs(e.deltaY) >= 40                       // wheel vs trackpad
        ? Math.sign(e.deltaY) * notch
        : e.deltaY * (e.deltaMode === 1 ? 16 : 1);
      const base = this._wTarget != null ? this._wTarget - top : here;
      const next = Math.min(span, Math.max(0, base + dy));
      if ((here <= 0 && dy < 0) || (here >= span && dy > 0)) return;
      e.preventDefault();
      /* one notch glides over ~100 ms and lands: smoother than a hard step,
         and short enough that the coach still stops with the wheel. */
      this._wTarget = top + next;
      if (!this._wRaf) this._wRaf = requestAnimationFrame(this._wheelStep);
    };
    this._wheelStep = () => {
      const target = this._wTarget;
      if (target == null) { this._wRaf = 0; return; }
      const d = target - scrollY;
      if (Math.abs(d) < 0.6) {
        scrollTo({ top: target, behavior: 'instant' });
        this._wTarget = null; this._wRaf = 0; return;
      }
      scrollTo({ top: scrollY + d * 0.34, behavior: 'instant' });
      this._wRaf = requestAnimationFrame(this._wheelStep);
    };
    addEventListener('wheel', this._onWheel, { passive: false });
    this._ro = new ResizeObserver(() => { this._resize(); this._dirty = true; });
    this._ro.observe(this);
    this._io = new IntersectionObserver(e => {
      const vis = e[0].isIntersecting;
      if (vis && !this._visible) { this._snap = true; this._snapRig = true; this._last = 0; }
      this._visible = vis;
    }, { rootMargin: '20% 0px' });
    this._io.observe(this);

    this._resize();
    this._tick();
  }
  disconnectedCallback() {
    removeEventListener('scroll', this._onScroll);
    removeEventListener('wheel', this._onWheel);
    cancelAnimationFrame(this._wRaf);
    this._ro?.disconnect(); this._io?.disconnect();
    cancelAnimationFrame(this._raf);
    this._renderer?.dispose();
  }

  _initScene() {
    const renderer = new THREE.WebGLRenderer({
      canvas: this._canvas, antialias: true, alpha: false,
    });
    /* Performance tier. Phones get a lower ceiling on pixel ratio and no shadow
       pass at all: the scene is read at a glance there, and a dropped frame
       during scroll is far more visible than a missing contact shadow. */
    const lite = innerWidth < 760 || (navigator.hardwareConcurrency || 8) <= 4;
    this._lite = lite;
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, lite ? 1.4 : 2));
    renderer.shadowMap.enabled = !lite;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    this._renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(PAPER);
    scene.fog = new THREE.Fog(PAPER, 38, 215);
    this._scene = scene;

    this._camera = new THREE.PerspectiveCamera(38, 1, 0.5, 900);

    scene.add(new THREE.HemisphereLight('#ffffff', '#cfd4cb', 1.05));
    const key = new THREE.DirectionalLight('#fff8ec', 2.1);
    key.castShadow = !lite;
    key.shadow.mapSize.set(lite ? 512 : 1024, lite ? 512 : 1024);
    const sc = key.shadow.camera;
    sc.left = -34; sc.right = 34; sc.top = 34; sc.bottom = -34; sc.near = 1; sc.far = 150;
    key.shadow.bias = -0.0012;
    scene.add(key, key.target);
    this._key = key;

    /* ---- the road ---- */
    const curve = new THREE.CatmullRomCurve3([
      [0, 0, -12], [0, 0, 12], [4, 0, 34], [6, 0, 56],
      [2, 0, 78], [-5, 0, 100], [-4, 0, 122], [0, 0, 143], [3, 0, 166],
    ].map(p => new THREE.Vector3(...p)), false, 'catmullrom', 0.5);
    this._curve = curve;
    this._len = curve.getLength();

    const M = {
      asphalt: new THREE.MeshStandardMaterial({ color: INK, roughness: 0.94, metalness: 0.02 }),
      dash:    new THREE.MeshStandardMaterial({ color: '#1E7A52', roughness: 0.55 }),
      edge:    new THREE.MeshStandardMaterial({ color: '#D8D6CE', roughness: 0.7 }),
      ground:  new THREE.MeshStandardMaterial({ color: '#EFEDE4', roughness: 1 }),
      field:   new THREE.MeshStandardMaterial({ color: '#DFE3D6', roughness: 1 }),
      trunk:   new THREE.MeshStandardMaterial({ color: '#4A4A42', roughness: 0.9 }),
      crown:   new THREE.MeshStandardMaterial({ color: '#2E5A3E', roughness: 0.85 }),
      block:   new THREE.MeshStandardMaterial({ color: '#E4E2D9', roughness: 0.8 }),
      blockAlt:new THREE.MeshStandardMaterial({ color: '#D3D6CE', roughness: 0.8 }),
      ink:     new THREE.MeshStandardMaterial({ color: '#23272D', roughness: 0.6 }),
      green:   new THREE.MeshStandardMaterial({ color: GREEN, roughness: 0.45 }),
      concrete:new THREE.MeshStandardMaterial({ color: '#D9D6CD', roughness: 0.88 }),
      signface:new THREE.MeshStandardMaterial({ color: '#8E8A7C', roughness: 0.9 }),
      signtext:new THREE.MeshStandardMaterial({ map: signTexture(), roughness: 0.85, transparent: true }),
      mkWoxsen:new THREE.MeshStandardMaterial({
        map: markerTexture('WOXSEN', 'BOARDING POINT', {}), roughness: 0.82 }),
      mkMiyapur:new THREE.MeshStandardMaterial({
        map: markerTexture('MIYAPUR', 'METRO · RED LINE', { dark: true }), roughness: 0.82 }),
      signtop: new THREE.MeshStandardMaterial({ color: '#6E6A5E', roughness: 0.9 }),
      joint:   new THREE.MeshStandardMaterial({ color: '#C3C0B6', roughness: 0.9 }),
      white:   new THREE.MeshStandardMaterial({ color: '#F4F2EC', roughness: 0.62 }),
      glass:   new THREE.MeshStandardMaterial({ color: '#DDE2DE', roughness: 0.28, metalness: 0.24 }),
      palm:    new THREE.MeshStandardMaterial({ color: '#6C6454', roughness: 0.88 }),
      frond:   new THREE.MeshStandardMaterial({ color: '#4A7A57', roughness: 0.78, side: THREE.DoubleSide }),
      hedge:   new THREE.MeshStandardMaterial({ color: '#2C5439', roughness: 0.9 }),
      lawn:    new THREE.MeshStandardMaterial({ color: '#DCE2D2', roughness: 1 }),
    };
    this._M = M;

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(700, 800), M.ground);
    ground.rotation.x = -Math.PI / 2; ground.position.set(0, -0.04, 75);
    ground.receiveShadow = true; scene.add(ground);

    scene.add(this._ribbon(curve, 9.2, 0.0, M.asphalt, true));
    scene.add(this._ribbon(curve, 0.26, 4.45, M.edge, false));
    scene.add(this._ribbon(curve, 0.26, -4.45, M.edge, false));
    scene.add(this._dashes(curve, M.dash));

    this._scatter(M);

    /* Stop markers: a low lit face on a stone base, carrying the place NAME.
       They were 7 m dark posts with a side arm, which read as a gibbet from
       every angle — and then as unlabelled green bars, which read as nothing. */
    [[WOXSEN, -12.5], [MIYAPUR, 12.5]].forEach(([d, side], i) => {
      const g = new THREE.Group();
      const face = i ? M.mkMiyapur : M.mkWoxsen;
      const base = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.5, 1.1), M.joint);
      base.position.y = 0.25; base.receiveShadow = true;
      const panel = new THREE.Mesh(new THREE.BoxGeometry(2.9, 1.7, 0.28),
        [M.signface, M.signface, M.signtop, M.signtop, face, face]);
      panel.position.y = 1.35; panel.castShadow = true;
      const cap = new THREE.Mesh(new THREE.BoxGeometry(3.1, 0.18, 0.42), M.signtop);
      cap.position.y = 2.29; cap.castShadow = true;
      const foot = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.10, 0.34), M.green);
      foot.position.y = 0.55;
      g.add(base, panel, cap, foot);
      this._place(g, d, side, side < 0 ? 0.12 : Math.PI - 0.12);
      g.name = i ? 'marker_miyapur' : 'marker_woxsen';
      scene.add(g);
    });
  }

  /* a flat ribbon following the curve, optionally the full road slab */
  _ribbon(curve, width, offset, mat, shadow) {
    const N = 420, pos = [], idx = [];
    const up = new THREE.Vector3(0, 1, 0), right = new THREE.Vector3();
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      const p = curve.getPointAt(u), tg = curve.getTangentAt(u);
      right.crossVectors(tg, up).normalize();
      const c = p.clone().addScaledVector(right, offset);
      const a = c.clone().addScaledVector(right, -width / 2);
      const b = c.clone().addScaledVector(right, width / 2);
      pos.push(a.x, 0.008 + (offset ? 0.004 : 0), a.z, b.x, 0.008 + (offset ? 0.004 : 0), b.z);
      if (i < N) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx); g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat);
    m.receiveShadow = !!shadow;
    return m;
  }

  /* the green centre line — the same dash that runs through the whole product */
  _dashes(curve, mat) {
    const step = 9, dashLen = 3.4;
    const n = Math.floor(this._len / step);
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.3, 0.04, dashLen), mat, n);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < n; i++) {
      const u = (i * step) / this._len;
      if (u > 1) break;
      const p = curve.getPointAt(u), tg = curve.getTangentAt(u);
      q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), tg.clone().normalize());
      m4.compose(new THREE.Vector3(p.x, 0.03, p.z), q, new THREE.Vector3(1, 1, 1));
      mesh.setMatrixAt(i, m4);
    }
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }

  _place(obj, dist, lateral, yaw = 0) {
    const u = clamp01(dist / this._len);
    const p = this._curve.getPointAt(u), tg = this._curve.getTangentAt(u);
    const right = new THREE.Vector3().crossVectors(tg, new THREE.Vector3(0, 1, 0)).normalize();
    obj.position.set(p.x + right.x * lateral, 0, p.z + right.z * lateral);
    obj.rotation.y = Math.atan2(tg.x, tg.z) + yaw;
    return obj;
  }

  /* environment. Every element earns its place: campus greenery at the start,
     open country in the middle, city blocks + the metro viaduct at Miyapur. */
  _scatter(M) {
    const S = this._scene;
    const rnd = (s => () => (s = (s * 16807) % 2147483647) / 2147483647)(7);

    const broad = [], palms = [];
    for (let d = -4; d < 172; d += 3.1) {
      const near = d < 56 ? 0.85 : d < 100 ? 0.32 : 0.18;
      [-1, 1].forEach(side => {
        if (rnd() > near) return;
        if (d > 34 && d < 68) return;                  // sightline to the board
        if (d < 34 && Math.abs(side * 11) < 40 && d > 4) {
          /* the opening frame puts this band behind the hero copy */
          if (side < 0) return;
        }

        const e = [d + rnd() * 2.4, side * (11 + rnd() * 26), 0.62 + rnd() * 0.92];
        /* palms only on the open lawn side of the campus, and never inside the
           building band, where their crowns appeared to sprout from rooftops */
        const palm = d > 24 && d < 58 && side > 0 && Math.abs(e[1]) < 26 && rnd() < 0.34;
        (palm ? palms : broad).push(e);
      });
    }
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), tone = new THREE.Color();
    const V = (x, y, z) => new THREE.Vector3(x, y, z);

    /* Neem and banyan read as an irregular clump of masses on a short thick
       trunk, never a cone. Three offset blobs per tree, each tree's offsets,
       flattening and foliage tone its own, so no two instances repeat. */
    const bTrunk = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.20, 0.36, 3.1, 7), M.trunk, broad.length);
    bTrunk.castShadow = true;
    /* three limbs leaving the trunk into the canopy — without them the crown
       floats and the tree reads as a ball on a stick */
    const LIMB = 3;
    const limb = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.07, 0.15, 2.5, 5), M.trunk, broad.length * LIMB);
    limb.castShadow = true;
    const BLOBS = [[2.30, 3.7, 0.80], [1.72, 4.7, 0.72], [1.48, 3.2, 0.88]];
    const blobs = BLOBS.map(() => {
      const im = new THREE.InstancedMesh(
        new THREE.IcosahedronGeometry(1, 1), M.crown.clone(), broad.length);
      im.castShadow = true; return im;
    });
    broad.forEach(([d, lat, sc], i) => {
      const o = this._place(new THREE.Object3D(), d, lat);
      q.setFromEuler(new THREE.Euler(0, rnd() * 6.28, 0));
      m4.compose(V(o.position.x, 1.55 * sc, o.position.z), q, V(sc, sc, sc));
      bTrunk.setMatrixAt(i, m4);
      const lb = rnd() * 6.28;
      for (let k = 0; k < LIMB; k++) {
        const la = lb + k * 2.094 + (rnd() - 0.5) * 0.5, tl = 0.42 + rnd() * 0.26;
        q.setFromEuler(new THREE.Euler(Math.cos(la) * tl, -la, Math.sin(la) * tl));
        m4.compose(V(o.position.x + Math.sin(tl) * Math.cos(la) * 0.7 * sc,
                     (2.9 + rnd() * 0.5) * sc,
                     o.position.z + Math.sin(tl) * Math.sin(la) * 0.7 * sc),
                   q, V(sc, sc * (0.85 + rnd() * 0.4), sc));
        limb.setMatrixAt(i * LIMB + k, m4);
      }
      tone.setHSL(0.335 + (rnd() - 0.5) * 0.055, 0.26 + rnd() * 0.14, 0.24 + rnd() * 0.10);
      BLOBS.forEach(([r, y, flat], k) => {
        const a = rnd() * 6.28, off = (0.45 + rnd() * 0.85) * sc;
        const rr = r * sc * (0.86 + rnd() * 0.28);
        q.setFromEuler(new THREE.Euler(rnd() * 0.4, rnd() * 6.28, rnd() * 0.4));
        m4.compose(V(o.position.x + Math.cos(a) * off, y * sc, o.position.z + Math.sin(a) * off),
                   q, V(rr, rr * flat, rr));
        blobs[k].setMatrixAt(i, m4);
        blobs[k].setColorAt(i, tone);
      });
    });
    bTrunk.instanceMatrix.needsUpdate = true; limb.instanceMatrix.needsUpdate = true;
    blobs.forEach(im => { im.instanceMatrix.needsUpdate = true; im.instanceColor.needsUpdate = true; });
    S.add(bTrunk, limb, ...blobs);

    /* palms — bare tapering stem, six fronds thrown out from the crown */
    const FR = 9;
    const pTrunk = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.13, 0.23, 6.2, 6), M.palm, palms.length);
    pTrunk.castShadow = true;
    /* A frond is a flat blade, not a spike: a thin plane long in Y, wide in X,
       pivoting from its base so per-instance rotation can arc it over and drop
       the tip below the crown. Two segments along the blade let it bend. */
    const blade = new THREE.PlaneGeometry(0.72, 3.2, 1, 2);
    blade.translate(0, -1.6, 0);                       // pivot at the leaf base
    {
      const p = blade.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const y = p.getY(i);                           // taper to the tip, curl down
        p.setX(i, p.getX(i) * (1 - 0.72 * (-y / 3.2)));
        p.setZ(i, -1.35 * Math.pow(-y / 3.2, 2));   // blade arcs, not a straight ray
      }
      blade.computeVertexNormals();
    }
    const frond = new THREE.InstancedMesh(blade, M.frond, palms.length * FR);
    frond.castShadow = true;
    palms.forEach(([d, lat, sc], i) => {
      const s2 = 0.82 + sc * 0.38;
      const o = this._place(new THREE.Object3D(), d, lat);
      const lean = (rnd() - 0.5) * 0.16, la = rnd() * 6.28;
      q.setFromEuler(new THREE.Euler(Math.sin(la) * lean, 0, Math.cos(la) * lean));
      m4.compose(V(o.position.x, 3.1 * s2, o.position.z), q, V(s2, s2, s2));
      pTrunk.setMatrixAt(i, m4);
      const topY = 6.1 * s2, base = rnd() * 6.28;
      const e = new THREE.Euler();
      for (let k = 0; k < FR; k++) {
        /* Each blade leaves the crown pointing outward and past horizontal, so
           the tip falls below the crown — a canopy, not a starburst. */
        const a = base + k * (6.2832 / FR) + (rnd() - 0.5) * 0.34;
        const droop = 0.95 + rnd() * 0.32;              // < pi/2, so every tip falls
        e.set(0, -a, 0); q.setFromEuler(e);
        const out = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), droop);
        q.multiply(out);
        m4.compose(V(o.position.x, topY, o.position.z), q,
                   V(s2 * 1.05, s2 * 1.15, s2));
        frond.setMatrixAt(i * FR + k, m4);
      }
    });
    pTrunk.instanceMatrix.needsUpdate = true; frond.instanceMatrix.needsUpdate = true;
    S.add(pTrunk, frond);

    /* A distant treeline and two ranges of low hills. Far enough out to sit in
       the fog, so they read as depth rather than objects — the horizon was
       otherwise blank paper wherever the roadside band ran out. */
    const hillMat = new THREE.MeshStandardMaterial({ color: '#C9CCC0', roughness: 1 });
    const farMat = new THREE.MeshStandardMaterial({ color: '#DDDFD5', roughness: 1 });
    [[132, hillMat, 26, 15, 58], [178, farMat, 20, 22, 84]].forEach(([out, mat, count, hMax, wMax]) => {
      const im = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 7, 1), mat, count);
      const m = new THREE.Matrix4(), qq = new THREE.Quaternion(), vv = new THREE.Vector3();
      for (let i = 0; i < count; i++) {
        const a = (i / count) * 6.2832 + rnd() * 0.2;
        const rr = out * (0.9 + rnd() * 0.25);
        const w = wMax * (0.55 + rnd() * 0.6), hh = hMax * (0.5 + rnd() * 0.75);
        qq.setFromEuler(new THREE.Euler(0, rnd() * 6.28, 0));
        m.compose(vv.set(Math.cos(a) * rr, hh / 2 - 3, 75 + Math.sin(a) * rr), qq,
                  new THREE.Vector3(w, hh, w * 0.8));
        im.setMatrixAt(i, m);
      }
      im.instanceMatrix.needsUpdate = true; S.add(im);
    });
    /* a treeline band closer in, reading as canopy mass rather than trees */
    const bandMat = new THREE.MeshStandardMaterial({ color: '#B4BCAE', roughness: 1 });
    const band = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 5), bandMat, 54);
    {
      const m = new THREE.Matrix4(), qq = new THREE.Quaternion(), vv = new THREE.Vector3();
      for (let i = 0; i < 54; i++) {
        const a = (i / 54) * 6.2832 + rnd() * 0.1, rr = 108 * (0.92 + rnd() * 0.2);
        const w = 13 + rnd() * 12;
        qq.setFromEuler(new THREE.Euler(0, rnd() * 6.28, 0));
        m.compose(vv.set(Math.cos(a) * rr, 1.5 + rnd() * 2.6, 75 + Math.sin(a) * rr), qq,
                  new THREE.Vector3(w, 4.6 + rnd() * 3.4, w * 0.7));
        band.setMatrixAt(i, m);
      }
      band.instanceMatrix.needsUpdate = true; S.add(band);
    }

    /* shrub rows, not extruded green slabs */
    const shrubRow = (d0, lat, len, yaw) => {
      const row = new THREE.InstancedMesh(
        new THREE.IcosahedronGeometry(0.62, 1), M.hedge, Math.round(len / 0.85));
      row.castShadow = true; row.receiveShadow = true;
      const m = new THREE.Matrix4(), qq = new THREE.Quaternion(), vv = new THREE.Vector3();
      for (let i = 0; i < row.count; i++) {
        const o = this._place(new THREE.Object3D(), d0 + i * 0.85 - len / 2, lat);
        qq.setFromEuler(new THREE.Euler(0, rnd() * 6.28, 0));
        const sx = 0.82 + rnd() * 0.3;
        m.compose(vv.set(o.position.x, 0.42 + rnd() * 0.09, o.position.z), qq,
                  new THREE.Vector3(sx, 0.72 + rnd() * 0.18, sx));
        row.setMatrixAt(i, m);
      }
      row.instanceMatrix.needsUpdate = true; S.add(row);
    };
    /* WOXSEN — built from what the coach actually passes at the gate: a lawn,
       a concrete panel sign wall at the roadside, the white gate and fence
       beyond it, and one cantilevered academic block as the landmark. */
    /* set well back from the shoulder, and slightly below the road surface so it
       can never z-fight with the carriageway */
    const lawn = new THREE.Mesh(new THREE.PlaneGeometry(52, 30), M.lawn);
    lawn.rotation.x = -Math.PI / 2;
    this._place(lawn, 52, -48); lawn.position.y = -0.03; lawn.receiveShadow = true; S.add(lawn);

    /* The board from the photo: a long low run of concrete panels on a plinth,
       lighter than the fog so it reads at distance, turned a few degrees to
       face oncoming traffic, with lettering-weight bars and a hedge at its base. */
    const wall = new THREE.Group();
    const plinthW = new THREE.Mesh(new THREE.BoxGeometry(15.4, 1.6, 1.15), M.joint);
    plinthW.position.y = -1.15; plinthW.receiveShadow = true; wall.add(plinthW);
    const mound = new THREE.Mesh(new THREE.BoxGeometry(17.6, 0.55, 3.2), M.lawn);
    mound.position.y = -2.05; mound.receiveShadow = true; wall.add(mound);
    const face = new THREE.Mesh(new THREE.BoxGeometry(14.8, 3.15, 0.62), [
      M.signface, M.signface, M.signface, M.signface, M.signtext, M.signface]);
    face.position.y = 1.96; face.castShadow = true; face.receiveShadow = true; wall.add(face);
    const coping = new THREE.Mesh(new THREE.BoxGeometry(15.2, 0.26, 0.84), M.signtop);
    coping.position.y = 3.62; coping.castShadow = true; wall.add(coping);
    this._place(wall, 54, -20, 0.22 + Math.PI); wall.position.y = 2.35; S.add(wall);
    shrubRow(53.4, -18.2, 15);

    const gate = new THREE.Group();
    [-4.2, 4.2].forEach(x => {
      const pier = new THREE.Mesh(new THREE.BoxGeometry(1.5, 5.0, 1.5), M.white);
      pier.position.set(x, 2.5, 0); pier.castShadow = true; pier.receiveShadow = true;
      const cap = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.28, 1.9), M.signtop);
      cap.position.set(x, 5.14, 0); cap.castShadow = true;
      gate.add(pier, cap);
    });
    const beam = new THREE.Mesh(new THREE.BoxGeometry(7.2, 0.55, 0.85), M.white);
    beam.position.y = 4.45; beam.castShadow = true; gate.add(beam);
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(6.4, 1.05, 0.35), M.signtop);
    lintel.position.set(0, 3.62, 0.06); lintel.castShadow = true; gate.add(lintel);
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.7, 2.4), M.white);
    cabin.position.set(-6.6, 1.35, 1.4); cabin.castShadow = true; cabin.receiveShadow = true;
    const cabinRoof = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.22, 3.0), M.signtop);
    cabinRoof.position.set(-6.6, 2.8, 1.4); cabinRoof.castShadow = true;
    gate.add(cabin, cabinRoof);
    for (let i = 0; i < 24; i++) {                        // fence line
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.9, 0.08), M.white);
      bar.position.set(5.0 + i * 0.58, 0.95, 0); gate.add(bar);
    }
    this._place(gate, 57, -15, 0.08); S.add(gate);

    shrubRow(55, -19, 26);

    const uni = new THREE.Group();
    const podium = new THREE.Mesh(new THREE.BoxGeometry(24, 4.6, 13), M.glass);
    podium.position.y = 2.4; podium.castShadow = true; podium.receiveShadow = true;
    const cantilever = new THREE.Mesh(new THREE.BoxGeometry(29, 5.4, 15.5), M.concrete);
    cantilever.position.set(0, 7.5, 1.7); cantilever.castShadow = true; cantilever.receiveShadow = true;
    const strip = new THREE.Mesh(new THREE.BoxGeometry(29.3, 1.9, 15.8), M.glass);
    strip.position.set(0, 7.7, 1.7);
    const slab = new THREE.Mesh(new THREE.BoxGeometry(30.2, 0.5, 16.6), M.concrete);
    slab.position.set(0, 10.4, 1.7); slab.castShadow = true;
    uni.add(podium, cantilever, strip, slab);

    // mullions across the podium glazing
    for (let i = -5; i <= 5; i++) {
      const mull = new THREE.Mesh(new THREE.BoxGeometry(0.16, 4.6, 0.16), M.white);
      mull.position.set(i * 2.1, 2.4, 6.56); uni.add(mull);
    }
    // columns carrying the cantilever, so the overhang has something to sit on
    [-11.5, -5.8, 5.8, 11.5].forEach(x => {
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 4.8, 10), M.white);
      col.position.set(x, 2.4, 8.4); col.castShadow = true; uni.add(col);
    });
    // horizontal fins shading the upper storey
    for (let i = 0; i < 5; i++) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(29.3, 0.12, 0.5), M.white);
      fin.position.set(0, 6.4 + i * 0.62, 9.55); uni.add(fin);
    }
    // recessed entrance under the overhang
    const doors = new THREE.Mesh(new THREE.BoxGeometry(6.4, 3.2, 0.3), M.ink);
    doors.position.set(0, 1.6, 6.62); uni.add(doors);
    const canopyU = new THREE.Mesh(new THREE.BoxGeometry(9.2, 0.28, 3.2), M.signtop);
    canopyU.position.set(0, 3.6, 8.0); canopyU.castShadow = true; uni.add(canopyU);
    const step = new THREE.Mesh(new THREE.BoxGeometry(11, 0.22, 2.4), M.concrete);
    step.position.set(0, 0.11, 9.4); step.receiveShadow = true; uni.add(step);
    // parapet and rooftop plant
    const parapetU = new THREE.Mesh(new THREE.BoxGeometry(30.6, 0.62, 17.0), M.signtop);
    parapetU.position.set(0, 10.96, 1.7); parapetU.castShadow = true; uni.add(parapetU);
    [[-9, -2.5, 3.4, 1.5], [-3.5, 1.2, 2.2, 1.1], [7.5, -3.0, 4.2, 1.8]].forEach(([x, z, w, hh]) => {
      const box = new THREE.Mesh(new THREE.BoxGeometry(w, hh, w * 0.7), M.blockAlt);
      box.position.set(x, 10.65 + hh / 2, 1.7 + z); box.castShadow = true; uni.add(box);
    });
    const stair = new THREE.Mesh(new THREE.BoxGeometry(4.6, 2.8, 5.0), M.concrete);
    stair.position.set(-12.4, 11.9, -1.2); stair.castShadow = true; uni.add(stair);
    // service core anchoring one end
    const core = new THREE.Mesh(new THREE.BoxGeometry(4.6, 13.2, 6.0), M.concrete);
    core.position.set(-16.4, 6.6, -2.2); core.castShadow = true; core.receiveShadow = true;
    uni.add(core);

    this._place(uni, 54, -64, -0.06); S.add(uni);

    const annex = new THREE.Mesh(new THREE.BoxGeometry(19, 8.4, 14), M.block);
    annex.castShadow = true; annex.receiveShadow = true;
    this._place(annex, 28, -56, 0.12); annex.position.y = 4.2; S.add(annex);

    /* MIYAPUR — apartment mid-rise rather than random boxes: every block is a
       plinth, a shaft banded at a 3.1 m floor height, and a parapet, so height
       reads in storeys. Instanced, so 22 blocks cost four draw calls. */
    const CITY = [];
    for (let i = 0; i < 22; i++) {
      CITY.push([101 + i * 3.0 + rnd() * 1.6,
                 (rnd() > 0.5 ? 1 : -1) * (17 + rnd() * 38),
                 10 + rnd() * 9, 9 + rnd() * 8, 3 + Math.floor(rnd() * 8)]);
    }
    const FLOOR = 3.1, unit = new THREE.BoxGeometry(1, 1, 1);
    const plinth = new THREE.InstancedMesh(unit, M.blockAlt, CITY.length);
    const shaft = new THREE.InstancedMesh(unit, M.block, CITY.length);
    const parapet = new THREE.InstancedMesh(unit, M.blockAlt, CITY.length);
    const bandCount = CITY.reduce((a, c) => a + c[4], 0);
    const bands = new THREE.InstancedMesh(unit, M.glass, bandCount);
    plinth.castShadow = shaft.castShadow = parapet.castShadow = true;
    shaft.receiveShadow = plinth.receiveShadow = true;
    let bi = 0;
    CITY.forEach(([d, lat, w, dep, floors], i) => {
      const o = this._place(new THREE.Object3D(), d, lat);
      const H = floors * FLOOR;
      q.setFromEuler(new THREE.Euler(0, o.rotation.y + (rnd() - 0.5) * 0.5, 0));
      m4.compose(V(o.position.x, 1.1, o.position.z), q, V(w + 1.5, 2.2, dep + 1.5));
      plinth.setMatrixAt(i, m4);
      m4.compose(V(o.position.x, 2.2 + H / 2, o.position.z), q, V(w, H, dep));
      shaft.setMatrixAt(i, m4);
      m4.compose(V(o.position.x, 2.2 + H + 0.35, o.position.z), q, V(w + 0.9, 0.7, dep + 0.9));
      parapet.setMatrixAt(i, m4);
      for (let f = 0; f < floors; f++) {
        m4.compose(V(o.position.x, 2.2 + f * FLOOR + 1.95, o.position.z), q,
                   V(w + 0.14, 1.15, dep + 0.14));
        bands.setMatrixAt(bi++, m4);
      }
    });
    [plinth, shaft, parapet, bands].forEach(im => { im.instanceMatrix.needsUpdate = true; S.add(im); });

    /* the station itself, so the viaduct reads as a metro and not a flyover */
    const stn = new THREE.Group();
    const concourse = new THREE.Mesh(new THREE.BoxGeometry(9.6, 1.7, 34), M.blockAlt);
    concourse.position.y = 9.4; concourse.castShadow = true;
    const canopy = new THREE.Mesh(new THREE.BoxGeometry(12.6, 0.5, 38), M.block);
    canopy.position.y = 14.3; canopy.castShadow = true;
    stn.add(concourse, canopy);
    for (let i = -2; i <= 2; i++) {
      const col = new THREE.Mesh(new THREE.BoxGeometry(0.5, 4.2, 0.5), M.blockAlt);
      col.position.set(0, 12.1, i * 7.6); stn.add(col);
    }
    /* the station's name board, hung on the road-facing fascia — the destination
       has to name itself in the world, not only in the DOM card */
    const nameBoard = new THREE.Mesh(new THREE.BoxGeometry(0.22, 2.2, 3.8),
      [M.mkMiyapur, M.mkMiyapur, M.signtop, M.signtop, M.blockAlt, M.blockAlt]);
    nameBoard.position.set(-5.0, 11.9, -6.0); nameBoard.castShadow = true;
    stn.add(nameBoard);
    this._place(stn, 120, 25); S.add(stn);
    const deck = new THREE.Group();
    for (let d = 103; d < 168; d += 2.2) {
      const seg = new THREE.Mesh(new THREE.BoxGeometry(6.2, 1.5, 8.4), M.blockAlt);
      this._place(seg, d, 25); seg.position.y = 9.4; seg.castShadow = true;
      deck.add(seg);
      if (Math.round((d - 103) / 2.2) % 4 === 0) {
        const pier = new THREE.Mesh(new THREE.BoxGeometry(2.1, 9.4, 2.1), M.blockAlt);
        this._place(pier, d, 25); pier.position.y = 4.7; pier.castShadow = true;
        deck.add(pier);
      }
    }
    S.add(deck);

    /* Kilometre stones, the way they actually sit on a state highway: a short
       white stone with a rounded painted top, close to the shoulder. They give
       near-field parallax without the unexplained bare poles the old planted
       opening shot needed — and being knee-high, they never read as clutter. */
    for (let d = 12; d < 168; d += 7.5) {
      const st = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.72, 0.30), M.white);
      body.position.y = 0.36; body.castShadow = true; body.receiveShadow = true;
      /* the painted top is flush with the stone, not a proud lid */
      const top = new THREE.Mesh(new THREE.BoxGeometry(0.445, 0.24, 0.305), M.green);
      top.position.y = 0.60; top.castShadow = true;
      st.add(body, top);
      this._place(st, d, (Math.floor(d / 7.5) % 2 ? 1 : -1) * 5.6); S.add(st);
    }

  }

  async _loadCoach() {
    try {
      const gltf = await new GLTFLoader().loadAsync('./assets/dlt-coach.glb');
      const raw = gltf.scene;
      const holder = new THREE.Group();
      const inner = new THREE.Group();

      raw.updateMatrixWorld(true);
      let bb = new THREE.Box3().setFromObject(raw);
      let sz = bb.getSize(new THREE.Vector3());
      inner.rotation.y = (sz.x > sz.z ? Math.PI / 2 : 0) + Math.PI;
      inner.add(raw); holder.add(inner);
      holder.updateMatrixWorld(true);
      bb = new THREE.Box3().setFromObject(holder);
      sz = bb.getSize(new THREE.Vector3());
      holder.scale.setScalar(11 / Math.max(sz.x, sz.z));
      holder.updateMatrixWorld(true);
      bb = new THREE.Box3().setFromObject(holder);
      const ctr = bb.getCenter(new THREE.Vector3());
      holder.position.set(-ctr.x, -bb.min.y, -ctr.z);
      holder.updateMatrixWorld(true);
      bb = new THREE.Box3().setFromObject(holder);
      const H = bb.max.y;

      /* livery as a world-height strip: crisp bands whatever the triangles do */
      const BANDS = [
        [0.000, 0.111, '#23272D'], [0.111, 0.268, GREEN], [0.268, 0.438, SHELL],
        [0.438, 0.460, GREEN], [0.460, 0.485, SHELL], [0.485, 0.795, RIBBON],
        [0.795, 1.000, SHELL],
      ];
      const cv = document.createElement('canvas'); cv.width = 8; cv.height = 1024;
      const ctx = cv.getContext('2d');
      BANDS.forEach(([lo, hi, col]) => {
        ctx.fillStyle = col; ctx.fillRect(0, Math.round(lo * 1024), 8, Math.ceil((hi - lo) * 1024));
      });
      const tex = new THREE.CanvasTexture(cv);
      tex.flipY = false; tex.colorSpace = THREE.SRGBColorSpace;
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      const livery = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.4, metalness: 0.14 });
      const rubber = new THREE.MeshStandardMaterial({ color: '#191A1C', roughness: 0.92 });

      const wheels = [];
      const seen = new Set(), v3 = new THREE.Vector3();
      raw.traverse(n => {
        if (!n.isMesh) return;
        n.castShadow = true; n.receiveShadow = true;
        const bx = new THREE.Box3().setFromObject(n), ex = bx.getSize(new THREE.Vector3());
        /* the tyres are named axles in the model (o_Pneu_*), each mesh holding
           both tyres of one axle: name them, so body panels that happen to be
           round-ish (steering wheel, mirrors) are never spun. */
        const nm = (n.name || '').toLowerCase();
        const body = /cubo|plano|poltrona|mesh_|line_|bumper|grille|c[ií]rculo/.test(nm);
        if (!body && /pneu|wheel|tire|tyre|roda/.test(nm) && bx.min.y < 0.4 &&
            Math.abs(ex.y - ex.z) < 0.4 * Math.max(ex.y, ex.z)) {
          n.material = rubber; wheels.push(n); return;
        }
        let geo = n.geometry;
        if (seen.has(geo)) { geo = geo.clone(); n.geometry = geo; }
        seen.add(geo);
        const p = geo.attributes.position, uv = new Float32Array(p.count * 2);
        for (let i = 0; i < p.count; i++) {
          v3.fromBufferAttribute(p, i).applyMatrix4(n.matrixWorld);
          uv[i * 2] = 0.5;
          uv[i * 2 + 1] = Math.min(0.999, Math.max(0.001, v3.y / H));
        }
        geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        n.material = livery;
      });

      /* Each wheel spins around a pivot placed at its own centre, in the coach's
         basis — rotating the mesh on its own origin made parts orbit the model. */
      const spinners = [];
      for (const w of wheels) {
        const c = new THREE.Box3().setFromObject(w).getCenter(new THREE.Vector3());
        const pivot = new THREE.Group();
        pivot.position.copy(holder.worldToLocal(c.clone()));
        holder.add(pivot);
        pivot.updateMatrixWorld(true);
        pivot.attach(w);
        spinners.push(pivot);
      }

      const rig = new THREE.Group();
      rig.add(holder);
      this._coach = rig;
      this._wheels = spinners;
      this._scene.add(rig);
      this._dirty = true;
      this.dispatchEvent(new CustomEvent('journeycoach', { bubbles: true, composed: true }));
    } catch (err) {
      console.warn('DLT journey: coach model unavailable, road-only fallback', err);
      this.dispatchEvent(new CustomEvent('journeycoachfailed', { bubbles: true, composed: true }));
    }
  }

  /* the rig sampled at t. Distance is derived from framing and lens, so
     apparent subject size stays authored rather than emergent. */
  _cameraFor(t, busP, tg, right) {
    const azim = RIG.azim(t), elev = RIG.elev(t);
    const frame = Math.min(0.50, Math.max(0.18, RIG.frame(t)));
    const fov = Math.min(60, Math.max(26, RIG.fov(t)));
    const aim = busP.clone(); aim.y += AIM_H;
    const half = Math.tan(fov * DEG / 2);
    const a = azim * DEG, e = elev * DEG;
    /* True projected extent. The coach is 11 x 2.8 x 3 m, so how much frame it
       occupies depends on the whole viewing orientation — measuring only its
       horizontal spread under-reads badly from above, which dragged the aerial
       camera in until the roof filled the screen. Project the box's half-extents
       onto the screen axes and solve distance against both. */
    const dir0 = new THREE.Vector3()
      .addScaledVector(tg, Math.cos(a) * Math.cos(e))
      .addScaledVector(right, Math.sin(a) * Math.cos(e));
    dir0.y += Math.sin(e);
    dir0.normalize();
    const view = dir0.clone().negate();
    const WUP = new THREE.Vector3(0, 1, 0);
    const sr = new THREE.Vector3().crossVectors(view, WUP).normalize();
    const su = new THREE.Vector3().crossVectors(sr, view).normalize();
    const ax = (v) => 0.5 * (COACH_L * Math.abs(tg.dot(v)) + COACH_H * Math.abs(WUP.dot(v))
                           + COACH_W * Math.abs(right.dot(v)));
    const aspect = this._camera.aspect || 1.7;
    const frameH = Math.min(0.62, frame * 1.35);
    const dist = Math.max(ax(sr) / (frame * half * aspect), ax(su) / (frameH * half));
    const pos = aim.clone().addScaledVector(dir0, dist);
    if (pos.y < 1.6) pos.y = 1.6;
    /* lift the aim with the camera: from above, aiming at the coach's waist
       tips the horizon out of frame and the shot reads as a map, not a camera. */
    aim.y += Math.max(0, pos.y - 3.5) * 0.17;
    return { pos, aim, fov, anchor: [RIG.ax(t), RIG.ay(t)] };
  }

  _resize() {
    const r = this.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    this._renderer.setSize(w, h, false);
    this._camera.aspect = w / h;
    this._camera.updateProjectionMatrix();
  }

  progress() {
    const host = this.closest('[data-journey-scroll]') || this.parentElement;
    const r = host.getBoundingClientRect();
    const span = r.height - innerHeight;
    return span <= 0 ? 0 : clamp01(-r.top / span);
  }

  _tick = () => {
    this._raf = requestAnimationFrame(this._tick);
    this._frame();
  };

  _frame() {
    if (!this._visible) { this._last = 0; return; }

    /* Render on demand. Scroll, resize, visibility and the coach's arrival all
       mark the scene dirty; at rest nothing is redrawn, which is what keeps a
       phone from burning battery on a still frame. */
    const at = this.progress();
    if (!this._dirty && this._t === at) { this._last = 0; return; }
    this._dirty = false;

    /* frame-rate independent clock. Browser scroll arrives in steps (a wheel
       click can be 5% of the journey in one frame); a critically damped filter
       turns those steps into continuous travel without adding lag you can feel. */
    const now = performance.now();
    let dt = this._last ? (now - this._last) / 1000 : 1 / 60;
    this._last = now;
    dt = Math.min(0.05, Math.max(0.0004, dt));

    /* Scroll IS the motor, with nothing in between: t IS the scroll position.
       No filter, no momentum, no catch-up — the frame on screen always shows
       exactly where the scrollbar is, so travel ends the instant scrolling does. */
    const t = at;
    if (this._snap) { this._snap = false; this._snapRig = true; }
    this._vel = (t - (this._prevT ?? t)) / dt;
    this._prevT = t;
    this._sT = t;
    this._t = t;

    const root = document.documentElement;
    root.style.setProperty('--journey-t', t.toFixed(4));
    root.style.setProperty('--journey-handoff', clamp01((t - 0.90) / 0.09).toFixed(4));
    const beat = beatAt(t);
    if (beat !== this._beat) {
      this._beat = beat;
      root.setAttribute('data-journey-beat', beat);
      this.dispatchEvent(new CustomEvent('journeybeat', { detail: beat, bubbles: true, composed: true }));
    }

    const dist = trackAt(t);
    const u = clamp01(dist / this._len);
    const p = this._curve.getPointAt(u), tg = this._curve.getTangentAt(u).normalize();
    const right = new THREE.Vector3().crossVectors(tg, new THREE.Vector3(0, 1, 0)).normalize();

    /* the coach is the reference: everything the camera does is expressed
       relative to this point, in the coach's own basis */
    const busP = p.clone().addScaledVector(right, LANE);

    if (this._coach) {
      /* the coach carries mass: it pitches as it brakes into a stop, squats as
         it pulls away, and leans into the curve. A degree or two, but it is the
         difference between a vehicle and a prop sliding along a spline. */
      const speed = (dist - (this._prevDist ?? dist)) / dt;   // m/s
      this._prevDist = dist;
      const sm = 1 - Math.exp(-dt / 0.30);
      this._speed = (this._speed ?? speed) + (speed - (this._speed ?? speed)) * sm;
      const accel = (this._speed - (this._prevSpeed ?? this._speed)) / dt;
      this._prevSpeed = this._speed;
      this._accelSm = (this._accelSm ?? 0) + (accel - (this._accelSm ?? 0)) * (1 - Math.exp(-dt / 0.45));

      const du = 1.2 / this._len;
      const tgA = this._curve.getTangentAt(clamp01(u - du));
      const tgB = this._curve.getTangentAt(clamp01(u + du));
      const curv = (Math.atan2(tgB.x, tgB.z) - Math.atan2(tgA.x, tgA.z)) / 2.4;

      const cap = (v, m) => v > m ? m : v < -m ? -m : v;
      const pitch = cap(-this._accelSm * 0.0008, 0.014);       // under a degree
      const roll  = cap(-curv * this._speed * 0.55, 0.024);    // ~1.4 deg

      this._coach.position.copy(busP);
      this._coach.rotation.order = 'YXZ';
      this._coach.rotation.y = Math.atan2(tg.x, tg.z);
      this._coach.rotation.x = pitch;
      this._coach.rotation.z = roll;
      if (this._wheels) {
        const spin = -dist / 0.52;
        for (const w of this._wheels) w.rotation.x = spin;
      }
    }

    /* Position, aim and lens are damped as ONE state on ONE clock, so they can
       never drift apart, and the lens opens a little with journey velocity. */
    const shot = this._cameraFor(t, busP, tg, right);
    this._snapRig = false;
    this._cam = { p: shot.pos, a: shot.aim, f: shot.fov };

    const fwd = this._cam.a.clone().sub(this._cam.p).normalize();
    const cRight = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const cUp = new THREE.Vector3().crossVectors(cRight, fwd).normalize();
    const aimDist = this._cam.p.distanceTo(this._cam.a);
    const halfT = Math.tan(this._cam.f * DEG / 2);
    const aim = this._cam.a.clone()
      .addScaledVector(cUp, -shot.anchor[1] * aimDist * halfT)
      .addScaledVector(cRight, -shot.anchor[0] * aimDist * halfT * this._camera.aspect);

    this._camera.position.copy(this._cam.p);
    if (Math.abs(this._camera.fov - this._cam.f) > 0.01) {
      this._camera.fov = this._cam.f;
      this._camera.updateProjectionMatrix();
    }
    this._camera.lookAt(aim);

    this._key.position.set(p.x + 42, 58, p.z - 26);
    this._key.target.position.copy(p);
    this._key.target.updateMatrixWorld();

    this._renderer.render(this._scene, this._camera);
    if (!this._announced) {
      this._announced = true;
      /* both channels: an event for whoever is listening, and a flag on <html>
         for a host that mounted its listener after this first frame. */
      document.documentElement.setAttribute('data-journey-ready', '1');
      this.dispatchEvent(new CustomEvent('journeyready', { bubbles: true, composed: true }));
    }
  }
}

if (!customElements.get('dlt-journey')) customElements.define('dlt-journey', DLTJourney);
