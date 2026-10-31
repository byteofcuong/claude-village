// A few cats that have nothing to do with the data: they turn up on a random island, wander, nap,
// and later slip away to turn up somewhere else.
import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import type { Assets } from './assets.js';
import { isFree, route, type Point } from './paths.js';
import { bobOf, walkable, type Isle } from './village.js';
import { softDot } from './world.js';

const COUNT = 4;
const CAT_H = 0.36;
const WALK_SPEED = 0.5;
const POP_SECONDS = 0.6;
const CLEAR_OF_PEOPLE = 0.8;
const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]!;
const between = (a: number, b: number) => a + Math.random() * (b - a);

class Cat {
  private readonly root = new THREE.Group();
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  private readonly blob: THREE.Mesh;
  private isle: Isle | null = null;
  private pos: Point = { x: 0, z: 0 };
  private path: Point[] = [];
  private facing = 0;
  /** Seconds left of the present pose, of this visit, and of the time away. */
  private pose = 0;
  private stay = 0;
  private away: number;
  private size = 0;
  private readonly scale: number;

  constructor(private readonly clips: Map<string, THREE.AnimationClip>, source: THREE.Object3D, height: number, material: THREE.Material, host: THREE.Group, blobMat: THREE.Material, blobGeo: THREE.BufferGeometry, firstVisit: number) {
    const model = SkeletonUtils.clone(source);
    model.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (!m.isSkinnedMesh) return;
      m.material = material;
      m.frustumCulled = false;
    });
    this.scale = CAT_H / height;
    this.root.add(model);
    this.root.visible = false;
    host.add(this.root);
    this.mixer = new THREE.AnimationMixer(model);
    this.blob = new THREE.Mesh(blobGeo, blobMat);
    this.blob.renderOrder = 1;
    this.blob.visible = false;
    host.add(this.blob);
    this.away = firstVisit;
  }

  private play(name: string): void {
    const clip = this.clips.get(name);
    if (!clip) return;
    let action = this.actions.get(name);
    if (!action) {
      action = this.mixer.clipAction(clip);
      this.actions.set(name, action);
    }
    if (action === this.current) return;
    action.reset().play();
    if (this.current) this.current.crossFadeTo(action, 0.3, false);
    this.current = action;
  }

  /** A free patch of ground on the island, out of everyone's way. */
  private freeSpot(isle: Isle, people: readonly Point[]): Point | null {
    for (let t = 0; t < 30; t++) {
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * isle.R;
      const p = { x: Math.cos(a) * r, z: Math.sin(a) * r };
      if (!walkable(isle, p) || !isFree(p, isle.obstacles)) continue;
      if (people.every((q) => Math.hypot(q.x - (isle.x + p.x), q.z - (isle.z + p.z)) > CLEAR_OF_PEOPLE)) return p;
    }
    return null;
  }

  private nextPose(people: readonly Point[]): void {
    const isle = this.isle;
    if (!isle) return;
    const to = Math.random() < 0.45 ? this.freeSpot(isle, people) : null;
    if (to) {
      this.path = route(this.pos, to, isle.obstacles, (p) => walkable(isle, p));
      this.play('walk');
      return;
    }
    const pose = pick(['idle', 'idle_alt', 'sit', 'sit', 'sleep', 'eat']);
    this.play(pose);
    this.pose = pose === 'sleep' ? between(18, 40) : between(5, 14);
  }

  update(dt: number, t: number, isles: readonly Isle[], people: readonly Point[]): void {
    if (!this.isle) {
      this.away -= dt;
      if (this.away > 0) return;
      const isle = pick(isles);
      const spot = this.freeSpot(isle, people);
      if (!spot) { this.away = 3; return; }
      this.isle = isle;
      this.pos = spot;
      this.path = [];
      this.pose = 0;
      this.stay = between(70, 170);
      this.facing = Math.random() * Math.PI * 2;
      this.root.visible = this.blob.visible = true;
    }
    const isle = this.isle;
    // Its island can go when a project drops out of the village.
    if (!isles.includes(isle)) { this.leave(); return; }
    this.stay -= dt;
    if (this.stay <= 0 && !this.path.length) {
      this.size = Math.max(0, this.size - dt / POP_SECONDS);
      if (this.size === 0) { this.leave(); return; }
    } else this.size = Math.min(1, this.size + dt / POP_SECONDS);

    const goal = this.path[0];
    if (goal) {
      const dx = goal.x - this.pos.x, dz = goal.z - this.pos.z, d = Math.hypot(dx, dz), step = WALK_SPEED * dt;
      if (d <= step) {
        this.pos = { ...goal };
        this.path.shift();
      } else {
        this.pos.x += (dx / d) * step;
        this.pos.z += (dz / d) * step;
        this.facing = Math.atan2(dx, dz);
      }
      if (!this.path.length) this.pose = 0;
    } else {
      this.pose -= dt;
      if (this.pose <= 0) this.nextPose(people);
    }
    this.mixer.update(dt);
    const y = isle.y + isle.shape.heightAt(this.pos.x, this.pos.z) + bobOf(t, isle.phase);
    const wx = isle.x + this.pos.x, wz = isle.z + this.pos.z;
    this.root.position.set(wx, y, wz);
    let turn = this.facing - this.root.rotation.y;
    while (turn > Math.PI) turn -= Math.PI * 2;
    while (turn < -Math.PI) turn += Math.PI * 2;
    this.root.rotation.y += turn * Math.min(1, dt * 6);
    this.root.scale.setScalar(this.scale * this.size);
    this.blob.position.set(wx, y + 0.02, wz);
    this.blob.scale.setScalar(this.size);
  }

  private leave(): void {
    this.isle = null;
    this.path = [];
    this.size = 0;
    this.away = between(12, 45);
    this.root.visible = this.blob.visible = false;
  }

  foot(): { x: number; y: number; z: number } | null {
    return this.isle ? { x: this.root.position.x, y: this.root.position.y, z: this.root.position.z } : null;
  }
}

export class Cats {
  private readonly list: Cat[] = [];

  constructor(assets: Assets, scene: THREE.Scene) {
    const host = new THREE.Group();
    scene.add(host);
    const blobMat = new THREE.MeshBasicMaterial({ map: softDot('rgba(30,40,40,0.5)', 'rgba(30,40,40,0.24)'), transparent: true, depthWrite: false, fog: false });
    const blobGeo = new THREE.PlaneGeometry(0.42, 0.42).rotateX(-Math.PI / 2);
    const { scene: source, clips, height, variants } = assets.cat;
    for (let i = 0; i < COUNT; i++) {
      this.list.push(new Cat(clips, source, height, variants[i % variants.length]!, host, blobMat, blobGeo, 1 + i * between(4, 14)));
    }
  }

  update(dt: number, t: number, isles: readonly Isle[], people: readonly Point[]): void {
    for (const cat of this.list) cat.update(dt, t, isles, people);
  }

  /** Where the cats are, for the walking check. */
  feet(): { x: number; y: number; z: number }[] {
    return this.list.flatMap((c) => c.foot() ?? []);
  }
}
