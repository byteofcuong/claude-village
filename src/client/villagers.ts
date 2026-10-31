// People. A villager walks to the place that fits its work, then acts it out with a prop and a bubble.
import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import type { Activity, VillagerDTO, VillagerState } from '../shared/types.js';
import type { Assets } from './assets.js';
import { bobOf, type Isle, type Point, type StationName } from './village.js';
import { bubbleTexture, hashString, softDot } from './world.js';

interface Act { clips: string[]; prop?: string; bubble: string; station: StationName; sit?: boolean; patrol?: boolean }

const ACTS: Record<Activity, Act> = {
  thinking: { clips: ['Sit_Floor_Idle', 'Idle_B'], bubble: '💭', station: 'view', sit: true },
  talking: { clips: ['Waving', 'Interact', 'Cheering'], bubble: '💬', station: 'door' },
  reading: { clips: ['Holding_A', 'Holding_B'], prop: 'spellbook_open', bubble: '📖', station: 'read' },
  building: { clips: ['Hammering', 'Sawing', 'Working_B'], prop: 'axe_1handed', bubble: '🔨', station: 'work' },
  running: { clips: ['Working_A', 'Pickaxing', 'Chopping'], prop: 'axe_1handed', bubble: '⚙️', station: 'forge' },
  exploring: { clips: ['Walking_A', 'Walking_B'], prop: 'staff', bubble: '🧭', station: 'door', patrol: true },
  delegating: { clips: ['Waving', 'Throw', 'Cheering'], bubble: '📣', station: 'door' },
  working: { clips: ['Use_Item', 'Working_C', 'Digging'], bubble: '🧰', station: 'work' },
  resting: { clips: ['Idle_A', 'Sit_Floor_Idle', 'Waving', 'Sit_Ups', 'Push_Ups', 'Idle_B'], prop: 'mug_full', bubble: '🍵', station: 'rest' },
};
const ASLEEP: Act = { clips: ['Lie_Idle'], bubble: '💤', station: 'rest' };
const ERROR: Act = { clips: ['Hit_A', 'Hit_B'], bubble: '❗', station: 'door' };
const LONG: Act = { clips: ['Digging', 'Sawing', 'Pickaxing', 'Lockpicking'], bubble: '⏳', station: 'forge' };

function actFor(state: VillagerState, activity: Activity): Act {
  if (state === 'asleep') return ASLEEP;
  if (state === 'error') return ERROR;
  if (state === 'long-running') return LONG;
  return ACTS[activity];
}

const WALK_SPEED = 0.95;
const VILLAGER_H = 0.8;
const IDLE_SWAP_MS = 18_000;

class Villager {
  readonly root = new THREE.Group();
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  private readonly model: THREE.Object3D;
  private readonly hand: THREE.Object3D | null;
  private propObj: THREE.Object3D | null = null;
  private propName = '';
  readonly bubble: THREE.Sprite;
  readonly blob: THREE.Mesh;
  private target: Point;
  private patrolIndex = 0;
  private act: Act;
  private clipIndex: number;
  private swapAt = 0;
  private walking = false;
  private pos: Point;
  private facing = 0;
  private unplayed = 0;
  dto: VillagerDTO;
  isle: Isle;
  groundY = 0;

