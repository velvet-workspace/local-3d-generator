import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT,'server','g3-readonly-qa-cli.js');
function run(...args) {
  const r = spawnSync(process.execPath,[CLI,...args],{cwd:ROOT,encoding:'utf8',timeout:8000});
  assert.ok(r.stdout?.trim(), r.stderr || 'missing stdout');
  return {code:r.status, doc:JSON.parse(r.stdout.trim())};
}
test('read-only G3 bridge refuses arbitrary command or missing args',()=>{
  const v=run('--execute','some-script');
  assert.equal(v.doc.status,'BLOCKED');
  assert.notEqual(v.code,0);
});
test('read-only G3 bridge refuses nonfixed artifact names',()=>{
  const v=run('--input','C:/tmp/model.glb','--output','C:/tmp/report.json');
  assert.equal(v.doc.status,'BLOCKED');
  assert.match(v.doc.reason,/Fixed sibling/);
});
test('read-only G3 bridge refuses input outside the LOCAL3D QA root',()=>{
  const v=run('--input','C:/tmp/output.glb','--output','C:/tmp/geometry-qa.json');
  assert.equal(v.doc.status,'BLOCKED');
  assert.notEqual(v.code,0);
});
