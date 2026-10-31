// Loads the model packs once and keeps what the village needs.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export interface Part { geometry: THREE.BufferGeometry; material: THREE.Material; matrix: THREE.Matrix4 }
export interface Model { parts: Part[]; height: number; footprint: number; minY: number; sizeX: number; sizeZ: number }
export interface CharacterKind { name: string; scene: THREE.Object3D; height: number; variants: THREE.MeshStandardMaterial[] }
export interface Assets {
  nature: Map<string, Model>;
  village: Map<string, Model>;
  roofMaps: Record<string, THREE.Texture>;
  characters: CharacterKind[];
  clips: Map<string, THREE.AnimationClip>;
  props: Map<string, THREE.Object3D>;
  cat: { scene: THREE.Object3D; clips: Map<string, THREE.AnimationClip>; height: number; variants: THREE.Material[] };
  dragon: { scene: THREE.Object3D; clips: Map<string, THREE.AnimationClip>; variants: THREE.Material[] };
  leaf: { pink: Map<THREE.Texture, THREE.Texture>; gold: Map<THREE.Texture, THREE.Texture> };
}

const loader = new GLTFLoader();

function modelOf(root: THREE.Object3D): Model {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const toOrigin = new THREE.Matrix4().makeTranslation(-centre.x, -box.min.y, -centre.z);
  const parts: Part[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const material = Array.isArray(m.material) ? m.material[0] : m.material;
    if (material) parts.push({ geometry: m.geometry, material, matrix: toOrigin.clone().multiply(m.matrixWorld) });
  });
  return { parts, height: size.y, footprint: Math.max(size.x, size.z), minY: 0, sizeX: size.x, sizeZ: size.z };
}

