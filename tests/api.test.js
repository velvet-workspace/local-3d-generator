import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../server/index.js';
import { createFixtureBuffer } from '../server/fixture.js';
import { listenFixtureSafePort } from './safe-loopback-fixture.mjs';

let app, base, tmp;
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAY0lEQVR4nO3PQQ3AIADAQMAOrvCF14ngcVnSU9DOfe74s6UDXjWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgfWv2AaqHnAIRAAAAAElFTkSuQmCC'.replace(/_/g,'/'), 'base64');
async function req(url, method = 'GET', body, headers = {}) {
  const response = await fetch(base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const type = response.headers.get('content-type') || '';
  return { status: response.status, value: type.includes('json') ? await response.json() : await response.arrayBuffer() };
}
async function waitFor(id, wanted, timeout = 1800) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const r = await req('/v1/jobs/' + id);
    if (r.value.status === wanted) return r.value;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('Timeout waiting for job ' + id + ' to become ' + wanted);
}
beforeEach(async () => {
  // macOS /var is commonly an alias of /private/var. The HTTP security
  // gate rejects symlinked ancestors, so this fixture must use a canonical
  // temp root rather than weakening the production path check.
  const canonicalTemp = await fs.realpath(os.tmpdir());
  tmp = await fs.mkdtemp(path.join(canonicalTemp, 'local3d-test-'));
  app = await createApp({ dataDir: path.join(tmp, 'data'), fixtureFile: path.join(tmp, 'fixture.glb'), stepMs: 32 });
  await listenFixtureSafePort(app.server);
  base = 'http://127.0.0.1:' + app.server.address().port;
});
afterEach(async () => { await app.close(); await fs.rm(tmp, { recursive:true, force:true }); });

test('health stays local, only fixture provider can run', async () => {
  const health = await req('/v1/health');
  assert.equal(health.status, 200); assert.equal(health.value.inference, false);
  const providers = await req('/v1/providers');
  assert.equal(providers.value.providers.filter(x => x.canStart).length, 1);
  assert.equal(providers.value.providers.find(x => x.id === 'triposr-local').status, 'STAGED_DISABLED');
});
test('G3 benchmark coverage is public read-only fixture metadata, never runs GPU', async () => {
  const report = await req('/v1/benchmarks/g3');
  assert.equal(report.status,200);
  assert.equal(report.value.schema,'local3d.g3.benchmark-coverage.v1');
  assert.equal(report.value.fixtureCount,9);
  assert.equal(report.value.fixturesWithPreviouslyObservedE2ERun,1);
  assert.equal(report.value.fixturesAwaitingRecordedOutput,8);
  assert.equal(report.value.modelInferenceExecuted,false);
  assert.equal(report.value.printQualified,false);
  assert.equal((await req('/v1/jobs')).value.jobs.length,0);
});

test('licensed G3 source images are SHA-verified and loading them never submits inference',async()=>{
  const catalog = JSON.parse(await fs.readFile(path.resolve(import.meta.dirname,'..','benchmarks/g3/fixtures/manifest.json'),'utf8'));
  for(const fixture of catalog.fixtures){
    const got=await req('/v1/benchmarks/g3/sources/'+fixture.id);
    assert.equal(got.status,200);
    assert.equal(got.value.schema,'local3d.g3.fixture-image.v1');
    assert.equal(got.value.fixtureId,fixture.id);
    assert.equal(got.value.sha256,fixture.imageSha256);
    assert.equal(got.value.image.mime,'image/png');
    assert.equal(got.value.manualOnly,true);
    assert.equal(got.value.confirmationGranted,false);
    assert.equal(got.value.modelInferenceExecuted,false);
    const bytes=Buffer.from(got.value.image.base64,'base64');
    assert.equal(bytes.length,got.value.image.bytes);
    assert.equal((await import('node:crypto')).createHash('sha256').update(bytes).digest('hex'),fixture.imageSha256);
  }
  const none=await req('/v1/benchmarks/g3/sources/UNKNOWN');
  assert.equal(none.status,404);
  const traversal=await req('/v1/benchmarks/g3/sources/%2e%2e%2fsecret');
  assert.notEqual(traversal.status,200);
  const jobs=await req('/v1/jobs');
  assert.equal(jobs.value.jobs.length,0);
});

