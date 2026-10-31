import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { VillageSnapshot, VillagerDTO } from '../shared/types.js';
import { loadAssets } from './assets.js';
import { Cats } from './cats.js';
import { demoSnapshot } from './demo.js';
import { Dragons } from './dragons.js';
import { TungTung } from './tungtung.js';
import { Panel } from './panel.js';
import { DayNight } from './sky.js';
import { Village, bobOf, type Isle } from './village.js';
import { People } from './villagers.js';
import { cloudTexture, makeRng, softDot } from './world.js';
import './style.css';

const params = new URLSearchParams(location.search);
const DEMO = params.get('demo');
const fixedHour = params.has('hour') ? Number(params.get('hour')) : null;

const status = document.getElementById('status') as HTMLElement;
const clockText = document.getElementById('clock') as HTMLElement;
const countText = document.getElementById('count') as HTMLElement;
const speedButton = document.getElementById('speed') as HTMLButtonElement;
const homeButton = document.getElementById('home') as HTMLButtonElement;
const statsText = document.getElementById('stats') as HTMLElement;
const loading = document.getElementById('loading') as HTMLElement;
const debug = params.has('hud');
if (debug) statsText.hidden = false;

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
let pixelRatio = Math.min(devicePixelRatio, 1.25);
renderer.setPixelRatio(pixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;
renderer.toneMapping = THREE.NeutralToneMapping;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.3, 700);
const VIEWS: Record<string, { pos: [number, number, number]; at: [number, number, number] }> = {
  wide: { pos: [29, 21, 50], at: [0, -0.6, 0] },
  hero: { pos: [15.5, 8.6, 25], at: [0.2, 0.3, 0] },
  close: { pos: [5.2, 2.3, 8.2], at: [8.4, 1.0, 4.8] },
};
const view = VIEWS[params.get('cam') ?? 'wide'] ?? VIEWS['wide']!;
camera.position.set(...view.pos);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(...view.at);
controls.enableDamping = true;
controls.minDistance = 2.5;
controls.maxDistance = 110;
controls.maxPolarAngle = 2.2;
controls.autoRotate = !params.has('still');
controls.autoRotateSpeed = 0.12;
controls.addEventListener('start', () => { controls.autoRotate = false; });

const sky = new DayNight(scene, 40);
const time = { value: 0 };

// Pond and waterfall on the central island.
const fallTime = { value: 0 };
function waterfall(points: THREE.Vector3[]): THREE.Mesh {
  const curve = new THREE.CatmullRomCurve3(points);
  const n = 60, pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, p = curve.getPoint(t), tan = curve.getTangent(t), side = new THREE.Vector3(-tan.z, 0, tan.x).normalize(), w = 0.15 + t * 0.34;
    pos.push(p.x - side.x * w, p.y, p.z - side.z * w, p.x + side.x * w, p.y, p.z + side.z * w);
    uv.push(0, t, 1, t);
    if (i < n) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  const m = new THREE.Mesh(g, new THREE.ShaderMaterial({
    transparent: true, side: THREE.DoubleSide, depthWrite: false, uniforms: { t: fallTime, night: sky.night },
    vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: `varying vec2 vUv; uniform float t, night;
      float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
      float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}
      void main(){ float e=smoothstep(0.,.2,vUv.x)*smoothstep(1.,.8,vUv.x);
        float s=n(vec2(vUv.x*9.,vUv.y*42.-t*2.6))*.6+n(vec2(vUv.x*22.,vUv.y*90.-t*4.2))*.4;
        vec3 c=mix(vec3(.45,.8,.95),vec3(1.),smoothstep(.42,.72,s))*mix(1.,.38,night);
        gl_FragColor=vec4(c,e*mix(.95,.55,vUv.y)*smoothstep(1.,.82,vUv.y)*(.75+s*.4)); }`,
  }));
  m.renderOrder = 2;
  return m;
}

