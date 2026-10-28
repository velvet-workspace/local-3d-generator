# LOCAL3D Dioramas preview — scoped merge decision (2026-10-28)

This is an engineering release note for [PR #12](https://github.com/velvet-workspace/local-3d-generator/pull/12).
It authorizes **source-code integration into LOCAL3D main only**, subject to GitHub merge permissions and the exact head SHA below. It is NOT a print release, deployment to a hosted portal, cloud service, background job, AI inference, or automatic startup.

## Reviewed head

- Candidate branch: `feat/dioramas-preview-20261028`.
- Reviewed head: `5f202e47e3b8878c8c7b390f8c80f013301729f7`.
- Parent main baseline: `2d430acdbe279ca8ef98d7ad5e498c0022c5e453`.
- Upstream: Dioramas commit `868539fb5b64a843071a2247d5d8bacb706a07b1`; source code MIT; example watch asset and derived screenshots CC BY 4.0 with attribution.
- LOCAL3D's existing G1/G2/G3 contracts, job persistence, input type and download actions are unchanged.

## Acceptance receipts

| Check | Windows Chris / Chrome 155 | Mac-Bedroom / Edge 143 |
| --- | --- | --- |
| `npm run qa:browser` | PASS — 9 phases; live CSP script denies eval/Function; Studio toggle | PASS — 9 phases; same CSP checks |
| `npm test --prefix tools/preview-optimizer` | PASS | PASS |
| `node tools/preview-optimizer/qa-browser.mjs` | PASS — Meshopt GLB rendered; mean difference 0.016/255 | PASS — mean difference 0.015/255 |
| `node tools/preview-optimizer/qa-textured.mjs` on attributed upstream watch | PASS — 3 embedded WebP textures; zero measured RGB difference | PASS — same source SHA, same preview SHA, 3 textures, zero measured RGB difference |

- The watch was **AI-generated upstream**, not a validated/physical Velvet Factory product. It verifies representative embedded PBR texture decoding in both browsers.
- Geometry-only compression on this already-optimized watch saved only 0.05%, therefore future default CLI refuses <1% gain to prevent needless derivatives. The watched comparison used a derivative created before enforcing this gate.
- The deterministic local G1 fixture saved 69.79% (119,972 → 36,248 bytes), with no shape count changes or source mutation.
- `npm audit --prefix tools/preview-optimizer --omit=dev --audit-level=high`: 0 findings at check time.

## Existing full-suite debt and scoped waiver

- A full `npm test` on isolated, same-host original main and candidate branch **fails 95 tests on each, with identical failing test names** (difference 0).
- Failures concern pre-existing G3 source/evidence hash pinning and unavailable private historical 34-package/full-venv recovery receipts. No evidence was fabricated or rewritten. This does **not** certify historical G3 restores or absolute security.
- There are no new failing tests in the exact compare. Browser, explicit API/geometry tests and adversarial optimizer checks are passing. This is a narrow *no-new-regression* waiver for merging optional viewer improvements, not a claim that G3's full suite is green.
- Historical evidence repairs must be scoped separately to avoid cascading unrelated revisions.

## Security containment

- A textured model revealed a genuine preexisting `connect-src` block of browser-created `blob:` texture URLs. The fix allows `connect-src 'self' blob:`, **not** external HTTP origins. `worker-src 'none'` still applies.
- `script-src` uses `'wasm-unsafe-eval'` for Meshopt decoding; no JS `'unsafe-eval'` or `'unsafe-inline'` has been added. The browser QA injects a real script in a test-only route and asserts both `eval` and `new Function` raise `EvalError`. This was verified on Windows and macOS.
- Both normal and textured QA assert zero unexpected network requests; source files are hash-checked and never modified.
- Optional CLI only, with a separate lockfile, bounded 64 MiB self-contained static GLB input, refusal of symlink sources and exclusive output creation. No upstream model-generation APIs are installed.

## Post-merge actions and limits

1. Re-read GitHub's merge result and exact `main` SHA; no success claims before verification.
2. Use a clean local main checkout to run the dedicated QA; G1 demonstration only with browser-local loopback, not production or G2 GPU activation.
3. Do not expose LOCAL3D's loopback-only demo through VelvetOS portal; this requires an explicit authenticated integration contract and security review.
4. Reuse the viewer and optimizer as shared source components when later extending product catalog and assembled-view capabilities; do not create a second renderer or a global Skill.

**Decision**: acceptable to merge into LOCAL3D source with the above *existing-baseline* waiver, but NOT to deploy as a continuously running production service or claim 3D print readiness.
