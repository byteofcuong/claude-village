// People. A villager walks to the place that fits its work, then acts it out with a prop and a bubble.
import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import type { Activity, VillagerDTO, VillagerState } from '../shared/types.js';
import type { Assets } from './assets.js';
import { CHATS, lineFor, type LineKey } from './lines.js';
import { freeWalk, isFree, pushOut, route, BODY } from './paths.js';
import { bobOf, walkable, type Isle, type Point, type StationName } from './village.js';
import { bubbleTexture, hashString, softDot, speechTexture } from './world.js';

interface Act { key: LineKey; clips: string[]; prop?: string; bubble: string; station: StationName; sit?: boolean; patrol?: boolean; stay?: boolean; social?: boolean }

const ACTS: Record<Activity, Act> = {
  thinking: { key: 'thinking', clips: ['Sit_Floor_Idle', 'Idle_B'], bubble: '💭', station: 'view', sit: true },
  talking: { key: 'talking', clips: ['Waving', 'Interact', 'Cheering'], bubble: '💬', station: 'door', social: true },
  reading: { key: 'reading', clips: ['Holding_A', 'Holding_B'], prop: 'spellbook_open', bubble: '📖', station: 'read' },
  building: { key: 'building', clips: ['Hammering', 'Sawing', 'Working_B'], prop: 'axe_1handed', bubble: '🔨', station: 'work' },
  running: { key: 'running', clips: ['Working_A', 'Pickaxing', 'Chopping'], prop: 'axe_1handed', bubble: '⚙️', station: 'forge' },
  exploring: { key: 'exploring', clips: ['Walking_A', 'Walking_B'], prop: 'staff', bubble: '🧭', station: 'door', patrol: true },
  delegating: { key: 'delegating', clips: ['Waving', 'Interact', 'Cheering'], bubble: '📣', station: 'door', social: true },
  working: { key: 'working', clips: ['Use_Item', 'Working_C', 'Digging'], bubble: '🧰', station: 'work' },
  resting: { key: 'resting', clips: ['Idle_A', 'Sit_Floor_Idle', 'Waving', 'Sit_Ups', 'Push_Ups', 'Idle_B'], prop: 'mug_full', bubble: '🍵', station: 'rest', social: true },
};
const ASLEEP: Act = { key: 'asleep', clips: ['Lie_Idle'], bubble: '💤', station: 'rest' };
// A fright happens on the spot: nobody crosses the island to be startled.
const ERROR: Act = { key: 'error', clips: ['Hit_A', 'Hit_B'], bubble: '❗', station: 'door', stay: true };
const LONG: Act = { key: 'long', clips: ['Digging', 'Sawing', 'Pickaxing', 'Lockpicking'], bubble: '⏳', station: 'forge' };

function actFor(state: VillagerState, activity: Activity): Act {
  if (state === 'asleep') return ASLEEP;
  if (state === 'error') return ERROR;
  if (state === 'long-running') return LONG;
  return ACTS[activity];
}

