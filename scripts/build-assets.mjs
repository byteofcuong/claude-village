// Builds assets/generated from the source packs in assets-src. Neither folder is committed:
// see assets/LICENSES.md for where to get each pack.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, simplify, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const root = resolve(import.meta.dirname, '..');
const src = join(root, 'assets-src');
const out = join(root, 'assets', 'generated');
const adv = join(src, 'KayKit_Adventurers_2.0_FREE', 'KayKit_Adventurers_2.0_FREE');
const anim = join(src, 'KayKit_Character_Animations_1.1', 'KayKit_Character_Animations_1.1', 'Animations', 'gltf', 'Rig_Medium');
const nature = join(src, 'Quaternius_Nature', 'glTF');
const village = join(src, 'WizP_Village', 'VillagePack.glb');
for (const need of [adv, anim, nature, village]) {
  if (!existsSync(need)) {
    console.error(`Missing source pack: ${need}\nSee assets/LICENSES.md.`);
    process.exit(2);
  }
}

rmSync(out, { recursive: true, force: true });
for (const d of ['chars', 'anims', 'props', 'nature', 'village']) mkdirSync(join(out, d), { recursive: true });

await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const tris = (doc) => doc.getRoot().listMeshes().reduce((s, m) => s + m.listPrimitives().reduce((a, p) => a + (p.getIndices() ?? p.getAttribute('POSITION')).getCount() / 3, 0), 0);
const report = {};

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
  CommonTree_3: 1900, CommonTree_5: 1900, Pine_5: 1500,
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
  if (target && before > target) steps.push(simplify({ simplifier: MeshoptSimplifier, ratio: target / before, error: 0.2 }));
  await doc.transform(...steps, prune({ keepLeaves: true, keepAttributes: true }), dedup(), textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [768, 768], quality: 82 }));
  await io.write(join(out, 'nature', `${name}.glb`), doc);
  report[`nature:${name}`] = tris(doc);
}

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