// Clouds below and between the islands; their colours follow the time of day.
function clouds(): void {
  const tex = cloudTexture();
  const layer = (count: number, build: (i: number, d: THREE.Object3D) => void, opacity: number) => {
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, uniforms: { map: { value: tex }, t: time, opacity: { value: opacity }, lit: sky.cloudLit, shade: sky.cloudShade },
      vertexShader: `uniform float t; varying vec2 vUv;
        void main(){ vUv=uv; vec4 o=instanceMatrix*vec4(0.,0.,0.,1.); float s=length(instanceMatrix[0].xyz);
          float a=o.x*.13+o.z*.07; o.x+=sin(t*.018+a)*7.; o.z+=cos(t*.014+a)*5.;
          vec4 mv=viewMatrix*o; float r=a*.62; vec2 q=mat2(cos(r),-sin(r),sin(r),cos(r))*position.xy;
          mv.xy+=q*s*vec2(1.4,.8); gl_Position=projectionMatrix*mv; }`,
      fragmentShader: `uniform sampler2D map; uniform float opacity; uniform vec3 lit, shade; varying vec2 vUv;
        void main(){ float a=texture2D(map,vUv).a; if(a<.012)discard;
          gl_FragColor=vec4(mix(shade,lit,smoothstep(.1,.9,vUv.y*.7+a*.7)),a*opacity);
          #include <colorspace_fragment>
        }`,
    });
    const inst = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, count);
    const d = new THREE.Object3D();
    for (let i = 0; i < count; i++) { build(i, d); d.updateMatrix(); inst.setMatrixAt(i, d.matrix); }
    inst.frustumCulled = false;
    inst.renderOrder = 1;
    scene.add(inst);
  };
  const r = makeRng(77);
  layer(64, (i, d) => {
    const a = r() * 6.28, m = 8 + Math.sqrt(r()) * 120;
    d.position.set(Math.cos(a) * m, -11 - r() * 7 + (i % 5 === 0 ? 2.5 : 0), Math.sin(a) * m);
    d.scale.setScalar(22 + r() * 26);
  }, 0.9);
  layer(10, (_i, d) => {
    const a = r() * 6.28, m = 12 + r() * 26;
    d.position.set(Math.cos(a) * m, -6 + r() * 13, Math.sin(a) * m);
    d.scale.setScalar(6 + r() * 8);
  }, 0.45);
}

// One point cloud: blossom petals by day, fireflies by night.
function drifters(): THREE.Points {
  const N = 240, pos = new Float32Array(N * 3), seed = new Float32Array(N), r = makeRng(5);
  for (let i = 0; i < N; i++) { pos.set([(r() - 0.5) * 60, -2 + r() * 10, (r() - 0.5) * 60], i * 3); seed[i] = r() * 6.28; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('seedA', new THREE.BufferAttribute(seed, 1));
  const p = new THREE.Points(g, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, uniforms: { t: time, night: sky.night, map: { value: softDot('rgba(255,255,255,1)', 'rgba(255,255,255,.75)') } },
    vertexShader: `attribute float seedA; uniform float t; varying float vA;
      void main(){ vec3 p=position; float ph=seedA; p.x+=mod(t*.28+ph*9.,60.)-30.; p.y+=sin(t*.5+ph)*.5-mod(t*.11+ph*2.,5.); p.z+=sin(t*.23+ph*3.)*1.4; vA=.5+.5*sin(t*1.4+ph*5.);
        vec4 mv=modelViewMatrix*vec4(p,1.); gl_PointSize=(58./-mv.z)*(.55+vA*.45); gl_Position=projectionMatrix*mv; }`,
    fragmentShader: `uniform sampler2D map; uniform float night; varying float vA;
      void main(){ float m=texture2D(map,gl_PointCoord).a; vec3 petal=mix(vec3(1.,.72,.82),vec3(1.,.95,.95),vA), fly=vec3(.95,1.,.5);
        gl_FragColor=vec4(mix(petal,fly,step(.45,night)),m*mix(.85,vA*vA,step(.45,night))); }`,
  }));
  p.frustumCulled = false;
  scene.add(p);
  return p;
}

// Boot.
const assets = await loadAssets((done, total) => { loading.textContent = `Đang dựng làng… ${Math.round((done / total) * 100)}%`; });
const village = new Village(assets, scene, sky.night, time, softDot('rgba(255,225,170,1)', 'rgba(255,150,70,.42)'));
const people = new People(assets, scene);
const cats = new Cats(assets, scene);
const dragons = new Dragons(assets, scene);
const tung = new TungTung(assets, scene);
clouds();
drifters();