function hsl(image: CanvasImageSource & { width: number; height: number }, fn: (h: { h: number; s: number; l: number }) => { h: number; s: number; l: number } | null, base: THREE.Texture, maxSize = 512): THREE.Texture {
  const c = document.createElement('canvas');
  const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
  c.width = Math.max(1, Math.round(image.width * scale));
  c.height = Math.max(1, Math.round(image.height * scale));
  const x = c.getContext('2d', { willReadFrequently: true });
  if (!x) throw new Error('2D canvas is unavailable');
  x.drawImage(image, 0, 0, c.width, c.height);
  const d = x.getImageData(0, 0, c.width, c.height);
  const color = new THREE.Color();
  const out = { h: 0, s: 0, l: 0 };
  for (let i = 0; i < d.data.length; i += 4) {
    if (d.data[i + 3] === 0) continue;
    color.setRGB(d.data[i]! / 255, d.data[i + 1]! / 255, d.data[i + 2]! / 255);
    color.getHSL(out);
    const next = fn(out);
    if (!next) continue;
    color.setHSL(next.h, next.s, next.l);
    d.data[i] = color.r * 255; d.data[i + 1] = color.g * 255; d.data[i + 2] = color.b * 255;
  }
  x.putImageData(d, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.flipY = base.flipY;
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = base.wrapS;
  t.wrapT = base.wrapT;
  return t;
}
const imageOf = (t: THREE.Texture) => t.image as CanvasImageSource & { width: number; height: number };

const NATURE = ['CommonTree_3', 'CommonTree_5', 'Pine_5', 'Fern_1', 'Clover_1', 'Clover_2', 'Flower_3_Single', 'Grass_Common_Short', 'Rock_Medium_1', 'Rock_Medium_2', 'Pebble_Square_4', 'Plant_1'];
const VILLAGE = ['building_1', 'building_3', 'shop', 'shrine', 'arch_2', 'brazier', 'lamp', 'well', 'pot_1', 'urn_1', 'barrel_1', 'cart', 'stand', 'forge', 'frame', 'wood_1', 'wood_2', 'fence_1', 'statue_monk', 'bell', 'drum'];

// Cloth moves to indigo, earth, teal and mustard; skin and leather keep their orange hues.
const CLOTH: [number, number][] = [[0.62, 0.55], [0.04, 0.55], [0.48, 0.45], [0.12, 0.65]];

export async function loadAssets(onProgress: (done: number, total: number) => void): Promise<Assets> {
  const total = NATURE.length + 1 + 6 + 4 + 4 + 1 + 1;
  let done = 0;
  const tick = <T>(p: Promise<T>) => p.then((v) => { onProgress(++done, total); return v; });

  const nature = new Map<string, Model>();
  await Promise.all(NATURE.map((n) => tick(loader.loadAsync(`nature/${n}.glb`)).then((g) => { nature.set(n, modelOf(g.scene)); })));

  const pack = await tick(loader.loadAsync('village/VillagePack.glb'));
  pack.scene.updateMatrixWorld(true);
  const village = new Map<string, Model>();
  let palette: THREE.Texture | null = null;
  for (const name of VILLAGE) {
    const node = pack.scene.getObjectByName(name);
    if (!node) continue;
    const holder = node.clone();
    holder.position.set(0, 0, 0);
    const model = modelOf(holder);
    for (const p of model.parts) palette ??= (p.material as THREE.MeshStandardMaterial).map;
    village.set(name, model);
  }
  if (!palette) throw new Error('Village palette is missing');
  const base = palette;
  const isRoof = (h: { h: number; s: number; l: number }) => h.s > 0.42 && h.l > 0.16 && (h.h < 0.04 || h.h > 0.93 || (h.h > 0.38 && h.h < 0.55));
  const timber = (h: { h: number; s: number; l: number }) => (h.s > 0.08 && h.s <= 0.55 && h.l < 0.34 && (h.h < 0.06 || h.h > 0.88) ? { h: 0.055, s: 0.42, l: h.l + 0.09 } : null);
  const roof = (hue: number, sat: number, lift: number) => hsl(imageOf(base), (h) => (isRoof(h) ? { h: hue, s: Math.min(1, h.s * sat), l: h.l + lift } : timber(h)), base, 1024);
  const roofMaps: Record<string, THREE.Texture> = {
    thatch: roof(0.115, 0.55, 0.17), terracotta: roof(0.05, 0.62, 0.1), moss: roof(0.38, 0.38, 0.06), slate: roof(0.58, 0.36, 0.09), clay: roof(0.09, 0.42, 0.04),
  };
  for (const t of Object.values(roofMaps)) t.magFilter = THREE.NearestFilter;

  const characters: CharacterKind[] = [];
  for (const name of ['Rogue', 'Rogue_Hooded', 'Ranger', 'Mage', 'Knight', 'Barbarian']) {
    const g = await tick(loader.loadAsync(`chars/${name}.glb`));
    g.scene.updateMatrixWorld(true);
    const meshes: THREE.SkinnedMesh[] = [];
    g.scene.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh); });
    const merged = mergeGeometries(meshes.map((m) => {
      const c = m.geometry.clone();
      for (const a of Object.keys(c.attributes)) if (!['position', 'normal', 'uv', 'skinIndex', 'skinWeight'].includes(a)) c.deleteAttribute(a);
      return c;
    }));
    const first = meshes[0];
    if (!merged || !first) throw new Error(`Character ${name} did not load`);
    const material = first.material as THREE.MeshStandardMaterial;
    const single = new THREE.SkinnedMesh(merged, material);
    first.parent?.add(single);
    single.bind(first.skeleton, first.bindMatrix);
    single.frustumCulled = false;
    single.name = 'body';
    for (const m of meshes) m.removeFromParent();
    const texture = material.map;
    const variants = texture ? CLOTH.map(([hue, sat]) => {
      const m = material.clone();
      m.map = hsl(imageOf(texture), (h) => (h.h > 0.17 && h.h < 0.88 && h.s > 0.12 ? { h: hue + (h.h - 0.4) * 0.05, s: Math.min(1, sat + h.s * 0.2), l: h.l } : null), texture);
      return m;
    }) : [material];
    characters.push({ name, scene: g.scene, height: new THREE.Box3().setFromObject(g.scene).max.y, variants: [material, ...variants] });
  }

  const clips = new Map<string, THREE.AnimationClip>();
  await Promise.all(['Tools', 'General', 'Simulation', 'MovementBasic'].map((f) => tick(loader.loadAsync(`anims/${f}.glb`)).then((g) => { for (const c of g.animations) clips.set(c.name, c); })));

  const props = new Map<string, THREE.Object3D>();
  await Promise.all(['axe_1handed', 'spellbook_open', 'mug_full', 'staff'].map((p) => tick(loader.loadAsync(`props/${p}.glb`)).then((g) => { props.set(p, g.scene); })));

  const catFile = await tick(loader.loadAsync('cats/cat.glb'));
  catFile.scene.updateMatrixWorld(true);
  let catMaterial: THREE.MeshStandardMaterial | null = null;
  catFile.scene.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) catMaterial = (o as THREE.SkinnedMesh).material as THREE.MeshStandardMaterial; });
  if (!catMaterial) throw new Error('Cat did not load');
  const catBase: THREE.MeshStandardMaterial = catMaterial;
  const catMap = catBase.map;
  // The fur is orange in the file; eyes, nose and whites keep their colours.
  const fur = (h: { h: number; s: number; l: number }) => h.h < 0.16 && h.s > 0.2;
  const coat = (next: (h: { h: number; s: number; l: number }) => { h: number; s: number; l: number }) => {
    const m = catBase.clone();
    if (catMap) m.map = hsl(imageOf(catMap), (h) => (fur(h) ? next(h) : null), catMap);
    return m;
  };
  const cat = {
    scene: catFile.scene,
    clips: new Map(catFile.animations.map((c) => [c.name, c] as const)),
    height: new THREE.Box3().setFromObject(catFile.scene).getSize(new THREE.Vector3()).y,
    variants: [
      catBase,
      coat((h) => ({ h: 0.09, s: 0.1, l: Math.min(0.97, h.l + 0.42) })),
      coat((h) => ({ h: 0.62, s: 0.14, l: h.l * 0.42 })),
      coat((h) => ({ h: 0.6, s: 0.1, l: h.l * 0.72 })),
    ],
  };

  const dragonFile = await tick(loader.loadAsync('dragons/dragon.glb'));
  dragonFile.scene.updateMatrixWorld(true);
  let dragonMaterial: THREE.MeshStandardMaterial | null = null;
  dragonFile.scene.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) dragonMaterial = (o as THREE.SkinnedMesh).material as THREE.MeshStandardMaterial; });
  if (!dragonMaterial) throw new Error('Dragon did not load');
  const ashen: THREE.MeshStandardMaterial = dragonMaterial;
  const crimson = ashen.clone();
  // The ash-grey hide and pale wings turn to dark crimson and ember; contrast stays as painted.
  if (ashen.map) crimson.map = hsl(imageOf(ashen.map), (h) => ({ h: 0.99 + h.l * 0.07, s: 0.62, l: h.l * 0.72 }), ashen.map, 1024);
  const dragon = { scene: dragonFile.scene, clips: new Map(dragonFile.animations.map((c) => [c.name, c] as const)), variants: [ashen, crimson] };

  // Blossom and apricot canopies come from the same leaves, recoloured.
  const leaf = { pink: new Map<THREE.Texture, THREE.Texture>(), gold: new Map<THREE.Texture, THREE.Texture>() };
  for (const model of nature.values()) for (const part of model.parts) {
    const map = (part.material as THREE.MeshStandardMaterial).map;
    if (!map || !(part.material as THREE.MeshStandardMaterial).alphaTest || leaf.pink.has(map) || !part.material.name.includes('Leaves')) continue;
    leaf.pink.set(map, hsl(imageOf(map), (h) => ({ h: 0.95, s: 0.78, l: Math.min(0.9, h.l + 0.56) }), map));
    leaf.gold.set(map, hsl(imageOf(map), (h) => ({ h: 0.135, s: 0.95, l: Math.min(0.78, h.l + 0.4) }), map));
  }
  return { nature, village, roofMaps, characters, clips, props, cat, dragon, leaf };
}
