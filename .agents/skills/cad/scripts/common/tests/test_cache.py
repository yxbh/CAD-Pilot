"""The per-user cache keeps what was used this month and drops the rest, for every kind it holds."""

import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from common import issued_refs
from common.cache import PRUNE_AFTER_SECONDS, cache_path


class CacheTests(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory(prefix="cad-cache-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        patcher = mock.patch.dict(os.environ, {"CAD_PILOT_CACHE": str(self.root / "cache")})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_marking_refs_for_a_build_prunes_markers_unused_for_a_month(self) -> None:
        old_step, new_step = self.root / "old.step", self.root / "new.step"
        issued_refs.mark(old_step, "a" * 64)
        stale = cache_path(issued_refs.KIND, issued_refs._marker(old_step).name)
        long_ago = time.time() - PRUNE_AFTER_SECONDS - 60
        os.utime(stale, (long_ago, long_ago))
        issued_refs.mark(new_step, "b" * 64)
        self.assertFalse(stale.exists())
        self.assertTrue(issued_refs.refs_issued_for(new_step, "b" * 64))


if __name__ == "__main__":
    unittest.main()
