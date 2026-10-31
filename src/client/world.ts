// Geometry and textures made by code: terrain, bridges, soft sprites.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { sagOf } from './paths.js';

export const col = (c: string) => new THREE.Color(c);
export const mix = (a: THREE.Color, b: THREE.Color, t: number) => a.clone().lerp(b, Math.min(1, Math.max(0, t)));
export const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

const fract = (x: number) => x - Math.floor(x);
const hash = (x: number, y: number) => fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453);
export function noise(x: number, y: number): number {
  const i = Math.floor(x), j = Math.floor(y), u = x - i, v = y - j;
  const a = hash(i, j), b = hash(i + 1, j), c = hash(i, j + 1), d = hash(i + 1, j + 1);
  const su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
  return a + (b - a) * su + (c - a) * sv + (a - b - c + d) * su * sv;
}
export function fbm(x: number, y: number, octaves = 4): number {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < octaves; i++) { s += a * noise(x * f, y * f); a *= 0.5; f *= 2.03; }
  return s;
}
export function makeRng(seed: number): () => number {
  let s = Math.abs(Math.floor(seed * 9301 + 49297)) % 233280 || 7;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}
export function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function solid(g: THREE.BufferGeometry, color: string): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  const c = col(color);
  const n = out.attributes['position']!.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
  out.setAttribute('color', new THREE.BufferAttribute(a, 3));
  out.deleteAttribute('uv');
  if (!out.attributes['normal']) out.computeVertexNormals();
  return out;
}
export function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const clean = parts.map((p) => {
    for (const k of Object.keys(p.attributes)) if (!['position', 'normal', 'color'].includes(k)) p.deleteAttribute(k);
    return p.index ? p.toNonIndexed() : p;
  });
  const merged = mergeGeometries(clean);
  if (!merged) throw new Error('Geometry parts do not match');
  return merged;
}
const flat = (g: THREE.BufferGeometry) => { const n = g.index ? g.toNonIndexed() : g; n.computeVertexNormals(); return n; };
export function box(w: number, h: number, d: number, x: number, y: number, z: number, color: string, ry = 0): THREE.BufferGeometry {
  const g = flat(new THREE.BoxGeometry(w, h, d));
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return solid(g, color);
}
export function post(r1: number, r2: number, h: number, x: number, y: number, z: number, color: string, seg = 6): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r2, h, seg, 1, true);
  g.translate(x, y + h / 2, z);
  return solid(g, color);
}
export function rope(points: [number, number, number][], r: number, color: string): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
  return solid(new THREE.TubeGeometry(curve, Math.max(4, points.length * 2), r, 3, false), color);
}

export interface Flat { x: number; z: number; r: number; earth?: boolean }
export interface Pond { x: number; z: number; r: number }
export interface IslandShape {
  geo: THREE.BufferGeometry;
  heightAt(x: number, z: number): number;
  radiusAt(angle: number): number;
}

