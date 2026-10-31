// Two dragons, there only for the view: they circle the village, sometimes come down to rest on an
// island, and later take off again. While one is down, it counts as an obstacle for the people.
import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import type { Assets } from './assets.js';
import { isFree, type Obstacle, type Point } from './paths.js';
import { bobOf, walkable, type Isle } from './village.js';
import { softDot } from './world.js';

const COUNT = 2;
/** The model is in metres with a 12 m wingspan; this leaves about 4.5 units across the wings. */
const SCALE = 0.38;
const SPEED = 5.5;
const MAX_TURN = 0.75;
const BODY_ROOM = 1.05;
const CLEAR_OF_PEOPLE = 1.7;
const TAKEOFF_SECONDS = 2.4;
const ROAR_SECONDS = 2;
const RISE = 3.5;
const between = (a: number, b: number) => a + Math.random() * (b - a);
const smooth = (t: number) => t * t * (3 - 2 * t);

type Phase = 'flying' | 'landing' | 'resting' | 'roaring' | 'rising';

class Dragon {
  private readonly root = new THREE.Group();
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  private readonly blob: THREE.Mesh;
  phase: Phase = 'flying';
  private clock = 0;
  private flight: number;
  private rest = 0;
  private readonly pos = new THREE.Vector3();
  private heading = Math.random() * Math.PI * 2;
  private bank = 0;
  private pitch = 0;
  private wander = new THREE.Vector3();
  private isle: Isle | null = null;
  private seat: (Obstacle & { facing: number }) | null = null;
  private readonly curve = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] as const;
  private curveSeconds = 0;

  constructor(private readonly clips: Map<string, THREE.AnimationClip>, source: THREE.Object3D, material: THREE.Material, host: THREE.Group, blobMat: THREE.Material, blobGeo: THREE.BufferGeometry, firstFlight: number) {
    const model = SkeletonUtils.clone(source);
    model.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (!m.isSkinnedMesh) return;
      m.material = material;
      m.frustumCulled = false;
    });
    this.root.add(model);
    this.root.scale.setScalar(SCALE);
    this.root.rotation.order = 'YXZ';
    host.add(this.root);
    this.mixer = new THREE.AnimationMixer(model);
    this.blob = new THREE.Mesh(blobGeo, blobMat);
    this.blob.renderOrder = 1;
    this.blob.visible = false;
    host.add(this.blob);
    this.flight = firstFlight;
    this.pickWander();
    const a = Math.random() * Math.PI * 2, r = between(22, 34);
    this.pos.set(Math.cos(a) * r, between(8, 12), Math.sin(a) * r);
    this.play('fly_loop');
  }

  private play(name: string, once = false, reverse = false): void {
    const clip = this.clips.get(name);
    if (!clip) return;
    let action = this.actions.get(name);
    if (!action) {
      action = this.mixer.clipAction(clip);
      this.actions.set(name, action);
    }
    action.reset();
    action.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = once;
    action.timeScale = reverse ? -1 : 1;
    if (reverse) action.time = clip.duration;
    action.play();
    if (this.current && this.current !== action) this.current.crossFadeTo(action, 0.45, false);
    this.current = action;
  }

  private pickWander(): void {
    const a = Math.random() * Math.PI * 2, r = between(14, 36);
    this.wander.set(Math.cos(a) * r, between(7.5, 13), Math.sin(a) * r);
  }

  /** Open ground near the rim, big enough for the body. The tail hangs out over the edge. */
  private findSeat(isles: readonly Isle[], people: readonly Point[]): { isle: Isle; x: number; z: number; facing: number } | null {
    const homes = isles.filter((i) => i.id !== 'tent');
    for (let t = 0; t < 60; t++) {
      // The central island is the widest and the first thing in view, so it gets half the visits.
      const isle = Math.random() < 0.5 ? isles[0] : homes[Math.floor(Math.random() * homes.length)];
      if (!isle) return null;
      const a = Math.random() * Math.PI * 2, r = isle.shape.radiusAt(a) * between(0.58, 0.72);
      const p = { x: Math.cos(a) * r, z: Math.sin(a) * r };
      if (!walkable(isle, p) || !isFree(p, isle.obstacles, BODY_ROOM)) continue;
      if (people.some((q) => Math.hypot(q.x - (isle.x + p.x), q.z - (isle.z + p.z)) < CLEAR_OF_PEOPLE)) continue;
      return { isle, ...p, facing: Math.atan2(-p.x, -p.z) };
    }
    return null;
  }

  private startLanding(found: { isle: Isle; x: number; z: number; facing: number }, t: number): void {
    this.isle = found.isle;
    this.seat = { x: found.x, z: found.z, r: BODY_ROOM, facing: found.facing };
    found.isle.obstacles.push(this.seat);
    const [p0, p1, p2, p3] = this.curve;
    p0.copy(this.pos);
    p3.copy(this.seatWorld(t));
    const dir = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    const into = new THREE.Vector3(Math.sin(found.facing), 0, Math.cos(found.facing));
    const span = p0.distanceTo(p3);
    p1.copy(p0).addScaledVector(dir, span * 0.45);
    p2.copy(p3).addScaledVector(into, -Math.max(7, span * 0.3)).setY(p3.y + 5.5);
    this.curveSeconds = (span * 1.25) / SPEED + TAKEOFF_SECONDS;
    this.clock = 0;
    this.phase = 'landing';
  }

  private seatWorld(t: number): THREE.Vector3 {
    const { isle, seat } = this;
    if (!isle || !seat) return this.pos;
    return new THREE.Vector3(isle.x + seat.x, isle.y + isle.shape.heightAt(seat.x, seat.z) + bobOf(t, isle.phase), isle.z + seat.z);
  }

  private leaveSeat(): void {
    const { isle, seat } = this;
    if (isle && seat) {
      const i = isle.obstacles.indexOf(seat);
      if (i >= 0) isle.obstacles.splice(i, 1);
    }
    this.isle = null;
    this.seat = null;
    this.blob.visible = false;
  }

  update(dt: number, t: number, isles: readonly Isle[], people: readonly Point[]): void {
    this.clock += dt;
    if (this.isle && !isles.includes(this.isle) && this.phase !== 'rising') {
      // The island left the village under it.
      this.leaveSeat();
      this.phase = 'flying';
      this.flight = between(25, 60);
      this.play('fly_loop');
    }
    if (this.phase === 'flying') this.fly(dt, t, isles, people);
    else if (this.phase === 'landing') this.land(t);
    else if (this.phase === 'resting' || this.phase === 'roaring') this.sit(dt, t);
    else this.rise(t);
    this.mixer.update(dt);
    this.root.position.copy(this.pos);
    this.root.rotation.set(this.pitch, this.heading, this.bank);
  }

  private fly(dt: number, t: number, isles: readonly Isle[], people: readonly Point[]): void {
    this.flight -= dt;
    if (this.flight <= 0) {
      const found = this.findSeat(isles, people);
      if (found) { this.startLanding(found, t); return; }
      this.flight = 8;
    }
    if (this.pos.distanceTo(this.wander) < 7) this.pickWander();
    const want = Math.atan2(this.wander.x - this.pos.x, this.wander.z - this.pos.z);
    let turn = want - this.heading;
    while (turn > Math.PI) turn -= Math.PI * 2;
    while (turn < -Math.PI) turn += Math.PI * 2;
    const rate = THREE.MathUtils.clamp(turn, -MAX_TURN, MAX_TURN);
    this.heading += rate * dt;
    this.bank += (-rate * 0.75 - this.bank) * Math.min(1, dt * 2);
    const climb = THREE.MathUtils.clamp(this.wander.y - this.pos.y, -1.2, 1.2);
    this.pitch += (-climb * 0.1 - this.pitch) * Math.min(1, dt * 2);
    this.pos.x += Math.sin(this.heading) * SPEED * dt;
    this.pos.z += Math.cos(this.heading) * SPEED * dt;
    this.pos.y += climb * dt;
  }

  private land(t: number): void {
    const [p0, p1, p2] = this.curve;
    const p3 = this.seatWorld(t);
    const left = this.curveSeconds - this.clock;
    if (left <= TAKEOFF_SECONDS && this.current?.getClip().name === 'fly_loop') this.play('takeoff', true, true);
    const u = Math.min(1, this.clock / this.curveSeconds), s = 1 - (1 - u) ** 1.7, r = 1 - s;
    const next = new THREE.Vector3()
      .addScaledVector(p0, r * r * r).addScaledVector(p1, 3 * r * r * s)
      .addScaledVector(p2, 3 * r * s * s).addScaledVector(p3, s * s * s);
    const dx = next.x - this.pos.x, dz = next.z - this.pos.z;
    if (Math.hypot(dx, dz) > 0.01 && left > 1) this.heading = this.turnTowards(Math.atan2(dx, dz), 0.08);
    else if (this.seat) this.heading = this.turnTowards(this.seat.facing, 0.05);
    this.bank *= 0.96;
    this.pitch *= 0.95;
    this.pos.copy(next);
    if (u >= 1) {
      this.phase = 'resting';
      this.clock = 0;
      this.rest = between(25, 70);
      this.blob.visible = true;
      this.play('idle_loop');
    }
  }

  private turnTowards(want: number, amount: number): number {
    let turn = want - this.heading;
    while (turn > Math.PI) turn -= Math.PI * 2;
    while (turn < -Math.PI) turn += Math.PI * 2;
    return this.heading + turn * amount;
  }

  private sit(dt: number, t: number): void {
    this.pos.copy(this.seatWorld(t));
    this.blob.position.set(this.pos.x, this.pos.y + 0.03, this.pos.z);
    this.pitch = this.bank = 0;
    if (this.phase === 'roaring') {
      if (this.clock < ROAR_SECONDS) return;
      this.phase = 'rising';
      this.clock = 0;
      this.play('takeoff', true);
      return;
    }
    this.rest -= dt;
    if (this.rest > 0) return;
    this.phase = 'roaring';
    this.clock = 0;
    this.play('roar', true);
  }

  private rise(t: number): void {
    const base = this.seat ? this.seatWorld(t).y : this.pos.y - RISE;
    const u = Math.min(1, this.clock / TAKEOFF_SECONDS);
    this.pos.y = base + smooth(u) * RISE;
    if (u < 1) return;
    this.leaveSeat();
    this.phase = 'flying';
    this.flight = between(35, 90);
    this.pickWander();
    this.wander.y = Math.max(this.wander.y, this.pos.y + 3);
    this.play('fly_loop');
  }

  state(): { phase: Phase; x: number; y: number; z: number; clip: string | null } {
    return { phase: this.phase, x: this.pos.x, y: this.pos.y, z: this.pos.z, clip: this.current?.getClip().name ?? null };
  }
}

export class Dragons {
  private readonly list: Dragon[] = [];

  constructor(assets: Assets, scene: THREE.Scene) {
    const host = new THREE.Group();
    scene.add(host);
    const blobMat = new THREE.MeshBasicMaterial({ map: softDot('rgba(30,40,40,0.5)', 'rgba(30,40,40,0.22)'), transparent: true, depthWrite: false, fog: false });
    const blobGeo = new THREE.PlaneGeometry(2.6, 2.6).rotateX(-Math.PI / 2);
    const { scene: source, clips, variants } = assets.dragon;
    for (let i = 0; i < COUNT; i++) {
      this.list.push(new Dragon(clips, source, variants[i % variants.length]!, host, blobMat, blobGeo, between(8, 20) + i * 25));
    }
  }

  update(dt: number, t: number, isles: readonly Isle[], people: readonly Point[]): void {
    for (const d of this.list) d.update(dt, t, isles, people);
  }

  /** Where they are and what they do, for checks and screenshots. */
  states(): ReturnType<Dragon['state']>[] { return this.list.map((d) => d.state()); }
}
