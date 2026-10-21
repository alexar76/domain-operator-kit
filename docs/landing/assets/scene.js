// The hero's 3D: your seller node at the centre, the registries of the seller's extensions on orbits,
// agents on an outer shell asking for quotes, and a stream of names spiralling in to be resolved.
// The name check in the hero drives it: an arc flies to each registry and comes back free or taken.
// three.js is served from this site (assets/vendor/three, MIT), so the page keeps script-src 'self'.
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

const TLD_COLORS = { com: 0x5ac8ff, net: 0xa78bfa, org: 0xf5c26b };
const SPARE = [0x6ee7b7, 0xf472b6, 0x93c5fd];
const STATE_COLORS = { free: 0x34e39a, taken: 0xff5d73, unknown: 0xffc94d };
const BG = 0x060a14;

function canvasTexture(w, h, draw) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const GLOW = canvasTexture(128, 128, (g) => {
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, "rgba(255,255,255,1)"); r.addColorStop(0.22, "rgba(255,255,255,.42)"); r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
});
const RING = canvasTexture(128, 128, (g) => {
  g.strokeStyle = "rgba(255,255,255,1)"; g.lineWidth = 5;
  g.beginPath(); g.arc(64, 64, 58, 0, Math.PI * 2); g.stroke();
});
const additive = (map, color, opacity = 1) =>
  new THREE.SpriteMaterial({ map, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
function glow(color, size, opacity = 1) {
  const s = new THREE.Sprite(additive(GLOW, color, opacity));
  s.scale.setScalar(size);
  return s;
}

/** A pill-shaped text label that always faces the camera. */
function label(text, color, height = 0.42) {
  const font = "600 60px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  const probe = document.createElement("canvas").getContext("2d");
  probe.font = font;
  const w = Math.ceil(probe.measureText(text).width) + 56;
  const map = canvasTexture(w, 96, (g) => {
    g.font = font; g.textBaseline = "middle";
    g.fillStyle = "rgba(8,13,28,.78)";
    g.beginPath(); g.roundRect ? g.roundRect(3, 6, w - 6, 84, 42) : g.rect(3, 6, w - 6, 84); g.fill();
    g.strokeStyle = color; g.globalAlpha = 0.6; g.lineWidth = 3; g.stroke(); g.globalAlpha = 1;
    g.fillStyle = color; g.fillText(text, 28, 50);
  });
  map.anisotropy = 4;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false }));
  s.scale.set(height * w / 96, height, 1);
  return s;
}