const c = village.centre;
const pond = new THREE.Mesh(new THREE.CircleGeometry(1.35, 28).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x56b6cf, roughness: 0.12, metalness: 0.2, transparent: true, opacity: 0.86 }));
pond.position.set(-2.6, -0.09, 1.6);
pond.receiveShadow = true;
scene.add(pond);
const fallAngle = 2.72, rim = c.shape.radiusAt(fallAngle), pts: THREE.Vector3[] = [];
for (let i = 0; i <= 16; i++) {
  const t = i / 16, x = -2.6 + (Math.cos(fallAngle) * rim + 2.6) * t + Math.sin(t * 9) * 0.06, z = 1.6 + (Math.sin(fallAngle) * rim - 1.6) * t;
  pts.push(new THREE.Vector3(x, Math.min(c.shape.heightAt(x, z), -0.09) + 0.02, z));
}
const end = pts[pts.length - 1]!, out = new THREE.Vector3(Math.cos(fallAngle), 0, Math.sin(fallAngle));
for (let i = 1; i <= 12; i++) { const t = i / 12; pts.push(new THREE.Vector3(end.x + out.x * (0.12 + t * 0.26), end.y - t * t * 11, end.z + out.z * (0.12 + t * 0.26))); }
scene.add(waterfall(pts));

// Data.
let snapshot: VillageSnapshot | null = null;
const apply = (snap: VillageSnapshot) => {
  snapshot = snap;
  village.sync(snap.houses, !!snap.tent);
  const entries: { dto: VillagerDTO; isle: NonNullable<ReturnType<Village['isle']>> }[] = [];
  for (const h of snap.houses) { const isle = village.isle(h.id); if (isle) for (const dto of h.villagers) entries.push({ dto, isle }); }
  const tentIsle = village.tent();
  if (snap.tent && tentIsle) for (const dto of snap.tent.villagers) entries.push({ dto, isle: tentIsle });
  people.sync(entries);
  const hidden = snap.hiddenHouses ? ` · ẩn ${snap.hiddenHouses} nhà` : '';
  countText.textContent = `${snap.houses.length} đảo · ${entries.length} người${hidden}`;
  refreshPanel();
};

function connect(): void {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => { status.textContent = ''; };
  ws.onmessage = (e) => { if (typeof e.data === 'string') apply(JSON.parse(e.data) as VillageSnapshot); };
  ws.onclose = () => { status.textContent = 'Mất kết nối, đang thử lại…'; setTimeout(connect, 2000); };
}

// Selecting a villager.
let selected: string | null = null;
const panel = new Panel(() => choose(null));
function choose(id: string | null): void {
  selected = id;
  people.select(id);
  refreshPanel();
}
function refreshPanel(): void {
  const dto = selected ? people.get(selected) : null;
  if (selected && !dto) { selected = null; people.select(null); }
  let home = '';
  let helpers: VillagerDTO[] = [];
  if (dto && snapshot) {
    const house = snapshot.houses.find((h) => h.villagers.some((v) => v.id === dto.id));
    home = house?.name ?? 'Lều khách';
    helpers = (house?.villagers ?? snapshot.tent?.villagers ?? []).filter((v) => v.parentId === dto.id);
  }
  panel.show(dto, home, helpers);
}
const pointer = new THREE.Vector2(), ray = new THREE.Raycaster();
let downAt: [number, number] = [0, 0];
renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(pointer, camera);
  const id = people.pick(ray.ray);
  choose(id);
  const isle = id ? people.isleOf(id) : village.isleAt(ray.ray);
  if (isle) focus(isle);
});
renderer.domElement.addEventListener('pointermove', (e) => {
  pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(pointer, camera);
  renderer.domElement.style.cursor = people.pick(ray.ray) || village.isleAt(ray.ray) ? 'pointer' : 'grab';
});
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (selected) choose(null);
  else if (focused) goHome();
});

