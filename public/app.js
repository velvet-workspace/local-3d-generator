import * as THREE from 'three';
import { OrbitControls } from '/vendor/three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from '/vendor/three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from '/vendor/three/examples/jsm/libs/meshopt_decoder.module.js';
import { createStudioPreview } from './studio-preview.js';

const el = id => document.getElementById(id);
const state = { mode: 'image', provider: 'fixture-demo', providers: [], image: null, imageUrl: null, jobs: [], selected: null, currentModel: null, lastModelUrl: null, viewer: null, geometryCache: new Map(), geometryPending: new Set(), benchmarkCache: new Map(), benchmarkPending: new Set(), benchmarkCatalog: new Set() };
const stageNames = {
  queued: 'ממתין בתור', demo_intake: 'הדמיה: קליטת קלט',
  demo_processing: 'הדמיה: עיבוד', demo_packaging: 'הדמיה: הכנת GLB',
  fixture_ready: 'Fixture לדוגמה מוכן', cancelled: 'בוטלה', interrupted: 'הופסקה באתחול', error: 'נכשלה',
  g2_gpu_guard: 'אימות עומס GPU ו־Office', g2_verify_sources: 'אימות קוד ומודל מקומיים',
  g2_preprocess_image: 'בדיקת קובץ התמונה לפני הפעלת GPU',
  g2_loading_model: 'טעינת TripoSR לכרטיס המסך', g2_infer_image: 'יצירת מודל מתוך התמונה',
  g2_extract_mesh: 'חילוץ רשת תלת־ממדית', g2_export_glb: 'יצוא GLB', g2_completed: 'אימות התוצר',
  g2_ready_draft: 'תוצר AI מקומי מוכן · DRAFT', g2_stopping_worker: 'עצירת תהליך GPU'
};
const statusNames = {queued:'בתור',running:'מתבצעת',cancelling:'נעצרת',completed:'הושלמה',cancelled:'בוטלה',interrupted:'הופסקה',failed:'שגיאה'};
let toastTimer;

async function api(url, method = 'GET', body) {
  const res = await fetch(url, { method, headers: body ? {'Content-Type':'application/json'} : {}, body: body ? JSON.stringify(body) : undefined, cache:'no-store' });
  const json = await res.json();
  if (!res.ok) { const e = new Error(json.error?.message || 'Local request failed'); e.code = json.error?.code; throw e; }
  return json;
}
function toast(message) {
  const box = el('toast'); box.textContent = message; box.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => box.classList.remove('show'), 3300);
}
function readableDate(s) { try { return new Date(s).toLocaleTimeString('he-IL', { hour:'2-digit', minute:'2-digit' }); } catch { return '—'; } }
function selectedJob() { return state.jobs.find(j => j.id === state.selected); }
function sourceName(j) { return j.mode === 'image' ? (j.source?.name || 'תמונה') : (j.prompt ? j.prompt.slice(0, 34) : 'תיאור טקסט'); }

