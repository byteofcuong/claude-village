import { describe, expect, it } from 'vitest';
import { Crossing, setOff, type Bridge } from '../src/client/bridges.js';
import { sagOf } from '../src/client/paths.js';
import type { Isle } from '../src/client/village.js';

const isle = (x: number, y: number, obstacles: Isle['obstacles'] = []): Isle => ({
  id: `${x}`, x, y, z: 0, R: 3, phase: -1, obstacles, stations: {} as Isle['stations'], patrol: [], facing: 0, looks: {},
  shape: { heightAt: () => 0.5, radiusAt: () => 3 } as unknown as Isle['shape'],
});
const left = isle(0, 0), right = isle(10, 1);
const bridge: Bridge = { a: left, b: right, aEnd: { x: 2.58, z: 0 }, bEnd: { x: -2.58, z: 0 } };

describe('setOff', () => {
  it('leads from the island over the bridge, to a free spot on the far side', () => {
    const away = setOff(left, { x: 0, z: 0 }, [bridge])!;
    expect(away.crossing.to).toBe(right);
    expect(away.path.at(-1)).toEqual(away.crossing.start);
    expect(Math.hypot(away.crossing.arrive.x, away.crossing.arrive.z)).toBeLessThan(3 * 0.84);
  });

  it('works in both directions', () => {
    expect(setOff(right, { x: 0, z: 0 }, [bridge])!.crossing.to).toBe(left);
  });

  it('stays home when no bridge touches the island or the way onto it is blocked', () => {
    expect(setOff(isle(30, 0), { x: 0, z: 0 }, [bridge])).toBeNull();
    const walled = isle(0, 0, [{ x: 1.9, z: 0, r: 1.2 }]);
    expect(setOff(walled, { x: 0, z: 0 }, [{ ...bridge, a: walled }])).toBeNull();
  });
});

describe('Crossing', () => {
  const walkAll = () => {
    const c = new Crossing(left, right, { x: 2, z: 0 }, { x: 2.58, z: 0 }, { x: -2.58, z: 0 }, { x: -2, z: 0 });
    const seen: { x: number; y: number; z: number; over: boolean }[] = [];
    for (let i = 0; i < 2000 && !c.done; i++) {
      c.walk(0.01);
      seen.push({ ...c.at(0), over: c.overPlanks });
    }
    return { c, seen };
  };

  it('ends on the far island after a steady walk', () => {
    const { c, seen } = walkAll();
    expect(c.done).toBe(true);
    expect(seen.at(-1)!.x).toBeCloseTo(8);
    for (let i = 1; i < seen.length; i++) expect(Math.hypot(seen[i]!.x - seen[i - 1]!.x, seen[i]!.y - seen[i - 1]!.y)).toBeLessThan(0.02);
  });

  it('follows the sag of the rope bridge', () => {
    const { seen } = walkAll();
    const fromX = 2.58, toX = 7.42, y0 = 0.515, y1 = 1.515, span = Math.hypot(toX - fromX, y1 - y0);
    const mid = seen.reduce((a, b) => (Math.abs(b.x - 5) < Math.abs(a.x - 5) ? b : a));
    const t = (mid.x - fromX) / (toX - fromX);
    expect(mid.y).toBeCloseTo(y0 + (y1 - y0) * t - sagOf(t, span), 1);
  });

  it('is over the planks only between the two shores', () => {
    const { seen } = walkAll();
    expect(seen[0]!.over).toBe(false);
    expect(seen.at(-1)!.over).toBe(false);
    expect(seen.some((s) => s.over)).toBe(true);
    for (const s of seen) if (s.over) expect(s.x > 2.58 && s.x < 7.42).toBe(true);
  });
});
