import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createFixtureBuffer } from '../../server/fixture.js';
import { optimizeApprovedPreview } from './optimize.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vf-preview-optimizer-'));
try {
  const sourcePath = path.join(dir, 'original.glb');
  const outputPath = path.join(dir, 'model.preview.glb');
  const source = createFixtureBuffer();
  await fs.writeFile(sourcePath, source);
  const result = await optimizeApprovedPreview(sourcePath, outputPath);
  const optimized = await fs.readFile(outputPath);
  assert.equal(result.status, 'WEB_PREVIEW_ONLY_NOT_PRINT_QUALIFIED');
  assert.equal(result.sourceSha256, sha(source));
  assert.equal(result.previewSha256, sha(optimized));
  assert.equal(sha(await fs.readFile(sourcePath)), sha(source));
  assert.ok(optimized.length < source.length);
  assert.deepEqual(result.shape, { meshes:4, scenes:1, primitives:4, triangles:6144 });
  await assert.rejects(optimizeApprovedPreview(sourcePath, outputPath), /EEXIST/);
  await assert.rejects(optimizeApprovedPreview(sourcePath, sourcePath), /different.*preview/);
  await assert.rejects(optimizeApprovedPreview(sourcePath, path.join(dir, 'wrong.glb')), /preview/);
  const bad = Buffer.from(source);
  bad.write('BADD', 0, 4, 'ascii');
  await fs.writeFile(path.join(dir, 'bad.glb'), bad);
  await assert.rejects(optimizeApprovedPreview(path.join(dir, 'bad.glb'), path.join(dir, 'bad.preview.glb')), /complete GLB/);
  console.log('PREVIEW_OPTIMIZER_QA_PASS ' + JSON.stringify({sourceBytes:source.length,previewBytes:optimized.length,savedPercent:result.savedPercent,triangles:result.shape.triangles,shaPreserved:true,overwriteBlocked:true,invalidBlocked:true}));
} catch(error) {
  console.error('PREVIEW_OPTIMIZER_QA_FAIL ' + (error.stack || error));
  process.exitCode=1;
} finally {
  await fs.rm(dir,{recursive:true,force:true});
}