function initViewer() {
  const host = el('canvasHost');
  try {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, .02, 100);
    camera.position.set(2.9, 1.9, 3.6);
    const renderer = new THREE.WebGLRenderer({ antialias:true, alpha:true });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);
    const studio = createStudioPreview(renderer, scene);
    const studioButton = el('studioMode');
    studioButton.disabled = true;
    scene.add(new THREE.HemisphereLight(0xc5f7ed, 0x25384b, 2.6));
    const key = new THREE.DirectionalLight(0xffffff, 3.3); key.position.set(-2, 5, 3); scene.add(key);
    const fill = new THREE.DirectionalLight(0x7ae7e0, 1.4); fill.position.set(3, 1, -2); scene.add(fill);
    const grid = new THREE.GridHelper(6, 18, 0x385b64, 0x253e48); grid.position.y = -1.17; scene.add(grid);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enablePan = false; controls.minDistance = 1.2; controls.maxDistance = 12;
    controls.target.set(0, .05, 0);
    const render = () => renderer.render(scene, camera);
    studioButton.addEventListener('click', () => {
      try {
        const enabled = studio.setEnabled(studioButton.getAttribute('aria-pressed') !== 'true');
        studioButton.setAttribute('aria-pressed', String(enabled));
        studioButton.textContent = enabled ? 'סטודיו ✓' : 'סטודיו';
        render();
      } catch {
        studio.setEnabled(false);
        studioButton.setAttribute('aria-pressed', 'false');
        studioButton.textContent = 'סטודיו';
        toast('תאורת סטודיו אינה זמינה במכשיר זה; התצוגה הרגילה נשמרה.');
        render();
      }
    });
    controls.addEventListener('change', render);
    function resize() {
      const width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight);
      camera.aspect = width / height; camera.updateProjectionMatrix();
      renderer.setSize(width, height, false); render();
    }
    new ResizeObserver(resize).observe(host);
    resize();
    const reset = () => { camera.position.set(2.9, 1.9, 3.6); controls.target.set(0,.05,0); controls.update(); render(); };
    function disposeModel() {
      if (!state.currentModel) return;
      scene.remove(state.currentModel);
      state.currentModel.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
        mats.forEach(m => m.dispose());
      });
      state.currentModel = null; render();
    }
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    function show(url, real = false) {
      if (url === state.lastModelUrl) return;
      state.lastModelUrl = url;
      studioButton.disabled = true;
      disposeModel();
      if (!url) return;
      loader.load(url, gltf => {
        if (state.lastModelUrl !== url) return;
        const obj = gltf.scene;
        const box = new THREE.Box3().setFromObject(obj);
        const center = box.getCenter(new THREE.Vector3());
        obj.position.sub(center);
        const size = box.getSize(new THREE.Vector3());
        obj.scale.multiplyScalar(2.15 / Math.max(size.x,size.y,size.z, .001));
        scene.add(obj); state.currentModel = obj;
        studioButton.disabled = false;
        el('emptyState').hidden = true;
        el('demoWatermark').hidden = false;
        el('demoWatermark').textContent = real ? 'REAL LOCAL AI · DRAFT / NOT PRINT QUALIFIED' : 'DEMO FIXTURE · NOT AI GENERATED';
        el('viewerStatus').textContent = real ? 'REAL AI / DRAFT' : 'DEMO GLB / READY';
        reset();
      }, undefined, () => {
        el('viewerStatus').textContent = 'GLB / LOAD ERROR';
        el('emptyState').hidden = false;
        toast('הטעינה לתצוגה נכשלה; ניתן עדיין להוריד את הקובץ לבדיקה.');
      });
    }
    state.viewer = { show, reset };
  } catch {
    el('viewerStatus').textContent = 'WEBGL UNAVAILABLE';
    el('emptyState').querySelector('strong').textContent = 'WebGL אינו זמין בדפדפן';
    state.viewer = { show:() => {}, reset:() => {} };
  }
}