// Flying to an island: the camera turns around it afterwards, and zooms towards it.
let focused: string | null = null;
const FLIGHT_SECONDS = 1.2;
const flight = { active: false, t: 0, fromAt: new THREE.Vector3(), toAt: new THREE.Vector3(), fromPos: new THREE.Vector3(), toPos: new THREE.Vector3() };
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
function flyTo(at: THREE.Vector3, pos: THREE.Vector3): void {
  flight.fromAt.copy(controls.target);
  flight.fromPos.copy(camera.position);
  flight.toAt.copy(at);
  flight.toPos.copy(pos);
  flight.t = reducedMotion ? 1 : 0;
  flight.active = true;
}
function focus(isle: Isle): void {
  if (focused === isle.id) return;
  focused = isle.id;
  controls.autoRotate = false;
  homeButton.hidden = false;
  const at = new THREE.Vector3(isle.x, isle.y + 0.7, isle.z);
  // Keep looking from the side the camera is already on, so the flight does not spin the world.
  const side = camera.position.clone().sub(at).setY(0).normalize();
  // Close and from above, so the islands in front do not block the view.
  const dist = isle.R * 3.6;
  flyTo(at, at.clone().addScaledVector(side, dist * 0.78).setY(at.y + dist * 0.62));
}
function goHome(): void {
  focused = null;
  homeButton.hidden = true;
  flyTo(new THREE.Vector3(...view.at), new THREE.Vector3(...view.pos));
}
homeButton.addEventListener('click', goHome);
controls.addEventListener('start', () => { flight.active = false; });
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// Time of day: the real clock by default, or a full day in three minutes.
let fast = false;
let fastHour = 0;
speedButton.addEventListener('click', () => {
  fast = !fast;
  const d = new Date();
  fastHour = d.getHours() + d.getMinutes() / 60;
  speedButton.textContent = fast ? 'Về giờ thật' : 'Tua nhanh một ngày';
});
const currentHour = (dt: number) => {
  if (fixedHour !== null) return fixedHour;
  if (fast) return (fastHour = (fastHour + dt * (24 / 180)) % 24);
  const d = new Date();
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
};
const labelOf = (h: number) => (h < 5 ? 'Đêm' : h < 8 ? 'Sáng sớm' : h < 11 ? 'Sáng' : h < 14 ? 'Trưa' : h < 17.5 ? 'Chiều' : h < 19.5 ? 'Hoàng hôn' : 'Tối');

