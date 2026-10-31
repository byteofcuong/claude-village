// Builds assets/generated from the source packs in assets-src. Neither folder is committed:
// see assets/LICENSES.md for where to get each pack.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, simplify, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

const root = resolve(import.meta.dirname, '..');
const src = join(root, 'assets-src');
const out = join(root, 'assets', 'generated');
const adv = join(src, 'KayKit_Adventurers_2.0_FREE', 'KayKit_Adventurers_2.0_FREE');
const anim = join(src, 'KayKit_Character_Animations_1.1', 'KayKit_Character_Animations_1.1', 'Animations', 'gltf', 'Rig_Medium');
const nature = join(src, 'Quaternius_Nature', 'glTF');
const village = join(src, 'WizP_Village', 'VillagePack.glb');
const cat = join(src, 'Vuena_Pets', 'GLB', 'animal_cat.glb');
const dragon = join(src, 'Ashwing_Drake_Lite', 'Ashwing_Drake_Lite', 'Ashwing_Drake_Lite.glb');
const tung = join(src, 'TungTung', 'zip');
for (const need of [adv, anim, nature, village, cat, dragon, tung]) {
  if (!existsSync(need)) {
    console.error(`Missing source pack: ${need}\nSee assets/LICENSES.md.`);
    process.exit(2);
  }
}

rmSync(out, { recursive: true, force: true });
for (const d of ['chars', 'anims', 'props', 'nature', 'village', 'cats', 'dragons', 'tung']) mkdirSync(join(out, d), { recursive: true });

await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const tris = (doc) => doc.getRoot().listMeshes().reduce((s, m) => s + m.listPrimitives().reduce((a, p) => a + (p.getIndices() ?? p.getAttribute('POSITION')).getCount() / 3, 0), 0);
const report = {};
// FBXLoader asks the browser to fetch textures; here the texture is read from disk instead.
globalThis.document ??= { createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, style: {} }) };
const readArrayBuffer = (file) => { const b = readFileSync(file); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

/** A skinned FBX scene as a glTF document. Every mesh shares one texture. */
function fbxToDoc(fbx, png) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene();
  const material = doc.createMaterial('Mat').setRoughnessFactor(1).setMetallicFactor(0)
    .setBaseColorTexture(doc.createTexture('tex').setMimeType('image/png').setImage(png));
  const accessor = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const nodes = new Map();
  const copy = (o) => {
    const node = doc.createNode(o.name).setTranslation(o.position.toArray()).setRotation(o.quaternion.toArray()).setScale(o.scale.toArray());
    nodes.set(o, node);
    for (const c of o.children) if (!c.isMesh) node.addChild(copy(c));
    return node;
  };
  scene.addChild(copy(fbx));
  fbx.updateMatrixWorld(true);
  fbx.traverse((m) => {
    if (!m.isSkinnedMesh) return;
    const { position, normal, uv, skinIndex, skinWeight } = m.geometry.attributes;
    const weights = Float32Array.from(skinWeight.array);
    for (let i = 0; i < weights.length; i += 4) {
      const sum = weights[i] + weights[i + 1] + weights[i + 2] + weights[i + 3];
      for (let k = 0; k < 4; k++) weights[i + k] /= sum || 1;
    }
    // FBX counts texture rows from the bottom, glTF from the top.
    const uvs = Float32Array.from(uv.array);
    for (let i = 1; i < uvs.length; i += 2) uvs[i] = 1 - uvs[i];
    const prim = doc.createPrimitive().setMaterial(material)
      .setAttribute('POSITION', accessor('VEC3', Float32Array.from(position.array)))
      .setAttribute('NORMAL', accessor('VEC3', Float32Array.from(normal.array)))
      .setAttribute('TEXCOORD_0', accessor('VEC2', uvs))
      .setAttribute('JOINTS_0', accessor('VEC4', Uint16Array.from(skinIndex.array)))
      .setAttribute('WEIGHTS_0', accessor('VEC4', weights));
    // three skins by bone * boneInverse * bindMatrix, glTF by joint * inverseBind.
    const binds = new Float32Array(m.skeleton.bones.length * 16);
    m.skeleton.boneInverses.forEach((inverse, i) => inverse.clone().multiply(m.bindMatrix).toArray(binds, i * 16));
    const skin = doc.createSkin(m.name).setInverseBindMatrices(accessor('MAT4', binds));
    for (const b of m.skeleton.bones) skin.addJoint(nodes.get(b));
    scene.addChild(doc.createNode(m.name).setMesh(doc.createMesh(m.name).addPrimitive(prim)).setSkin(skin));
  });
  return doc;
}

// Characters: no capes or headgear, so a nón lá fits; at most 2.9k triangles.
const CHAR_TARGET = 2900;
for (const name of ['Rogue', 'Rogue_Hooded', 'Ranger', 'Mage', 'Knight', 'Barbarian']) {
  const doc = await io.read(join(adv, 'Characters', 'gltf', `${name}.glb`));
  for (const node of doc.getRoot().listNodes()) {
    if (/Cape|_Hat|Helmet|Visor|BearHat|Quiver|Mask/.test(node.getMesh()?.getName() ?? '')) node.dispose();
  }
  await doc.transform(prune({ keepLeaves: true, keepAttributes: true }));
  let error = 0.002;
  while (tris(doc) > CHAR_TARGET && error < 0.3) {
    await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: Math.min(0.95, CHAR_TARGET / tris(doc)), error }));
    error *= 1.6;
  }
  if (tris(doc) > 3000) throw new Error(`${name} is over the character budget: ${tris(doc)}`);
  await io.write(join(out, 'chars', `${name}.glb`), doc);
  report[`char:${name}`] = tris(doc);
}

