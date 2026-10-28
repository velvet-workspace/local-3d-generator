// Optional real-textured GLB verification; input model is never added to the repository.
// Usage: node tools/preview-optimizer/qa-textured.mjs approved.glb approved.preview.glb
// No model inference, no printer, no network assets and no write to model files.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {MeshoptDecoder} from 'meshoptimizer';
import {chromium} from 'playwright-core';
import {createFixtureBuffer} from '../../server/fixture.js';
import {createApp} from '../../server/index.js';

const [input,output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node qa-textured.mjs <approved.glb> <approved.preview.glb>');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const item of [input,output]) {
  const stat = await fs.lstat(item);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 20 || stat.size > 64*1024*1024) {
    throw new Error('Textured smoke requires approved ordinary GLB files, each <=64 MiB');
  }
}
const a = await fs.readFile(input), b = await fs.readFile(output);
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({'meshopt.decoder':MeshoptDecoder});
const source = await io.readBinary(a), preview = await io.readBinary(b);
const textures = doc => doc.getRoot().listTextures().map(t=>({
  hash:hash(t.getImage()||Buffer.alloc(0)), mime:t.getMimeType(),
}));
const t0 = textures(source), t1 = textures(preview);
assert.ok(t0.length>0,'Expected an actual GLB with embedded textures');
assert.deepEqual(t1,t0,'Texture payloads/mimes must be byte-identical after geometry-only optimization');
const scenes = doc => doc.getRoot().listScenes().length;
assert.equal(scenes(source),scenes(preview),'Scene count changed');

const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'vf-textured-glb-'));
const screenshotDir=path.resolve('runtime/qa/dioramas-textured-20261028');
await fs.mkdir(screenshotDir,{recursive:true});
const browserExecutable=process.env.LOCAL3D_QA_BROWSER||(process.platform==='win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : process.platform==='darwin' ? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    : '/usr/bin/chromium');
let app=null,browser=null;
const errors=[],foreignRequests=[];
try{
  const fixture=path.join(tmp,'demo.glb');
  await fs.writeFile(fixture,createFixtureBuffer());
  app=await createApp({dataDir:path.join(tmp,'data'),fixtureFile:fixture,stepMs:125});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+app.server.address().port;
  browser=await chromium.launch({executablePath:browserExecutable,headless:true,
    args:['--no-first-run','--disable-extensions','--use-gl=angle',
      '--use-angle=swiftshader','--enable-unsafe-swiftshader']});

  const capture=async (buffer,label,initialJob) => {
    const page=await browser.newPage({viewport:{width:1440,height:950},locale:'he-IL'});
    page.on('pageerror',error=>errors.push(label+':'+error.message));
    page.on('console',msg=>{if(msg.type()==='error')errors.push(label+':'+msg.text());});
    page.on('request',req=>{if(!req.url().startsWith(origin+'/')&&!req.url().startsWith('blob:')&&!req.url().startsWith('data:'))
      foreignRequests.push(req.url());});
    let intercepted=0;
    await page.route('**/assets/preview-glb',async route=>{
      intercepted++;await route.fulfill({status:200,contentType:'model/gltf-binary',body:buffer});
    });
    await page.goto(origin,{waitUntil:'networkidle',timeout:30000});
    if(initialJob){
      await page.locator('#textMode').click();
      await page.locator('#prompt').fill('authorized textured WebGL fixture');
      await page.locator('#startJob').click();
    }
    await page.waitForFunction(()=>document.querySelector('#viewerStatus')?.textContent==='DEMO GLB / READY',null,{timeout:50000});
    await page.waitForTimeout(350);
    const pixels=await page.locator('#canvasHost canvas').screenshot();
    await page.locator('#viewport').screenshot({path:path.join(screenshotDir,label+'.png')});
    assert.ok(intercepted>0,'Expected GLB asset interception');
    await page.close();
    return {pixels,intercepted};
  };

  const first=await capture(a,'source',true);
  const second=await capture(b,'preview',false);
  const delta=await (async()=>{
    // Decodes the two actual screenshot rasters in a browser canvas, no image uploads.
    const page=await browser.newPage();
    await page.goto(origin);
    const value=await page.evaluate(async ([x,y])=>{
      const decode=async data=>{
        const img=new Image();img.src='data:image/png;base64,'+data;await img.decode();
        const canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;
        const ctx=canvas.getContext('2d',{willReadFrequently:true});
        ctx.drawImage(img,0,0);return ctx.getImageData(0,0,img.width,img.height).data;
      };
      const l=await decode(x),r=await decode(y);
      if(l.length!==r.length)throw new Error('Canvas dimension mismatch');
      let total=0;
      for(let i=0;i<l.length;i+=4)for(let c=0;c<3;c++)total+=Math.abs(l[i+c]-r[i+c]);
      return Math.round(total/(l.length/4*3)*1000)/1000;
    },[first.pixels.toString('base64'),second.pixels.toString('base64')]);
    await page.close();return value;
  })();
  assert.ok(delta<3,'Textured product geometry differs too much in browser rendering');
  assert.deepEqual(errors,[],'WebGL console errors');
  assert.deepEqual(foreignRequests,[],'Unexpected external browser requests');
  assert.equal(hash(await fs.readFile(input)),hash(a),'Source asset was modified during QA');
  assert.equal(hash(await fs.readFile(output)),hash(b),'Optimized asset was modified during QA');
  console.log('TEXTURED_GLB_BROWSER_PASS '+JSON.stringify({browser:browser.version(),textures:t0,
    sourceBytes:a.length,previewBytes:b.length,savedPercent:Math.round((1-b.length/a.length)*10000)/100,
    meanRgbDelta:delta,sourceSha256:hash(a),previewSha256:hash(b),
    screenshotDir,modelSource:'license-verified-upstream-local-only',originalAssetsUnchanged:true}));
}catch(error){
  console.error('TEXTURED_GLB_BROWSER_FAIL '+(error.stack||error));process.exitCode=1;
}finally{
  await browser?.close().catch(()=>{});
  await app?.close().catch(()=>{});
  await fs.rm(tmp,{recursive:true,force:true});
}