let frames = 0, last = performance.now(), count = 0, elapsed = 0, slowSeconds = 0, frameAt = performance.now();
(window as unknown as { __stats: unknown }).__stats = { ready: false };
function tick(at: number): void {
  // The frame's own timestamp, not the clock when this code happens to run: anything that moves fast
  // would otherwise shake by however late each frame started.
  const dt = Math.min(Math.max(0, at - frameAt) / 1000, 0.1);
  frameAt = at;
  elapsed += dt;
  count++;
  if (flight.active) {
    flight.t = Math.min(1, flight.t + dt / FLIGHT_SECONDS);
    const e = flight.t * flight.t * (3 - 2 * flight.t);
    controls.target.lerpVectors(flight.fromAt, flight.toAt, e);
    camera.position.lerpVectors(flight.fromPos, flight.toPos, e);
    if (flight.t >= 1) flight.active = false;
  }
  controls.update();
  const hour = currentHour(dt);
  sky.update(hour);
  time.value = elapsed + 300;
  fallTime.value = elapsed;
  village.update(elapsed);
  people.update(dt, elapsed, camera);
  const isles = village.isles(), feet = people.feet(), bridges = village.bridges();
  cats.update(dt, elapsed, isles, feet, bridges);
  dragons.update(dt, elapsed, isles, feet);
  tung.update(dt, elapsed, isles, feet, bridges);
  pond.position.y = -0.09 + bobOf(elapsed, -1);
  // Shadows follow the slow sun and only need a refresh now and then.
  if (village.dirty || count < 4 || count % 90 === 0) {
    renderer.shadowMap.needsUpdate = true;
    village.dirty = false;
  }
  renderer.render(scene, camera);
  frames++;
  const now = performance.now();
  if (now - last > 1000) {
    const fps = (frames * 1000) / (now - last);
    frames = 0;
    last = now;
    const { calls, triangles } = renderer.info.render;
    (window as unknown as { __stats: unknown }).__stats = { ready: !!snapshot, fps: +fps.toFixed(1), calls, triangles, hour: +hour.toFixed(2), pixelRatio };
    statsText.textContent = `${fps.toFixed(0)} FPS · ${calls} calls · ${(triangles / 1000).toFixed(0)}k tris`;
    clockText.textContent = `${labelOf(hour)} ${String(Math.floor(hour)).padStart(2, '0')}:${String(Math.floor((hour % 1) * 60)).padStart(2, '0')}`;
    // On a weak GPU, trade a little sharpness for smoothness rather than stutter: first down to the
    // screen's own pixels, and below that only when the game would otherwise be choppy.
    // Under about 5 FPS the browser is throttling a window it thinks nobody is watching, which says
    // nothing about the GPU, and the sharpness lost would never come back.
    const floor = fps < 28 ? 0.7 : Math.min(devicePixelRatio, 1);
    slowSeconds = fps < 58 && fps > 5 ? slowSeconds + 1 : 0;
    if (slowSeconds >= 5 && pixelRatio > floor) {
      pixelRatio = Math.max(floor, pixelRatio - 0.125);
      renderer.setPixelRatio(pixelRatio);
      slowSeconds = 0;
    }
  }
  requestAnimationFrame(tick);
}
if (debug) {
  // For scripts/e2e.mjs: where a villager is on screen, so a real click can be sent there.
  (window as unknown as { __screenOf: unknown }).__screenOf = (id: string) => {
    const p = people.worldOf(id);
    if (!p) return null;
    p.project(camera);
    return { x: ((p.x + 1) / 2) * innerWidth, y: ((1 - p.y) / 2) * innerHeight };
  };
  (window as unknown as { __snapshot: unknown }).__snapshot = () => snapshot;
  (window as unknown as { __triangles: unknown }).__triangles = () => {
    const out: Record<string, number> = {};
    scene.traverse((o) => {
      const m = o as THREE.InstancedMesh;
      if (!m.isMesh || !m.geometry) return;
      const n = (m.geometry.index ? m.geometry.index.count : m.geometry.attributes['position']!.count) / 3;
      const key = m.isInstancedMesh ? `${m.geometry.attributes['position']!.count}v x${m.count}` : (m as THREE.Mesh).type;
      out[key] = (out[key] ?? 0) + n * (m.isInstancedMesh ? m.count : 1);
    });
    return Object.entries(out).sort((a, b) => b[1] - a[1]).slice(0, 14);
  };
  (window as unknown as { __clipOf: unknown }).__clipOf = (id: string) => people.clipOf(id);
  // For scripts/e2e.mjs: where the camera is looking, and where an island is on screen.
  (window as unknown as { __view: unknown }).__view = () => ({ x: controls.target.x, y: controls.target.y, z: controls.target.z, flying: flight.active, focused });
  (window as unknown as { __isleOnScreen: unknown }).__isleOnScreen = (id: string) => {
    const isle = village.isle(id);
    if (!isle) return null;
    const p = new THREE.Vector3(isle.x, isle.y + isle.shape.heightAt(isle.R * 0.6, isle.R * 0.2), isle.z).add(new THREE.Vector3(isle.R * 0.6, 0, isle.R * 0.2)).project(camera);
    return { x: ((p.x + 1) / 2) * innerWidth, y: ((1 - p.y) / 2) * innerHeight, wx: isle.x, wz: isle.z };
  };
  (window as unknown as { __dragons: unknown }).__dragons = () => dragons.states();
  (window as unknown as { __tung: unknown }).__tung = () => tung.state();
  (window as unknown as { __catFeet: unknown }).__catFeet = () => cats.feet();
  (window as unknown as { __lookAt: unknown }).__lookAt = (x: number, y: number, z: number, away: number, angle: number) => {
    controls.target.set(x, y, z);
    camera.position.set(x + Math.sin(angle) * away, y + away * 0.2, z + Math.cos(angle) * away);
  };
  // For scripts/walk.mjs: who is standing inside a solid model right now.
  (window as unknown as { __inside: unknown }).__inside = () => {
    const spots = people.feet();
    const hits = spots.map((s) => ({ id: s.id, assets: village.solidsAt(s.x, s.y, s.z) })).filter((h) => h.assets.length);
    const close = spots.flatMap((a, i) => spots.slice(i + 1).filter((b) => Math.hypot(a.x - b.x, a.z - b.z) < 0.4).map((b) => a.moving || b.moving));
    const catFeet = cats.feet();
    const roamers = [...catFeet.map((s, i) => ({ s, id: `cat-${i}` })), ...[tung.state()].flatMap((s) => (s ? [{ s, id: 'tung' }] : []))];
    const catHits = roamers.map(({ s, id }) => ({ id, assets: village.solidsAt(s.x, s.y, s.z) })).filter((h) => h.assets.length);
    const onBridge = roamers.filter(({ s }) => s.overPlanks).map(({ s, id }) => ({ id, gap: village.gapToPlanks(s.x, s.y, s.z) }));
    return { people: spots.length, hits: [...hits, ...catHits], crowded: close.length, standing: close.filter((m) => !m).length, cats: catFeet.length, onBridge, stuck: people.stuck() };
  };
}
if (DEMO) {
  const start = Date.now();
  const refresh = () => apply(demoSnapshot(DEMO, (Date.now() - start) / 1000, Date.now()));
  refresh();
  setInterval(refresh, 3000);
} else connect();
loading.remove();
requestAnimationFrame(tick);
