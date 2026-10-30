import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { ensureFixture } from './fixture.js';
import { createTripoSRAdapter } from './triposr-adapter.js';
import { createGeometryReviewer } from './geometry-review.js';
import { createGpuLease, LeaseUnavailable } from './gpu-lease.js';
import { getBenchmarkSource, FixtureSourceError } from './benchmark-sources.js';
import { createBenchmarkReviewer } from './benchmark-review.js';
import { admitRealJobStorage, StorageAdmissionError } from './storage-admission.js';
import {preflightImageStructure, ImageStructureError} from './image-structure-preflight.js';
import {readShaVerifiedJobAsset} from './g347-http-asset-integrity.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DATA_DIR = path.join(ROOT, 'runtime', 'data');
const DEFAULT_FIXTURE = path.join(ROOT, 'fixtures', 'demo-sculpture.glb');
const G3_PUBLIC_COVERAGE = path.join(ROOT, 'docs', 'evidence', 'g3', 'benchmark-coverage.json');
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_QUEUE = 30;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMPORT_MAP = '{"imports":{"three":"/vendor/three/build/three.module.js"}}';
const IMPORT_HASH = createHash('sha256').update(IMPORT_MAP).digest('base64');
const PROVIDERS = Object.freeze([
  {
    id: 'fixture-demo', name: 'Fixture Lab', version: 'g1.0', status: 'DEMO_ONLY',
    inputTypes: ['image', 'text'], outputTypes: ['glb'],
    licenseLane: 'original-test-fixture', hardwareNeeds: 'CPU / no GPU', simulation: true,
    canStart: true, canCancel: true, deterministicSeed: true
  },
  {
    id: 'triposr-local', name: 'TripoSR Local', version: 'source-107cefd', status: 'CANDIDATE_G2',
    inputTypes: ['image'], outputTypes: ['glb'], licenseLane: 'review-required',
    hardwareNeeds: 'GPU / validate locally', simulation: false, canStart: false, canCancel: false
  },
  {
    id: 'hunyuan-shape', name: 'Hunyuan3D Shape', version: 'not-installed', status: 'RESEARCH_G3',
    inputTypes: ['image'], outputTypes: ['glb'], licenseLane: 'territory-and-commercial-review',
    hardwareNeeds: 'VRAM / benchmark required', simulation: false, canStart: false, canCancel: false
  }
]);

class HttpError extends Error {
  constructor(code, status, message) { super(message); this.code = code; this.status = status; }
}
function fail(code, status, message) { throw new HttpError(code, status, message); }
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function isUuid(s) { return ID_PATTERN.test(s || ''); }
function now() { return new Date().toISOString(); }
function sniffImage(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { mime: 'image/png', ext: '.png' };
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { mime: 'image/jpeg', ext: '.jpg' };
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: '.webp' };
  return null;
}
function reply(res, status, body, method = 'GET') {
  const raw = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': raw.length, 'Cache-Control': 'no-store' });
  if (method === 'HEAD') res.end(); else res.end(raw);
}
function errorReply(res, e) {
  if (res.headersSent || res.writableEnded) return;
  const status = e instanceof HttpError ? e.status : 500;
  reply(res, status, { error: { code: e.code || 'INTERNAL_ERROR', message: status === 500 ? 'Unexpected local server error' : e.message } });
}
function readBody(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) fail('CONTENT_TYPE', 415, 'Expected application/json');
  if (Number(req.headers['content-length'] || 0) > MAX_BODY_BYTES) fail('BODY_TOO_LARGE', 413, 'Request exceeds size limit');
  return new Promise((resolve, reject) => {
    let len = 0; const chunks = [];
    req.on('data', part => {
      len += part.length;
      if (len > MAX_BODY_BYTES) {
        reject(new HttpError('BODY_TOO_LARGE', 413, 'Request exceeds size limit'));
        req.pause();
        return;
      }
      chunks.push(part);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError('BAD_JSON', 400, 'Malformed JSON')); }
    });
    req.on('error', reject);
  });
}
function sanitizeFileName(name) {
  return String(name || 'image').replace(/\\/g, '/').split('/').pop().replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 100);
}