function renderHistory() {
  const host = el('history'); host.replaceChildren();
  el('jobCount').textContent = state.jobs.length + ' JOBS';
  if (!state.jobs.length) {
    const empty = document.createElement('div'); empty.className = 'history-empty';
    empty.textContent = 'עדיין אין משימות. ניתן ליצור משימת הדגמה באמצעות התמונה או הטקסט.';
    host.appendChild(empty); return;
  }
  for (const job of state.jobs) {
    const b = document.createElement('button'); b.type = 'button';
    b.className = 'history-item' + (state.selected === job.id ? ' selected' : '');
    const top = document.createElement('div'); top.className = 'history-item-top';
    const name = document.createElement('strong'); name.textContent = sourceName(job);
    const time = document.createElement('time'); time.textContent = readableDate(job.createdAt);
    top.append(name, time);
    const bottom = document.createElement('div'); bottom.className = 'history-item-bottom';
    const label = document.createElement('span'); label.className = 'hist-label';
    const dot = document.createElement('i'); dot.className = 'hist-dot ' + job.status;
    const status = document.createElement('span'); status.textContent = statusNames[job.status] || job.status;
    label.append(dot, status);
    const id = document.createElement('span'); id.textContent = job.id.slice(0, 8).toUpperCase(); id.dir = 'ltr';
    bottom.append(label, id); b.append(top,bottom);
    b.addEventListener('click', () => { state.selected = job.id; render(); });
    host.appendChild(b);
  }
}
function renderSelected() {
  const job = selectedJob();
  el('metricStatus').textContent = job ? statusNames[job.status] || job.status : 'אין משימה';
  el('metricProgress').textContent = job ? job.progress + '%' : '—';
  el('metricOutput').textContent = job?.status === 'completed' ? 'GLB' : '—';
  el('metricProvider').textContent = job?.providerId === 'triposr-local' ? 'TripoSR Local' : 'Fixture Lab';
  el('selectedJobId').textContent = job ? job.id.slice(0, 13).toUpperCase() : 'NO JOB SELECTED';
  el('detailMessage').textContent = job ? (stageNames[job.stage] || job.stage) +
    (job.simulation ? ' · תוצאת הדגמה ללא AI' : ' · הרצת AI מקומית ידנית · ללא אישור הדפסה') : 'לא נוצרה משימה עדיין.';
  el('progressFill').style.width = (job?.progress || 0) + '%';
  el('cancelJob').disabled = !(job && ['queued','running'].includes(job.status));
  el('copyManifest').disabled = !job;
  const ready = job?.status === 'completed' && job.assets.some(a => a.id === 'preview-glb');
  for (const id of ['downloadModel','downloadReport']) {
    const anchor = el(id); anchor.setAttribute('aria-disabled', ready ? 'false' : 'true');
    anchor.href = ready ? '/v1/jobs/' + encodeURIComponent(job.id) + '/assets/' + (id === 'downloadModel' ? 'preview-glb' : 'qa-report') : '#';
  }
  const hasGeometry = !!(job && job.assets.some(a => a.id === 'geometry-qa'));
  const realComplete = !!(ready && job.simulation === false && job.providerId === 'triposr-local');
  const scanner = el('reviewGeometry');
  scanner.hidden = !realComplete;
  scanner.disabled = !realComplete || hasGeometry;
  scanner.textContent = hasGeometry ? 'סריקת רשת הושלמה' : 'סריקת רשת (CPU)';
  const geomLink = el('downloadGeometry');
  geomLink.hidden = !hasGeometry;
  geomLink.setAttribute('aria-disabled', hasGeometry ? 'false' : 'true');
  geomLink.href = hasGeometry ? '/v1/jobs/' + encodeURIComponent(job.id) + '/assets/geometry-qa' : '#';
  const summary = el('geometrySummary');
  summary.hidden = !hasGeometry;
  if (hasGeometry && state.geometryCache.has(job.id)) {
    const g = state.geometryCache.get(job.id);
    summary.textContent = 'בדיקת CPU: ' + (g.topology?.everyObjectWatertight ? 'רשת סגורה' : 'קצוות פתוחים') +
      ' · נפח חיובי: ' + (g.topology?.everyObjectPositiveVolume ? 'כן' : 'לא') +
      ' · רכיבים: ' + (g.topology?.componentCount ?? 'לא ידוע') +
      ' · קנה מידה, עובי דופן וחוזק לא אומתו · אינו מאושר להדפסה.';
  } else if (hasGeometry) {
    summary.textContent = 'טוען דוח גאומטריה…';
    if (!state.geometryPending.has(job.id)) {
      state.geometryPending.add(job.id);
      void api('/v1/jobs/' + encodeURIComponent(job.id) + '/assets/geometry-qa')
        .then(report => state.geometryCache.set(job.id, report))
        .catch(() => state.geometryCache.set(job.id, {topology:{}, loadingFailed:true}))
        .finally(() => {
          state.geometryPending.delete(job.id);
          if (state.selected === job.id) renderSelected();
        });
    }
  }
  const sourceAsset = job?.assets.find(a => a.id === 'source-image');
  const hasBenchmark = !!job?.assets.some(a => a.id === 'benchmark-shape');
  const canBenchmark = realComplete && state.benchmarkCatalog.has(sourceAsset?.sha256);
  const scorer = el('scoreBenchmark');
  scorer.hidden = !canBenchmark;
  scorer.disabled = !canBenchmark || hasBenchmark;
  scorer.textContent = hasBenchmark ? 'השוואת G3 הושלמה' : 'השוואת G3 (CPU)';
  const benchmarkLink = el('downloadBenchmark');
  benchmarkLink.hidden = !hasBenchmark;
  benchmarkLink.setAttribute('aria-disabled',hasBenchmark ? 'false':'true');
  benchmarkLink.href = hasBenchmark ?
    '/v1/jobs/' + encodeURIComponent(job.id) + '/assets/benchmark-shape' : '#';
  const comparison = el('benchmarkShapeSummary');
  comparison.hidden = !hasBenchmark;
  if (hasBenchmark && state.benchmarkCache.has(job.id)) {
    const result=state.benchmarkCache.get(job.id);
    if (result.loadingFailed) {
      comparison.textContent = 'לא ניתן לטעון כרגע את דוח השוואת G3. נסה להוריד את הדוח המלא.';
    } else if (result.evaluation === 'NO_GROUND_TRUTH_3D') {
      comparison.textContent = 'השוואת G3 (CPU): לא קיים מודל מקור תלת־ממדי להשוואה. '
        + 'נבדקה טופולוגיה בלבד. אין ציון התאמה ואין אישור הדפסה.';
    } else {
      const n = result.shape?.bestView?.chamferL1Normalized;
      const distance = typeof n === 'number' && Number.isFinite(n) ? n.toFixed(5) : 'לא זמין';
      comparison.textContent = 'מרחק משטחים מנורמל (Chamfer): ' + distance
        + ' · נבחרה זווית מיטבית בדיעבד, וקנה המידה בוטל. '
        + 'זהו מדד אבחוני, לא אחוז דיוק ולא אישור הדפסה.';
    }
  } else if (hasBenchmark) {
    comparison.textContent = 'טוען דוח השוואת G3…';
    if (!state.benchmarkPending.has(job.id)) {
      state.benchmarkPending.add(job.id);
      void api('/v1/jobs/' + encodeURIComponent(job.id) + '/assets/benchmark-shape')
        .then(report => state.benchmarkCache.set(job.id,report))
        .catch(() => state.benchmarkCache.set(job.id,{loadingFailed:true}))
        .finally(() => {
          state.benchmarkPending.delete(job.id);
          if (state.selected === job.id) renderSelected();
        });
    }
  }
  const source = el('viewSource');
  const hasSource = !!(job && job.assets.some(a => a.id === 'source-image'));
  source.setAttribute('aria-disabled', hasSource ? 'false' : 'true');
  source.href = hasSource ? '/v1/jobs/' + encodeURIComponent(job.id) + '/assets/source-image' : '#';
  if (!ready) {
    state.viewer?.show(null);
    el('emptyState').hidden = false; el('demoWatermark').hidden = true;
    el('viewerStatus').textContent = job ? (job.simulation ? 'DEMO / ' : 'LOCAL AI / ') + job.status.toUpperCase() : 'READY / NO MODEL';
  } else {
    state.viewer?.show('/v1/jobs/' + encodeURIComponent(job.id) + '/assets/preview-glb', !job.simulation);
  }
}
function render() { renderHistory(); renderSelected(); }
async function refresh() {
  try {
    const result = await api('/v1/jobs');
    state.jobs = result.jobs;
    if (!state.selected && state.jobs.length) state.selected = state.jobs[0].id;
    render();
    el('healthStatus').textContent = 'READY'; el('hostStatus').textContent = '127.0.0.1';
  } catch {
    el('healthStatus').textContent = 'OFFLINE'; el('hostStatus').textContent = 'DISCONNECTED';
  }
}