  constructor(private readonly assets: Assets, dto: VillagerDTO, isle: Isle, private readonly hash: number, host: THREE.Group, private readonly bubbleMat: (s: string) => THREE.SpriteMaterial, blobMat: THREE.Material, blobGeo: THREE.BufferGeometry, hatGeo: THREE.BufferGeometry, hatMat: THREE.Material) {
    this.dto = dto;
    this.isle = isle;
    const kind = assets.characters[hash % assets.characters.length]!;
    this.model = SkeletonUtils.clone(kind.scene);
    const material = kind.variants[(hash >>> 3) % kind.variants.length]!;
    this.model.traverse((o) => { if (o.name === 'body') (o as THREE.SkinnedMesh).material = material; });
    const scale = (dto.kind === 'helper' ? 0.8 : 1) * (0.95 + ((hash >>> 6) % 11) * 0.01);
    this.model.scale.setScalar((VILLAGER_H / kind.height) * scale);
    this.root.add(this.model);
    host.add(this.root);
    this.mixer = new THREE.AnimationMixer(this.model);
    let hand: THREE.Object3D | null = null;
    let head: THREE.Object3D | null = null;
    this.model.traverse((o) => {
      if (o.name === 'handslotr') hand = o;
      if (o.name === 'head') head = o;
    });
    this.hand = hand;
    if (head && (hash >>> 8) % 4 !== 0) {
      const hat = new THREE.Mesh(hatGeo, hatMat);
      hat.position.set(0, 1.12, 0);
      (head as THREE.Object3D).add(hat);
    }
    this.bubble = new THREE.Sprite(bubbleMat('💤'));
    this.bubble.scale.setScalar(0.42);
    this.bubble.renderOrder = 4;
    host.add(this.bubble);
    this.blob = new THREE.Mesh(blobGeo, blobMat);
    this.blob.renderOrder = 1;
    host.add(this.blob);
    this.act = actFor(dto.state, dto.activity);
    this.clipIndex = (hash >>> 11) % this.act.clips.length;
    this.pos = { ...this.spotFor(this.act) };
    this.target = { ...this.pos };
    this.placeOnGround();
    this.play(this.clipName());
    this.setProp(this.act.prop);
    this.swapAt = performance.now() + IDLE_SWAP_MS + (hash % 9000);
  }

  /** Each villager has its own place around a station, so a crowd does not stack up. */
  private spotFor(act: Act): Point {
    const base = this.isle.stations[act.station];
    const a = ((this.hash >>> 2) % 8) * 0.785 + (this.hash % 7) * 0.2, r = 0.22 + ((this.hash >>> 5) % 4) * 0.13;
    const x = base.x + Math.cos(a) * r, z = base.z + Math.sin(a) * r;
    const ang = Math.atan2(z, x), lim = this.isle.shape.radiusAt(ang) * 0.82, len = Math.hypot(x, z);
    return len > lim ? { x: (x / len) * lim, z: (z / len) * lim } : { x, z };
  }

  private clipName(): string {
    const clips = this.act.clips.filter((c) => this.assets.clips.has(c));
    return clips[this.clipIndex % Math.max(1, clips.length)] ?? 'Idle_A';
  }

  private play(name: string): void {
    const clip = this.assets.clips.get(name) ?? this.assets.clips.get('Idle_A');
    if (!clip) return;
    let action = this.actions.get(clip.name);
    if (!action) {
      action = this.mixer.clipAction(clip);
      this.actions.set(clip.name, action);
    }
    if (action === this.current) return;
    action.reset();
    action.time = (this.hash % 100) / 100 * Math.min(1.5, clip.duration);
    action.play();
    if (this.current) this.current.crossFadeTo(action, 0.35, false);
    this.current = action;
  }

  private setProp(name?: string): void {
    if ((name ?? '') === this.propName || !this.hand) return;
    this.propName = name ?? '';
    if (this.propObj) { this.propObj.removeFromParent(); this.propObj = null; }
    if (!name) return;
    const source = this.assets.props.get(name);
    if (source) { this.propObj = source.clone(); this.hand.add(this.propObj); }
  }

  sync(dto: VillagerDTO, isle: Isle): void {
    const prev = this.act;
    this.dto = dto;
    if (isle !== this.isle) {
      this.isle = isle;
      this.pos = { ...this.spotFor(this.act) };
    }
    const next = actFor(dto.state, dto.activity);
    if (next !== prev) {
      this.act = next;
      this.clipIndex = (this.hash >>> 11) % next.clips.length;
      this.target = this.spotFor(next);
      this.startWalk();
      this.swapAt = performance.now() + IDLE_SWAP_MS;
    }
    this.bubble.material = this.bubbleMat(next.bubble);
  }