test('valid image -> queued/running -> GLB + non-printable QA report', async () => {
  const created = await req('/v1/jobs', 'POST', {
    providerId:'fixture-demo', mode:'image', prompt:'ornamental sculpture',
    image:{filename:'sample.png',mime:'image/png',base64:tinyPng.toString('base64')}
  });
  assert.equal(created.status, 201);
  assert.equal(created.value.simulation, true);
  const job = await waitFor(created.value.id, 'completed');
  assert.equal(job.assets.length, 3); assert.equal(job.progress, 100);
  const glb = await req('/v1/jobs/' + job.id + '/assets/preview-glb');
  assert.equal(glb.status, 200); assert.equal(Buffer.from(glb.value).toString('ascii',0,4), 'glTF');
  const report = await req('/v1/jobs/' + job.id + '/assets/qa-report');
  const deniedCpuReview = await req('/v1/jobs/' + job.id + '/review', 'POST');
  assert.equal(deniedCpuReview.status, 422);
  assert.equal(deniedCpuReview.value.error.code, 'G3_REVIEW_UNAVAILABLE');
  const deniedBenchmark=await req('/v1/jobs/' + job.id + '/benchmark','POST');
  assert.equal(deniedBenchmark.status,422);
  assert.equal(deniedBenchmark.value.error.code,'G3_BENCHMARK_UNAVAILABLE');
  assert.equal(report.value.geometryStatus,'DRAFT');
  assert.equal(report.value.printQualified,false);
  const source = await req('/v1/jobs/' + job.id + '/assets/source-image');
  assert.equal(source.status, 200);
});
test('G3.47 fixture HTTP GET/HEAD verify immutable SHA before emitting asset bytes',async()=>{
 const made=await req('/v1/jobs','POST',{providerId:'fixture-demo',mode:'image',
  prompt:'owned synthetic HTTP asset',
  image:{mime:'image/png',filename:'sample.png',base64:tinyPng.toString('base64')}});
 assert.equal(made.status,201);
 const done=await waitFor(made.value.id,'completed');
 for(const asset of done.assets){
  const u='/v1/jobs/'+done.id+'/assets/'+asset.id;
  const get=await fetch(base+u),head=await fetch(base+u,{method:'HEAD'});
  assert.equal(get.status,200);
  assert.equal(head.status,200);
  const got=Buffer.from(await get.arrayBuffer());
  assert.equal(got.length,asset.bytes);
  assert.equal((await import('node:crypto')).createHash('sha256').update(got).digest('hex'),asset.sha256);
  assert.equal(Number(get.headers.get('content-length')),asset.bytes);
  assert.equal(Number(head.headers.get('content-length')),asset.bytes);
  assert.equal((await head.arrayBuffer()).byteLength,0);
 }
});
test('G3.47 HTTP same-size on-disk GLB tamper must deny GET and HEAD',async()=>{
 const made=await req('/v1/jobs','POST',{providerId:'fixture-demo',mode:'text',
  prompt:'synthetic non-printable GLB'});
 assert.equal(made.status,201);
 const job=await waitFor(made.value.id,'completed');
 const model=path.join(tmp,'data','jobs',job.id,'output.glb');
 const old=await fs.readFile(model);
 await fs.writeFile(model,Buffer.alloc(old.length,5));
 const route='/v1/jobs/'+job.id+'/assets/preview-glb';
 const denied=await fetch(base+route);
 assert.equal(denied.status,409);
 assert.equal((await denied.json()).error.code,'G347_ASSET_UNVERIFIED');
 const head=await fetch(base+route,{method:'HEAD'});
 assert.equal(head.status,409);
 assert.equal((await head.arrayBuffer()).byteLength,0);
 assert.equal((await req('/v1/jobs/'+job.id+'/assets/qa-report')).status,200);
});
test('G3.47 HTTP hardlinked QA refuses GET+HEAD, source remains valid',async()=>{
 const created=await req('/v1/jobs','POST',{providerId:'fixture-demo',mode:'image',
  prompt:'owned synthetic QA file',image:{mime:'image/png',base64:tinyPng.toString('base64')}});
 assert.equal(created.status,201);
 const j=await waitFor(created.value.id,'completed');
 const file=path.join(tmp,'data','jobs',j.id,'qa-report.json');
 await fs.link(file,path.join(tmp,'owned-qa-hardlink'));
 const url='/v1/jobs/'+j.id+'/assets/qa-report';
 const deny=await fetch(base+url),head=await fetch(base+url,{method:'HEAD'});
 assert.equal(deny.status,409);
 assert.equal((await deny.json()).error.code,'G347_ASSET_UNVERIFIED');
 assert.equal(head.status,409);
 assert.equal((await head.arrayBuffer()).byteLength,0);
 assert.equal((await req('/v1/jobs/'+j.id+'/assets/source-image')).status,200);
});
test('G3.47 HTTP parent Windows Junction may not serve any job asset',async()=>{
 const created=await req('/v1/jobs','POST',{providerId:'fixture-demo',mode:'text',
  prompt:'owned synthetic redirected job'});
 assert.equal(created.status,201);
 const j=await waitFor(created.value.id,'completed');
 const folder=path.join(tmp,'data','jobs',j.id),other=path.join(tmp,'owned-relocated-job');
 await fs.rename(folder,other);
 await fs.symlink(other,folder,process.platform==='win32'?'junction':'dir');
 for(const asset of j.assets){
  const u='/v1/jobs/'+j.id+'/assets/'+asset.id;
  assert.equal((await fetch(base+u)).status,409);
  assert.equal((await fetch(base+u,{method:'HEAD'})).status,409);
 }
});
test('bad inputs and remote providers fail closed', async () => {
  const candidate = await req('/v1/jobs','POST',{providerId:'triposr-local',mode:'text',prompt:'something'});
  assert.equal(candidate.status,422); assert.equal(candidate.value.error.code,'PROVIDER_UNAVAILABLE');
  const fake = await req('/v1/jobs','POST',{providerId:'fixture-demo',mode:'image',image:{mime:'image/png',base64:Buffer.from('not-an-image').toString('base64')}});
  assert.equal(fake.status,422);
  const noPrompt = await req('/v1/jobs','POST',{providerId:'fixture-demo',mode:'text',prompt:' '});
  assert.equal(noPrompt.status,422);
  const url = await req('/v1/jobs','POST',{providerId:'fixture-demo',mode:'text',prompt:'a vase',url:'https://internal/'});
  assert.equal(url.status,422); assert.equal(url.value.error.code,'FORBIDDEN_REMOTE_INPUT');
});
test('cancel active job: no output artifact and no orphan task', async () => {
  const created = await req('/v1/jobs','POST',{providerId:'fixture-demo',mode:'text',prompt:'a simple vase'});
  assert.equal(created.status,201);
  const cancel = await req('/v1/jobs/' + created.value.id + '/cancel', 'POST');
  assert.equal(cancel.status,200);
  const job = await waitFor(created.value.id,'cancelled');
  assert.ok(!job.assets.some(a => a.id === 'preview-glb'));
  const asset = await req('/v1/jobs/' + job.id + '/assets/preview-glb');
  assert.equal(asset.status,404);
});
test('host/origin checks and path traversal barriers', async () => {
  const blockedOrigin = await req('/v1/jobs','POST',{providerId:'fixture-demo',mode:'text',prompt:'three chairs'},{Origin:'http://evil.example'});
  assert.equal(blockedOrigin.status,403);
  const traversal = await req('/v1/jobs/%2e%2e/%2e%2e/secret');
  assert.notEqual(traversal.status,200);
  const randomJob = await req('/v1/jobs/11111111-1111-4111-8111-111111111111/assets/source-image');
  assert.equal(randomJob.status,404);
  const deniedHost = await new Promise((resolve,reject) => {
    const host = new URL(base);
    http.get({hostname:'127.0.0.1',port:Number(host.port),path:'/v1/health',headers:{Host:'example.com'}},response => {
      response.resume(); response.on('end',()=>resolve(response.statusCode));
    }).on('error',reject);
  });
  assert.equal(deniedHost,403);
});
test('fixture has binary GLB header and a valid length', async () => {
  const bytes = createFixtureBuffer();
  assert.equal(bytes.toString('ascii',0,4),'glTF');
  assert.equal(bytes.readUInt32LE(4),2);
  assert.equal(bytes.readUInt32LE(8),bytes.length);
});

