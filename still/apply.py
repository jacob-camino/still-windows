#!/usr/bin/env python3
"""Apply Still's small patch series after upstream Helium source preparation."""

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
PATCHES = [ROOT / "still/patches" / name for name in (
    "001-ink-margin-grayscale.patch",
    "002-still-windows-identity.patch",
    "003-local-blocking.patch",
    "004-product-name.patch",
    "005-floating-islands.patch",
    "006-centered-left-island.patch",
)]


def git(source, *args, check=True):
    # Extracted Chromium trees may have no .git. Do not let Git discover the
    # wrapper repository and silently interpret these paths from its root.
    environment = {**os.environ, "GIT_CEILING_DIRECTORIES": str(source.parent)}
    return subprocess.run(["git", "-C", str(source), "apply", *map(str, args)],
                          check=check, text=True, capture_output=True, env=environment)


def patch_paths(source, patches):
    """Read Git's parsed patch paths rather than copying the Chromium checkout."""
    paths = set()
    for record in git(source, "--numstat", "-z", *patches).stdout.split("\0"):
        if not record:
            continue
        fields = record.split("\t", 2)
        if len(fields) != 3 or not fields[2]:
            raise RuntimeError("Patch series must use ordinary file changes, not renames")
        path = Path(fields[2])
        if path.is_absolute() or ".." in path.parts:
            raise RuntimeError(f"Unsafe patch path: {path}")
        paths.add(path)
    return sorted(paths)


def source_state(source, paths):
    state = {}
    for path in paths:
        target = source / path
        if target.is_symlink():
            raise RuntimeError(f"Patch target must not be a symlink: {path}")
        state[path] = ((target.read_bytes(), target.stat().st_mode & 0o777)
                       if target.exists() else None)
    return state


def validate_series(source, patches):
    """Return the applied prefix length after rehearsing the complete series.

    A later patch can change lines introduced by an earlier one. Therefore an
    individual reverse-check cannot establish whether that earlier patch was
    applied. Reverse candidate prefixes in order, then replay the whole series
    on a small temporary copy. The real source remains untouched on failure.
    """
    paths = patch_paths(source, patches)
    original = source_state(source, paths)
    last_error = ""
    with tempfile.TemporaryDirectory(prefix="still-patch-check-") as temporary:
        fixture = Path(temporary) / "src"
        for applied in range(len(patches), -1, -1):
            if fixture.exists():
                shutil.rmtree(fixture)
            fixture.mkdir()
            for path, contents in original.items():
                if contents is not None:
                    target = fixture / path
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(contents[0])
                    target.chmod(contents[1])
            try:
                for patch in reversed(patches[:applied]):
                    git(fixture, "--reverse", patch)
                for index, patch in enumerate(patches):
                    git(fixture, patch)
                    if index + 1 == applied and source_state(fixture, paths) != original:
                        raise RuntimeError("Replayed prefix differs from the original source")
            except (subprocess.CalledProcessError, RuntimeError) as error:
                last_error = getattr(error, "stderr", None) or str(error)
                continue
            return applied
    raise RuntimeError("Source is not a valid prefix of Still's patch series.\n" + last_error)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--check-only", action="store_true")
    args = parser.parse_args()
    source = args.source.resolve()
    values = dict(line.split("=", 1) for line in
                  (source / "chrome/VERSION").read_text().splitlines() if "=" in line)
    actual = ".".join(values[key] for key in ("MAJOR", "MINOR", "BUILD", "PATCH"))
    expected = (ROOT / "helium-chromium/chromium_version.txt").read_text().strip()
    if actual != expected:
        raise RuntimeError(f"Expected Helium's pinned Chromium {expected}, got {actual}")

    validator = ROOT / "still/blocking/copy-into-source.py"
    subprocess.run([sys.executable, str(validator), "--source", str(source), "--check-only"], check=True)
    applied = validate_series(source, PATCHES)
    for patch in PATCHES[:applied]:
        print(f"Already applied: {patch.name}")
    pending = PATCHES[applied:]
    if args.check_only:
        print(f"Patch validation passed; {len(pending)} pending.")
        return
    subprocess.run([sys.executable, str(validator), "--source", str(source)], check=True)
    for patch in pending:
        git(source, patch)
    print("Still UI, identity, and local-blocker patches are ready.")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        raise SystemExit(error.stderr or str(error))
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        raise SystemExit(str(error))
