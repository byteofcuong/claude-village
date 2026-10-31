// Tung Tung Tung Sahur: a log with a club who has nothing to do with the data. He turns up on a random
// island, wanders, bangs out his three beats and calls for sahur, then slips away. The model has a
// rig but no clips, so his moves are worked out here, bone by bone.
import * as THREE from 'three';
import type { Assets } from './assets.js';
import { setOff, type Bridge, type Crossing } from './bridges.js';
import { freeSpot } from './cats.js';
import { freeWalk, type Point } from './paths.js';
import { bobOf, walkable, type Isle } from './village.js';
import { softDot, speechTexture } from './world.js';

const HEIGHT = 1.05;
const WALK_SPEED = 0.72;
const STRIDE = 8.5;
const POP_SECONDS = 0.5;
const BEAT = 0.6;
const BEATS = 3;
const SAHUR_SECONDS = 1.3;
const SPEECH_SIZE = 0.42;
const CROSS_CHANCE = 0.22;
const between = (a: number, b: number) => a + Math.random() * (b - a);

type Mode = 'walk' | 'idle' | 'bang';
const POSE = { hips: 0, spine: 0, legL: 0, legR: 0, kneeL: 0, kneeR: 0, armL: 0, armR: 0, armOut: 0, foreR: 0, lift: 0 };
type Pose = typeof POSE;
/** A bone that turns about a sideways axis of the whole body, whatever its own axes are. */
interface Joint { bone: THREE.Object3D; rest: THREE.Quaternion; axis: THREE.Vector3 }

const SIDEWAYS = new THREE.Vector3(1, 0, 0);
const turn = new THREE.Quaternion();

export class TungTung {
  private readonly root = new THREE.Group();
  private readonly blob: THREE.Mesh;
  private readonly joints: Record<Exclude<keyof Pose, 'lift' | 'armOut'>, Joint>;
  /** Swings the club arm away from the log, so a raised arm does not go through his face. */
  private readonly armOutAxis: THREE.Vector3;
  private readonly hipsRest: THREE.Vector3;
  private readonly pose: Pose = { ...POSE };
  private readonly scale: number;
  private isle: Isle | null = null;
  private pos: Point = { x: 0, z: 0 };
  private path: Point[] = [];
  private crossing: Crossing | null = null;
  private mode: Mode = 'idle';
  private facing = 0;
  private clock = 0;
  private modeLeft = 0;
  private stay = 0;
  private away = 3;
  private size = 0;
  private speech: THREE.Sprite | null = null;
  private speechLeft = 0;
  private said = 0;

