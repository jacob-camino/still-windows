#!/usr/bin/env python3
"""Apply Still's small patch series after upstream Helium source preparation."""

import argparse
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
PATCHES = [ROOT / "still/patches" / name for name in (
    "001-ink-margin-grayscale.patch",
    "002-still-windows-identity.patch",
    "003-local-blocking.patch",
    "004-product-name.patch",
)]


def git(source, *args, check=True):
    # Tarball builds live inside this platform repository but have no .git of
    # their own. Do not let Git discover that parent and silently skip paths
    # outside its build/src prefix. A real source checkout still works normally.
    environment = dict(os.environ, GIT_CEILING_DIRECTORIES=str(source.parent))
    return subprocess.run(["git", "-C", str(source), "apply", *map(str, args)],
                          check=check, text=True, capture_output=True,
                          env=environment)


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
    pending = []
    for patch in PATCHES:
        if git(source, "--reverse", "--check", patch, check=False).returncode == 0:
            print(f"Already applied: {patch.name}")
        else:
            pending.append(patch)
    # Validate the complete pending series before changing any source files.
    if pending:
        git(source, "--check", *pending)
    if args.check_only:
        print(f"Patch validation passed; {len(pending)} pending.")
        return
    subprocess.run([sys.executable, str(validator), "--source", str(source)], check=True)
    if pending:
        git(source, *pending)
    print("Still UI, identity, and local-blocker patches are ready.")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        raise SystemExit(error.stderr or str(error))
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        raise SystemExit(str(error))