  private startWalk(): void {
    const away = Math.hypot(this.target.x - this.pos.x, this.target.z - this.pos.z);
    if (away > 0.12 && this.act !== ASLEEP) {
      this.walking = true;
      this.setProp(undefined);
      this.play('Walking_A');
    } else {
      if (this.act === ASLEEP) this.pos = { ...this.target };
      this.arrive();
    }
  }

  private arrive(): void {
    this.walking = false;
    this.play(this.clipName());
    this.setProp(this.act.prop);
    if (this.act.station === 'view' || this.act.station === 'rest') this.facing = this.isle.facing;
    else this.facing = Math.atan2(this.isle.stations.door.x - this.pos.x, this.isle.stations.door.z - this.pos.z);
  }

  private placeOnGround(): void {
    this.groundY = this.isle.y + this.isle.shape.heightAt(this.pos.x, this.pos.z);
  }

  update(dt: number, animate: boolean, t: number, now: number, follow: Point | null): void {
    if (follow && !this.walking) {
      const d = Math.hypot(follow.x - this.pos.x, follow.z - this.pos.z);
      if (d > 1.6) {
        this.target = { x: follow.x + Math.cos(this.hash) * 0.55, z: follow.z + Math.sin(this.hash) * 0.55 };
        this.startWalk();
      }
    }
    if (this.act.patrol && !this.walking && this.isle.patrol.length) {
      this.target = this.isle.patrol[this.patrolIndex++ % this.isle.patrol.length]!;
      this.startWalk();
    } else if (!this.walking && !this.act.patrol && this.act.clips.length > 1 && now > this.swapAt) {
      this.clipIndex++;
      this.swapAt = now + IDLE_SWAP_MS + (this.hash % 6000);
      this.play(this.clipName());
    }
    if (this.walking) {
      const dx = this.target.x - this.pos.x, dz = this.target.z - this.pos.z, d = Math.hypot(dx, dz), step = WALK_SPEED * dt;
      if (d <= step) {
        this.pos = { ...this.target };
        this.placeOnGround();
        if (this.act.patrol) {
          this.walking = false;
          this.play('Walking_A');
          this.setProp(this.act.prop);
        } else this.arrive();
      } else {
        this.pos.x += (dx / d) * step;
        this.pos.z += (dz / d) * step;
        this.facing = Math.atan2(dx, dz);
        this.placeOnGround();
      }
    }
    // Skipped frames are added up, so a villager animated less often still moves at the right speed.
    this.unplayed += dt;
    if (animate) {
      this.mixer.update(this.unplayed);
      this.unplayed = 0;
    }
    const bob = bobOf(t, this.isle.phase);
    const y = this.groundY + bob;
    const lying = this.act === ASLEEP;
    const wx = this.isle.x + this.pos.x, wz = this.isle.z + this.pos.z;
    this.root.position.set(wx, y, wz);
    let turn = this.facing - this.root.rotation.y;
    while (turn > Math.PI) turn -= Math.PI * 2;
    while (turn < -Math.PI) turn += Math.PI * 2;
    this.root.rotation.y += turn * Math.min(1, dt * 7);
    this.blob.position.set(wx, y + 0.02, wz);
    const sitting = this.act.sit && !this.walking;
    this.bubble.position.set(wx, y + (lying ? 0.55 : sitting ? 0.82 : 1.12) + Math.sin(t * 1.6 + this.hash) * 0.02, wz);
    this.bubble.visible = !this.walking;
  }

  /** Where a click would hit. */
  centre(into: THREE.Vector3): THREE.Vector3 {
    return into.set(this.root.position.x, this.root.position.y + 0.4, this.root.position.z);
  }
  place(): Point { return this.pos; }
  clip(): string | null { return this.current?.getClip().name ?? null; }

  dispose(): void {
    this.mixer.stopAllAction();
    this.root.removeFromParent();
    this.bubble.removeFromParent();
    this.blob.removeFromParent();
  }
}