test('restart persists records and does not falsely complete unfinished work', async () => {
  const created = await req('/v1/jobs','POST',{providerId:'fixture-demo',mode:'text',prompt:'abstract lamp'});
  assert.equal(created.status,201);
  const id = created.value.id;
  await app.close();
  app = await createApp({dataDir:path.join(tmp,'data'),fixtureFile:path.join(tmp,'fixture.glb'),stepMs:32});
  await listenFixtureSafePort(app.server);
  base = 'http://127.0.0.1:' + app.server.address().port;
  const readBack = await req('/v1/jobs/' + id);
  assert.equal(readBack.status,200);
  assert.equal(readBack.value.status,'interrupted');
  assert.ok(!readBack.value.assets.some(a => a.id === 'preview-glb'));
});

test('browser assets, Three.js imports and CSP are served locally', async () => {
  const paths = ['/', '/app.js', '/styles.css', '/favicon.svg',
    '/vendor/three/build/three.module.js',
    '/vendor/three/build/three.core.js',
    '/vendor/three/examples/jsm/controls/OrbitControls.js',
    '/vendor/three/examples/jsm/loaders/GLTFLoader.js',
    '/vendor/three/examples/jsm/utils/BufferGeometryUtils.js'];
  for (const asset of paths) {
    const result = await fetch(base + asset);
    assert.equal(result.status, 200, asset);
    assert.equal(result.headers.get('x-content-type-options'),'nosniff');
    await result.arrayBuffer();
  }
  const page = await fetch(base + '/');
  assert.match(await page.text(), /type="importmap"/);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
});
