# LOCAL3D G3 — visual material-channel QA (2026-10-29)

## Why this belongs in existing G3 QA

The existing `engines/quality/geometry_qa.py` verifies GLB byte integrity,
indexed topology, signed volume and draft/print refusal. Its geometry results
cannot report when an otherwise identical GLB loses a `metallicRoughness`
texture binding. The optional Meshopt preview checker independently verifies
texture bytes across a before/after derivative, but not each material's PBR
channel *binding* in the routine G3 report.

This focused, additive diagnostic was informed by Apache-2.0 AssetFurnace's
[GLB forensics](https://github.com/Bingeljell/image-to-3dlab/blob/98b3c4cb16266df52ec22dd6052774f1ede99b82/scripts/glb_forensics.py).
It adds no renderer, agent, model weights, service, MCP or print authority.

## Contract and limitations

- `inspect_glb()` still uses the same 64 MiB/500k-vertex/1M-face bounded input,
  existing metadata schema and existing Trimesh geometry checks. The original
  raw-index topology and print assertions are left untouched.
- New top-level `visualMaterialChannels` contains boolean glTF JSON
  declarations for `baseColor`, `metallicRoughness`, `normal`, `occlusion`,
  `emissive`, per *unnamed* material index and the aggregate binding count.
- Parse only the validated first GLB JSON chunk, bounded by the existing file
  cap; reject invalid or oversized material lists and malformed JSON. No
  user-selected model names, private textures, paths or image pixels are
  included in the new result.
- `textureImageReadback=NOT_TESTED`: a declared binding does **not** certify
  that its referenced image exists, decodes, uses correct UVs, has the required
  resolution or looks good. This is a missing-binding detector, not texture QA.
- `printQualified=false` remains mandatory. No engineering dimensions,
  watertightness, supportability or STL/3MF release is inferred.

## Same-geometry negative control

`test_visual_material_qa.py` exports **two real, reopened GLBs** of the same
25x20x5 arbitrary-unit box. Both have the same triangle count and topology,
and their source SHAs remain unchanged after QA. The first binds baseColor and
metallicRoughness, the second deliberately omits metallicRoughness. G3 now
reports the missing binding while retaining identical geometric results.
Additional negative controls reject malformed GLB chunks and invalid material
lists. No neural image-to-3D inference occurs in this test.

## Repro and deployment boundary

On a Windows host with the existing isolated LOCAL3D TripoSR Python environment:

```powershell
& "<existing-tripOSR-venv>\Scripts\python.exe" -m unittest discover -s engines/quality -p test_visual_material_qa.py -v
& "<existing-tripOSR-venv>\Scripts\python.exe" -m unittest discover -s engines/quality -p test_quality.py -v
npm ci --ignore-scripts --no-audit --no-fund
node --test tests/benchmark-ledger.test.js tests/gpu-lease.test.js
```

This change is **source and isolated test evidence only** until the LOCAL3D
owner PR is merged, the approved production runtime is updated and the native
ChatGPT → Skill → Router → authorized host → GLB → QA chain is separately
read back. Do not label this as a new AI provider or as print qualification.
