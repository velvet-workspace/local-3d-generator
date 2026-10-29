"""AssetFurnace-inspired visual-material diagnostics: CPU-only, no model inference."""
from __future__ import annotations
import tempfile
import unittest
from pathlib import Path
import sys
import numpy as np
import trimesh
from PIL import Image
sys.path.insert(0,str(Path(__file__).resolve().parent))
import geometry_qa as q


class VisualMaterials(unittest.TestCase):
    def test_metallic_roughness_channel_loss_is_visible(self):
        good={"materials":[{"pbrMetallicRoughness":{
            "baseColorTexture":{"index":0},"metallicRoughnessTexture":{"index":1}},
            "normalTexture":{"index":2}}]}
        damaged={"materials":[{"pbrMetallicRoughness":{"baseColorTexture":{"index":0}}}]}
        a=q.summarize_material_channels(good)
        b=q.summarize_material_channels(damaged)
        self.assertEqual(a["declaredChannelCount"],3)
        self.assertEqual(b["declaredChannelCount"],1)
        self.assertTrue(a["materials"][0]["metallicRoughness"])
        self.assertFalse(b["materials"][0]["metallicRoughness"])
        self.assertEqual(a["measurement"],"DECLARED_GLTF_PBR_TEXTURE_BINDINGS_NOT_IMAGE_PIXELS")
        self.assertFalse(a["printQualified"])

    def test_absent_materials_are_not_invented(self):
        x=q.summarize_material_channels({})
        self.assertEqual(x["materialCount"],0)
        self.assertEqual(x["declaredChannelCount"],0)
        self.assertEqual(x["materials"],[])

    def test_reject_invalid_or_oversized_materials(self):
        for bad in ({"materials":"nope"},{"materials":[{}]*257},
                    {"materials":[5]},{"materials":[{"pbrMetallicRoughness":[] }]}):
            with self.subTest(bad=str(bad)[:20]):
                with self.assertRaises(q.QAError):
                    q.summarize_material_channels(bad)

    def test_actual_glb_reopens_without_changing_geometry_or_source(self):
        mesh=trimesh.creation.box(extents=[25,20,5])
        image=Image.new("RGBA",(8,8),(160,110,70,255))
        def output(has_roughness):
            material=trimesh.visual.material.PBRMaterial(
                baseColorTexture=image,
                metallicRoughnessTexture=image if has_roughness else None)
            m=mesh.copy()
            m.visual=trimesh.visual.TextureVisuals(
                uv=np.zeros((len(m.vertices),2)),material=material)
            return m.export(file_type="glb")
        with tempfile.TemporaryDirectory() as tmp:
            a,b=Path(tmp)/"source.glb",Path(tmp)/"missing-roughness.glb"
            a.write_bytes(output(True));b.write_bytes(output(False))
            before_a, before_b = q.digest(a),q.digest(b)
            r1, r2=q.inspect_glb(a),q.inspect_glb(b)
            self.assertEqual(before_a,q.digest(a))
            self.assertEqual(before_b,q.digest(b))
            self.assertEqual(r1["totalTriangles"],r2["totalTriangles"])
            self.assertEqual(r1["topology"],r2["topology"])
            self.assertTrue(r1["visualMaterialChannels"]["materials"][0]["metallicRoughness"])
            self.assertFalse(r2["visualMaterialChannels"]["materials"][0]["metallicRoughness"])
            self.assertFalse(r1["printQualified"])
            self.assertFalse(r2["printQualified"])

    def test_bad_glb_json_chunk_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=Path(tmp)/"bad.glb"
            f.write_bytes(b"glTF"+(2).to_bytes(4,"little")+
                          (32).to_bytes(4,"little")+
                          (5).to_bytes(4,"little")+b"BIN\x00"+
                          b"abcde"+b"\x00"*15)
            with self.assertRaisesRegex(q.QAError,"JSON first chunk"):
                q.inspect_material_channels(f)


if __name__=="__main__":
    unittest.main()
