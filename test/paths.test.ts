import { describe, expect, it } from 'vitest';
import { BODY, boxCircles, freeWalk, isFree, pushOut, route, type Obstacle, type Point } from '../src/client/paths.js';

const gapTo = (o: Obstacle, a: Point, b: Point) => {
  const vx = b.x - a.x, vz = b.z - a.z, len2 = vx * vx + vz * vz;
  const t = len2 ? Math.max(0, Math.min(1, ((o.x - a.x) * vx + (o.z - a.z) * vz) / len2)) : 0;
  return Math.hypot(a.x + vx * t - o.x, a.z + vz * t - o.z) - o.r;
};
const walk = (from: Point, path: Point[]) => path.map((p, i) => [i ? path[i - 1]! : from, p] as const);

describe('boxCircles', () => {
  it('leaves no room to stand anywhere inside the rectangle', () => {
    for (const [width, depth] of [[3.4, 3.4], [4.6, 2.2], [1, 1]] as const) {
      const box = boxCircles(1.7, -1.9, 0.55, width, depth);
      for (let u = -0.5; u <= 0.5; u += 0.05) for (let v = -0.5; v <= 0.5; v += 0.05) {
        const dx = u * width, dz = v * depth;
        const p = { x: 1.7 + Math.sin(0.55) * dz + Math.cos(0.55) * dx, z: -1.9 + Math.cos(0.55) * dz - Math.sin(0.55) * dx };
        expect(isFree(p, box)).toBe(false);
      }
    }
  });
});

describe('route', () => {
  it('walks straight when nothing is in the way', () => {
    expect(route({ x: 0, z: 0 }, { x: 2, z: 0 }, [{ x: 0, z: 5, r: 1 }])).toEqual([{ x: 2, z: 0 }]);
  });

  it('goes around a rock instead of through it', () => {
    const rock = { x: 1, z: 0, r: 0.5 }, to = { x: 2, z: 0 };
    const path = route({ x: 0, z: 0 }, to, [rock]);
    expect(path.length).toBeGreaterThan(1);
    expect(path[path.length - 1]).toEqual(to);
    for (const [a, b] of walk({ x: 0, z: 0 }, path)) expect(gapTo(rock, a, b)).toBeGreaterThanOrEqual(BODY - 1e-9);
  });

  it('finds a way through a row of obstacles', () => {
    const row = [-2, -1, 0, 1, 2].map((z) => ({ x: 1, z, r: 0.45 }));
    const path = route({ x: 0, z: 0 }, { x: 2, z: 0 }, row);
    for (const o of row) for (const [a, b] of walk({ x: 0, z: 0 }, path)) expect(gapTo(o, a, b)).toBeGreaterThanOrEqual(BODY - 1e-9);
  });

  it('keeps detours on the island', () => {
    const allowed = (p: Point) => p.z > -0.1;
    const path = route({ x: 0, z: 0 }, { x: 2, z: 0 }, [{ x: 1, z: 0, r: 0.5 }], allowed);
    expect(path.every((p) => p.z > -0.1)).toBe(true);
  });

  it('still walks when no way exists, and lets someone inside walk out', () => {
    const to = { x: 3, z: 0 };
    expect(route({ x: 0, z: 0 }, to, [{ x: 1.5, z: 0, r: 1 }], () => false)).toEqual([to]);
    expect(route({ x: 1, z: 0 }, to, [{ x: 1, z: 0, r: 0.5 }])).toEqual([to]);
  });
});

describe('freeWalk', () => {
  it('admits when no way exists instead of walking through', () => {
    expect(freeWalk({ x: 0, z: 0 }, { x: 3, z: 0 }, [{ x: 1.5, z: 0, r: 1 }], () => false)).toBeNull();
  });

  it('agrees with route when a way exists', () => {
    const rock = [{ x: 1, z: 0, r: 0.5 }], from = { x: 0, z: 0 }, to = { x: 2, z: 0 };
    expect(freeWalk(from, to, rock)).toEqual(route(from, to, rock));
  });
});

describe('isFree', () => {
  it('tells a gap too narrow to stand in from open ground', () => {
    const narrow = [{ x: 0, z: 0, r: 0.5 }, { x: 1.1, z: 0, r: 0.5 }];
    expect(isFree({ x: 0.55, z: 0 }, narrow)).toBe(false);
    expect(isFree(pushOut({ x: 0.55, z: 2 }, narrow), narrow)).toBe(true);
  });
});

describe('pushOut', () => {
  it('leaves a free spot alone', () => {
    expect(pushOut({ x: 5, z: 5 }, [{ x: 0, z: 0, r: 1 }])).toEqual({ x: 5, z: 5 });
  });

  it('moves a spot out of everything it overlaps', () => {
    const near = [{ x: 0, z: 0, r: 0.6 }, { x: 0.8, z: 0, r: 0.6 }];
    const p = pushOut({ x: 0.4, z: 0 }, near);
    for (const o of near) expect(Math.hypot(p.x - o.x, p.z - o.z)).toBeGreaterThanOrEqual(o.r + BODY);
  });

  it('copes with a spot exactly on the centre', () => {
    const p = pushOut({ x: 1, z: 1 }, [{ x: 1, z: 1, r: 0.5 }]);
    expect(Math.hypot(p.x - 1, p.z - 1)).toBeGreaterThanOrEqual(0.5 + BODY);
  });
});
