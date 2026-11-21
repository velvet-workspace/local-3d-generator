# Three.js r186 — isolated LOCAL3D compatibility candidate

Decision scope: 2026-10-30 owner-requested update review. Source checkout: the existing LOCAL3D main at b3161db. This branch is isolated; **no live dependency change** and no new graphics runtime.

## Exact change

- Three.js npm dependency from `0.180.0` to **`0.186.0`** (package and lock file only).
- New r186 `GLTFLoader.js` imports `../utils/SkeletonUtils.js`; existing local same-origin static allowlist omitted the file. Explicitly allowlist this one vendor module, keeping Content Security Policy, origin, and deny-by-default static routing unchanged.
- Add one test proving both allowed ESM utilities return 200 and an unknown or encoded traversal vendor asset cannot be served.

## Recorded host validation

On Chris / Windows Chrome 155, run from isolated LF checkout:
- npm install --save-exact --ignore-scripts, dependency version readback 0.186.0.
- `node --test tests/img2threejs-adapter.test.js`: 4/4 PASS.
- `node --test tests/three-r186-assets.test.js`: 1/1 PASS.
- `npm run qa:browser`: **BROWSER_QA_PASS (9 phases)** after the explicit SkeletonUtils allowlist correction. Prior attempts before correction failed deterministically on a network request 404 for that module.
- Read-only benchmark model imports and UI are covered by the existing browser QA. This is not mesh/print qualification.

## QA limitations before production promotion

`npm test` from a freshly created worktree is not fully green because hundreds of historical G3 security/host evidence assertions depend on ignored local `runtime/qa` files and platform-specific frozen byte hashes (LF/CRLF). The current live main checkout's `npm test` passed in the same session. A relevant historical slice (`G3.23-G3.26`) passed 21/21 after matching original public fixture. No historical receipts were modified in the final branch diff, and no security gate was bypassed.

Require an isolated **full** compatibility test with appropriate baseline evidence, CI, and current signed local runtime state before merge/deployment. Preserve working live 0.180.0 as rollback.

No model inference, GPU training, cloud provider, printer action, publication, or customer media was used.