export class People {
  private readonly list = new Map<string, Villager>();
  private readonly group = new THREE.Group();
  private readonly bubbleCache = new Map<string, THREE.SpriteMaterial>();
  private readonly blobMat = new THREE.MeshBasicMaterial({ map: softDot('rgba(30,40,40,0.55)', 'rgba(30,40,40,0.28)'), transparent: true, depthWrite: false, fog: false });
  private readonly blobGeo = new THREE.PlaneGeometry(0.72, 0.72).rotateX(-Math.PI / 2);
  private readonly hatGeo = (() => { const g = new THREE.ConeGeometry(0.78, 0.42, 10).toNonIndexed(); g.computeVertexNormals(); return g; })();
  private readonly hatMat = new THREE.MeshStandardMaterial({ color: 0xead6a0, flatShading: true, roughness: 0.85 });
  private readonly ring: THREE.Mesh;
  private selected: string | null = null;
  private frame = 0;
  private readonly tmp = new THREE.Vector3();
  private readonly closest = new THREE.Vector3();

  constructor(private readonly assets: Assets, scene: THREE.Scene) {
    scene.add(this.group);
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.27, 0.34, 28).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffe28a, transparent: true, opacity: 0.95, depthWrite: false, fog: false }));
    this.ring.visible = false;
    this.ring.renderOrder = 2;
    scene.add(this.ring);
  }

  private bubbleMat = (symbol: string): THREE.SpriteMaterial => {
    let m = this.bubbleCache.get(symbol);
    if (!m) {
      m = new THREE.SpriteMaterial({ map: bubbleTexture(symbol), transparent: true, depthWrite: false, fog: false });
      this.bubbleCache.set(symbol, m);
    }
    return m;
  };

  sync(entries: { dto: VillagerDTO; isle: Isle }[]): void {
    const seen = new Set<string>();
    for (const { dto, isle } of entries) {
      seen.add(dto.id);
      const v = this.list.get(dto.id);
      if (v) v.sync(dto, isle);
      else this.list.set(dto.id, new Villager(this.assets, dto, isle, hashString(dto.id), this.group, this.bubbleMat, this.blobMat, this.blobGeo, this.hatGeo, this.hatMat));
    }
    for (const [id, v] of this.list) {
      if (seen.has(id)) continue;
      v.dispose();
      this.list.delete(id);
    }
  }

  update(dt: number, t: number, camera: THREE.Camera): void {
    this.frame++;
    const now = performance.now();
    let i = 0;
    for (const v of this.list.values()) {
      i++;
      // Far villagers animate less often; on a small screen nobody can tell.
      const far = v.centre(this.tmp).distanceTo(camera.position) > 34;
      const every = far ? 3 : 2;
      const parent = v.dto.parentId ? this.list.get(v.dto.parentId) : undefined;
      v.update(dt, (i + this.frame) % every === 0, t, now, parent ? parent.place() : null);
    }
    const sel = this.selected ? this.list.get(this.selected) : undefined;
    this.ring.visible = !!sel;
    if (sel) {
      sel.centre(this.tmp);
      this.ring.position.set(this.tmp.x, this.tmp.y - 0.37, this.tmp.z);
    }
  }

  select(id: string | null): void { this.selected = id; }
  get(id: string): VillagerDTO | null { return this.list.get(id)?.dto ?? null; }
  worldOf(id: string): THREE.Vector3 | null {
    const v = this.list.get(id);
    return v ? v.centre(new THREE.Vector3()) : null;
  }
  /** What a villager is currently playing, for the end-to-end check. */
  clipOf(id: string): string | null { return this.list.get(id)?.clip() ?? null; }

  /** Finds the villager nearest a ray, with a generous radius so small figures stay clickable. */
  pick(ray: THREE.Ray): string | null {
    let best: string | null = null, bestDist = Infinity;
    for (const [id, v] of this.list) {
      v.centre(this.tmp);
      const miss = ray.distanceSqToPoint(this.tmp);
      if (miss > 0.5 * 0.5) continue;
      ray.closestPointToPoint(this.tmp, this.closest);
      const along = this.closest.distanceTo(ray.origin);
      if (along < bestDist) { bestDist = along; best = id; }
    }
    return best;
  }
}