export async function createApp(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.L3D_DATA_DIR || DEFAULT_DATA_DIR);
  const fixtureFile = path.resolve(options.fixtureFile || DEFAULT_FIXTURE);
  const stepMs = options.stepMs ?? 850;
  // Default remains DEMO, including npm start. A REAL manual-only session
  // requires explicit operator opt-in before process launch, and per-job consent.
  const realAdapter = options.triposrAdapter || (process.platform === 'win32' && process.env.L3D_ENABLE_TRIPOSR === '1' ? createTripoSRAdapter() : null);
  const geometryReviewer = realAdapter ? (options.geometryReviewer || createGeometryReviewer()) : null;
  const benchmarkReviewer = realAdapter ? (options.benchmarkReviewer || createBenchmarkReviewer()) : null;
  const gpuLease = realAdapter ? (options.gpuLease || createGpuLease({root: options.gpuLeaseRoot})) : null;
  const storageAdmission = realAdapter ? (options.storageAdmission || admitRealJobStorage) : null;
  const jobsDir = path.join(dataDir, 'jobs');
  const logsDir = path.join(dataDir, 'audit');
  await fs.mkdir(jobsDir, { recursive: true });
  await fs.mkdir(logsDir, { recursive: true });
  await ensureFixture(fixtureFile);
  const jobs = new Map();
  const pending = [];
  const reviews = new Map(); // one CPU-only topology review per completed G2 job
  const benchmarkReviews = new Map(); // one bounded local CPU benchmark per G2 job
  // One heavy CPU review at a time across BOTH G3 review types.
  // This is cooperative process-local throttling, not an OS-wide scheduler.
  let cpuReviewActive = null;
  function reserveCpuReview(kind, jobId) {
    if (cpuReviewActive) fail('G3_CPU_BUSY', 409, 'Another local CPU geometry review is active; no background queue');
    const token = {kind, jobId};
    cpuReviewActive = token;
    return () => { if (cpuReviewActive === token) cpuReviewActive = null; };
  }
  let activeId = null, activeTimer = null, saving = Promise.resolve(), closing = false;
  let realRun = null; // real GPU permit, never queued or restarted unattended
  const jobFile = id => path.join(jobsDir, id, 'job.json');
  const jobFolder = id => path.join(jobsDir, id);
  async function audit(event, jobId, extra = {}) {
    await fs.appendFile(path.join(logsDir, 'events.jsonl'), JSON.stringify({ at: now(), event, jobId, ...extra }) + '\n').catch(() => {});
  }
  function persist(job) {
    const snapshot = JSON.stringify(job, null, 2) + '\n';
    saving = saving.catch(() => {}).then(async () => {
      await fs.mkdir(jobFolder(job.id), { recursive: true });
      const tmp = path.join(jobFolder(job.id), '.job-' + randomUUID() + '.tmp');
      await fs.writeFile(tmp, snapshot, { flag: 'wx' });
      try { await fs.rename(tmp, jobFile(job.id)); }
      catch (e) { await fs.unlink(tmp).catch(() => {}); throw e; }
    });
    return saving;
  }
  const folders = await fs.readdir(jobsDir, { withFileTypes: true });
  for (const dir of folders) {
    if (!dir.isDirectory() || !isUuid(dir.name)) continue;
    try {
      const j = JSON.parse(await fs.readFile(jobFile(dir.name), 'utf8'));
      if (j.id !== dir.name) continue;
      if (j.status === 'running' || j.status === 'queued' || j.status === 'cancelling') {
        j.status = 'interrupted'; j.progress = 0; j.stage = 'interrupted';
        j.error = { code: 'RESTART_INTERRUPTED', message: 'Previous job did not finish before restart; no engine resumed' };
        j.updatedAt = now(); await persist(j); await audit('recovered_as_interrupted', j.id);
      }
      jobs.set(j.id, j);
    } catch { /* unreadable records are ignored, never trusted as paths */ }
  }

  const publicJob = j => JSON.parse(JSON.stringify(j));
  const recordAsset = (id, kind, mime, bytes, label) => ({ id, kind, mime, bytes: bytes.length, sha256: sha(bytes), label });
  const realStages = Object.freeze({ gpu_guard: 4, verify_sources: 9, preprocess_image: 13, loading_model: 20, infer_image: 46, extract_mesh: 70, export_glb: 88, completed: 95 });
  async function runRealJob(job, controller) {
    try {
      if (job.status !== 'queued' || closing) throw new Error('Real job not queued');
      job.status = 'running'; job.stage = 'g2_gpu_guard'; job.progress = 2;
      job.updatedAt = now(); await persist(job); await audit('real_started', job.id);
      const inputPath = path.join(jobFolder(job.id), 'input' + sniffMimeExt(job.source.mime));
      const produced = await realAdapter.run({
        jobDir: jobFolder(job.id), inputPath, signal: controller.signal,
        onStage(stage) {
          if (job.status !== 'running' || !Object.hasOwn(realStages, stage)) return;
          job.stage = 'g2_' + stage; job.progress = realStages[stage]; job.updatedAt = now();
          void persist(job).catch(error => console.error('G2 status persistence:', error.message));
        }
      });
      if (job.status !== 'running' || controller.signal.aborted || closing) return;
      const report = Buffer.from(JSON.stringify({
        schema: 'local3d.qa.v1', jobId: job.id, mode: 'REAL_INFERENCE',
        provider: 'TripoSR', source: 'user-supplied local image',
        geometryStatus: 'DRAFT', manifoldCheck: produced.qa.watertight ? 'WATERTIGHT_SINGLE_SAMPLE' : 'NOT_WATERTIGHT',
        wallThicknessCheck: 'NOT_RUN', dimensions: 'UNCALIBRATED',
        printQualified: false, approvedForPrinter: false,
        realInference: true, simulation: false,
        provenance: {
          sourceCommit: produced.qa.sourceCommit, weightsRevision: produced.qa.weightsRevision,
          weightsSha256: produced.qa.weightsSha256, sourceSha256: produced.qa.inputSha256,
          artifactSha256: produced.qa.artifactSha256, elapsedSeconds: produced.qa.elapsedSeconds,
          gpu: produced.qa.gpu, peakCudaReservedMiB: produced.qa.peakCudaReservedMiB,
          hostGpuTelemetry: produced.qa.hostGpuTelemetry || null,
          vertices: produced.qa.vertices, faces: produced.qa.faces,
          coordinateSystem: produced.qa.coordinateSystem,
          preprocessing: produced.qa.preprocessing
        }
      }, null, 2) + '\n');
      // No partial GLB is made visible until the worker report, source SHA and
      // GLB bytes have all passed the adapter's independent verification.
      await fs.writeFile(path.join(jobFolder(job.id), 'output.glb'), produced.glb, { flag: 'wx' });
      await fs.writeFile(path.join(jobFolder(job.id), 'qa-report.json'), report, { flag: 'wx' });
      if (job.status !== 'running' || controller.signal.aborted || closing) return;
      job.assets.push(recordAsset('preview-glb','model','model/gltf-binary',produced.glb,'TripoSR real model — DRAFT GLB'));
      job.assets.push(recordAsset('qa-report','report','application/json',report,'Verified real inference — DRAFT report'));
      job.status = 'completed'; job.stage = 'g2_ready_draft'; job.progress = 100;
      job.updatedAt = now(); job.completedAt = now();
      await persist(job); await audit('real_completed', job.id, { modelSha256: sha(produced.glb) });
    } catch (error) {
      const cancelled = job.status === 'cancelling' || controller.signal.aborted || closing || error.code === 'CANCELLED';
      job.status = cancelled ? 'cancelled' : 'failed';
      job.stage = cancelled ? 'cancelled' : 'error'; job.progress = 0;
      job.updatedAt = now();
      job.error = cancelled ? null : { code: error.code || 'G2_WORKER_FAILED', message: 'Real local inference did not complete; no output approved' };
      await persist(job); await audit(cancelled ? 'real_cancelled' : 'real_failed', job.id, { code: error.code || 'G2_WORKER_FAILED' });
    } finally {
      const token = realRun?.jobId === job.id ? realRun : null;
      if (token?.lease) {
        try { await token.lease.release(); }
        catch (error) { console.error('G2 shared GPU lease release requires operator attention:', error.code || 'LEASE_ERROR'); }
      }
      if (realRun?.jobId === job.id) realRun = null;
    }
  }
  function launchReal(job) {
    const token = realRun;
    if (!token || token.jobId !== job.id || token.promise) throw new Error('Missing reserved GPU permit');
    token.promise = runRealJob(job, token.controller).catch(e => {
      console.error('Unexpected G2 job runner persistence error:', e.message);
    });
    return token;
  }
  async function finish(job) {
    if (job.status !== 'running' || activeId !== job.id) return;
    const glb = await fs.readFile(fixtureFile);
    await fs.writeFile(path.join(jobFolder(job.id), 'output.glb'), glb);
    const report = Buffer.from(JSON.stringify({
      schema: 'local3d.qa.v1', jobId: job.id, mode: 'DEMO',
      source: 'deterministic bundled fixture, unrelated to prompt/image',
      geometryStatus: 'DRAFT', manifoldCheck: 'NOT_RUN', wallThicknessCheck: 'NOT_RUN',
      dimensions: 'UNMEASURED', printQualified: false, approvedForPrinter: false
    }, null, 2) + '\n');
    await fs.writeFile(path.join(jobFolder(job.id), 'qa-report.json'), report);
    if (job.status !== 'running') return;
    job.assets.push(recordAsset('preview-glb', 'model', 'model/gltf-binary', glb, 'Demo sculpture — GLB'));
    job.assets.push(recordAsset('qa-report', 'report', 'application/json', report, 'Geometry status — DRAFT'));
    job.status = 'completed'; job.progress = 100; job.stage = 'fixture_ready';
    job.updatedAt = now(); job.completedAt = now();
    await persist(job); await audit('fixture_completed', job.id);
  }
  function queueNext() {
    if (closing || activeId) return;
    const nextId = pending.shift();
    if (!nextId) return;
    const job = jobs.get(nextId);
    if (!job || job.status !== 'queued') { queueMicrotask(queueNext); return; }
    activeId = nextId;
    void (async () => {
      job.status = 'running'; job.stage = 'demo_intake'; job.progress = 15;
      job.updatedAt = now(); await persist(job); await audit('simulation_started', job.id);
      scheduleStep(job, 0);
    })().catch(e => markFailed(job, e));
  }
  function markFailed(job, error) {
    void (async () => {
      if (job.status === 'running') {
        job.status = 'failed'; job.stage = 'error'; job.updatedAt = now();
        job.error = { code: 'FIXTURE_ERROR', message: 'Local demonstration could not finish' };
        await persist(job); await audit('job_failed', job.id);
      }
      if (activeId === job.id) { activeId = null; queueNext(); }
    })();
    console.error('Local fixture failure:', error.message);
  }
  function scheduleStep(job, stage) {
    if (job.status !== 'running' || activeId !== job.id || closing) return;
    activeTimer = setTimeout(() => {
      void (async () => {
        if (job.status !== 'running' || activeId !== job.id) return;
        if (stage === 0) { job.stage = 'demo_processing'; job.progress = 55; }
        else if (stage === 1) { job.stage = 'demo_packaging'; job.progress = 85; }
        else { await finish(job); if (activeId === job.id) { activeId = null; queueNext(); } return; }
        job.updatedAt = now(); await persist(job); scheduleStep(job, stage + 1);
      })().catch(e => markFailed(job, e));
    }, stepMs);
  }
  async function createJob(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('BAD_REQUEST', 400, 'Expected job object');
    const isReal = payload.providerId === 'triposr-local';
    if (payload.providerId !== 'fixture-demo' && (!isReal || !realAdapter)) {
      fail('PROVIDER_UNAVAILABLE', 422, 'Real inference requires an explicitly enabled local operator session');
    }
    if (isReal && payload.confirmGpu !== true) fail('G2_CONFIRM_REQUIRED', 422, 'Explicit GPU consent is required for each image');
    if (isReal && realRun) fail('G2_BUSY', 409, 'A real GPU job is already running; no background queue');
    if (isReal && closing) fail('G2_SHUTDOWN', 503, 'Local service is stopping');
    if (!['image', 'text'].includes(payload.mode)) fail('BAD_MODE', 422, 'Expected mode image or text');
    if (jobs.size >= 1000 || pending.length >= MAX_QUEUE) fail('CAPACITY', 429, 'Local job limit reached');
    const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
    if (prompt.length > 1200) fail('PROMPT_TOO_LONG', 422, 'Maximum 1200 characters');
    if (payload.mode === 'text' && prompt.length < 3) fail('PROMPT_REQUIRED', 422, 'Enter a text description');
    if (isReal && payload.mode !== 'image') fail('G2_IMAGE_ONLY', 422, 'TripoSR accepts images only, not text-to-3D');
    if (payload.url || payload.webhook || payload.remotePath || payload.command) fail('FORBIDDEN_REMOTE_INPUT', 422, 'Remote URLs and filesystem paths are not accepted');
    let image = null, imageInfo = null;
    if (payload.mode === 'image') {
      if (!payload.image || typeof payload.image.base64 !== 'string' || payload.image.base64.length > MAX_IMAGE_BYTES * 1.4 + 16) fail('IMAGE_REQUIRED', 422, 'A local PNG, JPEG or WebP is required (8 MiB max)');
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload.image.base64) || payload.image.base64.length % 4 === 1) fail('BAD_IMAGE', 422, 'Invalid image encoding');
      image = Buffer.from(payload.image.base64, 'base64');
      imageInfo = sniffImage(image);
      if (!imageInfo || image.length > MAX_IMAGE_BYTES || payload.image.mime !== imageInfo.mime) fail('BAD_IMAGE', 422, 'Image signature, MIME or size not supported');
      // G3.28 structural gate BEFORE creating a job, writing media or taking any GPU permit.
      // Not a native decoder sandbox; the G2 worker must still apply Pillow bounds.
      try {
        preflightImageStructure(image, imageInfo.mime, {minDimension:isReal ? 64 : 1});
      } catch (error) {
        if (error instanceof ImageStructureError) fail('BAD_IMAGE_STRUCTURE', 422, 'Incomplete or unsupported PNG, JPEG or WebP image container');
        throw error;
      }
    }
    const id = randomUUID();
    // Reserve GPU lease BEFORE the first asynchronous disk operation.
    // Otherwise concurrent POST requests could both pass the busy check.
    let token = null;
    if (isReal) {
      let finishInitialization;
      const initialized = new Promise(resolve => { finishInitialization = resolve; });
      token = { jobId: id, controller: new AbortController(), promise: null,
        lease: null, initialized, finishInitialization };
      realRun = token;
    }
    const j = {
      schema: 'local3d.job.v1', id, providerId: payload.providerId, mode: payload.mode, prompt,
      simulation: !isReal, seed: isReal ? null : 12026, status: 'queued', stage: 'queued', progress: 0,
      createdAt: now(), updatedAt: now(), completedAt: null, error: null,
      source: image ? { name: sanitizeFileName(payload.image.filename), mime: imageInfo.mime, bytes: image.length } : null,
      assets: []
    };
    // No user-provided path or URL is used to construct a disk location.
    try {
      if (isReal) {
        try {
          await storageAdmission({jobsDir, sourceBytes:image.length});
        } catch (error) {
          if (error instanceof StorageAdmissionError) {
            fail(error.code, error.code==='G3_STORAGE_UNVERIFIED' ? 503 : 507, error.message);
          }
          throw error;
        }
        let permit;
        try {
          permit = await gpuLease.acquire({jobId:id});
        } catch (error) {
          if (error instanceof LeaseUnavailable) {
            fail(error.code, error.code === 'G2_SHARED_GPU_BUSY' ? 409 : 503, error.message);
          }
          throw error;
        }
        if (closing || token.controller.signal.aborted || realRun !== token) {
          await permit.release();
          fail('G2_SHUTDOWN', 503, 'Manual session stopped before GPU lease was ready');
        }
        token.lease = permit;
      }
      await fs.mkdir(jobFolder(id), { recursive: true });
      if (image) {
        await fs.writeFile(path.join(jobFolder(id), 'input' + imageInfo.ext), image, { flag: 'wx' });
        j.assets.push(recordAsset('source-image', 'source', imageInfo.mime, image, 'Original reference image'));
      }
      jobs.set(id, j);
      await persist(j); await audit('job_created', id, { provider: j.providerId, mode: j.mode });
      if (isReal) launchReal(j);
      else { pending.push(id); queueNext(); }
      return publicJob(j);
    } catch (error) {
      if (isReal && realRun === token && !token.promise) {
        realRun = null;
        if (token.lease) {
          try { await token.lease.release(); }
          catch (releaseError) { console.error('G2 lease requires operator attention:', releaseError.code || 'LEASE_ERROR'); }
        }
      }
      if (!j.assets.some(a => a.id === 'source-image')) jobs.delete(id);
      throw error;
    } finally {
      if (token) token.finishInitialization();
    }
  }
  async function cancelJob(job) {
    if (!['queued', 'running'].includes(job.status)) fail('ALREADY_FINISHED', 409, 'Job is no longer cancellable');
    if (job.providerId === 'triposr-local') {
      // Remains in cancelling until child process-tree exit is confirmed.
      job.status = 'cancelling'; job.stage = 'g2_stopping_worker'; job.progress = 0;
      job.updatedAt = now(); await persist(job); await audit('real_cancel_requested', job.id);
      realRun?.controller.abort();
      return publicJob(job);
    }
    const wasActive = job.id === activeId;
    if (wasActive && activeTimer) { clearTimeout(activeTimer); activeTimer = null; }
    job.status = 'cancelled'; job.stage = 'cancelled'; job.progress = 0;
    job.updatedAt = now(); await persist(job); await audit('cancelled', job.id);
    const idx = pending.indexOf(job.id);
    if (idx >= 0) pending.splice(idx, 1);
    if (wasActive) { activeId = null; queueNext(); }
    return publicJob(job);
  }

  async function reviewBenchmark(job) {
    if (!benchmarkReviewer || job.providerId !== 'triposr-local' || job.simulation ||
        job.status !== 'completed' || closing) {
      fail('G3_BENCHMARK_UNAVAILABLE', 422, 'Only completed local G2 jobs can be scored on CPU');
    }
    if (job.assets.some(asset => asset.id === 'benchmark-shape')) return publicJob(job);
    if (benchmarkReviews.has(job.id)) fail('G3_BENCHMARK_BUSY', 409, 'CPU benchmark already running for this job');
    const releaseCpu = reserveCpuReview('benchmark',job.id);
    const work = (async () => {
      const sourceAsset = job.assets.find(a => a.id === 'source-image');
      const modelAsset = job.assets.find(a => a.id === 'preview-glb');
      if (!sourceAsset || !modelAsset || modelAsset.mime !== 'model/gltf-binary') {
        fail('G3_BENCHMARK_UNVERIFIED', 422, 'Completed job has no verified source and GLB model');
      }
      // No arbitrary private customer media gets sent through the licensed
      // G3 source benchmark. Only the SHA-locked nine-reference catalog.
      const staticReport = JSON.parse(await fs.readFile(G3_PUBLIC_COVERAGE,'utf8'));
      if (staticReport.schema !== 'local3d.g3.benchmark-coverage.v1' ||
          staticReport.fixtureResults?.length !== 9) {
        fail('G3_BENCHMARK_UNVERIFIED', 503, 'Licensed G3 source catalog is invalid');
      }
      const fixture = staticReport.fixtureResults.find(x => x.sourceSha256 === sourceAsset.sha256);
      if (!fixture) fail('G3_BENCHMARK_NO_REFERENCE', 422,
        'This completed job has no licensed G3 benchmark reference');
      try {
        const attested = await getBenchmarkSource(fixture.fixtureId);
        if (attested.sha256 !== sourceAsset.sha256) {
          fail('G3_BENCHMARK_UNVERIFIED', 503, 'Pinned G3 source bytes changed');
        }
      } catch (e) {
        if (e instanceof HttpError) throw e;
        fail('G3_BENCHMARK_UNVERIFIED', 503, 'G3 source rights or SHA cannot be verified');
      }
      const modelFile = path.join(jobFolder(job.id),'output.glb');
      const modelStat = await fs.lstat(modelFile).catch(() => null);
      if (!modelStat || !modelStat.isFile() || modelStat.isSymbolicLink() ||
          modelStat.size !== modelAsset.bytes || modelStat.size > 64*1024*1024 ||
          sha(await fs.readFile(modelFile)) !== modelAsset.sha256) {
        fail('G3_BENCHMARK_UNVERIFIED', 422, 'Model GLB failed hash or size verification');
      }
      const outputFile = path.join(jobFolder(job.id),'benchmark-shape.json');
      await audit('g3_cpu_benchmark_started',job.id,{fixtureId:fixture.fixtureId});
      let raw,report;
      try {
        ({raw,report} = await benchmarkReviewer({
          jobsRoot:jobsDir,jobId:job.id,outputFile,
          sourceSha:sourceAsset.sha256,modelSha:modelAsset.sha256
        }));
      } catch {
        // A pinned CPU scanner may reject model provenance, an existing
        // conflicting report, timeout, or invalid geometry. Never disclose
        // internal paths or Python stderr in an HTTP response.
        fail('G3_BENCHMARK_UNVERIFIED',422,
          'CPU reference analysis refused the model or local provenance');
      }
      if (!Buffer.isBuffer(raw) || raw.length > 128*1024 ||
          report?.schema !== 'local3d.g3.manual-job-shape-evaluation.v1' ||
          report.fixtureId !== fixture.fixtureId ||
          report.imageSha256 !== sourceAsset.sha256 ||
          report.modelSha256 !== modelAsset.sha256 ||
          report.candidateEvidenceLane !== 'HASH_LINKED_LOCAL_COMPLETED_JOB_NOT_INDEPENDENT_GPU_ATTESTATION' ||
          report.printQualified !== false || report.approvedForPrinter !== false ||
          report.modelInferenceExecuted !== false || report.fabricationAction !== 'NONE' ||
          !['NO_GROUND_TRUTH_3D','POST_HOC_NORMALIZED_3D_SHAPE_DIAGNOSTIC'].includes(report.evaluation)) {
        fail('G3_BAD_BENCHMARK', 422, 'Unsafe or inconsistent benchmark score refused');
      }
      const referenceAvailable = fixture.sourceRights === 'PROJECT_ORIGINAL_PROCEDURAL';
      if (referenceAvailable !== (report.evaluation === 'POST_HOC_NORMALIZED_3D_SHAPE_DIAGNOSTIC') ||
          (referenceAvailable && (
             !report.shape || report.shape.sameInputBinary !== false ||
             report.shape.referenceSelfSimilarityOnly !== false ||
             !Number.isFinite(report.shape.bestView?.chamferL1Normalized) ||
             report.shape.bestView.chamferL1Normalized < 0)) ||
          (!referenceAvailable && report.shape !== null)) {
        fail('G3_BAD_BENCHMARK', 422, 'Model claims a nonexistent or unverified 3D reference');
      }
      const disk = await fs.readFile(outputFile).catch(() => null);
      if (!disk || sha(disk) !== sha(raw)) fail('G3_BAD_BENCHMARK',422,
        'CPU benchmark report cannot be verified on disk');
      job.assets.push(recordAsset('benchmark-shape','report','application/json',raw,
        'G3 CPU shape diagnostic — DRAFT, NOT PRINT QUALIFIED'));
      job.updatedAt = now();
      await persist(job);
      await audit('g3_cpu_benchmark_completed',job.id,{
        fixtureId:fixture.fixtureId,reportSha256:sha(raw)
      });
      return publicJob(job);
    })();
    benchmarkReviews.set(job.id,work);
    try { return await work; } finally { benchmarkReviews.delete(job.id); releaseCpu(); }
  }

  async function reviewGeometry(job) {
    if (!geometryReviewer || job.providerId !== 'triposr-local' || job.simulation ||
        job.status !== 'completed' || closing) {
      fail('G3_REVIEW_UNAVAILABLE', 422, 'Only completed manual G2 model jobs can be reviewed');
    }
    if (job.assets.some(asset => asset.id === 'geometry-qa')) return publicJob(job);
    if (reviews.has(job.id)) fail('G3_REVIEW_BUSY', 409, 'Geometry review for this job already underway');
    const releaseCpu = reserveCpuReview('geometry',job.id);
    const work = (async () => {
      const asset = job.assets.find(x => x.id === 'preview-glb');
      if (!asset || asset.mime !== 'model/gltf-binary') {
        fail('G3_UNVERIFIED_MODEL', 422, 'Job has no verified model artifact');
      }
      const modelFile = path.join(jobFolder(job.id), 'output.glb');
      const outputFile = path.join(jobFolder(job.id), 'geometry-qa.json');
      const stat = await fs.lstat(modelFile).catch(() => null);
      if (!stat || !stat.isFile() || stat.isSymbolicLink() ||
          stat.size !== asset.bytes || stat.size > 64 * 1024 * 1024) {
        fail('G3_UNVERIFIED_MODEL', 422, 'GLB does not match the job manifest');
      }
      const bytes = await fs.readFile(modelFile);
      if (sha(bytes) !== asset.sha256) {
        fail('G3_UNVERIFIED_MODEL', 422, 'GLB hash does not match the job manifest');
      }
      await audit('geometry_review_started', job.id);
      const { raw, report } = await geometryReviewer({ modelFile, outputFile });
      if (!Buffer.isBuffer(raw) || raw.length > 128 * 1024 ||
          report?.schema !== 'local3d.g3.geometry-qa.v1' ||
          report.modelSha256 !== asset.sha256 || report.printQualified !== false ||
          report.approvedForPrinter !== false || report.fabricationAction !== 'NONE') {
        fail('G3_BAD_REPORT', 422, 'CPU report integrity validation failed');
      }
      const disk = await fs.readFile(outputFile);
      if (sha(raw) !== sha(disk)) fail('G3_BAD_REPORT', 422, 'CPU report file mismatch');
      // Only now expose an allowlisted, verifiable report asset.
      job.assets.push(recordAsset('geometry-qa', 'report', 'application/json', raw, 'G3 topology review — not print qualified'));
      job.updatedAt = now();
      await persist(job);
      await audit('geometry_review_completed', job.id, { reportSha256: sha(raw) });
      return publicJob(job);
    })();
    reviews.set(job.id, work);
    try { return await work; }
    finally { reviews.delete(job.id); releaseCpu(); }
  }

  async function serveFile(res, file, contentType, method = 'GET', cache = false) {
    const stat = await fs.stat(file).catch(() => null);
    if (!stat || !stat.isFile()) fail('NOT_FOUND', 404, 'Asset not found');
    res.writeHead(200, {
      'Content-Type': contentType, 'Content-Length': stat.size,
      'Content-Disposition': 'inline', 'Cache-Control': cache ? 'public, max-age=3600' : 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    if (method === 'HEAD') { res.end(); return; }
    const stream = createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }
  async function serveVerifiedJobAsset(res,jobDir,asset,method) {
    let bytes;
    try {bytes=await readShaVerifiedJobAsset({jobDir,asset});}
    catch {fail('G347_ASSET_UNVERIFIED',409,'Stored job asset failed integrity verification');}
    res.writeHead(200,{
      'Content-Type':asset.mime,'Content-Length':bytes.length,
      'Content-Disposition':'inline','Cache-Control':'no-store',
      'X-Content-Type-Options':'nosniff'
    });
    res.end(method==='HEAD'?undefined:bytes);
  }
  const staticPaths = new Map([
    ['/', [path.join(ROOT, 'public', 'index.html'), 'text/html; charset=utf-8']],
    ['/app.js', [path.join(ROOT, 'public', 'app.js'), 'text/javascript; charset=utf-8']],
    ['/studio-preview.js', [path.join(ROOT, 'public', 'studio-preview.js'), 'text/javascript; charset=utf-8']],
    ['/styles.css', [path.join(ROOT, 'public', 'styles.css'), 'text/css; charset=utf-8']],
    ['/favicon.svg', [path.join(ROOT, 'public', 'favicon.svg'), 'image/svg+xml']],
    ['/vendor/three/build/three.module.js', [path.join(ROOT, 'node_modules', 'three', 'build', 'three.module.js'), 'text/javascript; charset=utf-8']],
    ['/vendor/three/build/three.core.js', [path.join(ROOT, 'node_modules', 'three', 'build', 'three.core.js'), 'text/javascript; charset=utf-8']],
    ['/vendor/three/examples/jsm/controls/OrbitControls.js', [path.join(ROOT, 'node_modules', 'three', 'examples', 'jsm', 'controls', 'OrbitControls.js'), 'text/javascript; charset=utf-8']],
    ['/vendor/three/examples/jsm/loaders/GLTFLoader.js', [path.join(ROOT, 'node_modules', 'three', 'examples', 'jsm', 'loaders', 'GLTFLoader.js'), 'text/javascript; charset=utf-8']],
    ['/vendor/three/examples/jsm/libs/meshopt_decoder.module.js', [path.join(ROOT, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'meshopt_decoder.module.js'), 'text/javascript; charset=utf-8']],
    ['/vendor/three/examples/jsm/utils/BufferGeometryUtils.js', [path.join(ROOT, 'node_modules', 'three', 'examples', 'jsm', 'utils', 'BufferGeometryUtils.js'), 'text/javascript; charset=utf-8']],
    ['/vendor/three/examples/jsm/utils/SkeletonUtils.js', [path.join(ROOT, 'node_modules', 'three', 'examples', 'jsm', 'utils', 'SkeletonUtils.js'), 'text/javascript; charset=utf-8']]
  ]);
  const server = http.createServer(async (req, res) => {
    try {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'sha256-" + IMPORT_HASH + "' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self' blob:; worker-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      const host = String(req.headers.host || '');
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) fail('HOST_DENIED', 403, 'Loopback host required');
      const requested = new URL(req.url, 'http://localhost');
      const pathname = requested.pathname;
      if (pathname.length > 150 || pathname.includes('\\') || /%2f|%5c/i.test(req.url || '')) fail('INVALID_PATH', 400, 'Invalid URL path');
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        const origin = req.headers.origin;
        if (origin && origin !== 'http://' + host) fail('ORIGIN_DENIED', 403, 'Cross-origin mutation rejected');
      }
      if (req.method === 'GET' && pathname === '/v1/health') return reply(res, 200, {
        schema: 'local3d.health.v1', service: 'ready', localOnly: true,
        inference: Boolean(realAdapter), status: realAdapter ? 'G2_MANUAL_OPT_IN' : 'G1_DEMO', jobs: jobs.size,
        gpuBusy: Boolean(realRun), cpuReviewBusy: Boolean(cpuReviewActive), autoGpuQueue: false, printing: false
      });
      if (req.method === 'GET' && pathname === '/v1/benchmarks/g3') {
        const report = JSON.parse(await fs.readFile(G3_PUBLIC_COVERAGE, 'utf8'));
        if (report.schema !== 'local3d.g3.benchmark-coverage.v1' ||
            report.fixtureCount !== 9 || report.modelInferenceExecuted !== false ||
            report.printQualified !== false ||
            !Array.isArray(report.fixtureResults) || report.fixtureResults.length !== 9) {
          fail('G3_BENCHMARK_UNVERIFIED', 503, 'Stored quality coverage is unavailable');
        }
        return reply(res, 200, report);
      }
      const fixtureSourcePath=pathname.match(/^\/v1\/benchmarks\/g3\/sources\/([^/]+)$/);
      if (req.method === 'GET' && fixtureSourcePath){
        try{return reply(res,200,await getBenchmarkSource(fixtureSourcePath[1]));}
        catch(error){
          if(error instanceof FixtureSourceError){
            fail(error.code,error.code==='G3_SOURCE_NOT_FOUND'?404:503,error.message);
          }
          throw error;
        }
      }
      if (req.method === 'GET' && pathname === '/v1/providers') return reply(res, 200, {
        schema: 'local3d.providers.v1',
        providers: PROVIDERS.map(p => p.id === 'triposr-local' ? {
          ...p, version: 'source-107cefd', licenseLane: 'MIT-source-weights+Apache-DINO',
          status: realAdapter ? 'MANUAL_OPT_IN' : 'STAGED_DISABLED',
          canStart: Boolean(realAdapter), canCancel: Boolean(realAdapter)
        } : p)
      });
      if (req.method === 'GET' && pathname === '/v1/jobs') {
        const all = [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50);
        return reply(res, 200, { schema: 'local3d.jobs.v1', jobs: all.map(publicJob) });
      }
      if (req.method === 'POST' && pathname === '/v1/jobs') return reply(res, 201, await createJob(await readBody(req)));
      const match = pathname.match(/^\/v1\/jobs\/([^/]+)(?:\/(cancel|review|benchmark|assets\/([^/]+)))?$/);
      if (match) {
        const id = match[1]; if (!isUuid(id)) fail('INVALID_JOB_ID', 404, 'Job not found');
        const job = jobs.get(id); if (!job) fail('NOT_FOUND', 404, 'Job not found');
        if (req.method === 'GET' && !match[2]) return reply(res, 200, publicJob(job));
        if (req.method === 'POST' && match[2] === 'cancel') return reply(res, 200, await cancelJob(job));
        if (req.method === 'POST' && match[2] === 'review') return reply(res, 200, await reviewGeometry(job));
        if (req.method === 'POST' && match[2] === 'benchmark') return reply(res, 200, await reviewBenchmark(job));
        if (['GET', 'HEAD'].includes(req.method) && match[3]) {
          const asset = job.assets.find(x => x.id === match[3]);
          if (!asset) fail('NOT_FOUND', 404, 'Asset not found');
          return await serveVerifiedJobAsset(res,jobFolder(id),asset,req.method);
        }
      }
      if (['GET', 'HEAD'].includes(req.method) && staticPaths.has(pathname)) {
        const [file, mime] = staticPaths.get(pathname);
        return await serveFile(res, file, mime, req.method, pathname !== '/');
      }
      fail('NOT_FOUND', 404, 'Route not found');
    } catch (e) {
      if (!(e instanceof HttpError)) console.error('Local 3D service:', e);
      errorReply(res, e);
    }
  });
  function sniffMimeExt(mime) { return mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg'; }
  const close = async () => {
    closing = true;
    if (realRun) {
      const token = realRun;
      token.controller.abort();
      // Wait for even a not-yet-persisted GPU reservation before shutdown.
      await token.initialized;
      // Adapter must kill its process tree before the HTTP server closes.
      if (token.promise) await token.promise.catch(() => {});
    }
    if (activeTimer) clearTimeout(activeTimer);
    // Do not close the job persistence layer while a bounded CPU reviewer
    // is still writing its report or manifest.
    if (reviews.size) await Promise.allSettled([...reviews.values()]);
    if (benchmarkReviews.size) await Promise.allSettled([...benchmarkReviews.values()]);
    for (const job of jobs.values()) {
      if (job.status === 'running' || job.status === 'queued' || job.status === 'cancelling') {
        job.status = 'interrupted'; job.stage = 'interrupted'; job.progress = 0;
        job.updatedAt = now();
        job.error = { code: 'SHUTDOWN', message: 'Local job stopped before completion' };
        await persist(job);
      }
    }
    await new Promise(resolve => server.close(resolve));
  };
  return { server, close, dataDir, jobs };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = '127.0.0.1';
  const port = Number(process.env.L3D_PORT || 4177);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) { console.error('Invalid local port'); process.exit(1); }
  const app = await createApp();
  app.server.listen(port, host, () => console.log('LOCAL3D_READY http://' + host + ':' + port + (process.env.L3D_ENABLE_TRIPOSR === '1' ? '  G2 manual opt-in; no automatic GPU work' : '  G1 fixture-only, no AI inference')));
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, async () => { await app.close(); process.exit(0); });
}
