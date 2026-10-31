// Crossing a rope bridge: a walk along the planks from one island to another, for those free to roam.
// Bridges hang still while islands bob, so the bob fades out on the way onto the planks and back in.
import { freeWalk, isFree, sagOf, type Obstacle, type Point } from './paths.js';
import { bobOf, walkable, type Isle } from './village.js';

export interface Bridge { a: Isle; b: Isle; aEnd: Point; bEnd: Point }

const SAG_STEPS = 16;
const SHORE_STEPS = 3;
/** How far in from its anchor, as a share of the way to the island's centre, a walker may step off. */
const LANDINGS = [0.92, 0.88, 0.84, 0.8, 0.75, 0.7, 0.65];
const PLANK_TOP = 0.015;
const PLANK_MARGIN = 0.3;

/** The nearest spot behind a bridge's anchor that has a clear way onto it. */
function landingFor(isle: Isle, end: Point): Point | null {
  for (const f of LANDINGS) {
    const p = { x: end.x * f, z: end.z * f };
    if (walkable(isle, p) && isFree(p, isle.obstacles) && clearStep(p, end, isle.obstacles)) return p;
  }
  return null;
}
const clearStep = (a: Point, b: Point, obstacles: readonly Obstacle[]) => freeWalk(a, b, obstacles)?.length === 1;

export class Crossing {
  private readonly points: { x: number; y: number; z: number }[] = [];
  /** Distance along the walk at each point. */
  private readonly along: number[] = [0];
  private readonly onto: number;
  private readonly offAt: number;
  private walked = 0;
  private seg = 0;

  constructor(readonly from: Isle, readonly to: Isle, readonly start: Point, fromEnd: Point, toEnd: Point, readonly arrive: Point) {
    const shore = (isle: Isle, a: Point, b: Point) => {
      for (let i = 0; i <= SHORE_STEPS; i++) {
        const x = a.x + ((b.x - a.x) * i) / SHORE_STEPS, z = a.z + ((b.z - a.z) * i) / SHORE_STEPS;
        this.points.push({ x: isle.x + x, y: isle.y + isle.shape.heightAt(x, z) + PLANK_TOP, z: isle.z + z });
      }
    };
    shore(from, start, fromEnd);
    const onCount = this.points.length;
    const A = this.points[onCount - 1]!;
    const B = { x: to.x + toEnd.x, y: to.y + to.shape.heightAt(toEnd.x, toEnd.z) + PLANK_TOP, z: to.z + toEnd.z };
    const span = Math.hypot(B.x - A.x, B.y - A.y, B.z - A.z);
    for (let i = 1; i < SAG_STEPS; i++) {
      const t = i / SAG_STEPS;
      this.points.push({ x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t - sagOf(t, span), z: A.z + (B.z - A.z) * t });
    }
    const offCount = this.points.length;
    shore(to, toEnd, arrive);
    for (let i = 1; i < this.points.length; i++) {
      const p = this.points[i - 1]!, q = this.points[i]!;
      this.along.push(this.along[i - 1]! + Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z));
    }
    this.onto = this.along[onCount - 1]!;
    this.offAt = this.along[offCount]!;
  }

  private get total(): number { return this.along[this.along.length - 1]!; }
  get done(): boolean { return this.walked >= this.total; }
  /** Whether the walker is out over the planks, clear of both shores. */
  get overPlanks(): boolean { return this.walked > this.onto + PLANK_MARGIN && this.walked < this.offAt - PLANK_MARGIN; }

  walk(step: number): void {
    this.walked = Math.min(this.total, this.walked + step);
    while (this.seg < this.along.length - 2 && this.along[this.seg + 1]! <= this.walked) this.seg++;
  }

  get facing(): number {
    const p = this.points[this.seg]!, q = this.points[this.seg + 1]!;
    return Math.atan2(q.x - p.x, q.z - p.z);
  }

  /** The walker's place in the world at time t. */
  at(t: number): { x: number; y: number; z: number } {
    const p = this.points[this.seg]!, q = this.points[this.seg + 1]!;
    const u = (this.walked - this.along[this.seg]!) / (this.along[this.seg + 1]! - this.along[this.seg]! || 1);
    const onShore = Math.max(0, 1 - this.walked / (this.onto || 1)), offShore = Math.max(0, (this.walked - this.offAt) / (this.total - this.offAt || 1));
    return {
      x: p.x + (q.x - p.x) * u,
      y: p.y + (q.y - p.y) * u + bobOf(t, this.from.phase) * onShore + bobOf(t, this.to.phase) * offShore,
      z: p.z + (q.z - p.z) * u,
    };
  }
}

/** A way off this island over a random bridge: the walk to the bridge, then the crossing. Null if there is none. */
export function setOff(isle: Isle, pos: Point, bridges: readonly Bridge[]): { path: Point[]; crossing: Crossing } | null {
  const near = bridges.filter((b) => b.a === isle || b.b === isle);
  if (!near.length) return null;
  const bridge = near[Math.floor(Math.random() * near.length)]!;
  const out = bridge.a === isle;
  const to = out ? bridge.b : bridge.a, fromEnd = out ? bridge.aEnd : bridge.bEnd, toEnd = out ? bridge.bEnd : bridge.aEnd;
  const start = landingFor(isle, fromEnd), arrive = landingFor(to, toEnd);
  if (!start || !arrive) return null;
  const path = freeWalk(pos, start, isle.obstacles, (p) => walkable(isle, p));
  return path && { path, crossing: new Crossing(isle, to, start, fromEnd, toEnd, arrive) };
}
