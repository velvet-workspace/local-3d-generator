import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const target=process.env.IMG2_ADAPTER_PATH?pathToFileURL(process.env.IMG2_ADAPTER_PATH).href:new URL('../scripts/experiments/img2threejs-adapter.mjs',import.meta.url);
const {parseArgs,inside,pinnedCheckout,execute,PINNED_UPSTREAM}=await import(target);

test('typed doctor input is accepted, unknown operations are blocked',()=>{
  assert.equal(parseArgs(['doctor','--upstream','./vendor']).command,'doctor');
  assert.throws(()=>parseArgs(['exec','--upstream','./vendor']),{code:'COMMAND_NOT_ALLOWED'});
  assert.throws(()=>parseArgs(['doctor','--command','git init']),{code:'INVALID_ARGUMENT'});
  assert.throws(()=>parseArgs(['doctor']),{code:'MISSING_UPSTREAM'});
  assert.throws(()=>parseArgs(['doctor','--upstream','a','--upstream','b']),{code:'DUPLICATE_ARGUMENT'});
});
test('all output/input path references must stay under an explicit workspace',()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'vf-img2-'));
 try {
   assert.equal(inside(tmp,path.join(tmp,'nested','spec.json')),path.join(tmp,'nested','spec.json'));
   assert.throws(()=>inside(tmp,path.resolve(tmp,'..','outside.json')),{code:'OUTSIDE_WORKSPACE'});
 } finally {fs.rmSync(tmp,{recursive:true,force:true})}
});
test('unreviewed upstream path is rejected before code execution',()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'vf-img2-source-'));
 try {assert.throws(()=>pinnedCheckout(tmp),{code:'UPSTREAM_MISSING'});}
 finally {fs.rmSync(tmp,{recursive:true,force:true})}
});
test('pinned version is an exact 40-character commit, not a moving tag',()=>{
 assert.match(PINNED_UPSTREAM,/^[0-9a-f]{40}$/);
 assert.notEqual(PINNED_UPSTREAM,'main');
});
