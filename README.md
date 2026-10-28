# LOCAL3D — Local-first 3D Model Workbench

A standalone, Hebrew RTL workbench for experimenting with local 3D model generation. **Current source: v0.2.47 (research prototype).** It is separate from VelvetOS Office and AI Development Studio.

## What works

- **G1 demonstration:** a local web interface with uploads, job history, progress, cancellation and a 3D viewer. Its output is a deterministic demonstration fixture, **not** a model reconstructed from an uploaded image or text.
- **G2 manual image-to-3D:** a locally tested TripoSR adapter on the configured Windows host. It runs only in a separately started, explicitly confirmed GPU session and produces a draft GLB.
- **G3 quality research:** CPU-based model diagnostics, asset-integrity checks and evidence-backed tests. These checks do not certify that a generated object is printable.

## Optional 3D studio and browser-preview pilot

The existing GLB viewer has an opt-in **Studio** light toggle for product previews. It does not alter downloaded model bytes. Separately, `tools/preview-optimizer` can create smaller `*.preview.glb` derivatives for browser display; original GLBs remain authoritative and **only original, separately qualified geometry may be evaluated for print**. This optimizer is never called by the server or its job queue.

See [Dioramas preview pilot](docs/implementation/dioramas-preview-pilot-20261028.md) for the separately locked installation, commands, license, exact test results and limitations. This is not deployed into a global ChatGPT Skill or production infrastructure.

## Run the G1 demo

Requires Node.js 20+.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run qa:browser
npm start
```

Open `http://127.0.0.1:4177` on the same machine. No GPU or model inference is needed for G1.

## Run G2 manually (configured Windows host only)

```powershell
powershell -NoProfile -File scripts/start-g2-manual.ps1
```

Open `http://127.0.0.1:4179`, choose TripoSR Local, upload a supported image and explicitly approve the GPU action. Stop the manual session with Ctrl+C when finished. This mode is not an unattended service.

## Important limits

**All outputs are DRAFT / NOT PRINT QUALIFIED.** There is no implemented text-to-3D generation, automatic printer connection, cloud/SaaS fallback, unattended GPU queue or deployed cross-project integration. The G2 adapter has been exercised with specifically authorized examples; it is **not** cleared for arbitrary untrusted media or production use. Security, unattended startup and manufacturing qualification remain open work.

Detailed release-by-release findings belong in [CHANGELOG.md](CHANGELOG.md), with supporting [G3 evidence](docs/evidence/g3/README.md) and the documents under [docs/](docs/). These historical test results are not claims of current production readiness.
