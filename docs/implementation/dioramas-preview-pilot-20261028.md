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

## Scope and gating

- No optimized GLB replaces a G1/G2 output or any 3MF/STL. Tests intercept a browser response **only inside a headless Playwright smoke**.
- No deployment, auto-merge, persistent agent scheduler or global Skill is part of this patch.
- The full root `npm test` was attempted in an isolated shallow checkout and did not pass because many existing G3 historical tests require runtime backup/venv evidence missing from that checkout; example: `runtime/qa/g3/g342-real-restored-full-venv-cpu-qa.json`. Do not claim the full suite is green; separately adjudicate these fixtures and the CSP change before merge.
- Next candidates (not implemented): optional texture compression with verified fidelity, and exploded-view interactions for models with an authoritative part hierarchy. Do not infer real assemblies from a single fused mesh.