// Animations only: the rig meshes are dropped.
for (const f of ['Tools', 'General', 'Simulation', 'MovementBasic']) {
  const doc = await io.read(join(anim, `Rig_Medium_${f}.glb`));
  for (const node of doc.getRoot().listNodes()) if (node.getMesh()) node.setMesh(null).setSkin(null);
  await doc.transform(prune({ keepLeaves: true, keepAttributes: true }));
  await io.write(join(out, 'anims', `${f}.glb`), doc);
}

for (const p of ['axe_1handed', 'spellbook_open', 'mug_full', 'staff']) {
  const doc = await io.read(join(adv, 'Assets', 'gltf', `${p}.gltf`));
  await io.write(join(out, 'props', `${p}.glb`), doc);
}

// Nature: normal maps removed, textures shrunk, the heavier trees simplified.
const NATURE = {
  CommonTree_3: 1000, CommonTree_5: 1000, Pine_5: 1300,
  Fern_1: 0, Clover_1: 0, Clover_2: 0, Flower_3_Single: 0, Grass_Common_Short: 0,
  Rock_Medium_1: 0, Rock_Medium_2: 0, Pebble_Square_4: 0, Plant_1: 0,
};
for (const [name, target] of Object.entries(NATURE)) {
  const doc = await io.read(join(nature, `${name}.gltf`));
  for (const m of doc.getRoot().listMaterials()) {
    m.setNormalTexture(null);
    m.setMetallicRoughnessTexture(null);
    m.setMetallicFactor(0);
    m.setRoughnessFactor(1);
  }
  const before = tris(doc);
  const steps = [weld()];
  if (target && before > target) steps.push(simplify({ simplifier: MeshoptSimplifier, ratio: target / before, error: 0.35 }));
  await doc.transform(...steps, prune({ keepLeaves: true, keepAttributes: true }), dedup(), textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [768, 768], quality: 82 }));
  await io.write(join(out, 'nature', `${name}.glb`), doc);
  report[`nature:${name}`] = tris(doc);
}

// The cat: its lighter mesh only, simplified again, with just the clips a village cat needs.
const catDoc = await io.read(cat);
for (const node of catDoc.getRoot().listNodes()) if (node.getName() === 'cat_LOD0') node.dispose();
for (const clip of catDoc.getRoot().listAnimations()) if (!['idle', 'idle_alt', 'walk', 'sit', 'sleep', 'eat'].includes(clip.getName())) clip.dispose();
for (const m of catDoc.getRoot().listMaterials()) {
  m.setMetallicRoughnessTexture(null);
  m.setMetallicFactor(0);
  m.setRoughnessFactor(1);
}
await catDoc.transform(prune({ keepLeaves: true, keepAttributes: true }));
await catDoc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: 800 / tris(catDoc), error: 0.03 }), textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [512, 512], quality: 86 }));
await io.write(join(out, 'cats', 'cat.glb'), catDoc);
report.cat = tris(catDoc);

// The dragon: simplified to fit the budget, with its normal map kept so the scales still read.
const dragonDoc = await io.read(dragon);
for (const m of dragonDoc.getRoot().listMeshes()) for (const p of m.listPrimitives()) for (const t of p.listTargets()) t.dispose();
for (const clip of dragonDoc.getRoot().listAnimations()) if (clip.getName() === 'bite') clip.dispose();
for (const m of dragonDoc.getRoot().listMaterials()) {
  m.setMetallicRoughnessTexture(null);
  m.setMetallicFactor(0);
  m.setRoughnessFactor(0.72);
}
await dragonDoc.transform(prune({ keepLeaves: true, keepAttributes: true }));
await dragonDoc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: 4500 / tris(dragonDoc), error: 0.03 }), textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024], quality: 84 }));
await io.write(join(out, 'dragons', 'dragon.glb'), dragonDoc);
report.dragon = tris(dragonDoc);

// Tung Tung Tung Sahur comes as FBX only, so its meshes and bones are copied into a glTF by hand.
const tungDoc = fbxToDoc(new FBXLoader().parse(readArrayBuffer(join(tung, 'tungtungsahur.fbx')), ''), readFileSync(join(tung, 'tex.png')));
await tungDoc.transform(weld());
const tungBefore = tris(tungDoc);
// Lighter than the villagers: the scene has little room left under its 300k budget.
const TUNG_TARGET = 1900;
let tungError = 0.002;
while (tris(tungDoc) > TUNG_TARGET && tungError < 0.3) {
  await tungDoc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: Math.min(0.95, TUNG_TARGET / tris(tungDoc)), error: tungError }));
  tungError *= 1.6;
}
if (tris(tungDoc) > 3000) throw new Error(`Tung Tung is over the character budget: ${tris(tungDoc)}`);
await tungDoc.transform(prune({ keepLeaves: true, keepAttributes: true }), textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [768, 768], quality: 86 }));
await io.write(join(out, 'tung', 'tung.glb'), tungDoc);
report.tung = `${tungBefore} -> ${tris(tungDoc)}`;

const v = await io.read(village);
const vb = tris(v);
await v.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: 0.24, error: 0.1 }));
await io.write(join(out, 'village', 'VillagePack.glb'), v);
report.village = `${vb} -> ${tris(v)}`;

const size = (d) => readdirSync(d, { withFileTypes: true }).reduce((s, e) => s + (e.isDirectory() ? size(join(d, e.name)) : statSync(join(d, e.name)).size), 0);
const mb = size(out) / 1048576;
console.log(JSON.stringify(report));
console.log(`assets/generated: ${mb.toFixed(1)} MB`);
if (mb > 50) {
  console.error('Over the 50 MB asset budget.');
  process.exit(1);
}