  constructor(assets: Assets, scene: THREE.Scene) {
    const { scene: model, height } = assets.tung;
    model.updateMatrixWorld(true);
    const joint = (name: string): Joint => {
      // The file doubles every bone, once as a parent and once as an empty child.
      let bone: THREE.Object3D | null = null;
      model.traverse((o) => { if (!bone && o.children.length && (o.name === name || o.name === `${name}_1`)) bone = o; });
      if (!bone) throw new Error(`Bone ${name} is missing`);
      const found: THREE.Object3D = bone;
      const parent = found.parent!.getWorldQuaternion(new THREE.Quaternion()).invert();
      return { bone: found, rest: found.quaternion.clone(), axis: SIDEWAYS.clone().applyQuaternion(parent).normalize() };
    };
    this.joints = {
      hips: joint('mixamorig_Hips'), spine: joint('mixamorig_Spine1'),
      legL: joint('mixamorig_LeftUpLeg'), legR: joint('mixamorig_RightUpLeg'), kneeL: joint('mixamorig_LeftLeg'), kneeR: joint('mixamorig_RightLeg'),
      armL: joint('mixamorig_LeftArm'), armR: joint('mixamorig_RightArm'), foreR: joint('mixamorig_RightForeArm'),
    };
    this.armOutAxis = new THREE.Vector3(0, 0, 1).applyQuaternion(this.joints.armR.bone.parent!.getWorldQuaternion(new THREE.Quaternion()).invert()).normalize();
    this.hipsRest = this.joints.hips.bone.position.clone();
    model.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) o.frustumCulled = false; });
    this.scale = HEIGHT / height;
    this.root.add(model);
    this.root.visible = false;
    scene.add(this.root);
    this.blob = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: softDot('rgba(30,40,40,0.5)', 'rgba(30,40,40,0.24)'), transparent: true, depthWrite: false, fog: false }));
    this.blob.renderOrder = 1;
    this.blob.visible = false;
    scene.add(this.blob);
  }

  private say(text: string): void {
    this.hush();
    const { texture, aspect } = speechTexture(text);
    this.speech = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, fog: false }));
    this.speech.scale.set(SPEECH_SIZE * aspect, SPEECH_SIZE, 1);
    this.speech.renderOrder = 6;
    this.root.parent!.add(this.speech);
    this.speechLeft = 2.2;
  }

  private hush(): void {
    if (!this.speech) return;
    this.speech.removeFromParent();
    this.speech.material.map?.dispose();
    this.speech.material.dispose();
    this.speech = null;
  }

  private nextMode(people: readonly Point[], bridges: readonly Bridge[]): void {
    const isle = this.isle;
    if (!isle) return;
    this.clock = 0;
    this.said = 0;
    const away = Math.random() < CROSS_CHANCE ? setOff(isle, this.pos, bridges) : null;
    if (away) {
      this.path = away.path;
      this.crossing = away.crossing;
      this.mode = 'walk';
      return;
    }
    const roll = Math.random();
    const to = roll < 0.4 ? freeSpot(isle, people) : null;
    const walk = to && freeWalk(this.pos, to, isle.obstacles, (p) => walkable(isle, p));
    if (walk) {
      this.path = walk;
      this.mode = 'walk';
    } else if (roll < 0.8) {
      this.mode = 'bang';
      this.modeLeft = (BEAT * BEATS + SAHUR_SECONDS) * 2;
    } else {
      this.mode = 'idle';
      this.modeLeft = between(2, 5);
    }
  }

  /** Where every joint wants to be right now. */
  private target(): Pose {
    const pose = { ...POSE }, t = this.clock;
    if (this.mode === 'walk') {
      const s = Math.sin(t * STRIDE), c = Math.cos(t * STRIDE);
      Object.assign(pose, {
        legL: -s * 0.55, legR: s * 0.55, kneeL: Math.max(0, -c) * 0.8, kneeR: Math.max(0, c) * 0.8,
        armL: s * 0.4, armR: -s * 0.25 - 0.3, foreR: -0.3, spine: -0.05, lift: Math.abs(c) * 0.3,
      });
    } else if (this.mode === 'bang') {
      const round = BEAT * BEATS + SAHUR_SECONDS, r = t % round;
      if (r < BEAT * BEATS) {
        // Up slowly, down hard.
        const u = (r % BEAT) / BEAT, hit = u > 0.62;
        Object.assign(pose, { armR: hit ? -0.45 : -1.9, armOut: hit ? -0.4 : -0.7, foreR: hit ? -0.05 : -0.5, spine: hit ? -0.2 : 0.06, kneeL: hit ? 0.28 : 0, kneeR: hit ? 0.28 : 0, legL: hit ? -0.14 : 0, legR: hit ? -0.14 : 0, lift: hit ? -0.3 : 0 });
      } else {
        // Club held high for the call, with a small jump.
        const u = (r - BEAT * BEATS) / SAHUR_SECONDS;
        Object.assign(pose, { armR: -2.3, armOut: -1, foreR: -0.2, armL: -0.5, spine: 0.1, lift: Math.sin(u * Math.PI) * 1.6 });
      }
    } else {
      Object.assign(pose, { spine: Math.sin(t * 1.5) * 0.03, armR: -0.12 + Math.sin(t * 1.5) * 0.03 });
    }
    return pose;
  }

  private applyPose(dt: number): void {
    const want = this.target(), pose = this.pose, rate = Math.min(1, dt * (this.mode === 'bang' ? 22 : 11));
    for (const k of Object.keys(pose) as (keyof Pose)[]) pose[k] += (want[k] - pose[k]) * rate;
    for (const k of Object.keys(this.joints) as (keyof typeof this.joints)[]) {
      const j = this.joints[k];
      j.bone.quaternion.copy(turn.setFromAxisAngle(j.axis, pose[k])).multiply(j.rest);
    }
    // Out first, then up: the other way round an arm held forward would just spin on itself.
    const arm = this.joints.armR;
    arm.bone.quaternion.copy(arm.rest).premultiply(turn.setFromAxisAngle(this.armOutAxis, pose.armOut)).premultiply(turn.setFromAxisAngle(arm.axis, pose.armR));
    this.joints.hips.bone.position.set(this.hipsRest.x, this.hipsRest.y + pose.lift, this.hipsRest.z);
  }

  private bangLines(): void {
    const round = BEAT * BEATS + SAHUR_SECONDS, n = Math.floor(this.clock / round) * 2 + (this.clock % round >= BEAT * BEATS ? 1 : 0);
    if (n < this.said) return;
    this.say(n % 2 ? 'Sahur!' : 'Tung tung tung…');
    this.said = n + 1;
  }

  update(dt: number, t: number, isles: readonly Isle[], people: readonly Point[], bridges: readonly Bridge[]): void {
    if (!this.isle) {
      this.away -= dt;
      if (this.away > 0 || !isles.length) return;
      const isle = isles[Math.floor(Math.random() * isles.length)]!;
      const spot = freeSpot(isle, people);
      if (!spot) { this.away = 3; return; }
      this.isle = isle;
      this.pos = spot;
      this.path = [];
      this.modeLeft = 0;
      this.mode = 'idle';
      this.stay = between(60, 120);
      this.facing = Math.random() * Math.PI * 2;
      this.root.visible = this.blob.visible = true;
    }
    // His island, or the one he is heading for, can go when a project drops out of the village.
    if (!isles.includes(this.isle) || (this.crossing && !isles.includes(this.crossing.to))) { this.leave(); return; }
    this.stay -= dt;
    if (this.stay <= 0 && !this.path.length && !this.crossing) {
      this.size = Math.max(0, this.size - dt / POP_SECONDS);
      if (this.size === 0) { this.leave(); return; }
    } else this.size = Math.min(1, this.size + dt / POP_SECONDS);

    this.clock += dt;
    const goal = this.path[0];
    if (this.crossing && !goal) {
      this.crossing.walk(WALK_SPEED * dt);
      this.facing = this.crossing.facing;
      if (this.crossing.done) {
        this.isle = this.crossing.to;
        this.pos = { ...this.crossing.arrive };
        this.crossing = null;
        this.stay = Math.max(this.stay, between(40, 90));
      }
    } else if (this.mode === 'walk' && goal) {
      const dx = goal.x - this.pos.x, dz = goal.z - this.pos.z, d = Math.hypot(dx, dz), step = WALK_SPEED * dt;
      if (d <= step) {
        this.pos = { ...goal };
        this.path.shift();
      } else {
        this.pos.x += (dx / d) * step;
        this.pos.z += (dz / d) * step;
        this.facing = Math.atan2(dx, dz);
      }
    } else {
      this.modeLeft -= dt;
      if (this.mode === 'walk' || this.modeLeft <= 0) this.nextMode(people, bridges);
      else if (this.mode === 'bang') this.bangLines();
    }
    this.applyPose(dt);

    const isle = this.isle;
    const over = this.crossing && !this.path.length ? this.crossing.at(t) : null;
    const y = over?.y ?? isle.y + isle.shape.heightAt(this.pos.x, this.pos.z) + bobOf(t, isle.phase);
    const wx = over?.x ?? isle.x + this.pos.x, wz = over?.z ?? isle.z + this.pos.z;
    this.root.position.set(wx, y, wz);
    let spin = this.facing - this.root.rotation.y;
    while (spin > Math.PI) spin -= Math.PI * 2;
    while (spin < -Math.PI) spin += Math.PI * 2;
    this.root.rotation.y += spin * Math.min(1, dt * 6);
    this.root.scale.setScalar(this.scale * this.size);
    this.blob.position.set(wx, y + 0.02, wz);
    this.blob.scale.setScalar(this.size);
    if (this.speech) {
      this.speechLeft -= dt;
      if (this.speechLeft <= 0) this.hush();
      else this.speech.position.set(wx, y + HEIGHT + 0.3, wz);
    }
  }

  private leave(): void {
    this.isle = null;
    this.path = [];
    this.crossing = null;
    this.size = 0;
    this.away = between(8, 25);
    this.root.visible = this.blob.visible = false;
    this.hush();
  }

  /** Where he is and what he is doing, for the scripts. */
  state(): { x: number; y: number; z: number; mode: Mode; facing: number; overPlanks: boolean } | null {
    return this.isle ? { x: this.root.position.x, y: this.root.position.y, z: this.root.position.z, mode: this.mode, facing: this.facing, overPlanks: !this.path.length && !!this.crossing?.overPlanks } : null;
  }
}