function setMode(mode) {
  if (mode === 'text' && state.provider === 'triposr-local') {
    setProvider('fixture-demo');
    toast('TripoSR מקבל תמונה בלבד; תיאור טקסט אינו מנוע יצירה.');
  }
  state.mode = mode;
  el('imageMode').classList.toggle('active', mode === 'image');
  el('textMode').classList.toggle('active', mode === 'text');
  el('imageControls').hidden = mode !== 'image';
  el('promptRequirement').textContent = mode === 'text' ? 'חובה' : 'אופציונלי';
  el('formError').textContent = '';
}
function setProvider(id) {
  if (id === 'triposr-local' && !state.providers.some(p => p.id === id && p.canStart)) return;
  if (!['fixture-demo','triposr-local'].includes(id)) return;
  state.provider = id;
  if (id === 'triposr-local' && state.mode === 'text') setMode('image');
  el('providerFixture').classList.toggle('active-provider', id === 'fixture-demo');
  el('providerTripo').classList.toggle('active-provider', id === 'triposr-local');
  el('providerFixture').setAttribute('aria-pressed', id === 'fixture-demo' ? 'true' : 'false');
  el('providerTripo').setAttribute('aria-pressed', id === 'triposr-local' ? 'true' : 'false');
  el('gpuConsentWrap').hidden = id !== 'triposr-local';
  el('gpuConsent').checked = false;
  el('startJobLabel').textContent = id === 'triposr-local' ? 'צור מודל אמיתי (GPU)' : 'צור משימת DEMO';
  el('promptHint').textContent = id === 'triposr-local'
    ? 'TripoSR משתמש בתמונה בלבד. ההערות נשמרות במניפסט, אך אינן משפיעות על הגאומטריה.'
    : 'ב־G1 הטקסט נשמר למשימה בלבד ואינו משפיע על הגאומטריה.';
  el('formError').textContent = '';
}
async function loadProviders() {
  try {
    const data = await api('/v1/providers');
    state.providers = data.providers || [];
    const real = state.providers.find(p => p.id === 'triposr-local');
    el('providerTripo').disabled = !real?.canStart;
    el('providerTripo').classList.toggle('unavailable', !real?.canStart);
    el('triposrState').textContent = real?.canStart ? 'ידני · זמין' : 'כבוי';
    el('realProviderHealth').textContent = real?.canStart ? 'G2 · באישור בלבד' : 'כבוי (G1)';
    el('sessionBadge').textContent = real?.canStart ? 'G2 · MANUAL ONLY' : 'G1 · DEMO MODE';
    el('noticeVersion').textContent = real?.canStart ? 'v0.2.6 / G2' : 'v0.2.6 / G1';
    el('footerBuild').textContent = real?.canStart ? 'LOCAL3D / G2 MANUAL BUILD' : 'LOCAL3D / G1 DEVELOPMENT BUILD';
    if (real?.canStart) {
      el('noticeText').textContent = 'G2 ניסיוני בלבד: עבודה עם תמונות ממקור מהימן; תלויות Python ממתינות לבדיקת חולשות ושדרוג. נדרש אישור GPU נפרד לכל משימה, ללא תור אוטונומי. תוצאות DRAFT, לא להדפסה.';
    } else {
      el('noticeText').textContent = 'מצב G1: מודל DEMO בלבד. TripoSR הותקן בנפרד אך אינו מופעל במשימות. אין פעילות GPU אוטומטית.';
      setProvider('fixture-demo');
    }
  } catch {
    state.providers = [];
    el('providerTripo').disabled = true;
    setProvider('fixture-demo');
  }
}
function chooseImage(file) {
  if (!file) return;
  if (file.size > 8 * 1024 * 1024 || !['image/png','image/jpeg','image/webp'].includes(file.type)) {
    el('formError').textContent = 'התמונה צריכה להיות PNG, JPG או WebP ועד 8MB.'; return;
  }
  // A consent checkbox applies to exactly the image selected when checked.
  // Replacing the image (file, drop, fixture) always requires fresh consent.
  el('gpuConsent').checked = false;
  if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
  state.image = file; state.imageUrl = URL.createObjectURL(file);
  el('inputPreview').src = state.imageUrl; el('inputPreview').hidden = false;
  el('dropzone').classList.add('has-image');
  el('fileNote').textContent = file.name;
  el('clearImage').hidden = false;
  el('formError').textContent = '';
}
function clearImage() {
  el('gpuConsent').checked = false;
  state.image = null;
  if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
  state.imageUrl = null; el('inputPreview').removeAttribute('src');
  el('inputPreview').hidden = true; el('dropzone').classList.remove('has-image');
  el('fileNote').textContent = 'עד 8MB · הקובץ נשאר מקומי';
  el('imageInput').value = ''; el('clearImage').hidden = true;
}
function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('File read failed'));
    reader.readAsDataURL(file);
  });
}
async function startJob() {
  const b = el('startJob'); el('formError').textContent = '';
  if (state.mode === 'image' && !state.image) { el('formError').textContent = 'בחר תמונת מקור כדי להתחיל.'; return; }
  if (state.mode === 'text' && el('prompt').value.trim().length < 3) { el('formError').textContent = 'הזן תיאור של שלושה תווים לפחות.'; return; }
  if (state.provider === 'triposr-local' && !el('gpuConsent').checked) {
    el('formError').textContent = 'יש לאשר במפורש הפעלת GPU עבור משימה זו.';
    return;
  }
  b.disabled = true;
  try {
    const payload = { providerId:state.provider, mode:state.mode, prompt:el('prompt').value.trim() };
    if (state.provider === 'triposr-local') payload.confirmGpu = true;
    if (state.mode === 'image') payload.image = {
      filename:state.image.name, mime:state.image.type, base64:await toBase64(state.image)
    };
    const job = await api('/v1/jobs','POST',payload);
    state.selected = job.id;
    if (state.provider === 'triposr-local') {
      el('gpuConsent').checked = false;
      toast('המשימה נשלחה לבדיקת עומס GPU. אין תור רקע אוטומטי.');
    } else toast('נוצרה משימת DEMO. היא אינה מריצה מודל AI.');
    await refresh();
  } catch (e) { el('formError').textContent = (e.code ? e.code + ': ' : '') + e.message; }
  finally { b.disabled = false; }
}
async function cancelJob() {
  const job = selectedJob();
  if (!job || !['queued','running'].includes(job.status)) return;
  try {
    await api('/v1/jobs/' + encodeURIComponent(job.id) + '/cancel','POST');
    toast(job.providerId === 'triposr-local'
      ? 'נשלחה בקשה לעצירת GPU. המשימה תסומן מבוטלת לאחר סיום התהליך.'
      : 'משימת ה־DEMO בוטלה.');
    await refresh();
  } catch(e) { toast('לא ניתן לבטל: ' + e.message); }
}
async function loadBenchmarkSource() {
  const id = el('benchmarkSource').value;
  if (!id) { toast('יש לבחור תחילה מקרה בדיקה.'); return; }
  const button = el('loadBenchmarkSource');
  button.disabled = true;
  try {
    const data = await api('/v1/benchmarks/g3/sources/' + encodeURIComponent(id));
    if (data.schema !== 'local3d.g3.fixture-image.v1' || data.fixtureId !== id ||
        data.manualOnly !== true || data.confirmationGranted !== false ||
        data.modelInferenceExecuted !== false || data.image?.mime !== 'image/png') {
      throw new Error('Invalid licensed source fixture response');
    }
    const bytes = Uint8Array.from(atob(data.image.base64),char=>char.charCodeAt(0));
    if (bytes.length !== data.image.bytes || bytes.length > 8*1024*1024) {
      throw new Error('Invalid reference PNG length');
    }
    setMode('image');
    chooseImage(new File([bytes],data.image.filename,{type:'image/png'}));
    toast('תמונת מבחן מורשית נטענה לטופס. לא נוצרה משימה ולא אושר GPU.');
  } catch (e) {
    el('formError').textContent = 'טעינת תמונת המבחן נכשלה: ' + (e.code || e.message);
  } finally { button.disabled = false; }
}
el('loadBenchmarkSource').addEventListener('click',loadBenchmarkSource);
el('providerFixture').addEventListener('click', () => setProvider('fixture-demo'));
el('providerTripo').addEventListener('click', () => setProvider('triposr-local'));
el('imageMode').addEventListener('click', () => setMode('image'));
el('textMode').addEventListener('click', () => setMode('text'));
el('imageInput').addEventListener('change', e => chooseImage(e.target.files?.[0]));
el('dropzone').addEventListener('click', () => el('imageInput').click());
el('dropzone').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el('imageInput').click(); } });
el('dropzone').addEventListener('dragover', e => { e.preventDefault(); el('dropzone').classList.add('dragover'); });
el('dropzone').addEventListener('dragleave', () => el('dropzone').classList.remove('dragover'));
el('dropzone').addEventListener('drop', e => { e.preventDefault(); el('dropzone').classList.remove('dragover'); chooseImage(e.dataTransfer?.files?.[0]); });
el('clearImage').addEventListener('click', clearImage);
el('startJob').addEventListener('click', startJob);
el('cancelJob').addEventListener('click', cancelJob);
el('scoreBenchmark').addEventListener('click', async () => {
  const job = selectedJob();
  if (!job || job.simulation || job.status !== 'completed' ||
      !state.benchmarkCatalog.has(job.assets.find(a=>a.id==='source-image')?.sha256)) return;
  const button = el('scoreBenchmark');
  button.disabled = true;
  button.textContent = 'מודד רשת ב־CPU…';
  try {
    await api('/v1/jobs/' + encodeURIComponent(job.id) + '/benchmark','POST');
    toast('דוח G3 נוצר ב־CPU. אין אישור הדפסה ולא הופעל GPU.');
    await refresh();
  } catch (e) {
    toast('השוואת G3 נכשלה: ' + (e.code || e.message));
    await refresh();
  }
});
el('reviewGeometry').addEventListener('click', async () => {
  const job = selectedJob(), button = el('reviewGeometry');
  if (!job || job.simulation || job.status !== 'completed') return;
  button.disabled = true;
  button.textContent = 'מנתח רשת…';
  try {
    await api('/v1/jobs/' + encodeURIComponent(job.id) + '/review', 'POST');
    toast('בדיקת הגאומטריה הושלמה ב־CPU. הדוח אינו אישור הדפסה.');
    await refresh();
  } catch (e) {
    toast('סריקת הגאומטריה נכשלה: ' + (e.code || e.message));
    await refresh();
  }
});
el('refresh').addEventListener('click', refresh);
el('resetCamera').addEventListener('click', () => state.viewer?.reset());
el('copyManifest').addEventListener('click', async () => {
  const job = selectedJob(); if (!job) return;
  try { await navigator.clipboard.writeText(JSON.stringify(job,null,2)); toast('Manifest הועתק ללוח.'); }
  catch { toast('לא ניתן לגשת ללוח ההעתקה בדפדפן.'); }
});
async function loadBenchmark() {
  try {
    const report = await api('/v1/benchmarks/g3');
    if (report.schema !== 'local3d.g3.benchmark-coverage.v1' ||
        report.fixtureCount !== 9 || !Array.isArray(report.fixtureResults)) {
      throw new Error('Unsupported benchmark coverage report');
    }
    const count = report.fixturesWithPreviouslyObservedE2ERun;
    state.benchmarkCatalog = new Set(report.fixtureResults.map(x=>x.sourceSha256));
    el('benchmarkProgress').textContent = count + ' / ' + report.fixtureCount;
    el('benchmarkFill').style.width = (100 * count / report.fixtureCount).toFixed(2) + '%';
    el('benchmarkSummary').textContent = count + ' הרצת AI קודמת שנצפתה · ' +
      report.fixturesAwaitingRecordedOutput + ' מקרי בדיקה ללא תוצר · נתונים שמורים בלבד';
    const names = {
      '01-orb-alpha':'כדור · רקע שקוף',
      '02-orb-opaque':'כדור · רקע אטום',
      '03-hollow-vase':'אגרטל חלול',
      '04-torus-hole':'טבעת עם חור',
      '05-disconnected-pair':'שני עצמים מופרדים',
      '06-thin-chair':'כיסא בעל חלקים דקים',
      '07-gear-opaque':'גלגל שיניים',
      '08-arch-opaque':'קשת עם חלל',
      '09-upstream-chair':'כיסא מקור · TripoSR'
    };
    const ul = el('benchmarkCases');
    ul.replaceChildren();
    for (const item of report.fixtureResults) {
      const li = document.createElement('li');
      const label = names[item.fixtureId] || item.fixtureId;
      const state = item.coverage === 'PREVIOUSLY_OBSERVED_REAL_E2E_OUTPUT'
        ? 'תוצר AI קודם, DRAFT'
        : item.coverage === 'HASHED_LOCAL_JOB_NO_INDEPENDENT_GPU_ATTESTATION'
          ? 'רשומת מודל מקומית · לא אומתה חיצונית'
          : 'ממתין לעיבוד AI';
      li.textContent = label + ' — ' + state;
      ul.append(li);
    }
  } catch {
    state.benchmarkCatalog = new Set();
    el('benchmarkProgress').textContent = 'לא זמין';
    el('benchmarkSummary').textContent = 'אין כרגע דוח ביצועים מאומת. לא תופעל עבודת AI.';
  }
}
initViewer();
await loadProviders();
await loadBenchmark();
await refresh();
setInterval(refresh, 1000);
