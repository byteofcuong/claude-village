// The islands. Each project keeps its look, chosen from a hash of its id. Scenery shares instanced
// batches that are rebuilt only when the set of islands changes.
import * as THREE from 'three';
import type { Assets, Model } from './assets.js';
import type { Bridge } from './bridges.js';
import { BODY, boxCircles, isFree, pushOut, type Obstacle, type Point } from './paths.js';
import { hashString, labelTexture, makeIsland, makeRng, merge, ropeBridge, type IslandShape } from './world.js';
export type { Point } from './paths.js';

/** x, height, z of each island around the centre. */
export const SLOTS: [number, number, number][] = [
  [11.1, 0.7, 1], [11.2, -0.2, 10.1], [1.8, -0.6, 11.3], [-9.8, 0.9, 5.6], [-10.8, -0.4, -4], [-1, 1.1, -12], [10.4, 0.3, -8.1],
  [21.5, -1.2, 2], [19.2, 1, 14.4], [7.2, -1.6, 21], [-12.5, 0.8, 18.2], [-22, -0.8, 6.8], [-20.5, 1.2, -8.4], [15, -1, -18.5],
];
const TENT_POS: [number, number, number] = [-5.6, -0.3, 15.5];

export type StationName = 'door' | 'work' | 'forge' | 'read' | 'view' | 'rest';
export interface Isle {
  id: string;
  x: number; y: number; z: number;
  R: number;
  phase: number;
  shape: IslandShape;
  stations: Record<StationName, Point>;
  patrol: Point[];
  facing: number;
  /** What stands in the way of a walk, in island coordinates. */
  obstacles: Obstacle[];
  /** What a person at a station turns towards while working. */
  looks: Partial<Record<StationName, Point>>;
}

export const walkable = (isle: Isle, p: Point) => Math.hypot(p.x, p.z) < isle.shape.radiusAt(Math.atan2(p.z, p.x)) * 0.84;

interface Item { x: number; y: number; z: number; r: number; size: number; phase: number; cast?: boolean; pale?: 'pink' | 'gold' }
interface Plan { isle: Isle; items: Map<string, Item[]>; lights: THREE.Vector3[]; label: THREE.Sprite; terrain: THREE.Mesh; shadowBase?: number }

const uT = { value: 0 };
export const bobOf = (t: number, phase: number) => (phase < 0 ? 0 : Math.sin(t * 0.32 + phase) * 0.05);
function drifting<T extends THREE.Material>(mat: T, windy: boolean): T {
  mat.onBeforeCompile = (s) => {
    s.uniforms['uT'] = uT;
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute float aPhase; uniform float uT;');
    if (windy) {
      s.vertexShader = s.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        transformed.x += sin(uT*1.1+position.y*1.2+position.x)*.012*position.y; transformed.z += cos(uT*.9+position.y)*.01*position.y;`);
    }
    s.vertexShader = s.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
      if (aPhase >= 0.) { mvPosition += viewMatrix * vec4(0., sin(uT*.32+aPhase)*.05, 0., 0.); gl_Position = projectionMatrix * mvPosition; }`);
  };
  mat.customProgramCacheKey = () => (windy ? 'drift-wind' : 'drift');
  return mat;
}

const TREES = ['CommonTree_3', 'Pine_5', 'CommonTree_5', 'Pine_5'];
const BLOSSOM = ['CommonTree_3', 'CommonTree_5'];
const HOUSES: [string, number][] = [['building_1', 3.1], ['shop', 3.0], ['building_3', 3.1]];
const ROOFS = ['thatch', 'terracotta', 'moss', 'slate', 'clay'];
const PLANTS: [string, number, number][] = [['Grass_Common_Short', 0.32, 4], ['Flower_3_Single', 0.42, 2], ['Fern_1', 0.5, 1], ['Pebble_Square_4', 0.06, 3], ['Plant_1', 0.36, 2]];

function put(map: Map<string, Item[]>, asset: string, item: Item): void {
  const list = map.get(asset);
  if (list) list.push(item);
  else map.set(asset, [item]);
}

