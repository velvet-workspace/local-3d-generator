# Dioramas -> LOCAL3D: optional web-preview primitives (2026-10-28)

## Origin and architecture

- Upstream: [blendi-remade/dioramas](https://github.com/blendi-remade/dioramas), inspected at `868539fb5b64a843071a2247d5d8bacb706a07b1`.
- Source patterns: `src/core/engine.js` (PMREM studio lighting) and `scripts/optimize.mjs` (Meshopt preview compression).
- Code license: MIT, copied in [dioramas-MIT.txt](../licenses/dioramas-MIT.txt). No upstream models or images are bundled.
- Keep the existing LOCAL3D G1 Three.js viewer, G2 manual TripoSR and G3 CPU quality gates. No new engine, plugin or skill is installed.
- ChatGPT / Remote Desktop Commander was the execution point on an isolated Chris checkout. No Claude, external API, GPU inference, printer or production rollout.

## Browser viewport change

- `public/studio-preview.js`: optional, locally generated PMREM environment and ACES tone mapping. Default remains the existing renderer.
- `public/app.js`: a toggle only enables Studio when a model is present. Loaded GLB data and download route are unchanged.
- `server/index.js`: allowlists exactly the new local JS module and Three's Meshopt decoder.
- The decoder uses WebAssembly; the local CSP changes from disallowing all WebAssembly compilation to the narrowly scoped `'wasm-unsafe-eval'` token in `script-src`. **JavaScript `'unsafe-eval'` remains disallowed**; all other CSP clauses are retained. Treat this as a security review item before merging.
- No third-party network runtime dependencies; the viewer continues to use the already-pinned Three.js 0.180.0.

## Optional preview optimizer

- `tools/preview-optimizer` has an **independent, locked** Node toolchain, not added to the default app installation.
- Accepts one explicitly approved *self-contained, static* source GLB (<=64 MiB). It refuses external resource URIs, animations, skins, morphs, invalid inputs and existing destination files.
- Requires a *new* `*.preview.glb` output. No overwrite, no server endpoint, no background job, no print qualification.
- Applies dedup, weld, prune, mesh reordering, lossy quantization and Meshopt geometry compression. **Not a CAD or slicer source**. Future texturing work needs separate validation.
- Usage, from the root of a local checkout:

```sh
npm ci --prefix tools/preview-optimizer --ignore-scripts --no-audit --no-fund
node tools/preview-optimizer/optimize.mjs ./trusted.glb ./trusted.preview.glb
```

If an optimizer validation fails, it does not produce an output. The source GLB remains unchanged.

## Actual smoke results (Chris / Windows / Chrome 155.0.8059.85)

- Baseline commit of LOCAL3D: `2d430acdbe279ca8ef98d7ad5e498c0022c5e453`.
- `npm run qa:browser`: **PASS**, 9 phases including source GLB SHA invariance, Studio on/off, screenshot change, RTL, mobile and no external requests.
- `npm test --prefix tools/preview-optimizer`: **PASS**: geometry count, size, integrity, duplicate-output refusal and invalid-GLB refusal.
- `node tools/preview-optimizer/qa-browser.mjs`: **PASS**, actual Chrome GLTFLoader decodes Meshopt GLB when the browser-only asset response is intercepted with the derivative.
- Original fixture: **119,972 bytes**; preview: **36,248 bytes**; **69.79% smaller**; 4 meshes, 4 primitives, 1 scene, 6,144 triangles before/after.
- Pixel similarity on the fixture: mean absolute RGB difference **0.016 / 255** across an 803 x 483 capture. This is a limited fixture-specific comparison, not a blanket visual-fidelity certification.
- Viewport evidence: [original](../evidence/dioramas-preview-20261028/original.png), [optimized](../evidence/dioramas-preview-20261028/optimized.png), [optimized + Studio](../evidence/dioramas-preview-20261028/optimized-studio.png).

## Cross-platform verification

- Mac-Bedroom / Node.js 24.21.0 / Microsoft Edge 143.0.3650.80: `npm run qa:browser` **PASS** (9 phases), `npm test --prefix tools/preview-optimizer` **PASS**, `node tools/preview-optimizer/qa-browser.mjs` **PASS**.
- The same deterministic fixture compressed to 36,248 bytes on Mac; mean absolute RGB deviation in the browser was **0.015/255**.
- On macOS the default Node `os.tmpdir()` path starts with `/var`, a filesystem symlink; the existing G3.45/G3.47 security checks reject such directory ancestors. Cross-platform QA was correctly rerun with `TMPDIR=$HOME/Library/Caches/vf-dioramas-testtmp-20261028` (a real non-symlink directory) without relaxing the security check.
- Mac screenshot output remains local to the isolated pilot checkout. The linked repository screenshots are from the Windows run. Neither run establishes real-product fidelity or a browser FPS baseline.

## Follow-up release gates (2026-10-28)

### Equivalent full-suite baseline — no patch regression

- Clean checkout of original `main` (`2d430acdbe279ca8ef98d7ad5e498c0022c5e453`) and isolated Dioramas branch on the **same Chris Windows host**.
- Full `npm test`: **95 failures in original main, 95 failures in branch, zero additional failing test names**. The historical failures include G3.23–G3.43 SHA-pinned evidence and missing private runtime/backup receipts; the default root suite is **not green on either checkout**.
- This result is a *no-new-failures comparison*, not an attestation of current G3 historical evidence, GPU inference, print quality, or restoring a qualified Python virtual environment.
- Focused browser + independent optimizer tests remain required and have passed. Do not rewrite historical proof files to make old SHAs match current code.

### Real textured product-model representative

- [Dioramas source GLB](https://github.com/blendi-remade/dioramas/blob/868539fb5b64a843071a2247d5d8bacb706a07b1/public/models/horologie/watch.glb) — watch model, generated by Meshy 7.1, **not a physically verified/customer product**, used as a representative textured PBR asset.
- Provenance: [upstream asset license](https://github.com/blendi-remade/dioramas/blob/868539fb5b64a843071a2247d5d8bacb706a07b1/ASSET-LICENSES.md) **CC BY 4.0**. Credit: Dioramas (github.com/blendi-remade/dioramas). The model's bytes were **not added** to this repository; only attributed screenshots are present.
- Actual model: **5,566,312 bytes**, 152,980 triangles, 3 internally embedded **WebP** textures. SHA256: `419d8dba396aa980384ceb963ab69845049dfa6894dbf5594e99fab16b51e27d`.
- Geometry-only preview: **5,563,396 bytes**, just **0.05% smaller**. Both GLBs loaded with all PBR textures preserved **byte-for-byte**; browser mean RGB difference **0/255** on Chrome 155. The real product-like textured model surfaced why a geometry-only optimizer has little value when textures are already optimized.
- The optional CLI now **refuses** derivatives saving less than 1% by default instead of producing near-duplicates; the test above was performed on a local derivative created before that new quality gate. The existing G1 fixture still compresses 69.79%.
- Actual screenshots: [source](../evidence/dioramas-textured-watch-20261028/source.png), [preview](../evidence/dioramas-textured-watch-20261028/preview.png).
- Mac-Bedroom / Edge 143 also **PASS** on this same watch and derivative (identical source and optimized SHA, three WebP textures, mean RGB difference **0/255**); verified 2026-10-28. The Mac temp directory was the same non-symlink `TMPDIR` noted above.
- Repeatable smoke for any independently licensed/approved self-contained GLB: `node tools/preview-optimizer/qa-textured.mjs <source.glb> <existing.preview.glb>`, with no source upload or production output mutation. A real Velvet Factory customer's model remains **unverified** until expressly sourced.

### CSP security validation

- The textured watch exposed a **real defect**: `GLTFLoader` fetches embedded WebP textures through browser-created `blob:` URLs, but the original CSP had `connect-src 'self'`. This made both uncompressed and compressed watch previews render without their textures.
- Minimal repair: `connect-src 'self' blob:`; `img-src 'self' blob: data:` was already permitted. No wildcard remote origins, `https:`, `unsafe-inline`, or JS `unsafe-eval` added.
- The exact existing `script-src` hash and `'wasm-unsafe-eval'` permit Meshopt WebAssembly decoding without dynamic JS compilation. QA serves an intentional same-origin intercepted module script and verifies **both `eval()` and `new Function()` fail with `EvalError`**. Playwright's own page.evaluate bypasses ordinary page CSP and is intentionally not used as evidence of this rule.
- Same-origin browser only; external browser requests remain forbidden in both the normal and textured QA. `worker-src 'none'` and other hardening directives are unchanged.
- Independent dependency audit: `npm audit --prefix tools/preview-optimizer --omit=dev --audit-level=high`: **0 vulnerabilities** reported on 2026-10-28. It is not a formal pentest.
- Security scope: manually approved static self-contained GLBs, bounded at 64 MiB. The new code never deploys a file or starts a printer. Compressed previews are not appropriate for print or measurements.

## Scope and gating

- No optimized GLB replaces a G1/G2 output or any 3MF/STL. Tests intercept a browser response **only inside a headless Playwright smoke**.
- No deployment, auto-merge, persistent agent scheduler or global Skill is part of this patch.
- The full root `npm test` was attempted in an isolated shallow checkout and did not pass because many existing G3 historical tests require runtime backup/venv evidence missing from that checkout; example: `runtime/qa/g3/g342-real-restored-full-venv-cpu-qa.json`. Do not claim the full suite is green; separately adjudicate these fixtures and the CSP change before merge.
- Next candidates (not implemented): optional texture compression with verified fidelity, and exploded-view interactions for models with an authoritative part hierarchy. Do not infer real assemblies from a single fused mesh.