export function startScene(canvas, { tlds = ["com", "net", "org"] } = {}) {
  const mobile = matchMedia("(max-width: 1000px)").matches;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, mobile ? 1.5 : 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);
  scene.fog = new THREE.FogExp2(BG, 0.04);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 120);
  const world = new THREE.Group();
  scene.add(world);

  // Light: a cool fill and three coloured lights circling the crystal, for moving glints on its facets.
  scene.add(new THREE.AmbientLight(0x2a3a66, 1.2));
  const key = new THREE.DirectionalLight(0xdbe6ff, 1.6);
  key.position.set(4, 6, 8);
  scene.add(key);
  const spots = [0x5ac8ff, 0xa78bfa, 0xf5c26b].map((c) => {
    const l = new THREE.PointLight(c, 22, 9, 2);
    world.add(l);
    return l;
  });

  // Your seller node: a faceted crystal with a bright heart, glowing edges and a slow outer lattice.
  const core = new THREE.Group();
  world.add(core);
  const crystalGeo = new THREE.IcosahedronGeometry(1.05, 0);
  const crystal = new THREE.Mesh(crystalGeo, new THREE.MeshPhysicalMaterial({
    color: 0x203a7a, metalness: 0.35, roughness: 0.16, clearcoat: 1, clearcoatRoughness: 0.08,
    iridescence: 1, iridescenceIOR: 1.7, flatShading: true, transparent: true, opacity: 0.82,
    emissive: 0x0c1d4d, emissiveIntensity: 0.7,
  }));
  core.add(crystal);
  crystal.add(new THREE.LineSegments(new THREE.EdgesGeometry(crystalGeo), new THREE.LineBasicMaterial({ color: 0xa9c8ff, transparent: true, opacity: 0.95 })));
  const heart = new THREE.Mesh(new THREE.SphereGeometry(0.3, 32, 16), new THREE.MeshBasicMaterial({ color: 0xcfe0ff }));
  core.add(heart);
  const lattice = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(1.8, 1)),
    new THREE.LineBasicMaterial({ color: 0x5b7fd6, transparent: true, opacity: 0.16 }));
  core.add(lattice);
  const halo = glow(0x4f7dff, 6.5, 0.5);
  core.add(halo);

  // The registries: one planet per extension the seller sells, each on its own tilted orbit.
  const registries = new Map();
  tlds.forEach((tld, i) => {
    const color = new THREE.Color(TLD_COLORS[tld] ?? SPARE[i % SPARE.length]);
    const radius = 2.45 + i * 0.72;
    const orbit = new THREE.Group();
    orbit.rotation.set(0.5 - i * 0.32, i * 0.9, 0.16 * (i - 1));
    world.add(orbit);
    const pts = [];
    for (let k = 0; k <= 160; k++) { const a = (k / 160) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius)); }
    const ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.2 }));
    orbit.add(ring);
    const planet = new THREE.Group();
    orbit.add(planet);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.25, 32, 16),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.5, roughness: 0.35, metalness: 0.1 }));
    const aura = glow(color, 1.3, 0.6);
    const tag = label(`.${tld}`, `#${color.getHexString()}`);
    tag.position.y = 0.6;
    planet.add(ball, aura, tag);
    registries.set(tld, { orbit, ring, planet, ball, aura, radius, base: color, flash: 0, flashColor: color.clone(), angle: 0.7 + i * 2.2, speed: 0.11 - i * 0.022, waiting: null });
  });

  // The stream: names spiralling in from the dark and fading as they reach the node. All on the GPU.
  const N = mobile ? 1600 : 3600;
  const seeds = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    seeds[i * 4] = Math.random();
    seeds[i * 4 + 1] = Math.random() * Math.PI * 2;
    seeds[i * 4 + 2] = 0.35 + Math.random() * 0.75;
    seeds[i * 4 + 3] = (Math.random() - 0.5) * 2;
  }
  const streamGeo = new THREE.BufferGeometry();
  streamGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(N * 3), 3));
  streamGeo.setAttribute("seed", new THREE.BufferAttribute(seeds, 4));
  const stream = new THREE.Points(streamGeo, new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPixel: { value: renderer.getPixelRatio() }, uA: { value: new THREE.Color(0x5ac8ff) }, uB: { value: new THREE.Color(0xb197fc) } },
    vertexShader: `
      attribute vec4 seed; uniform float uTime; uniform float uPixel; varying float vLife;
      void main() {
        float life = fract(seed.x + uTime * 0.022 * seed.z);
        float r = mix(8.5, 1.15, pow(life, 0.85));
        float a = seed.y + uTime * 0.55 * seed.z / max(r, 0.7);
        vec3 p = vec3(cos(a) * r, seed.w * (0.18 + r * 0.075), sin(a) * r);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = uPixel * (1.1 + 2.4 * seed.z) * (13.0 / -mv.z);
        vLife = life;
      }`,
    fragmentShader: `
      uniform vec3 uA; uniform vec3 uB; varying float vLife;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float m = smoothstep(0.5, 0.0, d);
        float fade = smoothstep(0.0, 0.15, vLife) * smoothstep(1.0, 0.86, vLife);
        gl_FragColor = vec4(mix(uA, uB, vLife) * 1.5, m * fade * 0.8);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  stream.frustumCulled = false;
  world.add(stream);

  // A far dust shell, so the dark has depth when the scene turns.
  const dustGeo = new THREE.BufferGeometry();
  const dust = new Float32Array((mobile ? 500 : 1100) * 3);
  for (let i = 0; i < dust.length; i += 3) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(14 + Math.random() * 22);
    dust.set([v.x, v.y, v.z], i);
  }
  dustGeo.setAttribute("position", new THREE.BufferAttribute(dust, 3));
  scene.add(new THREE.Points(dustGeo, new THREE.PointsMaterial({ color: 0x8aa2d8, size: 0.06, transparent: true, opacity: 0.55, depthWrite: false })));

  // Agents on an outer shell. Now and then one asks the node for a quote.
  const agents = [];
  for (let i = 0; i < (mobile ? 9 : 14); i++) {
    const g = new THREE.Group();
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.065, 12, 8), new THREE.MeshBasicMaterial({ color: 0xeaf1ff }));
    g.add(dot, glow(0x9fb8ff, 0.7, 0.8));
    world.add(g);
    agents.push({ g, r: 4.9 + Math.random() * 1.0, lat: (Math.random() - 0.5) * 1.1, lon: Math.random() * Math.PI * 2, speed: (Math.random() < 0.5 ? -1 : 1) * (0.04 + Math.random() * 0.05) });
  }

  // Arcs: thin lines with a travelling comet head, from one moving point to another.
  const SEG = 72;
  const arcPool = [];
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3();
  function makeArc() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array((SEG + 1) * 3), 3));
    const t = new Float32Array(SEG + 1);
    for (let i = 0; i <= SEG; i++) t[i] = i / SEG;
    geo.setAttribute("t", new THREE.BufferAttribute(t, 1));
    const line = new THREE.Line(geo, new THREE.ShaderMaterial({
      uniforms: { uHead: { value: 0 }, uColor: { value: new THREE.Color() }, uFade: { value: 1 } },
      vertexShader: "attribute float t; varying float vT; void main(){ vT = t; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: `uniform float uHead; uniform vec3 uColor; uniform float uFade; varying float vT;
        void main(){ float d = uHead - vT; float a = d >= 0.0 ? exp(-d * 7.0) * uFade : 0.0; if (a < 0.004) discard;
          gl_FragColor = vec4(uColor * (1.0 + 2.5 * exp(-d * 45.0)), a); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    line.frustumCulled = false;
    const head = glow(0xffffff, 0.55, 1);
    world.add(line, head);
    return { line, head, busy: false };
  }
  function fire(from, to, color, { duration = 1, fade = 1, lift = 1, onArrive } = {}) {
    const arc = arcPool.find((a) => !a.busy) || (arcPool.length < 24 ? arcPool[arcPool.push(makeArc()) - 1] : null);
    if (!arc) { onArrive?.(); return; }
    Object.assign(arc, { busy: true, from, to, start: now, duration, lift, onArrive, done: false });
    arc.line.material.uniforms.uColor.value.set(color);
    arc.line.material.uniforms.uFade.value = fade;
    arc.head.material.color.set(color);
    arc.head.material.opacity = fade;
    arc.line.visible = arc.head.visible = true;
  }
  function placeArc(arc, head) {
    arc.from(tmpA); arc.to(tmpB);
    tmpC.addVectors(tmpA, tmpB).multiplyScalar(0.5);
    const out = tmpC.length() + 0.0001;
    tmpC.multiplyScalar(1 + (1.1 * arc.lift) / out).add(new THREE.Vector3(0, 0.9 * arc.lift, 0));
    const p = arc.line.geometry.attributes.position;
    for (let i = 0; i <= SEG; i++) {
      const t = i / SEG, u = 1 - t;
      p.setXYZ(i, u * u * tmpA.x + 2 * u * t * tmpC.x + t * t * tmpB.x, u * u * tmpA.y + 2 * u * t * tmpC.y + t * t * tmpB.y, u * u * tmpA.z + 2 * u * t * tmpC.z + t * t * tmpB.z);
    }
    p.needsUpdate = true;
    const h = Math.min(head, 1), u = 1 - h;
    arc.head.position.set(u * u * tmpA.x + 2 * u * h * tmpC.x + h * h * tmpB.x, u * u * tmpA.y + 2 * u * h * tmpC.y + h * h * tmpB.y, u * u * tmpA.z + 2 * u * h * tmpC.z + h * h * tmpB.z);
  }

  // Positions in the world group's own space, so arcs follow orbits and the visitor's turning.
  const atCore = (v) => v.set(0, 0, 0);
  const atRegistry = (r) => (v) => world.worldToLocal(r.ball.getWorldPosition(v));
  const atAgent = (a) => (v) => v.copy(a.g.position);

  // Short-lived effects: a shock ring and a rising name tag at a registry.
  const effects = [];
  function shock(r, color) {
    const s = new THREE.Sprite(additive(RING, color, 1));
    s.scale.setScalar(0.4);
    r.planet.add(s);
    effects.push({ obj: s, parent: r.planet, born: now, life: 1.2, sharedMap: true, update: (k) => { s.scale.setScalar(0.4 + k * 2.6); s.material.opacity = 1 - k; } });
  }
  function nameTag(r, text, color) {
    const s = label(text, color, 0.27);
    s.material.color.setScalar(0.82);
    const start = world.worldToLocal(r.ball.getWorldPosition(new THREE.Vector3()));
    s.position.copy(start).add(new THREE.Vector3(0, 0.55, 0));
    world.add(s);
    effects.push({ obj: s, parent: world, born: now, life: 5, update: (k) => {
      s.position.y = start.y + 0.55 + k * 1.5;
      s.material.opacity = k < 0.1 ? k / 0.1 : k > 0.7 ? (1 - k) / 0.3 : 1;
    } });
  }
  function flash(r, color) {
    r.flash = 1;
    r.flashColor.set(color);
    shock(r, color);
  }

  // The live check from the form: out to each registry, back with the registry's answer.
  function settle(r, domain, state) {
    const color = STATE_COLORS[state] ?? STATE_COLORS.unknown;
    flash(r, color);
    nameTag(r, `${state === "free" ? "✓" : state === "taken" ? "✗" : "?"} ${domain}`, `#${new THREE.Color(color).getHexString()}`);
    fire(atRegistry(r), atCore, color, { duration: 0.85, lift: 0.8, onArrive: () => { heartKick = 1; } });
  }
  function check(domains) {
    for (const domain of domains) {
      const r = registries.get(domain.slice(domain.lastIndexOf(".") + 1));
      if (!r) continue;
      r.waiting = { domain, arrived: false, result: null };
      const w = r.waiting;
      fire(atCore, atRegistry(r), 0xcfe0ff, { duration: 0.75, lift: 1.1, onArrive: () => {
        w.arrived = true;
        r.flash = 0.6; r.flashColor.set(0xffffff);
        if (w.result) settle(r, w.domain, w.result);
      } });
    }
  }
  function result(domain, state) {
    const r = registries.get(domain.slice(domain.lastIndexOf(".") + 1));
    if (!r) return;
    const w = r.waiting;
    if (w && w.domain === domain && !w.arrived) { w.result = state; return; }
    settle(r, domain, state);
  }

  // Ambient traffic: agents asking for quotes, and the node asking a registry.
  let nextAmbient = 1.2, heartKick = 0;
  function ambient(t) {
    if (t < nextAmbient || reduce) return;
    nextAmbient = t + 0.7 + Math.random() * 1.1;
    const a = agents[Math.floor(Math.random() * agents.length)];
    fire(atAgent(a), atCore, 0x9fb8ff, { duration: 1.3, fade: 0.55, lift: 0.6, onArrive: () => {
      heartKick = Math.max(heartKick, 0.5);
      if (Math.random() < 0.45) {
        const list = [...registries.values()];
        const r = list[Math.floor(Math.random() * list.length)];
        fire(atCore, atRegistry(r), r.base, { duration: 0.9, fade: 0.4, lift: 0.9, onArrive: () => {
          fire(atRegistry(r), atCore, r.base, { duration: 0.9, fade: 0.35, lift: 0.7 });
        } });
      }
    } });
  }

  // Framing: on wide screens the scene sits right of centre, behind the copy's empty side.
  let wide = false;
  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    bloom.setSize(w, h);
    wide = w >= 1000;
    if (wide) {
      const fw = w * 1.52, fh = h * 1.16;
      camera.aspect = fw / fh;
      camera.setViewOffset(fw, fh, 0, h * 0.16, w, h);
      camera.position.set(0, 2.4, 16.5);
    } else {
      camera.clearViewOffset();
      camera.aspect = w / h;
      const half = Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect);
      camera.position.set(0, 3.4, Math.max(8.5, 5.4 / Math.tan(half)));
    }
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), mobile ? 0.65 : 0.8, 0.5, 0.3);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // The visitor turns it: the pointer tilts it a little, a drag spins it with some inertia.
  let tiltX = 0, tiltY = 0, spin = 0, spinV = 0, dragging = false, lastX = 0;
  const host = canvas.closest("section") || canvas;
  host.addEventListener("pointermove", (e) => {
    const b = canvas.getBoundingClientRect();
    tiltY = ((e.clientX - b.left) / b.width - 0.6) * 0.5;
    tiltX = ((e.clientY - b.top) / b.height - 0.45) * 0.22;
    if (dragging) { spinV = (e.clientX - lastX) * 0.005; lastX = e.clientX; }
  });
  canvas.addEventListener("pointerdown", (e) => { dragging = true; lastX = e.clientX; canvas.setPointerCapture?.(e.pointerId); });
  const release = () => { dragging = false; };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);

  const timer = new THREE.Timer();
  timer.connect?.(document);
  let now = 0;
  let visible = true, frames = 0;
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(canvas);
  addEventListener("resize", resize);
  resize();

  // A slow machine (no GPU, a busy laptop) gets a lighter scene instead of a stutter: after 90 slow
  // frames the pixel ratio drops to 1, after 90 more the bloom goes. Never back up within a visit.
  let slowSum = 0, slowCount = 0, quality = 2;
  function govern(delta) {
    if (quality === 0 || delta <= 0 || delta > 0.5) return;
    slowSum += delta; slowCount++;
    if (slowCount < 90) return;
    const avg = slowSum / slowCount;
    slowSum = 0; slowCount = 0;
    if (avg < 1 / 33) return;
    quality--;
    if (quality === 1) { renderer.setPixelRatio(1); composer.setPixelRatio(1); stream.material.uniforms.uPixel.value = 1; resize(); }
    else bloom.enabled = false;
  }

  function frame() {
    requestAnimationFrame(frame);
    timer.update();
    if (!visible || document.hidden) return;
    govern(timer.getDelta());
    const dt = Math.min(timer.getDelta(), 0.1) * (reduce ? 0.25 : 1);
    now += dt;
    const t = now;
    frames++;

    // Every decay is per second, not per frame, so a slow machine sees the same motion, only coarser.
    const ease = 1 - Math.pow(0.05, dt);
    spin += spinV + dt * 0.06; spinV *= Math.pow(dragging ? 0.0001 : 0.05, dt);
    world.rotation.y += (tiltY + spin - world.rotation.y) * ease * 3;
    world.rotation.x += (tiltX - world.rotation.x) * ease * 3;

    crystal.rotation.y += dt * 0.35; crystal.rotation.x += dt * 0.12;
    lattice.rotation.y -= dt * 0.08; lattice.rotation.z += dt * 0.05;
    heartKick *= Math.pow(0.015, dt);
    const beat = 1 + Math.sin(t * 2.2) * 0.06 + heartKick * 0.45;
    heart.scale.setScalar(beat);
    halo.material.opacity = 0.42 + heartKick * 0.4 + Math.sin(t * 2.2) * 0.05;
    spots.forEach((l, i) => l.position.set(Math.cos(t * 0.6 + i * 2.1) * 2.4, Math.sin(t * 0.8 + i) * 1.3, Math.sin(t * 0.6 + i * 2.1) * 2.4));

    for (const r of registries.values()) {
      r.angle += dt * r.speed;
      r.planet.position.set(Math.cos(r.angle) * r.radius, 0, Math.sin(r.angle) * r.radius);
      r.flash *= Math.pow(0.12, dt);
      r.ball.material.emissive.copy(r.base).lerp(r.flashColor, Math.min(r.flash * 1.4, 1));
      r.ball.material.emissiveIntensity = 1.5 + r.flash * 1.6;
      r.aura.material.color.copy(r.base).lerp(r.flashColor, Math.min(r.flash * 1.4, 1));
      r.aura.scale.setScalar(1.3 + r.flash * 0.6);
      r.ring.material.opacity = 0.2 + r.flash * 0.35;
    }
    for (const a of agents) {
      a.lon += dt * a.speed;
      a.g.position.set(Math.cos(a.lon) * Math.cos(a.lat) * a.r, Math.sin(a.lat) * a.r * 0.6, Math.sin(a.lon) * Math.cos(a.lat) * a.r);
    }
    stream.material.uniforms.uTime.value = t;
    ambient(t);

    for (const arc of arcPool) {
      if (!arc.busy) continue;
      const k = (t - arc.start) / arc.duration;
      placeArc(arc, k);
      arc.line.material.uniforms.uHead.value = k;
      arc.head.visible = k <= 1;
      if (k >= 1 && !arc.done) { arc.done = true; arc.onArrive?.(); }
      if (k > 1.5) { arc.busy = false; arc.line.visible = arc.head.visible = false; }
    }
    for (let i = effects.length - 1; i >= 0; i--) {
      const e = effects[i], k = (t - e.born) / e.life;
      if (k >= 1) { e.parent.remove(e.obj); if (!e.sharedMap) e.obj.material.map?.dispose(); e.obj.material.dispose(); effects.splice(i, 1); continue; }
      e.update(k);
    }
    composer.render(dt);
  }
  frame();

  const api = { check, result, get frames() { return frames; }, get calls() { return renderer.info.render.calls; }, get quality() { return quality; } };
  window.__domainScene = api;
  return api;
}
