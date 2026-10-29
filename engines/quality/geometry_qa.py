"""LOCAL3D G3 bounded offline, CPU-only geometry QA. No print qualification."""
from __future__ import annotations
import argparse
import hashlib
import json
import math
from pathlib import Path
import sys

MAX_BYTES = 64 * 1024 * 1024
MAX_FACES = 1_000_000
MAX_VERTICES = 500_000


class QAError(ValueError):
    pass


def digest(file: Path) -> str:
    h = hashlib.sha256()
    with file.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def num(x):
    return round(float(x), 7)



def summarize_material_channels(gltf):
    """Report declared glTF PBR image bindings, not decoded texture quality.

    Diagnostic concept compared with Apache-2.0 AssetFurnace GLB forensics:
    https://github.com/Bingeljell/image-to-3dlab/tree/98b3c4cb16266df52ec22dd6052774f1ede99b82
    This bounded original implementation makes no materials or print claim.
    """
    materials=gltf.get("materials", [])
    if not isinstance(materials,list) or len(materials)>256:
        raise QAError("Invalid glTF material list")
    keys=("baseColor","metallicRoughness","normal","occlusion","emissive")
    channels=[]
    for idx,material in enumerate(materials):
        if not isinstance(material,dict):
            raise QAError("Invalid glTF material entry")
        pbr=material.get("pbrMetallicRoughness",{})
        if not isinstance(pbr,dict):
            raise QAError("Invalid glTF PBR declaration")
        sources=(pbr.get("baseColorTexture"),pbr.get("metallicRoughnessTexture"),
                 material.get("normalTexture"),material.get("occlusionTexture"),
                 material.get("emissiveTexture"))
        bits={key:isinstance(entry,dict) and type(entry.get("index")) is int
              and entry["index"]>=0 for key,entry in zip(keys,sources)}
        channels.append({"index":idx,**bits})
    return {
        "measurement":"DECLARED_GLTF_PBR_TEXTURE_BINDINGS_NOT_IMAGE_PIXELS",
        "materialCount":len(channels),
        "declaredChannelCount":sum(sum(x[k] for k in keys) for x in channels),
        "materials":channels,
        "textureImageReadback":"NOT_TESTED",
        "printQualified":False
    }


def inspect_material_channels(file: Path):
    """Bounded read-only GLB JSON chunk inspection; existing 64 MiB budget applies."""
    with file.open("rb") as stream:
        stream.seek(12)
        chunk_header=stream.read(8)
        if len(chunk_header)!=8 or chunk_header[4:]!=b"JSON":
            raise QAError("GLB missing JSON first chunk")
        length=int.from_bytes(chunk_header[:4],"little")
        if length<2 or length>min(MAX_BYTES,file.stat().st_size-20):
            raise QAError("GLB JSON exceeds declared bounds")
        raw=stream.read(length)
    if len(raw)!=length:
        raise QAError("Incomplete GLB JSON chunk")
    try:
        gltf=json.loads(raw)
    except (UnicodeError,ValueError) as exc:
        raise QAError("GLB JSON parse rejected") from exc
    if not isinstance(gltf,dict):
        raise QAError("Invalid GLB JSON root")
    return summarize_material_channels(gltf)


def inspect_mesh(mesh):
    import numpy as np
    v = np.asarray(mesh.vertices, dtype=np.float64)
    f = np.asarray(mesh.faces, dtype=np.int64)
    if not len(v) or not len(f):
        raise QAError("Empty mesh")
    if len(v) > MAX_VERTICES or len(f) > MAX_FACES:
        raise QAError("Excessive geometry")
    if not np.isfinite(v).all() or f.min() < 0 or f.max() >= len(v):
        raise QAError("Malformed mesh coordinates or references")
    ext = v.max(axis=0) - v.min(axis=0)
    scale = max(float(ext.max()), 1e-12)
    triangles = v[f]
    areas = .5 * np.linalg.norm(
        np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0]),
        axis=1
    )
    if not np.isfinite(areas).all():
        raise QAError("Nonfinite triangle areas")
    edges = np.vstack((f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]))
    _, incidence = np.unique(np.sort(edges, axis=1), return_counts=True, axis=0)
    _, duplicates = np.unique(np.sort(f, axis=1), return_counts=True, axis=0)
    near_zero = int(np.count_nonzero(areas <= (scale * 1e-7) ** 2))
    try:
        component_sizes = sorted(
            [int(len(m.faces)) for m in mesh.split(only_watertight=False, repair=False)],
            reverse=True
        )
    except Exception:
        component_sizes = None
    watertight = bool(mesh.is_watertight)
    winding = bool(mesh.is_winding_consistent)
    volume = float(mesh.volume) if watertight and winding else None
    return {
        "vertices": len(v), "triangles": len(f),
        "minArbitraryUnits": [num(x) for x in v.min(axis=0)],
        "maxArbitraryUnits": [num(x) for x in v.max(axis=0)],
        "extentsArbitraryUnits": [num(x) for x in ext],
        "surfaceAreaArbitraryUnitsSquared": num(areas.sum()),
        "signedVolumeArbitraryUnitsCubed": num(volume) if volume is not None and math.isfinite(volume) else None,
        "watertightIndexTopology": watertight,
        "windingConsistent": winding,
        "positiveVolume": bool(mesh.is_volume) if watertight else False,
        "boundaryEdges": int(np.count_nonzero(incidence == 1)),
        "nonManifoldEdges": int(np.count_nonzero(incidence > 2)),
        "zeroAreaFacesScaleRelative": near_zero,
        "repeatedVertexIndexFaces": int(np.count_nonzero(
            (f[:, 0] == f[:, 1]) | (f[:, 1] == f[:, 2]) | (f[:, 0] == f[:, 2])
        )),
        "duplicateFaceIndexTriples": int(np.sum(np.maximum(duplicates - 1, 0))),
        "connectedComponents": len(component_sizes) if component_sizes is not None else None,
        "componentTriangles": component_sizes
    }