export function makeIsland(opts: { R: number; seed: number; rings?: number; segs?: number; depth?: number; level?: number; flats?: Flat[]; pond?: Pond | null }): IslandShape {
  const { R, seed, rings = 11, segs = 36, depth = R * 1.05, level = 0.04, flats = [], pond = null } = opts;
  const radiusAt = (a: number) => R * (0.82 + 0.36 * fbm(Math.cos(a) * 1.25 + seed, Math.sin(a) * 1.25 + seed * 0.7, 3));
  const heightAt = (x: number, z: number) => {
    const a = Math.atan2(z, x), rr = Math.hypot(x, z) / radiusAt(a);
    let h = (fbm(x * 0.33 + seed, z * 0.33 - seed, 3) - 0.46) * 0.95 * (1 - smooth(0.62, 1, rr));
    for (const f of flats) {
      const k = 1 - smooth(f.r * 0.72, f.r, Math.hypot(x - f.x, z - f.z));
      h += (level - h) * k;
    }
    if (pond) h -= (1 - smooth(pond.r * 0.7, pond.r * 1.15, Math.hypot(x - pond.x, z - pond.z))) * 0.32;
    h -= Math.pow(Math.max(0, rr - 0.84) / 0.16, 2) * 0.32;
    return h;
  };
  const lush = col('#62a83a'), bright = col('#8fc943'), gold = col('#b8d657'), edge = col('#7db53e'), sand = col('#d8bf86'), deep = col('#4a9440');
  const colorTop = (x: number, z: number) => {
    const a = Math.atan2(z, x), rr = Math.hypot(x, z) / radiusAt(a), n = fbm(x * 0.8 + seed, z * 0.8, 4), m = fbm(x * 2.4 - seed, z * 2.4, 3);
    let c = n < 0.45 ? mix(deep, lush, (n - 0.2) / 0.25) : n < 0.6 ? mix(lush, bright, (n - 0.45) / 0.15) : mix(bright, gold, (n - 0.6) / 0.2);
    c = mix(c, c.clone().multiplyScalar(0.85), m);
    for (const f of flats) {
      const k = 1 - smooth(f.r * 0.45, f.r * 0.95, Math.hypot(x - f.x, z - f.z) + (m - 0.5) * 0.7);
      c = mix(c, f.earth ? sand : mix(sand, c, 0.45), k * (f.earth ? 0.95 : 0.8));
    }
    if (pond) c = mix(c, sand, 1 - smooth(pond.r * 0.9, pond.r * 1.25, Math.hypot(x - pond.x, z - pond.z)));
    return mix(c, edge, smooth(0.86, 0.99, rr));
  };
  const pos: number[] = [], colors: number[] = [], idx: number[] = [];
  const push = (x: number, y: number, z: number, c: THREE.Color) => { pos.push(x, y, z); colors.push(c.r, c.g, c.b); return pos.length / 3 - 1; };
  const center = push(0, heightAt(0, 0), 0, colorTop(0, 0));
  const ringId: number[][] = [];
  for (let i = 1; i <= rings; i++) {
    const row: number[] = [], rt = Math.pow(i / rings, 0.8);
    for (let j = 0; j < segs; j++) {
      const a = (j / segs) * Math.PI * 2, r = radiusAt(a) * rt, x = Math.cos(a) * r, z = Math.sin(a) * r;
      row.push(push(x, heightAt(x, z), z, colorTop(x, z)));
    }
    ringId.push(row);
  }
  const rock = ['#9a7a55', '#8d7a68', '#8c8680', '#85858c', '#7b7f92'].map(col);
  const K = 8;
  for (let k = 1; k <= K; k++) {
    const row: number[] = [], t = k / K;
    for (let j = 0; j < segs; j++) {
      const a = (j / segs) * Math.PI * 2, base = radiusAt(a);
      const shape = Math.pow(1 - t, 1.25) + 0.05;
      const jag = 0.74 + 0.6 * fbm(Math.cos(a) * 2.6 + seed + t * 3, Math.sin(a) * 2.6 + t * 3.4, 3);
      const r = base * shape * (t < 0.1 ? 1 : jag), x = Math.cos(a) * r, z = Math.sin(a) * r;
      const y = -0.34 - depth * Math.pow(t, 1.1) * (0.82 + 0.34 * noise(Math.cos(a) * 3 + seed, Math.sin(a) * 3));
      const strata = Math.sin(y * 7 + fbm(x, z, 2) * 5) * 0.5 + 0.5;
      const f = t * (rock.length - 1), lo = Math.floor(f), c0 = mix(rock[lo]!, rock[Math.min(lo + 1, rock.length - 1)]!, f - lo);
      let c = mix(c0, c0.clone().multiplyScalar(0.8), strata * 0.65);
      if (t < 0.16) c = mix(col('#6da33d'), c, smooth(0.02, 0.16, t + (noise(a * 7, seed) - 0.5) * 0.12));
      row.push(push(x, y, z, c));
    }
    ringId.push(row);
  }
  const tip = push(0, -depth * 1.14, 0, rock[4]!);
  for (let j = 0; j < segs; j++) idx.push(center, ringId[0]![(j + 1) % segs]!, ringId[0]![j]!);
  for (let i = 0; i < ringId.length - 1; i++) for (let j = 0; j < segs; j++) {
    const a = ringId[i]![j]!, b = ringId[i]![(j + 1) % segs]!, c = ringId[i + 1]![j]!, d = ringId[i + 1]![(j + 1) % segs]!;
    idx.push(a, b, c, b, d, c);
  }
  const last = ringId[ringId.length - 1]!;
  for (let j = 0; j < segs; j++) idx.push(last[j]!, last[(j + 1) % segs]!, tip);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return { geo: g, heightAt, radiusAt };
}

