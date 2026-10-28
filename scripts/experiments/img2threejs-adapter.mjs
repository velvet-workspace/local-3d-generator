// Optional, fail-closed procedural Three.js SPEC -> TypeScript adapter.
// Lives beside LOCAL3D research fixtures; does not touch G1/G2/G3 production or printing.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const PINNED_UPSTREAM = '3e7099e1b7fe93e187e06db4bdbe1e1906c21a28';
const SRC = {
  validator: 'forge/stage2_spec/validate_sculpt_spec.py',
  generator: 'forge/stage3_build/generate_threejs_factory.py',
  instruction: 'SKILL.md',
};
const sha256 = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const fail = (code,message,extra={}) => Object.assign(new Error(message), {code,extra});
export function inside(root,target) {
  const base=fs.realpathSync(root), absolute=path.resolve(target);
  const check=(actual)=>{const rel=path.relative(base,actual);
    if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))
      throw fail('OUTSIDE_WORKSPACE','Path outside explicit workspace');
  };
  check(absolute);
  if(fs.existsSync(absolute)) check(fs.realpathSync(absolute));
  else {let ancestor=path.dirname(absolute);
    while(!fs.existsSync(ancestor)&&path.dirname(ancestor)!==ancestor) ancestor=path.dirname(ancestor);
    check(fs.realpathSync(ancestor));
  }
  return absolute;
}
function run(program,args,opts={}) {
  const p=spawnSync(program,args,{cwd:opts.cwd,encoding:'utf8',shell:false,timeout:120000,maxBuffer:4*1024*1024});
  if(p.error) throw fail('SUBPROCESS_ERROR',p.error.message);
  return {status:p.status,stdout:(p.stdout||'').trim(),stderr:(p.stderr||'').trim()};
}
export function parseArgs(args) {
  const [command,...rest]=args;
  if(!['doctor','validate','generate'].includes(command)) throw fail('COMMAND_NOT_ALLOWED','Only doctor/validate/generate are allowed');
  const flags={}; const allowed=new Set(['--upstream','--workspace','--reference','--spec','--out']);
  for(let i=0;i<rest.length;i+=2) {
    if(!allowed.has(rest[i])||!rest[i+1]||rest[i+1].startsWith('--')) throw fail('INVALID_ARGUMENT','Expected typed --key value flags only');
    if(flags[rest[i]]) throw fail('DUPLICATE_ARGUMENT','Each flag is accepted once');
    flags[rest[i]]=rest[i+1];
  }
  if(!flags['--upstream']) throw fail('MISSING_UPSTREAM','Pass a pinned, pre-reviewed local checkout');
  return {command,flags};
}
export function pinnedCheckout(input) {
  const dir=fs.realpathSync(input);
  for(const rel of Object.values(SRC)) if(!fs.existsSync(path.join(dir,rel))) throw fail('UPSTREAM_MISSING','Missing required upstream file: '+rel);
  const check=run('git',['rev-parse','HEAD'],{cwd:dir});
  if(check.status!==0||check.stdout!==PINNED_UPSTREAM) throw fail('UPSTREAM_MISMATCH','Refusing unpinned/upgraded upstream checkout');
  const dirty=run('git',['status','--porcelain','--untracked-files=no'],{cwd:dir});
  if(dirty.status!==0||dirty.stdout) throw fail('UPSTREAM_DIRTY','Refusing an upstream checkout with modified tracked files');
  return dir;
}
function validated(spec,upstream) {
  const proc=run('python',[path.join(upstream,SRC.validator),spec,'--strict-quality','--json'],{cwd:upstream});
  let report;
  try {report=JSON.parse(proc.stdout);} catch {throw fail('INVALID_VALIDATOR_REPLY','Validator did not emit JSON',{stderr:proc.stderr.slice(0,400)});}
  if(proc.status!==0||report.ok!==true) throw fail('STRICT_QUALITY_BLOCKED','Upstream strict quality gate blocked spec',{errors:report.errors||[],warnings:report.warnings||[]});
  return {ok:true,summary:report.summary,warnings:report.warnings||[]};
}
export function execute(command, flags) {
  const upstream=pinnedCheckout(flags['--upstream']);
  if(command==='doctor') return {status:'PASS',action:'doctor',upstreamSha:PINNED_UPSTREAM,execution:'local-only',gpu:false,print:false,cloud:false};
  if(!flags['--workspace']||!flags['--spec']) throw fail('MISSING_INPUT','--workspace and --spec are required');
  const workspace=fs.realpathSync(flags['--workspace']);
  const spec=inside(workspace,flags['--spec']);
  if(!fs.statSync(spec).isFile()||path.extname(spec).toLowerCase()!=='.json') throw fail('INVALID_SPEC','Spec must be an existing JSON file inside workspace');
  const check=validated(spec,upstream);
  if(command==='validate') return {status:'PASS',action:'validate',specSha:sha256(spec),...check};
  if(!flags['--out']||!flags['--reference']) throw fail('MISSING_OUTPUT','generate needs explicit --out and --reference');
  const reference=inside(workspace,flags['--reference']);
  if(!fs.statSync(reference).isFile()||!['.png','.jpg','.jpeg','.webp'].includes(path.extname(reference).toLowerCase())) throw fail('INVALID_REFERENCE','Reference must be an existing image inside workspace');
  const out=inside(workspace,flags['--out']);
  if(path.extname(out).toLowerCase()!=='.ts') throw fail('INVALID_OUTPUT','The only emission target here is procedural .ts');
  if(fs.existsSync(out)||fs.existsSync(out+'.receipt.json')) throw fail('WOULD_OVERWRITE','New output path required, never overwrite');
  fs.mkdirSync(path.dirname(out),{recursive:true});
  const generated=run('python',[path.join(upstream,SRC.generator),spec,'--out',out],{cwd:upstream});
  if(generated.status!==0||!fs.existsSync(out)||fs.statSync(out).size<100) throw fail('CODEGEN_FAILED','Upstream codegen failed',{stdout:generated.stdout.slice(0,800),stderr:generated.stderr.slice(0,500)});
  const result={schema:'vf.img2threejs.experimental.v1',status:'CODE_GENERATED_NOT_VISUALLY_APPROVED',action:'generate',
    source:'img2threejs',upstreamSha:PINNED_UPSTREAM,codeSha:sha256(out),specSha:sha256(spec),
    referenceSha:sha256(reference),out,componentCount:check.summary?.components??null,
    restrictions:{visualFidelity:'UNPROVEN',printQualified:false,gpuUsed:false,cloudUsed:false,physicalAction:false}};
  fs.writeFileSync(out+'.receipt.json',JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const {command,flags}=parseArgs(process.argv.slice(2));console.log(JSON.stringify(execute(command,flags)));process.exit(0);}
  catch(error){console.log(JSON.stringify({status:'BLOCKED',code:error.code||'UNEXPECTED',reason:error.message,details:error.extra||{}}));process.exit(2);}
}