def inspect_glb(file: Path) -> dict:
    import trimesh
    file = file.resolve(strict=True)
    length = file.stat().st_size
    if length < 100 or length > MAX_BYTES:
        raise QAError("GLB outside configured byte budget")
    with file.open("rb") as stream:
        header = stream.read(12)
    if len(header) != 12 or header[:4] != b"glTF" or \
       int.from_bytes(header[4:8], "little") != 2 or \
       int.from_bytes(header[8:12], "little") != length:
        raise QAError("Invalid GLB version or declared length")
    try:
        scene = trimesh.load(file, file_type="glb", force="scene", process=False)
        meshes = scene.dump(concatenate=False)
    except Exception as exc:
        raise QAError("Failed to decode GLB geometry") from exc
    # Trimesh 4.x returns a numpy object array from Scene.dump().
    # Normalize any sequence, but do not mistake a single Trimesh for one.
    if hasattr(meshes, 'faces'):
        meshes = [meshes]
    else:
        meshes = list(meshes)
    if not meshes or len(meshes) > 64:
        raise QAError("Invalid count of scene meshes")
    if sum(len(m.faces) for m in meshes) > MAX_FACES or \
       sum(len(m.vertices) for m in meshes) > MAX_VERTICES:
        raise QAError("GLB geometry exceeds bounded analysis budget")
    parts = [inspect_mesh(m) for m in meshes]
    bounds_min = [min(p["minArbitraryUnits"][i] for p in parts) for i in range(3)]
    bounds_max = [max(p["maxArbitraryUnits"][i] for p in parts) for i in range(3)]
    topology = {
        "everyObjectWatertight": all(p["watertightIndexTopology"] for p in parts),
        "everyObjectWindingConsistent": all(p["windingConsistent"] for p in parts),
        "everyObjectPositiveVolume": all(p["positiveVolume"] for p in parts),
        "boundaryEdges": sum(p["boundaryEdges"] for p in parts),
        "nonManifoldEdges": sum(p["nonManifoldEdges"] for p in parts),
        "zeroAreaFaces": sum(p["zeroAreaFacesScaleRelative"] for p in parts),
        "duplicateFaceTriples": sum(p["duplicateFaceIndexTriples"] for p in parts),
        "componentCount": sum(p["connectedComponents"] for p in parts)
            if all(p["connectedComponents"] is not None for p in parts) else None
    }
    return {
        "schema": "local3d.g3.geometry-qa.v1",
        "model": file.name, "modelSha256": digest(file), "modelBytes": length,
        "classification": "DRAFT_REQUIRES_HUMAN_REVIEW",
        "geometryObjectCount": len(parts),
        "totalVertices": sum(p["vertices"] for p in parts),
        "totalTriangles": sum(p["triangles"] for p in parts),
        "globalBoundsArbitraryUnits": {
            "min": bounds_min, "max": bounds_max,
            "extents": [num(b-a) for a,b in zip(bounds_min,bounds_max)]
        },
        "parts": parts, "topology": topology,
        "visualMaterialChannels": inspect_material_channels(file),
        "notEvaluated": {
            "realWorldScaleAndUnits": "UNKNOWN_UNCALIBRATED",
            "selfIntersections": "NOT_TESTED", "wallThickness": "NOT_TESTED",
            "supportability": "NOT_TESTED", "structuralStrength": "NOT_TESTED",
            "interComponentInterference": "NOT_TESTED", "meshRepair": "NOT_PERFORMED",
            "printerCompatibility": "NOT_TESTED"
        },
        "printQualified": False, "approvedForPrinter": False, "fabricationAction": "NONE",
        "method": "Unmodified indexed GLB faces; Trimesh CPU topology and object bounds. No physical-unit inference, vertex welding or repair."
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    result = inspect_glb(args.model)
    out = args.out.resolve()
    if args.out.is_symlink():
        raise QAError("Symlink output forbidden")
    out.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(result, indent=2, sort_keys=True) + "\n"
    if out.exists() and out.read_text(encoding="utf-8") != raw:
        raise QAError("Refusing to overwrite changed audit report")
    out.write_text(raw, encoding="utf-8")
    print("G3_GEOMETRY_QA_DRAFT " + json.dumps({
        "sha256": result["modelSha256"], "faces": result["totalTriangles"],
        "components": result["topology"]["componentCount"],
        "watertight": result["topology"]["everyObjectWatertight"],
        "printQualified": False
    }))


if __name__ == "__main__":
    try:
        main()
    except (QAError, OSError, ValueError) as error:
        print("G3_GEOMETRY_QA_FAILED " + str(error), file=sys.stderr)
        sys.exit(1)
