"""Patch-series regressions, including overlapping changes and archive trees."""
import difflib
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("still_apply", Path(__file__).parents[1] / "apply.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PatchApplication(unittest.TestCase):
    def check_source(self, source_has_git):
        with tempfile.TemporaryDirectory() as temporary:
            wrapper = Path(temporary)
            subprocess.run(["git", "init", "--quiet", str(wrapper)], check=True)
            source = wrapper / "build/src"
            source.mkdir(parents=True)
            if source_has_git:
                subprocess.run(["git", "init", "--quiet", str(source)], check=True)
            target = source / "identity.txt"
            target.write_text("Helium\n")
            patch = wrapper / "identity.patch"
            patch.write_text("--- a/identity.txt\n+++ b/identity.txt\n@@ -1 +1 @@\n-Helium\n+Still\n")
            self.assertNotEqual(module.git(source, "--reverse", "--check", patch, check=False).returncode, 0)
            module.git(source, "--check", patch)
            self.assertEqual(target.read_text(), "Helium\n")
            module.git(source, patch)
            self.assertEqual(target.read_text(), "Still\n")
            module.git(source, "--reverse", "--check", patch)

    def test_archive_inside_wrapper_repository(self):
        self.check_source(False)

    def test_separate_chromium_repository(self):
        self.check_source(True)


class OrderedSeries(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "src"
        self.source.mkdir()
        current = {
            "settings.txt": "mode=margin\npinned=false\ncolor=true\n",
            "identity.txt": "Helium\n",
            "blocker.txt": "not installed\n",
            "label.txt": "Helium\n",
        }
        for name, contents in current.items():
            (self.source / name).write_text(contents)
        changes = [
            ("settings.txt", "mode=margin\npinned=true\ncolor=false\n"),
            ("identity.txt", "Still\n"),
            ("blocker.txt", "installed\n"),
            ("label.txt", "Still\n"),
            ("settings.txt", "mode=islands\npinned=false\ncolor=false\n"),
        ]
        self.patches = []
        self.states = [dict(current)]
        for number, (name, contents) in enumerate(changes, 1):
            patch = self.root / f"{number}.patch"
            patch.write_text("".join(difflib.unified_diff(
                current[name].splitlines(keepends=True),
                contents.splitlines(keepends=True),
                fromfile=f"a/{name}", tofile=f"b/{name}")))
            self.patches.append(patch)
            current[name] = contents
            self.states.append(dict(current))

    def snapshot(self):
        return {path.name: path.read_text() for path in self.source.iterdir()}

    def apply_remaining(self):
        applied = module.validate_series(self.source, self.patches)
        for patch in self.patches[applied:]:
            module.git(self.source, patch)

    def test_fresh_apply_and_repeated_complete_series(self):
        before = self.snapshot()
        self.assertEqual(module.validate_series(self.source, self.patches), 0)
        self.assertEqual(self.snapshot(), before)
        self.apply_remaining()
        self.assertEqual(self.snapshot(), self.states[5])
        # The old independent reverse-check fails on patch 1 after patch 5.
        self.assertNotEqual(module.git(
            self.source, "--reverse", "--check", self.patches[0],
            check=False).returncode, 0)
        self.assertEqual(module.validate_series(self.source, self.patches), 5)
        self.apply_remaining()
        self.assertEqual(self.snapshot(), self.states[5])

    def test_upgrade_four_to_five(self):
        for patch in self.patches[:4]:
            module.git(self.source, patch)
        self.assertEqual(module.validate_series(self.source, self.patches), 4)
        self.assertEqual(self.snapshot(), self.states[4])
        self.apply_remaining()
        self.assertEqual(module.validate_series(self.source, self.patches), 5)
        self.assertEqual(self.snapshot(), self.states[5])

    def test_every_partial_prefix_can_resume(self):
        for applied, patch in enumerate(self.patches):
            self.assertEqual(module.validate_series(self.source, self.patches), applied)
            module.git(self.source, patch)

    def test_mixed_non_prefix_state_is_rejected_without_writes(self):
        module.git(self.source, self.patches[0])
        module.git(self.source, self.patches[2])
        before = self.snapshot()
        with self.assertRaisesRegex(RuntimeError, "not a valid prefix"):
            module.validate_series(self.source, self.patches)
        self.assertEqual(self.snapshot(), before)

    def test_future_conflict_is_rejected_before_any_source_writes(self):
        (self.source / "label.txt").write_text("Locally changed\n")
        before = self.snapshot()
        with self.assertRaisesRegex(RuntimeError, "not a valid prefix"):
            module.validate_series(self.source, self.patches)
        self.assertEqual(self.snapshot(), before)


if __name__ == "__main__":
    unittest.main()
