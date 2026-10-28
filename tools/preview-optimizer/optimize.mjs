// Optional, explicitly invoked web-preview optimizer inspired by Dioramas scripts/optimize.mjs.
// Source: https://github.com/blendi-remade/dioramas (MIT 2026 Blendi).
// See docs/licenses/dioramas-MIT.txt. Never use this output for printing or CAD measurements.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, weld, prune, reorder, quantize, meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';

const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function preflightSelfContainedGlb(bytes) {
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'glTF' ||
      bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length ||
      bytes.toString('ascii', 16, 20) !== 'JSON') {
    throw new Error('Expected a complete GLB v2');
  }
  const jsonEnd = 20 + bytes.readUInt32LE(12);
  if (jsonEnd > bytes.length) throw new Error('GLB JSON chunk overflows input');
  const manifest = JSON.parse(bytes.toString('utf8', 20, jsonEnd));
  if (manifest.buffers?.some(buffer => buffer.uri) ||
      manifest.images?.some(image => image.uri)) {
    throw new Error('Only self-contained GLB files are supported (no external resource URIs)');
  }
  if (manifest.animations?.length || manifest.skins?.length ||
      manifest.meshes?.some(mesh => mesh.primitives?.some(p => p.targets?.length))) {
    throw new Error('Animated, skinned and morph-target models are not in this preview-only pilot');
  }
}

function shape(doc) {
  const root = doc.getRoot();
  const meshes = root.listMeshes();
  const primitives = meshes.flatMap(mesh => mesh.listPrimitives());
  if (!primitives.length || primitives.some(p => p.getMode() !== 4 ||
        !p.getAttribute('POSITION'))) throw new Error('Only triangle mesh GLBs are supported');
  return {
    meshes: meshes.length,
    scenes: root.listScenes().length,
    primitives: primitives.length,
    triangles: primitives.reduce((n, p) => n +
      Math.floor((p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3), 0),
  };
}

export async function optimizeApprovedPreview(inputPath, outputPath) {
  if (!inputPath || !outputPath) throw new Error('Usage: node optimize.mjs <source.glb> <output.preview.glb>');
  const input = path.resolve(inputPath), output = path.resolve(outputPath);
  if (!input.toLowerCase().endsWith('.glb') || !output.toLowerCase().endsWith('.preview.glb') ||
      input.toLowerCase() === output.toLowerCase()) {
    throw new Error('Input must be .glb; output must be a different *.preview.glb file');
  }
  const stat = await fs.lstat(input);
  if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > MAX_SOURCE_BYTES) {
    throw new Error('Input must be a regular approved local file within the 64 MiB limit');
  }
  const source = await fs.readFile(input);
  preflightSelfContainedGlb(source);
  const sourceSha256 = digest(source);
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
  const doc = await io.readBinary(source);
  const before = shape(doc);

  // No decimation/simplification: preserve mesh/primitive/triangle counts.
  // Quantization is intentionally lossy; this is a viewer derivative, never a master.
  await doc.transform(
    dedup(), weld(), prune(),
    reorder({ encoder: MeshoptEncoder }),
    quantize({ quantizePosition: 16, quantizeNormal: 10, quantizeTexcoord: 14 }),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );
  const optimized = Buffer.from(await io.writeBinary(doc));
  const after = shape(await io.readBinary(optimized));
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error('Preview optimization changed structural mesh/triangle counts');
  }
  // Creating a separate derivative is not worthwhile for already-optimized textured GLBs.
  if (optimized.length > source.length * 0.99) {
    throw new Error('No meaningful preview size benefit (under 1%); no derivative written');
  }
  if (digest(await fs.readFile(input)) !== sourceSha256) {
    throw new Error('Source GLB changed during optimization');
  }

  // Exclusive creation: never overwrite a source or existing preview.
  const handle = await fs.open(output, 'wx');
  try {
    await handle.writeFile(optimized);
  } catch (error) {
    await handle.close();
    await fs.rm(output, { force: true });
    throw error;
  }
  await handle.close();

  return {
    status: 'WEB_PREVIEW_ONLY_NOT_PRINT_QUALIFIED',
    input: path.basename(input),
    output: path.basename(output),
    sourceSha256,
    previewSha256: digest(optimized),
    sourceBytes: source.length,
    previewBytes: optimized.length,
    savedPercent: Math.round((1 - optimized.length / source.length) * 10000) / 100,
    shape: before,
    sourceUnchanged: true,
    noCloud: true,
    noGpuInference: true,
    printedOrExportedForFabrication: false,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  optimizeApprovedPreview(process.argv[2], process.argv[3])
    .then(result => console.log('PREVIEW_OPTIMIZER_PASS ' + JSON.stringify(result)))
    .catch(error => { console.error('PREVIEW_OPTIMIZER_BLOCKED ' + error.message); process.exitCode = 1; });
}