export class Village {
  readonly group = new THREE.Group();
  private plans = new Map<string, Plan>();
  private batches: THREE.Object3D[] = [];
  private bridge: THREE.Mesh | null = null;
  private spans: Bridge[] = [];
  private activeKey = '';
  private readonly caster = new THREE.Raycaster();
  private readonly terrainMat = drifting(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }), false);
  private readonly bridgeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
  private readonly matCache = new Map<string, THREE.Material>();
  private readonly lightPoints: THREE.Points;
  private readonly lightMaterial: THREE.ShaderMaterial;
  readonly centre: Isle;
  private readonly centrePlan: Plan;
  /** Set when instances change, so the shadow map can follow. */
  dirty = true;

  constructor(private readonly assets: Assets, scene: THREE.Scene, night: { value: number }, time: { value: number }, dot: THREE.Texture) {
    scene.add(this.group);
    this.lightMaterial = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { night, t: time, map: { value: dot }, pixel: { value: 1 } },
      vertexShader: `uniform float t, pixel; attribute float seedA; varying float vF;
        void main(){ vF=.85+.15*sin(t*3.+seedA*9.); vec4 mv=modelViewMatrix*vec4(position,1.); gl_PointSize=clamp(pixel*(560./-mv.z),6.,90.); gl_Position=projectionMatrix*mv; }`,
      fragmentShader: 'uniform sampler2D map; uniform float night; varying float vF; void main(){ float a=texture2D(map,gl_PointCoord).a; gl_FragColor=vec4(vec3(1.,.66,.32),a*(.12+night*.86)*vF); }',
    });
    this.lightPoints = new THREE.Points(new THREE.BufferGeometry(), this.lightMaterial);
    this.lightPoints.frustumCulled = false;
    this.lightPoints.renderOrder = 3;
    scene.add(this.lightPoints);
    this.centrePlan = this.planCentre();
    this.centre = this.centrePlan.isle;
    this.group.add(this.centrePlan.terrain);
  }

  update(t: number): void { uT.value = t; }
  isle(id: string): Isle | undefined { return this.plans.get(id)?.isle; }
  tent(): Isle | undefined { return this.plans.get('tent')?.isle; }
  isles(): Isle[] { return [this.centre, ...[...this.plans.values()].map((p) => p.isle)]; }
  bridges(): readonly Bridge[] { return this.spans; }

  /** How far above the planks this spot is, or null if there are no planks under it, for the walking check. */
  gapToPlanks(x: number, y: number, z: number): number | null {
    if (!this.bridge) return null;
    // Planks have gaps between them and sit level on a slope, so the nearest of several rays counts.
    let best: number | null = null;
    for (const [dx, dz] of [[0, 0], [0.09, 0], [-0.09, 0], [0, 0.09], [0, -0.09]] as const) {
      const hit = new THREE.Raycaster(new THREE.Vector3(x + dx, y + 0.3, z + dz), new THREE.Vector3(0, -1, 0), 0, 0.8).intersectObject(this.bridge, false)[0];
      if (hit && (best === null || Math.abs(hit.distance - 0.3) < Math.abs(best))) best = hit.distance - 0.3;
    }
    return best;
  }

  /** The island a ray points at: the ground it hits, or else the one it passes closest to, such as over a roof. */
  isleAt(ray: THREE.Ray): Isle | null {
    const all = [this.centrePlan, ...this.plans.values()];
    this.caster.ray.copy(ray);
    const hit = this.caster.intersectObjects(all.map((p) => p.terrain), false)[0];
    if (hit) return all.find((p) => p.terrain === hit.object)?.isle ?? null;
    const point = new THREE.Vector3();
    let best: Isle | null = null, bestMiss = 1;
    for (const { isle } of all) {
      const miss = Math.sqrt(ray.distanceSqToPoint(point.set(isle.x, isle.y + 0.8, isle.z))) / isle.R;
      if (miss < bestMiss) { bestMiss = miss; best = isle; }
    }
    return best;
  }

  /** The solid models a standing person at this spot would stand inside, for the walking check. */
  solidsAt(x: number, y: number, z: number): string[] {
    const ray = new THREE.Raycaster(new THREE.Vector3(x, y + 0.7, z), new THREE.Vector3(0, -1, 0), 0, 0.6);
    const solid = this.batches.filter((b) => {
      const mat = (b as THREE.InstancedMesh).material as THREE.Material;
      return b.userData['solid'] === true && mat.alphaTest === 0;
    });
    return [...new Set(ray.intersectObjects(solid, false).map((h) => h.object.userData['asset'] as string))];
  }

  /** Brings the islands in line with the snapshot. Costly work happens only if the set changed. */
  sync(houses: { id: string; name: string; slot: number }[], tent: boolean): void {
    const wanted = new Map<string, { name: string; pos: [number, number, number]; slot: number }>();
    for (const h of houses) wanted.set(h.id, { name: h.name, pos: SLOTS[h.slot % SLOTS.length]!, slot: h.slot });
    if (tent) wanted.set('tent', { name: 'Lều khách', pos: TENT_POS, slot: 99 });
    const key = [...wanted.entries()].map(([id, w]) => `${id}:${w.slot}:${w.name}`).sort().join('|');
    if (key === this.activeKey) return;
    this.activeKey = key;
    for (const [id, plan] of this.plans) {
      if (wanted.has(id)) continue;
      plan.terrain.removeFromParent();
      plan.terrain.geometry.dispose();
      plan.label.removeFromParent();
      plan.label.material.map?.dispose();
      plan.label.material.dispose();
      this.plans.delete(id);
    }
    for (const [id, w] of wanted) {
      if (this.plans.has(id)) continue;
      const plan = id === 'tent' ? this.planTent(w.pos) : this.planHome(id, w.name, w.pos);
      this.plans.set(id, plan);
      this.group.add(plan.terrain, plan.label);
    }
    this.rebuild();
  }

  private rebuild(): void {
    for (const b of this.batches) {
      b.removeFromParent();
      (b as THREE.InstancedMesh).geometry.dispose();
    }
    this.batches = [];
    const all = [this.centrePlan, ...this.plans.values()];
    const merged = new Map<string, Item[]>();
    for (const p of all) for (const [asset, items] of p.items) for (const it of items) put(merged, asset, it);
    for (const [asset, items] of merged) this.addBatch(asset, items);
    this.rebuildBridges();
    const lights = all.flatMap((p) => p.lights);
    const pos = new Float32Array(lights.length * 3), seed = new Float32Array(lights.length);
    lights.forEach((l, i) => { pos.set([l.x, l.y, l.z], i * 3); seed[i] = i * 0.73; });
    const g = this.lightPoints.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('seedA', new THREE.BufferAttribute(seed, 1));
    this.dirty = true;
  }

  private addBatch(asset: string, items: Item[]): void {
    const [kind, name, roof] = asset.split(':') as [string, string, string | undefined];
    const model: Model | undefined = kind === 'n' ? this.assets.nature.get(name) : this.assets.village.get(name);
    if (!model) return;
    const dummy = new THREE.Object3D();
    const groups = new Map<string, Item[]>();
    for (const it of items) { const k = it.pale ?? ''; const list = groups.get(k); if (list) list.push(it); else groups.set(k, [it]); }
    for (const [pale, group] of groups) {
      for (const part of model.parts) {
        const geo = part.geometry.clone();
        geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(Float32Array.from(group, (i) => i.phase), 1));
        const inst = new THREE.InstancedMesh(geo, this.materialFor(part.material, kind, roof, pale), group.length);
        group.forEach((it, i) => {
          const s = kind === 'n' ? it.size / model.height : it.size / model.footprint;
          dummy.position.set(it.x, it.y, it.z);
          dummy.rotation.set(0, it.r, 0);
          dummy.scale.setScalar(s);
          dummy.updateMatrix();
          inst.setMatrixAt(i, dummy.matrix.clone().multiply(part.matrix));
        });
        inst.frustumCulled = false;
        inst.castShadow = group[0]!.cast !== false;
        inst.receiveShadow = true;
        inst.userData['asset'] = name;
        inst.userData['solid'] = kind === 'v' || /Rock|Tree|Pine/.test(name);
        this.group.add(inst);
        this.batches.push(inst);
      }
    }
  }

  private materialFor(base: THREE.Material, kind: string, roof: string | undefined, pale: string): THREE.Material {
    const key = kind === 'v' ? `v:${roof}` : `${base.uuid}:${pale}`;
    const cached = this.matCache.get(key);
    if (cached) return cached;
    let m: THREE.Material;
    if (kind === 'v') {
      m = drifting(new THREE.MeshStandardMaterial({ map: this.assets.roofMaps[roof ?? 'thatch'] ?? null, roughness: 0.82 }), false);
    } else {
      const c = (base as THREE.MeshStandardMaterial).clone();
      const leafy = c.alphaTest > 0 && c.name.includes('Leaves');
      if (leafy) c.color.multiplyScalar(pale ? 1.3 : 1.45);
      if (pale && c.map && leafy) {
        const swap = this.assets.leaf[pale as 'pink' | 'gold'].get(c.map);
        if (swap) { c.map = swap; c.color.setScalar(1.25); }
      }
      c.roughness = 1;
      c.metalness = 0;
      m = drifting(c, leafy);
    }
    this.matCache.set(key, m);
    return m;
  }

  private rebuildBridges(): void {
    if (this.bridge) {
      this.bridge.removeFromParent();
      this.bridge.geometry.dispose();
      this.bridge = null;
    }
    this.spans = [];
    const homes = [...this.plans.values()].map((p) => p.isle).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
    if (!homes.length) return;
    const linked = [this.centre];
    const parts: THREE.BufferGeometry[] = [];
    for (const a of homes) {
      let best = this.centre, bd = Infinity;
      for (const b of linked) { const d = Math.hypot(a.x - b.x, a.z - b.z); if (d < bd) { bd = d; best = b; } }
      const ang = Math.atan2(a.z - best.z, a.x - best.x), ra = best.shape.radiusAt(ang) * 0.86, rb = a.shape.radiusAt(ang + Math.PI) * 0.86;
      const ax = Math.cos(ang) * ra, az = Math.sin(ang) * ra, bx = -Math.cos(ang) * rb, bz = -Math.sin(ang) * rb;
      parts.push(ropeBridge([best.x + ax, best.y + best.shape.heightAt(ax, az) + 0.02, best.z + az], [a.x + bx, a.y + a.shape.heightAt(bx, bz) + 0.02, a.z + bz]));
      this.spans.push({ a: best, b: a, aEnd: { x: ax, z: az }, bEnd: { x: bx, z: bz } });
      linked.push(a);
    }
    this.bridge = new THREE.Mesh(merge(parts), this.bridgeMat);
    this.bridge.castShadow = true;
    this.group.add(this.bridge);
  }

  private terrain(shape: IslandShape, pos: [number, number, number], phase: number): THREE.Mesh {
    const g = shape.geo;
    g.setAttribute('aPhase', new THREE.BufferAttribute(new Float32Array(g.attributes['position']!.count).fill(phase), 1));
    const m = new THREE.Mesh(g, this.terrainMat);
    m.position.set(...pos);
    m.castShadow = m.receiveShadow = true;
    m.frustumCulled = false;
    return m;
  }

  private cliffRocks(items: Map<string, Item[]>, isle: Isle, rnd: () => number, n: number): void {
    const model = this.assets.nature.get('Rock_Medium_2');
    const paths = [...Object.values(isle.stations), ...isle.patrol];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 6.28 + rnd() * 0.5, rim = isle.shape.radiusAt(a), d = rnd(), m = rim * (0.92 - d * 0.42);
      const x = Math.cos(a) * m, z = Math.sin(a) * m, r = rnd() * 6.28, size = 0.9 + rnd() * 1.1 * (isle.R / 3.5);
      const ground = isle.y + isle.shape.heightAt(x, z);
      let y = isle.y - 0.55 - d * isle.R * 0.62;
      if (y + size > ground && model) {
        // These rocks belong to the cliff. One that breaks the surface sinks if it would sit on a
        // place people use, and otherwise becomes something to walk around.
        const reach = (size / model.height) * model.footprint * 0.5;
        if (paths.some((p) => Math.hypot(p.x - x, p.z - z) < reach + BODY + 0.3)) y = ground - size - 0.02;
        else isle.obstacles.push({ x, z, r: reach });
      }
      put(items, 'n:Rock_Medium_2', { x: isle.x + x, y, z: isle.z + z, r, size, phase: isle.phase });
    }
  }

  private scatter(items: Map<string, Item[]>, isle: Isle, rnd: () => number, keepOut: { x: number; z: number; r: number }[], big: [string, number, number, ('pink' | 'gold')?][], plantScale: number): void {
    const { shape, R } = isle;
    const clear = (x: number, z: number, m: number) => keepOut.every((k) => Math.hypot(x - k.x, z - k.z) > k.r + m);
    const spot = (minR: number, maxR: number, m: number) => {
      for (let t = 0; t < 70; t++) {
        const a = rnd() * 6.28, rr = minR + rnd() * (maxR - minR), x = Math.cos(a) * R * rr, z = Math.sin(a) * R * rr;
        if (Math.hypot(x, z) < shape.radiusAt(a) * 0.85 && clear(x, z, m)) return { x, z, y: shape.heightAt(x, z) };
      }
      return null;
    };
    for (const [asset, h, n, pale] of big) for (let i = 0; i < n; i++) {
      const s = spot(0.4, 0.86, 0.35);
      if (!s) continue;
      const item: Item = { x: isle.x + s.x, y: isle.y + s.y - 0.03, z: isle.z + s.z, r: rnd() * 6.28, size: h * (0.82 + rnd() * 0.36), phase: isle.phase };
      if (pale) item.pale = pale;
      put(items, `n:${asset}`, item);
      keepOut.push({ x: s.x, z: s.z, r: 0.5 });
      isle.obstacles.push({ x: s.x, z: s.z, r: 0.28 });
    }
    for (const [asset, h, n] of PLANTS) for (let i = 0; i < Math.round(n * plantScale); i++) {
      const s = spot(0.12, 0.95, 0.03);
      if (s) put(items, `n:${asset}`, { x: isle.x + s.x, y: isle.y + s.y - 0.03, z: isle.z + s.z, r: rnd() * 6.28, size: h * (0.82 + rnd() * 0.36), phase: isle.phase, cast: false });
    }
  }

  private label(text: string, pos: [number, number, number], height: number): THREE.Sprite {
    const { texture, aspect } = labelTexture(text);
    // The same size on screen at any distance, so a name never covers the island it belongs to.
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, fog: false, transparent: true, sizeAttenuation: false }));
    sprite.scale.set(0.015 * aspect, 0.015, 1);
    sprite.position.set(pos[0], pos[1] + height, pos[2]);
    sprite.renderOrder = 5;
    return sprite;
  }

  private planHome(id: string, name: string, pos: [number, number, number]): Plan {
    const h = hashString(id), rnd = makeRng(h % 100_000), seed = 17 + (h % 997) * 0.37, R = 3.5 + rnd() * 0.8, phase = (h % 628) / 100;
    const shape = makeIsland({ R, seed, rings: 8, segs: 28, depth: R * (0.95 + rnd() * 0.45), flats: [{ x: 0, z: 0.4, r: 2.6 }] });
    const [hx, hz] = [(rnd() - 0.5) * 0.4, -0.3 + (rnd() - 0.5) * 0.25];
    const facing = Math.atan2(-pos[0], -pos[2]) * 0.35 + (rnd() - 0.5) * 0.3;
    const local = (dx: number, dz: number): Point => ({ x: hx + Math.sin(facing) * dz + Math.cos(facing) * dx, z: hz + Math.cos(facing) * dz - Math.sin(facing) * dx });
    const stations: Record<StationName, Point> = { door: local(-0.2, 1.85), work: local(1.5, 1.55), forge: local(-1.55, 1.45), read: local(0.9, 2.5), view: local(-0.9, 2.65), rest: local(0.15, 2.5) };
    const patrol = [local(-1.9, 1.2), local(-1, 2.8), local(1, 2.85), local(2, 1.1)];
    const looks = { forge: local(-1.9, 1.05), work: local(1.95, 1.2) };
    const isle: Isle = { id, x: pos[0], y: pos[1], z: pos[2], R, phase, shape, stations, patrol, facing, obstacles: [], looks };
    const items = new Map<string, Item[]>();
    const [house, width] = HOUSES[h % HOUSES.length]!;
    const roof = ROOFS[(h >>> 4) % ROOFS.length]!;
    const at = (p: Point) => ({ x: pos[0] + p.x, y: pos[1] + shape.heightAt(p.x, p.z) - 0.01, z: pos[2] + p.z });
    put(items, `v:${house}:${roof}`, { x: pos[0] + hx, y: pos[1] + shape.heightAt(hx, hz) - 0.02, z: pos[2] + hz, r: facing, size: width, phase });
    const houseModel = this.assets.village.get(house);
    const houseScale = houseModel ? width / houseModel.footprint : 1;
    isle.obstacles.push(...boxCircles(hx, hz, facing, (houseModel?.sizeX ?? width) * houseScale, (houseModel?.sizeZ ?? width) * houseScale));
    const prop = (asset: string, p: Point, size: number, r = facing) => {
      put(items, `v:${asset}:${roof}`, { ...at(p), r, size, phase });
      isle.obstacles.push({ x: p.x, z: p.z, r: size * 0.5 });
    };
    prop('forge', looks.forge, 0.95);
    prop(h % 2 ? 'cart' : 'frame', looks.work, 1.1, facing + 0.5);
    prop('wood_1', local(1.6, 1.0), 0.55);
    prop(h % 3 === 0 ? 'well' : 'lamp', local(1.25, 2.1), h % 3 === 0 ? 0.72 : 0.36);
    prop(['pot_1', 'barrel_1', 'urn_1'][h % 3]!, local(-0.95, 1.7), 0.32);
    for (const key of Object.keys(stations) as StationName[]) stations[key] = pushOut(stations[key], isle.obstacles);
    // A patrol point squeezed between the house and a prop has no room for a person, so it is dropped.
    isle.patrol = patrol.map((p) => pushOut(p, isle.obstacles)).filter((p) => isFree(p, isle.obstacles));
    const keepOut = [{ x: hx, z: hz, r: 2.0 }, ...Object.values(stations).map((p) => ({ ...p, r: 0.6 })), ...isle.patrol.map((p) => ({ ...p, r: 0.35 }))];
    const flower = h % 3 === 0 ? 'pink' : h % 3 === 1 ? 'gold' : undefined;
    const big: [string, number, number, ('pink' | 'gold')?][] = [[TREES[h % TREES.length]!, 2.5, 1], [flower ? BLOSSOM[h % 2]! : 'Pine_5', 2.1, 1, flower]];
    this.scatter(items, isle, rnd, keepOut, big, 1);
    this.cliffRocks(items, isle, rnd, 2);
    const glow = (dx: number, dz: number, up: number) => { const a = at(local(dx, dz)); return new THREE.Vector3(a.x, a.y + up, a.z); };
    return { isle, items, lights: [glow(-0.2, 1.4, 0.95), glow(0.9, 1.35, 1.0), glow(-1.1, 1.35, 1.0), glow(1.25, 2.1, 0.5), glow(-1.9, 1.05, 0.55)], label: this.label(name, pos, 3.4), terrain: this.terrain(shape, pos, phase) };
  }

  private planTent(pos: [number, number, number]): Plan {
    const rnd = makeRng(444), R = 2.6, phase = 1.3;
    const shape = makeIsland({ R, seed: 91.2, rings: 9, segs: 28, depth: R * 1.1, flats: [{ x: 0, z: 0, r: 2.1 }] });
    const stations: Record<StationName, Point> = { door: { x: 0, z: 1.1 }, work: { x: 0.9, z: 0.8 }, forge: { x: -0.9, z: 0.8 }, read: { x: 0.5, z: 1.5 }, view: { x: -0.5, z: 1.5 }, rest: { x: 0, z: 1.55 } };
    const obstacles = [{ x: 0, z: -0.4, r: 0.95 }, { x: 1.1, z: 0.4, r: 0.17 }];
    for (const key of Object.keys(stations) as StationName[]) stations[key] = pushOut(stations[key], obstacles);
    const patrol = [{ x: -1.2, z: 0.7 }, { x: 0, z: 1.7 }, { x: 1.2, z: 0.7 }].map((p) => pushOut(p, obstacles));
    const stand = { x: 0, z: -0.4 };
    const isle: Isle = { id: 'tent', x: pos[0], y: pos[1], z: pos[2], R, phase, shape, stations, patrol, facing: 0, obstacles, looks: { forge: stand, work: stand } };
    const items = new Map<string, Item[]>();
    put(items, 'v:stand:slate', { x: pos[0], y: pos[1] + shape.heightAt(0, -0.4), z: pos[2] - 0.4, r: 0, size: 1.9, phase });
    put(items, 'v:lamp:slate', { x: pos[0] + 1.1, y: pos[1] + shape.heightAt(1.1, 0.4), z: pos[2] + 0.4, r: 0, size: 0.34, phase });
    this.scatter(items, isle, rnd, [{ x: 0, z: 0, r: 1.5 }, ...Object.values(stations).map((p) => ({ ...p, r: 0.4 }))], [['Pine_5', 1.8, 1]], 0.5);
    this.cliffRocks(items, isle, rnd, 3);
    return { isle, items, lights: [new THREE.Vector3(pos[0] + 1.1, pos[1] + 0.6, pos[2] + 0.4)], label: this.label('Lều khách', pos, 2.3), terrain: this.terrain(shape, pos, phase) };
  }

  private planCentre(): Plan {
    const rnd = makeRng(9), R = 6.3, phase = -1, pos: [number, number, number] = [0, 0, 0];
    const pond = { x: -2.6, z: 1.6, r: 1.25 };
    const shape = makeIsland({ R, seed: 5.3, rings: 18, segs: 44, depth: 8, pond, flats: [{ x: 0.4, z: 1.7, r: 2.35, earth: true }, { x: 1.6, z: -1.7, r: 2 }] });
    const stations: Record<StationName, Point> = { door: { x: 0.4, z: 2.9 }, work: { x: 1.6, z: 1.7 }, forge: { x: -0.8, z: 1.7 }, read: { x: 1.2, z: 2.6 }, view: { x: -0.3, z: 2.9 }, rest: { x: 0.4, z: 0.5 } };
    const isle: Isle = { id: 'centre', x: 0, y: 0, z: 0, R, phase, shape, stations, patrol: [], facing: 0, obstacles: [], looks: {} };
    const items = new Map<string, Item[]>();
    const at = (x: number, z: number) => ({ x, y: shape.heightAt(x, z) - 0.02, z });
    put(items, 'v:shrine:clay', { ...at(1.7, -1.9), r: 0.55, size: 3.4, phase });
    put(items, 'v:arch_2:terracotta', { ...at(3.1, 3.3), r: 0.9, size: 2, phase });
    put(items, 'v:brazier:terracotta', { ...at(0.4, 1.7), r: 0, size: 0.72, phase });
    for (const [x, z] of [[-0.9, 3.2], [1.9, 2.8], [-1.4, 0.3]] as const) put(items, 'v:lamp:clay', { ...at(x, z), r: rnd() * 6, size: 0.34, phase });
    isle.obstacles.push(
      ...boxCircles(1.7, -1.9, 0.55, 3.4, 3.4), { x: 3.1, z: 3.3, r: 1 }, { x: 0.4, z: 1.7, r: 0.4 },
      { x: -0.9, z: 3.2, r: 0.17 }, { x: 1.9, z: 2.8, r: 0.17 }, { x: -1.4, z: 0.3, r: 0.17 }, { x: pond.x, z: pond.z, r: pond.r + 0.1 },
    );
    const lights = [new THREE.Vector3(0.4, shape.heightAt(0.4, 1.7) + 0.8, 1.7), ...[[-0.9, 3.2], [1.9, 2.8], [-1.4, 0.3]].map(([x, z]) => new THREE.Vector3(x!, shape.heightAt(x!, z!) + 0.55, z!))];
    for (let i = 0; i < 4; i++) {
      const a = rnd() * 6.28, m = Math.sqrt(rnd()) * pond.r * 0.8;
      put(items, 'n:Clover_2', { x: pond.x + Math.cos(a) * m, y: -0.12, z: pond.z + Math.sin(a) * m, r: rnd() * 6, size: 0.1, phase, cast: false });
    }
    this.scatter(items, isle, rnd, [{ x: 0.4, z: 1.7, r: 1.9 }, { x: 1.7, z: -1.9, r: 2.4 }, { x: pond.x, z: pond.z, r: pond.r + 0.25 }, { x: 3.1, z: 3.3, r: 1.3 }], [['CommonTree_3', 3.2, 2, 'pink'], ['CommonTree_5', 2.7, 1], ['Pine_5', 3.1, 1], ['CommonTree_3', 2.4, 1, 'gold']], 1.5);
    this.cliffRocks(items, isle, rnd, 8);
    return { isle, items, lights, label: new THREE.Sprite(), terrain: this.terrain(shape, pos, phase) };
  }
}
