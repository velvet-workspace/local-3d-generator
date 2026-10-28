import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createApp } from '../server/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'runtime', 'qa', new Date().toISOString().replace(/[:.]/g,'-'));
await fs.mkdir(output, { recursive: true });
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'local3d-browser-'));
const executablePath = process.env.LOCAL3D_QA_BROWSER || (process.platform === 'win32' ?
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' :
  process.platform === 'darwin' ? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' : '/usr/bin/chromium');
let app = null, browser = null, page = null;
const messages = [], requests = [], phases = [];
const pushPhase = (name, result = 'PASS') => phases.push({ name, result, at: new Date().toISOString() });
const hash = buf => createHash('sha256').update(buf).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAY0lEQVR4nO3PQQ3AIADAQMAOrvCF14ngcVnSU9DOfe74s6UDXjWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgfWv2AaqHnAIRAAAAAElFTkSuQmCC', 'base64');
let port = 0;
try {
  app = await createApp({dataDir:path.join(temp,'data'), fixtureFile:path.join(temp,'demo.glb'), stepMs:210});
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  port = app.server.address().port;
  const base = 'http://127.0.0.1:' + port;
  browser = await chromium.launch({ executablePath, headless:true, args:[
    '--no-first-run', '--disable-extensions',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'
  ] });
  page = await browser.newPage({ viewport:{width:1440,height:950}, locale:'he-IL', deviceScaleFactor:1, acceptDownloads:true });
  page.on('pageerror',e=>messages.push({type:'pageerror',message:e.message}));
  page.on('console',msg=>{ if(msg.type()==='error') messages.push({type:'console',message:msg.text(),source:msg.location().url}); });
  page.on('response',response=>{ if(response.status()>=400) messages.push({type:'http',status:response.status(),url:response.url()}); });
  page.on('request',req=>{const u=req.url(); if(!u.startsWith(base+'/') && !u.startsWith('data:') && !u.startsWith('blob:')) requests.push(u);});
  const result = await page.goto(base, { waitUntil:'networkidle' });
  assert.equal(result.status(),200);
  const csp = result.headers()['content-security-policy'] || '';
  assert.ok(csp.includes("'wasm-unsafe-eval'"), 'Only WebAssembly compilation is allowed for Meshopt decoder');
  assert.equal(csp.includes("'unsafe-eval'"), false, 'JavaScript eval must remain forbidden');
  assert.ok(csp.includes("connect-src 'self' blob:"), 'Embedded GLB PBR textures require local blob fetching');
  assert.ok(!csp.includes('https:'), 'No blanket external HTTPS access from viewer CSP');
  // Execute the probe inside an actual same-origin module script; Playwright page.evaluate
  // is a DevTools execution context and does NOT enforce webpage CSP restrictions.
  const securityPage = await browser.newPage();
  await securityPage.route('**/app.js', async route => {
    const js = await fs.readFile(path.join(root,'public','app.js'),'utf8');
    const suffix = "\nwindow.__cspProbe = [eval, Function].map((ctor, i) => { " +
      "try {if (i === 0) ctor('2+2'); else new ctor('return 2+2')(); return 'ALLOWED';} " +
      "catch (e) {return e.name;} });\n";
    await route.fulfill({status:200,contentType:'text/javascript',body:js+suffix});
  });
  await securityPage.goto(base, {waitUntil:'load'});
  await securityPage.waitForFunction(() => Array.isArray(window.__cspProbe),null,{timeout:8000});
  const evalGates = await securityPage.evaluate(() => window.__cspProbe);
  assert.deepEqual(evalGates, ['EvalError','EvalError'], 'CSP must still forbid dynamic JavaScript compilation');
  await securityPage.close();
  await page.locator('#healthStatus').getByText('READY').waitFor({timeout:6000});
  await page.waitForFunction(()=>document.querySelector('#benchmarkProgress')?.textContent?.includes('1 / 9'),null,{timeout:8000});
  assert.equal(await page.locator('#benchmarkProgress').getAttribute('dir'),'ltr','Benchmark fractions must not be reordered by Hebrew RTL');
  await page.locator('#emptyState').waitFor();
  assert.equal(await page.locator('.history-item').count(),0);
  assert.equal(await page.locator('#metricStatus').textContent(),'אין משימה');
  const desktopStart = path.join(output,'01-empty-desktop.png');
  await page.screenshot({path:desktopStart,fullPage:true});
  pushPhase('Desktop initial UI, Hebrew RTL, local health, empty state');
  await page.locator('#benchmarkSource').selectOption('04-torus-hole');
  await page.locator('#loadBenchmarkSource').click();
  await page.waitForFunction(()=>document.querySelector('#fileNote')?.textContent==='G3-04-torus-hole.png',null,{timeout:9000});
  assert.equal(await page.locator('#inputPreview').isVisible(),true);
  assert.equal((await(await page.request.get(base+'/v1/jobs')).json()).jobs.length,0,'Loading a licensed image must never create a job');
  assert.equal(await page.locator('#gpuConsent').isChecked(),false);
  await page.screenshot({path:path.join(output,'G3-licensed-source-loaded-no-job.png'),fullPage:true});
  await page.locator('#clearImage').click();
  pushPhase('G3 licensed fixture image loads locally with no job or GPU consent');
  // Run text-based fixture job.
  await page.locator('#textMode').click();
  assert.equal(await page.locator('#imageControls').isHidden(),true);
  await page.locator('#prompt').fill('כד קרמיקה עגול, דוגמת טקסט בלבד');
  await page.locator('#startJob').click();
  await page.waitForFunction(() => document.querySelector('#metricStatus')?.textContent?.trim() === 'הושלמה', null,{timeout:15000});
  await page.waitForFunction(() => document.querySelector('#viewerStatus')?.textContent === 'DEMO GLB / READY',null,{timeout:20000});
  assert.equal(await page.locator('#demoWatermark').isVisible(),true);
  assert.equal(await page.locator('#canvasHost canvas').count(),1);
  const glbHref = await page.locator('#downloadModel').getAttribute('href');
  assert.match(glbHref,/\/assets\/preview-glb$/);
  assert.equal(await page.locator('#downloadReport').getAttribute('aria-disabled'),'false');
  const report = await (await page.request.get(base+(await page.locator('#downloadReport').getAttribute('href')))).json();
  assert.equal(report.geometryStatus,'DRAFT');
  assert.equal(report.printQualified,false);
  const modelDownload = await page.request.get(base+glbHref);
  assert.equal(modelDownload.status(),200);
  assert.equal((await modelDownload.body()).subarray(0,4).toString('ascii'),'glTF');
  const desktopComplete = path.join(output,'02-completed-desktop.png');
  await page.screenshot({path:desktopComplete,fullPage:true});
  pushPhase('Text fixture job, GLB viewport, DRAFT report, no AI');
  // Dioramas-inspired studio preview is opt-in, local-only and never changes GLB bytes.
  const studioMode = page.locator('#studioMode');
  assert.equal(await studioMode.getAttribute('aria-pressed'), 'false');
  assert.equal(await studioMode.isEnabled(), true);
  const normalPixels = await page.locator('#canvasHost canvas').screenshot();
  await studioMode.click();
  assert.equal(await studioMode.getAttribute('aria-pressed'), 'true');
  assert.notEqual(hash(normalPixels), hash(await page.locator('#canvasHost canvas').screenshot()),
    'Studio lighting must visibly change rendered pixels');
  await page.screenshot({path:path.join(output,'02b-studio-preview.png'),fullPage:true});
  await studioMode.click();
  assert.equal(await studioMode.getAttribute('aria-pressed'), 'false');
  const unchangedGlb = await page.request.get(base+glbHref);
  assert.equal(hash(await unchangedGlb.body()), hash(await modelDownload.body()),
    'Preview mode must never modify the source/downloaded GLB');
  pushPhase('Opt-in studio light visibly changes pixels, restores baseline and preserves GLB SHA');
  // Confirm actual 3D orbit changes the rendered page, not just an HTML element.
  const viewport = page.locator('#viewport');
  const rect = await viewport.boundingBox();
  assert.ok(rect && rect.width>200 && rect.height>200);
  const x=rect.x+rect.width*.5,y=rect.y+rect.height*.5;
  const before = await viewport.screenshot();
  await page.mouse.move(x-60,y-20); await page.mouse.down(); await page.mouse.move(x+110,y+35,{steps:16}); await page.mouse.up();
  await page.waitForTimeout(250);
  const after = await viewport.screenshot();
  assert.notEqual(hash(before),hash(after),'Viewport pixels unchanged after orbit drag');
  await page.locator('#resetCamera').click();
  await page.waitForTimeout(150);
  await page.screenshot({path:path.join(output,'03-rotated-and-reset.png'),fullPage:true});
  pushPhase('OrbitControls visible pixel change and camera reset');
  // Test cancellation - no fabricated output.
  await page.locator('#startJob').click();
  await page.locator('#cancelJob').click({timeout:5000});
  await page.waitForFunction(()=>document.querySelector('#metricStatus')?.textContent?.trim()==='בוטלה',null,{timeout:9000});
  assert.equal(await page.locator('#downloadModel').getAttribute('aria-disabled'),'true');
  assert.equal(await page.locator('#demoWatermark').isHidden(),true);
  pushPhase('Cancellation prevents GLB output and resets preview');
  // Verify image mode, source and history selection.
  await page.locator('#imageMode').click();
  await page.locator('#imageInput').setInputFiles({name:'licensed-qa.png',mimeType:'image/png',buffer:png});
  await page.locator('#inputPreview').waitFor({state:'visible'});
  await page.locator('#startJob').click();
  await page.waitForFunction(()=>document.querySelector('#metricStatus')?.textContent?.trim()==='הושלמה',null,{timeout:15000});
  assert.equal(await page.locator('#viewSource').getAttribute('aria-disabled'),'false');
  assert.equal((await page.locator('.history-item').count()),3);
  await page.locator('#demoWatermark').waitFor({state:'visible',timeout:10000});
  const sourceResponse = await page.request.get(base+(await page.locator('#viewSource').getAttribute('href')));
  assert.equal(sourceResponse.status(),200);
  assert.equal(hash(await sourceResponse.body()),hash(png));
  await page.screenshot({path:path.join(output,'04-image-job.png'),fullPage:true});
  const selected = await page.locator('#selectedJobId').textContent();
  await page.locator('.history-item').nth(2).click();
  assert.notEqual(await page.locator('#selectedJobId').textContent(),selected);
  await page.locator('.history-item').first().click();
  assert.equal(await page.locator('#selectedJobId').textContent(),selected);
  pushPhase('Image upload, source asset, history navigation, completed preview');
  // Responsive viewport on same local UI.
  const mobile = await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1,locale:'he-IL'});
  mobile.on('pageerror',e=>messages.push({type:'mobile_pageerror',message:e.message}));
  const mobileResult=await mobile.goto(base,{waitUntil:'networkidle'});
  assert.equal(mobileResult.status(),200);
  await mobile.locator('#healthStatus').getByText('READY').waitFor({timeout:15000});
  await mobile.screenshot({path:path.join(output,'05-mobile.png'),fullPage:true});
  const dims=await mobile.evaluate(()=>({innerWidth,scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth}));
  assert.ok(dims.scrollWidth<=dims.innerWidth+1,'Unexpected horizontal overflow: '+JSON.stringify(dims));
  assert.equal(await mobile.locator('#demoWatermark').isVisible(),true);
  await mobile.close();
  pushPhase('390px mobile responsive layout and completed GLB');
  assert.deepEqual(requests,[],'Unapproved external network request observed');
  assert.deepEqual(messages,[],'Browser console or page errors detected');
  pushPhase('No JavaScript errors, CSP complaints, or external URL requests');
  console.log('BROWSER_QA_PASS '+JSON.stringify({ count:phases.length, output, browser:browser.version() }));
} catch (e) {
  pushPhase('QA interrupted', 'FAIL: '+String(e?.message||e));
  if(page) await page.screenshot({path:path.join(output,'FAIL-current.png'),fullPage:true,timeout:8000}).catch(()=>{});
  console.error('BROWSER_QA_FAIL '+String(e?.stack||e));
  process.exitCode=1;
} finally {
  const evidence={schema:'local3d.browser-qa.v1',at:new Date().toISOString(),platform:process.platform,port,phases,
    browserVersion:browser?.version()||null, browserExecutable:executablePath, messages, externalRequests:requests,
    screenshots:(await fs.readdir(output).catch(()=>[])).filter(x=>x.endsWith('.png'))};
  await fs.writeFile(path.join(output,'report.json'), JSON.stringify(evidence,null,2)+'\n');
  if(browser) await browser.close().catch(()=>{});
  if(app) await app.close().catch(()=>{});
  await fs.rm(temp,{recursive:true,force:true}).catch(()=>{});
}
