// How a villager gets around what stands on an island: every solid thing is a circle, and a walk
// is the shortest way through the free space between them.
export interface Point { x: number; z: number }
export interface Obstacle extends Point { r: number }

/** How much room a person takes up. */
export const BODY = 0.2;
const RING = 8;

/** A solid rectangle as a grid of circles; the gaps between them are narrower than a person. */
export function boxCircles(cx: number, cz: number, facing: number, width: number, depth: number): Obstacle[] {
  const r = 0.62, out: Obstacle[] = [];
  const count = (len: number) => Math.max(1, Math.ceil(len / (r * 1.6)));
  const nx = count(width), nz = count(depth);
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
    const dx = nx > 1 ? -width / 2 + r * 0.8 + (i / (nx - 1)) * (width - r * 1.6) : 0;
    const dz = nz > 1 ? -depth / 2 + r * 0.8 + (j / (nz - 1)) * (depth - r * 1.6) : 0;
    out.push({ x: cx + Math.sin(facing) * dz + Math.cos(facing) * dx, z: cz + Math.cos(facing) * dz - Math.sin(facing) * dx, r });
  }
  return out;
}

/** The nearest spot to p that a person can stand on. */
export function pushOut(p: Point, obstacles: readonly Obstacle[], margin = BODY + 0.03): Point {
  let { x, z } = p;
  for (let pass = 0; pass < 8; pass++) {
    let moved = false;
    for (const o of obstacles) {
      const need = o.r + margin;
      let dx = x - o.x, dz = z - o.z, d = Math.hypot(dx, dz);
      if (d >= need) continue;
      if (d < 1e-6) { dx = 1; dz = 0; d = 1; }
      x = o.x + (dx / d) * need;
      z = o.z + (dz / d) * need;
      moved = true;
    }
    if (!moved) break;
  }
  return { x, z };
}

export const isFree = (p: Point, obstacles: readonly Obstacle[], margin = BODY) => obstacles.every((o) => Math.hypot(p.x - o.x, p.z - o.z) >= o.r + margin - 1e-6);

function blocks(o: Obstacle, a: Point, b: Point): boolean {
  const reach = o.r + BODY;
  // Someone already inside must still be able to walk out.
  if (Math.hypot(a.x - o.x, a.z - o.z) < reach) return false;
  const vx = b.x - a.x, vz = b.z - a.z, len2 = vx * vx + vz * vz;
  const t = len2 ? Math.max(0, Math.min(1, ((o.x - a.x) * vx + (o.z - a.z) * vz) / len2)) : 0;
  return Math.hypot(a.x + vx * t - o.x, a.z + vz * t - o.z) < reach;
}

/** The waypoints of the shortest free walk, ending at `to`. Goes straight if nothing leads there. */
export function route(from: Point, to: Point, obstacles: readonly Obstacle[], allowed: (p: Point) => boolean = () => true): Point[] {
  const clear = (a: Point, b: Point) => !obstacles.some((o) => blocks(o, a, b));
  if (clear(from, to)) return [to];
  const nodes: Point[] = [from, to];
  for (const o of obstacles) {
    // Far enough out that the straight line between two neighbours still misses the circle.
    const r = (o.r + BODY + 0.02) / Math.cos(Math.PI / RING);
    for (let i = 0; i < RING; i++) {
      const p = { x: o.x + Math.cos((i / RING) * Math.PI * 2) * r, z: o.z + Math.sin((i / RING) * Math.PI * 2) * r };
      if (allowed(p) && obstacles.every((q) => Math.hypot(p.x - q.x, p.z - q.z) >= q.r + BODY)) nodes.push(p);
    }
  }
  const dist = nodes.map(() => Infinity), prev = nodes.map(() => -1), done = nodes.map(() => false);
  dist[0] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < nodes.length; i++) if (!done[i] && dist[i]! < Infinity && (u < 0 || dist[i]! < dist[u]!)) u = i;
    if (u < 0) return [to];
    if (u === 1) break;
    done[u] = true;
    const a = nodes[u]!;
    for (let i = 0; i < nodes.length; i++) {
      if (done[i]) continue;
      const b = nodes[i]!, next = dist[u]! + Math.hypot(a.x - b.x, a.z - b.z);
      if (next < dist[i]! && clear(a, b)) { dist[i] = next; prev[i] = u; }
    }
  }
  const path: Point[] = [];
  for (let i = 1; i > 0; i = prev[i]!) path.unshift(nodes[i]!);
  return path;
}
