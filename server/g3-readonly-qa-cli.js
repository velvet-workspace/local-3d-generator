/**
 * Bounded ChatGPT/Creative Craft hand-off for existing LOCAL3D G3 CPU audits.
 * Reuses geometry-review.js; never launches inference, exports meshes or prints.
 * Allowed input: LOCAL3D/runtime/qa/<job>/output.glb
 * Allowed output: exact sibling geometry-qa.json, created only if absent.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createGeometryReviewer } from './geometry-review.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QA_ROOT = path.join(ROOT, 'runtime', 'qa');
const digest = data => createHash('sha256').update(data).digest('hex');

function blocked(reason, exitCode = 2) {
  process.stdout.write(JSON.stringify({status:'BLOCKED', operation:'local3d.g3.qa', reason}) + '\n');
  process.exitCode = exitCode;
}
function parseArgs(argv) {
  if(argv.length !== 4 || argv[0] !== '--input' || argv[2] !== '--output') {
    throw new Error('Only --input <existing-output.glb> --output <new-geometry-qa.json> accepted');
  }
  return {input:path.resolve(argv[1]), output:path.resolve(argv[3])};
}
function isWithin(base, target) {
  const relative = path.relative(base, target);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

async function main() {
  const {input, output} = parseArgs(process.argv.slice(2));
  if(path.basename(input) !== 'output.glb' || path.basename(output) !== 'geometry-qa.json' ||
     path.dirname(input) !== path.dirname(output)) {
    throw new Error('Fixed sibling LOCAL3D G3 artifact names are required');
  }
  const realBase = await fs.realpath(QA_ROOT);
  const realParent = await fs.realpath(path.dirname(input));
  if(!isWithin(realBase,realParent) || path.resolve(path.dirname(input)) !== realParent) {
    throw new Error('Outside authorized LOCAL3D runtime/qa job directory');
  }
  const originalStat = await fs.lstat(input);
  if(!originalStat.isFile() || originalStat.isSymbolicLink()) throw new Error('Source is not a regular GLB file');
  const {raw,report} = await createGeometryReviewer()({modelFile:input,outputFile:output});
  process.stdout.write(JSON.stringify({
    status:'PASS', operation:'local3d.g3.qa', authority:'LOCAL3D G3',
    modelSha256:report.modelSha256, reportSha256:digest(raw),
    reportSchema:report.schema, classification:report.classification,
    printQualified:report.printQualified, fabricationAction:report.fabricationAction,
    visualMaterialChannels:report.visualMaterialChannels || null
  })+'\n');
}
main().catch(error=>blocked(String(error?.message || error),1));