const WALK_SPEED = 0.95;
const VILLAGER_H = 0.8;
const IDLE_SWAP_MS = 18_000;
// Claude switches tools faster than a person can cross an island, so a villager finishes a little
// of one job before starting the next instead of turning back halfway.
const HOLD_MS = 5_000;
const SPACING = 0.62;
const GIVE_UP_MS = 20_000;
/** Getting no further than this counts as walking on the spot. */
const MOVED = 0.15;
const STUCK_MS = 1_200;
const MAX_STUCK_TRIES = 3;
const SPEECH_MS = 3_600;
const SPEECH_RANGE = 32;
const MAX_SPEAKERS = 5;
const CHAT_REPLY_MS = 2_600;
const CHAT_EVERY_MS = 9_000;

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
  private path: Point[] = [];
  private repathAt = 0;
  private giveUpAt = 0;
  private movedFrom: Point = { x: 0, z: 0 };
  private movedAt = 0;
  private stuckTries = 0;
  private patrolIndex: number;
  private act: Act;
  private want: Act;
  private holdUntil = 0;
  private leader: Point | null = null;
  private clipIndex: number;
  private swapAt = 0;
  private walking = false;
  private pos: Point;
  private facing = 0;
  private unplayed = 0;
  private speech: THREE.Sprite | null = null;
  private speechUntil = 0;
  private lineAt: number;
  private queued: { text: string; at: number } | null = null;
  dto: VillagerDTO;
  isle: Isle;
  groundY = 0;

  constructor(private readonly assets: Assets, dto: VillagerDTO, isle: Isle, private readonly hash: number, private readonly host: THREE.Group, private readonly bubbleMat: (s: string) => THREE.SpriteMaterial, blobMat: THREE.Material, blobGeo: THREE.BufferGeometry, hatGeo: THREE.BufferGeometry, hatMat: THREE.Material, private readonly crowd: () => Iterable<Villager>) {
    this.dto = dto;
    this.isle = isle;
    this.patrolIndex = hash % 4;
    this.lineAt = performance.now() + 2_000 + (hash % 12_000);
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
    this.act = this.want = actFor(dto.state, dto.activity);
    this.bubble.material = bubbleMat(this.act.bubble);
    this.clipIndex = (hash >>> 11) % this.act.clips.length;
    this.pos = { ...this.spotFor(this.act) };
    this.target = { ...this.pos };
    this.placeOnGround();
    this.play(this.clipName());
    this.setProp(this.act.prop);
    this.swapAt = performance.now() + IDLE_SWAP_MS + (hash % 9000);
    this.turnToWork();
    this.root.rotation.y = this.facing;
  }

  /** The others on this island. */
  private *neighbours(): Generator<Villager> {
    for (const o of this.crowd()) if (o !== this && o.isle === this.isle) yield o;
  }

  /** Each villager takes a free place near where they are headed, so nobody stands in someone else. */
  private spotNear(base: Point): Point {
    const taken = [...this.neighbours()].map((o) => o.target);
    const first = (this.hash >>> 2) % 8;
    let best: Point | null = null, bestGap = -1;
    for (const [r, n] of [[0.32, 6], [0.66, 9], [1.0, 12], [1.35, 15]] as const) {
      for (let i = 0; i < n; i++) {
        const a = first * 0.785 + (i / n) * Math.PI * 2;
        const p = pushOut({ x: base.x + Math.cos(a) * r, z: base.z + Math.sin(a) * r }, this.isle.obstacles);
        if (!walkable(this.isle, p) || !isFree(p, this.isle.obstacles)) continue;
        const gap = taken.reduce((m, t) => Math.min(m, Math.hypot(t.x - p.x, t.z - p.z)), Infinity);
        if (gap >= SPACING) return p;
        if (gap > bestGap) { bestGap = gap; best = p; }
      }
    }
    return best ?? pushOut(base, this.isle.obstacles);
  }

  private spotFor(act: Act): Point {
    return this.spotNear(this.leader && act !== ASLEEP ? this.leader : this.isle.stations[act.station]);
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
    this.dto = dto;
    if (isle !== this.isle) {
      this.isle = isle;
      this.pos = { ...this.spotFor(this.act) };
      this.target = { ...this.pos };
      this.path = [];
    }
    this.want = actFor(dto.state, dto.activity);
  }

  private begin(next: Act, now: number): void {
    this.act = next;
    this.bubble.material = this.bubbleMat(next.bubble);
    this.clipIndex = (this.hash >>> 11) % next.clips.length;
    this.holdUntil = now + (next === ERROR ? HOLD_MS / 2 : HOLD_MS);
    this.swapAt = now + IDLE_SWAP_MS;
    this.lineAt = Math.min(this.lineAt, now + 400);
    if (next.stay) {
      // Caught mid-stride beside someone, take one step clear first.
      const crowded = [...this.neighbours()].some((o) => Math.hypot(o.target.x - this.pos.x, o.target.z - this.pos.z) < SPACING);
      this.target = crowded ? this.spotNear(this.pos) : { ...this.pos };
    } else this.target = this.spotFor(next);
    this.startWalk(now);
  }

  private startWalk(now: number): void {
    const away = Math.hypot(this.target.x - this.pos.x, this.target.z - this.pos.z);
    if (away > 0.12) {
      this.walking = true;
      this.path = route(this.pos, this.target, this.isle.obstacles, (p) => walkable(this.isle, p));
      this.repathAt = now + 4_000;
      this.giveUpAt = now + GIVE_UP_MS;
      this.movedFrom = { ...this.pos };
      this.movedAt = now;
      this.stuckTries = 0;
      this.setProp(undefined);
      this.play('Walking_A');
    } else this.arrive();
  }

  private arrive(): void {
    this.walking = false;
    this.path = [];
    this.play(this.clipName());
    this.setProp(this.act.prop);
    this.turnToWork();
  }

  /** Face the job: the forge or the bench, a person to talk to, or else the view. */
  private turnToWork(): void {
    const look = this.isle.looks[this.act.station];
    if (look) { this.lookAt(look); return; }
    this.facing = this.isle.facing;
    if (!this.act.social) return;
    let near: Villager | null = null, nearest = 1.8;
    for (const o of this.neighbours()) {
      const d = Math.hypot(o.pos.x - this.pos.x, o.pos.z - this.pos.z);
      if (d < nearest) { nearest = d; near = o; }
    }
    if (near) this.lookAt(near.pos);
  }

  lookAt(p: Point): void { this.facing = Math.atan2(p.x - this.pos.x, p.z - this.pos.z); }

  private endWalk(): void {
    if (this.act.patrol) {
      this.walking = false;
      this.play('Walking_A');
      this.setProp(this.act.prop);
    } else this.arrive();
  }

  /** Getting nowhere: find a way again, and failing that, get on with the job right here. */
  private unstick(now: number): void {
    this.movedAt = now;
    this.stuckTries++;
    // A dragon may have come down on the very spot.
    if (!isFree(this.target, this.isle.obstacles)) this.target = this.spotFor(this.act);
    const way = this.stuckTries < MAX_STUCK_TRIES ? freeWalk(this.pos, this.target, this.isle.obstacles, (p) => walkable(this.isle, p)) : null;
    if (way) {
      this.path = way;
      this.repathAt = now + 4_000;
      return;
    }
    this.target = { ...this.pos };
    this.path = [];
    this.endWalk();
  }

  /** One step along the path, stepping aside for anyone in the way. */
  private walkStep(dt: number, now: number): void {
    if (Math.hypot(this.pos.x - this.movedFrom.x, this.pos.z - this.movedFrom.z) > MOVED) {
      this.movedFrom = { ...this.pos };
      this.movedAt = now;
      this.stuckTries = 0;
    } else if (now - this.movedAt > STUCK_MS) {
      this.unstick(now);
      if (!this.walking) return;
    }
    // Boxed in by others: better to appear at the job than to shuffle in place forever.
    if (now > this.giveUpAt) {
      this.path = [{ ...this.target }];
      this.pos = { ...this.target };
    }
    if (now > this.repathAt) {
      this.path = freeWalk(this.pos, this.target, this.isle.obstacles, (p) => walkable(this.isle, p)) ?? this.path;
      this.repathAt = now + 4_000;
    }
    const goal = this.path[0] ?? this.target, step = WALK_SPEED * dt;
    const dx = goal.x - this.pos.x, dz = goal.z - this.pos.z, d = Math.hypot(dx, dz);
    if (d <= Math.max(step, 0.02)) {
      this.pos = { ...goal };
      this.placeOnGround();
      this.path.shift();
      if (this.path.length) return;
      this.endWalk();
      return;
    }
    const ux = dx / d, uz = dz / d;
    let sx = ux, sz = uz;
    // Two people stepping aside for each other can dance forever, so one who is stuck walks on.
    if (!this.stuckTries) for (const o of this.neighbours()) {
      const rx = o.pos.x - this.pos.x, rz = o.pos.z - this.pos.z, r = Math.hypot(rx, rz);
      if (r > 0.8 || r < 1e-3 || (rx * ux + rz * uz) / r < 0.1) continue;
      const side = -rx * uz + rz * ux >= 0 ? -1 : 1, push = ((0.8 - r) / 0.8) * 1.6;
      sx += -uz * side * push;
      sz += ux * side * push;
    }
    const len = Math.hypot(sx, sz), obstacles = this.isle.obstacles;
    let next = pushOut({ x: this.pos.x + (sx / len) * step, z: this.pos.z + (sz / len) * step }, obstacles, BODY);
    // Stepping aside into a gap too narrow for a person is no step at all: keep to the path instead.
    if (!isFree(next, obstacles)) { next = { x: this.pos.x + ux * step, z: this.pos.z + uz * step }; sx = ux; sz = uz; }
    if (isFree(next, obstacles) || !isFree(this.pos, obstacles)) this.pos = next;
    this.facing = Math.atan2(sx, sz);
    this.placeOnGround();
  }

  /** Whether a line is due, given that the village may only have a few people talking at once. */
  wantsToSpeak(now: number): boolean { return !this.speech && !this.walking && (now >= this.lineAt || (this.queued !== null && now >= this.queued.at)); }

  speak(now: number): void {
    const q = this.queued;
    if (q && now >= q.at) {
      this.queued = null;
      this.say(q.text, now);
      return;
    }
    this.say(lineFor(this.act.key, this.dto.currentLabel, Math.random()), now);
  }

  say(text: string, now: number): void {
    this.hush();
    const { texture, aspect } = speechTexture(text);
    this.speech = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, fog: false }));
    this.speech.scale.set(0.38 * aspect, 0.38, 1);
    this.speech.renderOrder = 6;
    this.host.add(this.speech);
    this.speechUntil = now + SPEECH_MS;
    // Sleepers mumble less than people at work.
    this.lineAt = now + (this.act === ASLEEP ? 40_000 : 14_000) + Math.random() * 16_000;
  }

  /** Starts a short exchange, if both are free to chat. */
  chatWith(other: Villager, now: number): void {
    const [ask, reply] = CHATS[Math.floor(Math.random() * CHATS.length)]!;
    this.lookAt(other.pos);
    other.lookAt(this.pos);
    this.say(ask, now);
    other.queued = { text: reply, at: now + CHAT_REPLY_MS };
    other.lineAt = Math.max(other.lineAt, now + CHAT_REPLY_MS + 8_000);
  }

  free(): boolean { return !this.walking && !this.speech && !this.queued && !!this.act.social; }
  speaking(): boolean { return this.speech !== null; }
  // A patroller only pauses for the frame between two legs of its walk.
  moving(): boolean { return this.walking || !!this.act.patrol; }
  /** How long this walker has been getting nowhere, for the walking check. */
  stuckFor(now: number): number {
    if (!this.walking) return 0;
    return now - this.movedAt;
  }
  isNear(o: Villager, within: number): boolean { return Math.hypot(o.pos.x - this.pos.x, o.pos.z - this.pos.z) < within; }
  delaySpeech(now: number): void { this.lineAt = Math.max(this.lineAt, now + 1_500); }

  private hush(): void {
    if (!this.speech) return;
    this.speech.removeFromParent();
    this.speech.material.map?.dispose();
    this.speech.material.dispose();
    this.speech = null;
  }

  private placeOnGround(): void {
    this.groundY = this.isle.y + this.isle.shape.heightAt(this.pos.x, this.pos.z);
  }

  update(dt: number, animate: boolean, t: number, now: number, follow: Point | null): void {
    this.leader = follow;
    if (this.want !== this.act && (now >= this.holdUntil || this.want === ASLEEP || this.want === ERROR)) this.begin(this.want, now);
    if (follow && !this.walking && !this.act.patrol && !this.act.stay && this.act !== ASLEEP) {
      const d = Math.hypot(follow.x - this.pos.x, follow.z - this.pos.z);
      if (d > 1.6) {
        this.target = this.spotNear(follow);
        this.startWalk(now);
      }
    }
    if (this.act.patrol && !this.walking && this.isle.patrol.length) {
      this.target = this.isle.patrol[this.patrolIndex++ % this.isle.patrol.length]!;
      this.startWalk(now);
    } else if (!this.walking && !this.act.patrol && this.act.clips.length > 1 && now > this.swapAt) {
      this.clipIndex++;
      this.swapAt = now + IDLE_SWAP_MS + (this.hash % 6000);
      this.play(this.clipName());
    }
    if (this.walking) this.walkStep(dt, now);
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
    this.bubble.visible = !this.walking && !this.speech;
    if (this.speech) {
      if (now > this.speechUntil) this.hush();
      else this.speech.position.set(wx, y + (lying ? 0.62 : sitting ? 0.88 : 1.16), wz);
    }
  }

  /** Where a click would hit. */
  centre(into: THREE.Vector3): THREE.Vector3 {
    return into.set(this.root.position.x, this.root.position.y + 0.4, this.root.position.z);
  }
  place(): Point { return this.pos; }
  clip(): string | null { return this.current?.getClip().name ?? null; }

  dispose(): void {
    this.hush();
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
  private chatAt = 0;
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
      else this.list.set(dto.id, new Villager(this.assets, dto, isle, hashString(dto.id), this.group, this.bubbleMat, this.blobMat, this.blobGeo, this.hatGeo, this.hatMat, () => this.list.values()));
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
    this.converse(now, camera);
    const sel = this.selected ? this.list.get(this.selected) : undefined;
    this.ring.visible = !!sel;
    if (sel) {
      sel.centre(this.tmp);
      this.ring.position.set(this.tmp.x, this.tmp.y - 0.37, this.tmp.z);
    }
  }

  /** Lets villagers within reading distance speak, a few at a time so the sky does not fill with text. */
  private converse(now: number, camera: THREE.Camera): void {
    const all = [...this.list.values()];
    const near = (v: Villager) => v.centre(this.tmp).distanceTo(camera.position) < SPEECH_RANGE;
    let speakers = all.filter((v) => v.speaking()).length;
    for (const v of all) {
      if (speakers >= MAX_SPEAKERS) break;
      if (!v.wantsToSpeak(now)) continue;
      if (!near(v)) { v.delaySpeech(now); continue; }
      v.speak(now);
      speakers++;
    }
    if (now < this.chatAt || speakers + 2 > MAX_SPEAKERS) return;
    this.chatAt = now + CHAT_EVERY_MS;
    const free = all.filter((v) => v.free() && near(v));
    for (const a of free) {
      const b = free.find((o) => o !== a && o.isle === a.isle && o.isNear(a, 2.4));
      if (b) { a.chatWith(b, now); return; }
    }
  }

  select(id: string | null): void { this.selected = id; }
  isleOf(id: string): Isle | null { return this.list.get(id)?.isle ?? null; }
  get(id: string): VillagerDTO | null { return this.list.get(id)?.dto ?? null; }
  worldOf(id: string): THREE.Vector3 | null {
    const v = this.list.get(id);
    return v ? v.centre(new THREE.Vector3()) : null;
  }
  /** What a villager is currently playing, for the end-to-end check. */
  clipOf(id: string): string | null { return this.list.get(id)?.clip() ?? null; }
  /** Where everyone stands, for the walking check. */
  feet(): { id: string; x: number; y: number; z: number; moving: boolean }[] {
    return [...this.list].map(([id, v]) => ({ id, x: v.root.position.x, y: v.groundY, z: v.root.position.z, moving: v.moving() }));
  }

  /** Walkers getting nowhere, for the walking check. */
  stuck(): { id: string; ms: number }[] {
    const now = performance.now();
    return [...this.list].flatMap(([id, v]) => { const ms = v.stuckFor(now); return ms > 1000 ? [{ id, ms }] : []; });
  }

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