/** A hanging rope bridge between two world points. */
export function ropeBridge(a: [number, number, number], b: [number, number, number]): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [], A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), dir = B.clone().sub(A), len = dir.length();
  const side = new THREE.Vector3(-dir.z, 0, dir.x).normalize().multiplyScalar(0.21);
  const yaw = Math.atan2(dir.x, dir.z);
  const at = (t: number) => { const p = A.clone().lerp(B, t); p.y -= sagOf(t, len); return p; };
  const n = Math.round(len / 0.24);
  for (let i = 1; i < n; i++) {
    const p = at(i / n), shade = i % 3 === 0 ? '#8a6242' : i % 3 === 1 ? '#a57a52' : '#976d48';
    parts.push(box(0.46, 0.022, 0.16, p.x, p.y, p.z, shade, yaw + (i % 2 ? 0.03 : -0.03)));
  }
  for (const sgn of [-1, 1]) {
    const lift = (t: number) => at(t).add(side.clone().multiplyScalar(sgn));
    const low: [number, number, number][] = [], high: [number, number, number][] = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6, p = lift(t);
      low.push([p.x, p.y + 0.01, p.z]);
      high.push([p.x, p.y + 0.34 - Math.sin(t * Math.PI) * 0.03, p.z]);
    }
    parts.push(rope(low, 0.011, '#cdb48a'), rope(high, 0.013, '#cdb48a'));
    for (const t of [0, 1]) { const p = lift(t); parts.push(post(0.04, 0.05, 0.62, p.x, p.y - 0.14, p.z, '#5d3d2c', 6)); }
  }
  return merge(parts);
}

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const x = c.getContext('2d');
  if (!x) throw new Error('2D canvas is unavailable');
  return [c, x];
}

export function cloudTexture(seed = 5): THREE.Texture {
  const [c, x] = canvas(256);
  const rnd = makeRng(seed);
  for (let i = 0; i < 46; i++) {
    const a = rnd() * 6.28, m = Math.pow(rnd(), 0.8) * 74, px = 128 + Math.cos(a) * m * 1.15, py = 132 + Math.sin(a) * m * 0.72, r = 26 + rnd() * 34;
    const g = x.createRadialGradient(px, py, 0, px, py, r);
    g.addColorStop(0, 'rgba(255,255,255,0.3)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.14)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, 256, 256);
  }
  return new THREE.CanvasTexture(c);
}

export function softDot(inner: string, midColor: string): THREE.Texture {
  const [c, x] = canvas(64);
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, inner);
  g.addColorStop(0.35, midColor);
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/** Bubble with an emoji, for what a villager is doing. */
export function bubbleTexture(symbol: string): THREE.Texture {
  const [c, x] = canvas(96);
  x.fillStyle = 'rgba(255,253,245,0.94)';
  x.beginPath();
  x.arc(48, 42, 34, 0, Math.PI * 2);
  x.fill();
  x.beginPath();
  x.moveTo(38, 72); x.lineTo(58, 72); x.lineTo(48, 90);
  x.fill();
  x.font = '38px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillStyle = '#28323c';
  x.fillText(symbol, 48, 44);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function speechTexture(text: string): { texture: THREE.Texture; aspect: number } {
  const c = document.createElement('canvas');
  const x = c.getContext('2d');
  if (!x) throw new Error('2D canvas is unavailable');
  const font = '600 30px "Segoe UI",system-ui,sans-serif';
  x.font = font;
  const w = Math.ceil(x.measureText(text).width) + 40, body = 56;
  c.width = w;
  c.height = body + 14;
  x.font = font;
  x.fillStyle = 'rgba(255,253,245,0.96)';
  x.beginPath();
  x.roundRect(0, 0, w, body, 22);
  x.fill();
  x.beginPath();
  x.moveTo(w / 2 - 10, body - 1); x.lineTo(w / 2 + 10, body - 1); x.lineTo(w / 2, body + 13);
  x.fill();
  x.fillStyle = '#28323c';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillText(text, w / 2, body / 2 + 1);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return { texture: t, aspect: w / (body + 14) };
}

export function labelTexture(text: string): { texture: THREE.Texture; aspect: number } {
  const c = document.createElement('canvas');
  const x = c.getContext('2d');
  if (!x) throw new Error('2D canvas is unavailable');
  const font = '600 32px "Segoe UI",system-ui,sans-serif';
  x.font = font;
  const shown = text.length > 26 ? `${text.slice(0, 25)}…` : text;
  const w = Math.ceil(x.measureText(shown).width) + 44;
  c.width = w;
  c.height = 60;
  x.font = font;
  x.fillStyle = 'rgba(24,30,44,0.62)';
  x.beginPath();
  x.roundRect(0, 0, w, 60, 30);
  x.fill();
  x.fillStyle = '#fff6e4';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillText(shown, w / 2, 31);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return { texture: t, aspect: w / 60 };
}
