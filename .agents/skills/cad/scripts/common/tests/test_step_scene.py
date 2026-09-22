import tempfile
import unittest
from pathlib import Path
from unittest import mock

import build123d

from common.step_scene import (
    SelectorOptions,
    SelectorProfile,
    _bbox_from_shape,
    extract_selectors_from_scene,
    load_step_scene,
)


class StepSceneSelectorArtifactTests(unittest.TestCase):
    def test_native_bbox_preserves_tolerance_gap(self) -> None:
        def add_bounds(_shape, box, _triangulation, _tolerance):
            box.Update(1, 2, 3, 4, 5, 6)
            box.SetGap(0.25)

        with mock.patch("common.step_scene.BRepBndLib") as native_bounds:
            native_bounds.AddOptimal_s.side_effect = add_bounds
            bounds = _bbox_from_shape(build123d.Box(1, 1, 1).wrapped)

        self.assertEqual([0.75, 1.75, 2.75], bounds["min"])
        self.assertEqual([4.25, 5.25, 6.25], bounds["max"])

    def test_artifact_topology_uses_glb_face_runs_without_duplicate_face_buffers(self) -> None:
        with tempfile.TemporaryDirectory(prefix="cad-topology-v1-") as temp_dir:
            step_path = Path(temp_dir) / "box.step"
            build123d.export_step(build123d.Box(1, 1, 1), step_path)
            scene = load_step_scene(step_path)

            bundle = extract_selectors_from_scene(
                scene,
                cad_ref="fixtures/box",
                profile=SelectorProfile.ARTIFACT,
                options=SelectorOptions(linear_deflection=0.1, angular_deflection=0.1),
            )

            self.assertEqual(1, bundle.manifest["schemaVersion"])
            self.assertEqual(".box.step.glb", bundle.manifest["faceProxy"]["source"])
            self.assertIn("faceRuns", bundle.buffers)
            self.assertTrue(scene.glb_mesh_payloads)
            self.assertNotIn("facePositions", bundle.buffers)
            self.assertNotIn("faceIndices", bundle.buffers)
            self.assertNotIn("faceIds", bundle.buffers)
            face_columns = bundle.manifest["tables"]["faceColumns"]
            triangle_count_column = face_columns.index("triangleCount")
            row_triangle_count = sum(int(row[triangle_count_column]) for row in bundle.manifest["faces"])
            run_triangle_count = sum(int(bundle.buffers["faceRuns"][index + 3]) for index in range(0, len(bundle.buffers["faceRuns"]), 5))
            self.assertEqual(row_triangle_count, run_triangle_count)


if __name__ == "__main__":
    unittest.main()
