// Browser smoke: an optimized derivative must be renderable by LOCAL3D's actual GLTFLoader.
// Playwright intercepts just the browser asset response; server output and source GLB are untouched.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { createFixtureBuffer } from '../../server/fixture.js';
import { createApp } from '../../server/index.js';
import { optimizeApprovedPreview } from './optimize.mjs';

const hash = x => createHash('sha256').update(x).digest('hex');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vf-preview-browser-'));
const evidence = path.resolve('runtime/qa/dioramas-optimized-preview');
await fs.mkdir(evidence,{recursive:true});
const sourcePath = path.join(dir,'original.glb');
const outputPath = path.join(dir,'original.preview.glb');
await fs.writeFile(sourcePath,createFixtureBuffer());
const meta = await optimizeApprovedPreview(sourcePath,outputPath);
const optimized = await fs.readFile(outputPath);
const browserExecutable = process.env.LOCAL3D_QA_BROWSER || (process.platform === 'win32' ?
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' :
  process.platform === 'darwin' ? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' : '/usr/bin/chromium');
let app, browser;
const errors = [];
try {
  app = await createApp({dataDir:path.join(dir,'data'),fixtureFile:sourcePath,stepMs:125});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  browser = await chromium.launch({executablePath:browserExecutable,headless:true,
    args:['--no-first-run','--disable-extensions','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const makePage = async () => {
    const page = await browser.newPage({viewport:{width:1440,height:950},locale:'he-IL'});
    page.on('pageerror',e=>errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
    return page;
  };
  const originalPage = await makePage();
  await originalPage.goto(base,{waitUntil:'networkidle'});
  await originalPage.locator('#textMode').click();
  await originalPage.locator('#prompt').fill('WebGL fixture only');
  await originalPage.locator('#startJob').click();
  await originalPage.waitForFunction(()=>document.querySelector('#viewerStatus')?.textContent==='DEMO GLB / READY',null,{timeout:15000});
  const originalPixels = await originalPage.locator('#canvasHost canvas').screenshot();
  await originalPage.locator('#viewport').screenshot({path:path.join(evidence,'original.png')});
  await originalPage.close();

  const optimizedPage = await makePage();
  let intercepted = 0;
  await optimizedPage.route('**/assets/preview-glb',async route=>{
    intercepted++;
    await route.fulfill({status:200,contentType:'model/gltf-binary',body:optimized});
  });
  await optimizedPage.goto(base,{waitUntil:'networkidle'});
  await optimizedPage.waitForFunction(()=>document.querySelector('#viewerStatus')?.textContent==='DEMO GLB / READY',null,{timeout:15000});
  assert.ok(intercepted>0,'WebGL viewer never requested optimized fixture');
  const optimizedPixels = await optimizedPage.locator('#canvasHost canvas').screenshot();
  assert.ok(optimizedPixels.length>2000,'Optimized mesh did not render');
  const pixelComparison = await optimizedPage.evaluate(async ({ original, compressed }) => {
    async function decode(base64) {
      const image = new Image();
      image.src = 'data:image/png;base64,' + base64;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d', { willReadFrequently:true });
      ctx.drawImage(image,0,0);
      return { width:image.width, height:image.height, pixels:ctx.getImageData(0,0,canvas.width,canvas.height).data };
    }
    const a = await decode(original), b = await decode(compressed);
    if(a.width !== b.width || a.height !== b.height) throw new Error('Mismatched canvas sizes');
    let delta = 0;
    for(let i=0;i<a.pixels.length;i+=4) {
      for(let channel=0;channel<3;channel++) delta += Math.abs(a.pixels[i+channel] - b.pixels[i+channel]);
    }
    return { width:a.width,height:a.height,meanRgbAbsDifference:Math.round(delta/(a.width*a.height*3)*1000)/1000 };
  }, { original:originalPixels.toString('base64'),compressed:optimizedPixels.toString('base64') });
  assert.ok(pixelComparison.meanRgbAbsDifference < 2, 'Web preview visually diverges from baseline');
  await optimizedPage.locator('#viewport').screenshot({path:path.join(evidence,'optimized.png')});
  await optimizedPage.locator('#studioMode').click();
  assert.equal(await optimizedPage.locator('#studioMode').getAttribute('aria-pressed'),'true');
  const studioPixels = await optimizedPage.locator('#canvasHost canvas').screenshot();
  assert.notEqual(hash(optimizedPixels),hash(studioPixels));
  await optimizedPage.locator('#viewport').screenshot({path:path.join(evidence,'optimized-studio.png')});
  assert.deepEqual(errors,[],'Browser parse/rasterization errors');
  console.log('OPTIMIZED_GLB_BROWSER_PASS '+JSON.stringify({
    browserVersion:browser.version(),browserExecutable,optimizedAssetIntercepted:intercepted,sourceBytes:meta.sourceBytes,
    previewBytes:meta.previewBytes,pixelComparison,sourceCanvasSha256:hash(originalPixels),
    previewCanvasSha256:hash(optimizedPixels),studioCanvasSha256:hash(studioPixels),screenshots:evidence,
    sourceUntouched:true
  }));
  await optimizedPage.close();
} catch(error) {
  console.error('OPTIMIZED_GLB_BROWSER_FAIL '+(error.stack||error));
  process.exitCode=1;
} finally {
  if(browser)await browser.close().catch(()=>{});
  if(app)await app.close().catch(()=>{});
  await fs.rm(dir,{recursive:true,force:true});
}
